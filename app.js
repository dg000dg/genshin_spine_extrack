(function () {
  "use strict";

  const runtimeRegistry = window.SpineRuntimeRegistry || {};
  const defaultRuntimeOrder = ["4.2", "4.1", "4.0", "3.8"];
  const INITIAL_LOAD_COUNT = 8;
  const MAX_ACTIVE_PLAYERS = 8;
  const MAX_CONCURRENT_LOADS = 2;
  const IDLE_CARD_MESSAGE = "鼠标悬停预览动画。";
  const GIF_WORKER_SCRIPT_URL = "/vendor/gif.worker.js";
  const GIF_CAPTURE_FPS = 12;
  const THEME_STORAGE_KEY = "spine_theme";
  const THEME_IDS = ["mondstadt", "liyue", "inazuma", "sumeru", "fontaine", "natlan", "snezhnaya", "moon"];

  const dom = {
    activityPickerButton: document.getElementById("activityPickerButton"),
    activityPickerModal: document.getElementById("activityPickerModal"),
    activityPickerPanel: document.getElementById("activityPickerPanel"),
    activityPickerCloseButton: document.getElementById("activityPickerCloseButton"),
    activityPickerResize: document.getElementById("activityPickerResize"),
    activityPickerList: document.getElementById("activityPickerList"),
    activityPickerEmpty: document.getElementById("activityPickerEmpty"),
    themeSelect: document.getElementById("themeSelect"),
    urlInput: document.getElementById("urlInput"),
    localFolderButton: document.getElementById("localFolderButton"),
    localFolderInput: document.getElementById("localFolderInput"),
    extractButton: document.getElementById("extractButton"),
    downloadButton: document.getElementById("downloadButton"),
    statusText: document.getElementById("statusText"),
    statusTextLabel: document.getElementById("statusTextLabel"),
    gifExportStatus: document.getElementById("gifExportStatus"),
    gifExportLabel: document.getElementById("gifExportLabel"),
    gifExportValue: document.getElementById("gifExportValue"),
    gifExportFill: document.getElementById("gifExportFill"),
    groupBadge: document.getElementById("groupBadge"),
    selectedBadge: document.getElementById("selectedBadge"),
    gridContainer: document.getElementById("gridContainer"),
    emptyState: document.getElementById("emptyState"),
    previewModal: document.getElementById("previewModal"),
    previewModalSlot: document.getElementById("previewModalSlot")
  };

  const state = {
    sessionId: "",
    sessionArchiveBaseName: "",
    activityLinks: [],
    activityLinksLoaded: false,
    activityLinksError: "",
    activityPickerWidth: 0,
    activityPickerResizePointerId: -1,
    selectedActivityKey: "",
    selectedActivityUrl: "",
    cards: new Map(),
    renderToken: 0,
    isBusy: false,
    loadQueue: [],
    loadingCount: 0,
    activeModalCardId: "",
    statusMessage: "等待提取。",
    statusTone: "idle",
    activeGifExportCardId: "",
    activeGifExportLabel: "",
    activeGifExportProgress: 0,
    frameSyncRafId: 0,
    themeId: "mondstadt"
  };

  function initialize() {
    dom.activityPickerButton.addEventListener("click", openActivityPicker);
    dom.activityPickerModal.addEventListener("click", handleActivityPickerClick);
    dom.activityPickerCloseButton.addEventListener("click", closeActivityPicker);
    dom.activityPickerResize.addEventListener("pointerdown", handleActivityPickerResizePointerDown);
    dom.extractButton.addEventListener("click", handleExtractClick);
    dom.downloadButton.addEventListener("click", handleDownloadClick);
    dom.localFolderButton.addEventListener("click", () => dom.localFolderInput.click());
    dom.localFolderInput.addEventListener("change", handleLocalFolderInputChange);
    dom.urlInput.addEventListener("input", handleUrlInputInput);
    dom.urlInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        handleExtractClick();
      }
    });
    document.addEventListener("keydown", handleGlobalKeydown);
    document.addEventListener("pointerdown", handleGlobalPointerDown);
    dom.previewModal.addEventListener("click", handleModalClick);

    window.addEventListener("beforeunload", () => {
      closePreviewModal();
      disposeAllPlayers();
      if (state.frameSyncRafId) {
        window.cancelAnimationFrame(state.frameSyncRafId);
        state.frameSyncRafId = 0;
      }
    });
    window.addEventListener("pointermove", handleActivityPickerResizePointerMove);
    window.addEventListener("pointerup", handleActivityPickerResizePointerUp);
    window.addEventListener("pointercancel", handleActivityPickerResizePointerUp);
    window.addEventListener("resize", handleWindowResize);

    initializeThemeControl();
    loadActivityLinks();
    renderExportProgressState();
    updateBadges();
    applyActivityPickerWidth();
    startFrameSyncLoop();
  }

  function normalizeThemeId(value) {
    const themeId = String(value || "").trim().toLowerCase();
    return THEME_IDS.includes(themeId) ? themeId : "mondstadt";
  }

  function applyTheme(themeId) {
    const nextThemeId = normalizeThemeId(themeId);
    state.themeId = nextThemeId;
    document.documentElement.setAttribute("data-theme", nextThemeId);
    if (dom.themeSelect && dom.themeSelect.value !== nextThemeId) {
      dom.themeSelect.value = nextThemeId;
    }
  }

  function initializeThemeControl() {
    let initialThemeId = "mondstadt";
    try {
      initialThemeId = normalizeThemeId(window.localStorage.getItem(THEME_STORAGE_KEY) || "mondstadt");
    } catch (_error) {
      initialThemeId = "mondstadt";
    }

    applyTheme(initialThemeId);

    if (!dom.themeSelect) {
      return;
    }

    dom.themeSelect.value = state.themeId;
    dom.themeSelect.addEventListener("change", () => {
      const nextThemeId = normalizeThemeId(dom.themeSelect.value);
      applyTheme(nextThemeId);
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, nextThemeId);
      } catch (_error) {
      }
    });
  }

  function getActivityPickerWidthBounds() {
    const viewportWidth = Math.max(window.innerWidth || 0, 320);
    const minWidth = viewportWidth <= 900 ? Math.min(viewportWidth, 440) : 360;
    const maxWidth = viewportWidth <= 900
      ? Math.min(viewportWidth, 440)
      : Math.min(Math.max(420, viewportWidth - 120), 960);

    return {
      min: Math.min(minWidth, maxWidth),
      max: Math.max(minWidth, maxWidth)
    };
  }

  function getDefaultActivityPickerWidth() {
    const bounds = getActivityPickerWidthBounds();
    const preferred = window.innerWidth <= 900
      ? bounds.max
      : Math.round(Math.min(Math.max(window.innerWidth * 0.33333, 380), 620));

    return Math.min(bounds.max, Math.max(bounds.min, preferred));
  }

  function clampActivityPickerWidth(width) {
    const bounds = getActivityPickerWidthBounds();
    return Math.min(bounds.max, Math.max(bounds.min, Math.round(Number(width) || getDefaultActivityPickerWidth())));
  }

  function applyActivityPickerWidth() {
    if (!dom.activityPickerPanel) {
      return;
    }

    if (window.innerWidth <= 900) {
      dom.activityPickerPanel.style.width = "";
      return;
    }

    if (!state.activityPickerWidth) {
      state.activityPickerWidth = getDefaultActivityPickerWidth();
    }

    dom.activityPickerPanel.style.width = `${clampActivityPickerWidth(state.activityPickerWidth)}px`;
  }

  function handleWindowResize() {
    if (state.activityPickerResizePointerId >= 0) {
      state.activityPickerWidth = clampActivityPickerWidth(window.innerWidth - Math.max(window.innerWidth - state.activityPickerWidth, 0));
    } else if (state.activityPickerWidth) {
      state.activityPickerWidth = clampActivityPickerWidth(state.activityPickerWidth);
    }

    applyActivityPickerWidth();
  }

  function handleActivityPickerResizePointerDown(event) {
    if (window.innerWidth <= 900) {
      return;
    }

    event.preventDefault();
    state.activityPickerResizePointerId = event.pointerId;
    dom.activityPickerResize.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing-activity-picker");
  }

  function handleActivityPickerResizePointerMove(event) {
    if (state.activityPickerResizePointerId !== event.pointerId || window.innerWidth <= 900) {
      return;
    }

    state.activityPickerWidth = clampActivityPickerWidth(window.innerWidth - event.clientX);
    applyActivityPickerWidth();
  }

  function handleActivityPickerResizePointerUp(event) {
    if (state.activityPickerResizePointerId !== event.pointerId) {
      return;
    }

    try {
      dom.activityPickerResize.releasePointerCapture(event.pointerId);
    } catch (_error) {
    }

    state.activityPickerResizePointerId = -1;
    document.body.classList.remove("is-resizing-activity-picker");
  }

  function isEditableKeyboardTarget(target) {
    if (!(target instanceof Element)) {
      return false;
    }
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
      return true;
    }
    return Boolean(target.closest("[contenteditable='true']"));
  }

  function closeCardDebugPopups(card) {
    return;
  }

  function handleGlobalPointerDown(event) {
    return;
  }

  function handleGlobalKeydown(event) {
    if (
      state.activeModalCardId
      && !isEditableKeyboardTarget(event.target)
      && (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "a" || event.key === "A" || event.key === "d" || event.key === "D")
    ) {
      const card = state.cards.get(state.activeModalCardId);
      if (card) {
        event.preventDefault();
        stepCardBySingleFrame(card, event.key === "ArrowLeft" || event.key === "a" || event.key === "A" ? -1 : 1);
        return;
      }
    }

    if (event.key === "Escape" && state.activeModalCardId) {
      closeCardDebugPopups(state.cards.get(state.activeModalCardId));
      closePreviewModal();
      return;
    }

    if (event.key === "Escape" && dom.activityPickerModal.classList.contains("is-active")) {
      closeActivityPicker();
    }
  }

  function handleModalClick(event) {
    const target = event.target;
    if (target instanceof Element && target.hasAttribute("data-modal-close")) {
      closePreviewModal();
    }
  }

  function handleActivityPickerClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    if (target.hasAttribute("data-activity-picker-close")) {
      closeActivityPicker();
      return;
    }

    const radio = target.closest("input[type='radio'][name='activity-link-choice']");
    if (!(radio instanceof HTMLInputElement)) {
      return;
    }

    const key = String(radio.value || "");
    const url = String(radio.dataset.url || "");
    if (!key || !url) {
      return;
    }

    applySelectedActivityLink(key, url);
  }

  async function loadActivityLinks() {
    state.activityLinksLoaded = false;
    state.activityLinksError = "";
    renderActivityPickerList();

    try {
      const response = await fetch("./activity-links.json", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`活动链接读取失败 (${response.status})`);
      }

      const payload = await response.json();
      const entries = Object.entries(payload || {})
        .map(([key, url]) => ({
          key: String(key || "").trim(),
          url: String(url || "").trim()
        }))
        .filter((item) => item.key && /^https?:\/\//i.test(item.url));

      state.activityLinks = entries;
      state.activityLinksLoaded = true;
    } catch (error) {
      console.error(error);
      state.activityLinks = [];
      state.activityLinksLoaded = true;
      state.activityLinksError = getErrorMessage(error);
    }

    renderActivityPickerList();
  }

  function renderActivityPickerList() {
    dom.activityPickerList.innerHTML = "";

    if (!state.activityLinksLoaded) {
      dom.activityPickerEmpty.hidden = true;
      dom.activityPickerEmpty.textContent = "";
      return;
    }

    if (state.activityLinksError) {
      dom.activityPickerEmpty.hidden = false;
      dom.activityPickerEmpty.textContent = `活动链接列表读取失败。\n${state.activityLinksError}`;
      return;
    }

    if (!state.activityLinks.length) {
      dom.activityPickerEmpty.hidden = false;
      dom.activityPickerEmpty.textContent = "当前没有可选的活动链接。";
      return;
    }

    dom.activityPickerEmpty.hidden = true;

    for (const item of state.activityLinks) {
      const label = document.createElement("label");
      label.className = "activity-option";

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "activity-link-choice";
      radio.value = item.key;
      radio.dataset.url = item.url;
      radio.checked = item.key === state.selectedActivityKey;
      radio.addEventListener("change", () => {
        applySelectedActivityLink(item.key, item.url);
      });

      const body = document.createElement("span");
      body.className = "activity-option__body";

      const name = document.createElement("span");
      name.className = "activity-option__name";
      name.textContent = item.key;

      const url = document.createElement("span");
      url.className = "activity-option__url";
      url.textContent = item.url;

      body.appendChild(name);
      body.appendChild(url);
      label.appendChild(radio);
      label.appendChild(body);
      dom.activityPickerList.appendChild(label);
    }
  }

  function openActivityPicker() {
    if (state.activeModalCardId) {
      closePreviewModal();
    }

    applyActivityPickerWidth();
    dom.activityPickerModal.classList.add("is-active");
    dom.activityPickerModal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    renderActivityPickerList();
  }

  function closeActivityPicker() {
    state.activityPickerResizePointerId = -1;
    document.body.classList.remove("is-resizing-activity-picker");
    dom.activityPickerModal.classList.remove("is-active");
    dom.activityPickerModal.setAttribute("aria-hidden", "true");
    if (!state.activeModalCardId) {
      document.body.style.overflow = "";
    }
  }

  function syncUrlInputTitle() {
    dom.urlInput.title = String(dom.urlInput.value || "").trim();
  }

  function clearSelectedActivityLink() {
    state.selectedActivityKey = "";
    state.selectedActivityUrl = "";
  }

  function handleUrlInputInput() {
    const currentValue = String(dom.urlInput.value || "").trim();
    if (state.selectedActivityUrl && currentValue !== state.selectedActivityUrl) {
      clearSelectedActivityLink();
    }
    syncUrlInputTitle();
  }

  function applySelectedActivityLink(key, url) {
    state.selectedActivityKey = key;
    state.selectedActivityUrl = url;
    dom.urlInput.value = url;
    dom.urlInput.title = `${key}\n${url}`;
    closeActivityPicker();
    setStatus(`已选择活动：${key}`, "success");
  }

  function getSelectedActivityArchiveBaseName(targetUrl) {
    if (!state.selectedActivityKey || !state.selectedActivityUrl) {
      return "";
    }

    return state.selectedActivityUrl === String(targetUrl || "").trim()
      ? state.selectedActivityKey
      : "";
  }

  async function handleExtractClick() {
    const targetUrl = String(dom.urlInput.value || "").trim();
    const archiveBaseName = getSelectedActivityArchiveBaseName(targetUrl);
    if (!/^https?:\/\//i.test(targetUrl)) {
      setStatus(
        /^本地文件/.test(targetUrl) || /^本地文件夹/.test(targetUrl)
          ? "当前输入框显示的是本地选择结果，如需提取网页请重新输入链接。"
          : "请输入有效的 http/https 链接。",
        "error"
      );
      return;
    }

    const requestToken = ++state.renderToken;
    closePreviewModal();
    disposeAllPlayers();
    state.sessionId = "";
    state.sessionArchiveBaseName = "";
    resetGrid();
    setBusy(true);
    showEmptyState("正在提取活动页面中的 Spine 资源...");
    setStatus("正在提取并整理资源，请稍候。", "loading");

    try {
      const response = await fetch("/api/extract", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          url: targetUrl,
          archiveBaseName
        })
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `提取失败 (${response.status})`);
      }

      const payload = await response.json();
      if (requestToken !== state.renderToken) {
        return;
      }

      applySessionPayload(payload, "提取完成");
    } catch (error) {
      console.error(error);
      state.sessionId = "";
      state.sessionArchiveBaseName = "";
      resetGrid();
      showEmptyState("提取失败。\n" + getErrorMessage(error));
      setStatus("提取失败: " + getErrorMessage(error), "error");
      updateBadges();
    } finally {
      if (requestToken === state.renderToken) {
        setBusy(false);
      }
    }
  }

  async function handleLocalFolderInputChange(event) {
    const input = event.target;
    try {
      await handleLocalPreviewFiles(input && input.files ? input.files : null, "文件夹");
    } finally {
      if (input) {
        input.value = "";
      }
    }
  }

  async function handleLocalPreviewFiles(fileList, sourceLabel) {
    const files = Array.from(fileList || []);
    if (!files.length) {
      return;
    }

    clearSelectedActivityLink();
    const displayText = buildLocalSelectionDisplay(files, sourceLabel);
    dom.urlInput.value = displayText;
    dom.urlInput.title = displayText;

    const requestToken = ++state.renderToken;
    closePreviewModal();
    disposeAllPlayers();
    state.sessionId = "";
    state.sessionArchiveBaseName = "";
    resetGrid();
    setBusy(true);
    showEmptyState(`正在整理本地${sourceLabel}中的 Spine 资源...`);
    setStatus(`正在读取本地${sourceLabel}...`, "loading");

    try {
      const formData = new FormData();
      const manifest = files.map((file, index) => ({
        fieldName: `file_${index}`,
        name: file.name || `file_${index}`,
        relativePath: getLocalRelativePath(file, index)
      }));

      formData.append("manifest", JSON.stringify(manifest));
      manifest.forEach((item, index) => {
        formData.append(item.fieldName, files[index], item.name);
      });

      const response = await fetch("/api/local-preview", {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `本地预览失败 (${response.status})`);
      }

      const payload = await response.json();
      if (requestToken !== state.renderToken) {
        return;
      }

      applySessionPayload(payload, "本地资源已载入");
    } catch (error) {
      console.error(error);
      state.sessionId = "";
      state.sessionArchiveBaseName = "";
      resetGrid();
      showEmptyState("本地预览失败。\n" + getErrorMessage(error));
      setStatus("本地预览失败: " + getErrorMessage(error), "error");
      updateBadges();
    } finally {
      if (requestToken === state.renderToken) {
        setBusy(false);
      }
    }
  }

  function getLocalRelativePath(file, index) {
    const rawPath = file && typeof file.webkitRelativePath === "string" && file.webkitRelativePath
      ? file.webkitRelativePath
      : (file && file.name ? file.name : `file_${index}`);

    return String(rawPath)
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .join("/");
  }

  function buildGroupDisplayName(group) {
    const fileName = group && group.fileName ? group.fileName : "未命名 Spine";
    const sizeLabel = formatImageByteSize(group && group.imageByteSize);
    return sizeLabel ? `${fileName} (${sizeLabel})` : fileName;
  }

  function formatImageByteSize(value) {
    const size = Number(value || 0);
    if (!Number.isFinite(size) || size <= 0) {
      return "";
    }

    if (size < 1024 * 1024) {
      return `${Math.max(1, Math.round(size / 1024))} KB`;
    }

    return `${(size / (1024 * 1024)).toFixed(2)} MB`;
  }

  function parseArchiveBaseName(archiveName) {
    return String(archiveName || "").replace(/\.zip$/i, "").trim();
  }

  function sanitizeFileNameSegment(value) {
    let normalized = String(value || "")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[.\s_]+|[.\s_]+$/g, "")
      .slice(0, 180);

    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(normalized)) {
      normalized = `${normalized}_file`;
    }

    return normalized;
  }

  function getGroupExportName(group) {
    const preferred = group && (group.customFileName || group.fileName)
      ? (group.customFileName || group.fileName)
      : "spine";
    return String(preferred || "").trim();
  }

  function buildCardNameLabel(group) {
    const fileName = getGroupExportName(group) || "未命名 Spine";
    const sizeLabel = formatImageByteSize(group && group.imageByteSize);
    return sizeLabel ? `${fileName} (${sizeLabel})` : fileName;
  }

  function updateCardNameDisplay(card) {
    if (!card || !card.name) {
      return;
    }

    card.name.textContent = buildCardNameLabel(card.group);
    card.name.title = `${getGroupExportName(card.group)}\n双击可重命名`;
  }

  function beginCardRename(card) {
    if (!card || card.isRenaming || !card.renameInput || !card.name) {
      return;
    }

    card.isRenaming = true;
    card.renameInput.value = getGroupExportName(card.group);
    card.renameInput.hidden = false;
    card.name.hidden = true;
    card.renameInput.focus();
    card.renameInput.select();
  }

  function commitCardRename(card, options) {
    if (!card || !card.isRenaming || !card.renameInput || !card.name) {
      return;
    }

    const keepEditingOnEmpty = !options || options.keepEditingOnEmpty !== false;
    const nextName = sanitizeFileNameSegment(card.renameInput.value || "");
    if (!nextName) {
      if (keepEditingOnEmpty) {
        setStatus("名称不能为空，请输入有效名称。", "error");
        card.renameInput.focus();
        card.renameInput.select();
        return;
      }
      card.group.customFileName = "";
    } else {
      card.group.customFileName = nextName;
    }

    card.isRenaming = false;
    card.renameInput.hidden = true;
    card.name.hidden = false;
    updateCardNameDisplay(card);
  }

  function cancelCardRename(card) {
    if (!card || !card.isRenaming || !card.renameInput || !card.name) {
      return;
    }

    card.isRenaming = false;
    card.renameInput.hidden = true;
    card.name.hidden = false;
    card.renameInput.value = getGroupExportName(card.group);
    updateCardNameDisplay(card);
  }

  function buildGifFileName(card) {
    const activityName = sanitizeFileNameSegment(state.sessionArchiveBaseName || "spine_export") || "spine_export";
    const resourceName = sanitizeFileNameSegment(getGroupExportName(card && card.group ? card.group : null) || "spine") || "spine";
    return `${activityName}-${resourceName}.gif`;
  }

  function buildSnapshotFileName(card, progress) {
    const gifFileName = buildGifFileName(card);
    const gifBaseName = String(gifFileName || "spine_export.gif").replace(/\.gif$/i, "");
    const animationItem = getSelectedAnimationItem(card);
    const durationSeconds = getAnimationDurationSeconds(animationItem && animationItem.animation);
    const exportDurationMs = Math.max(100, Math.round(durationSeconds * 1000));
    const frameDelayMs = Math.max(16, Math.round(1000 / GIF_CAPTURE_FPS));
    const totalFrames = durationSeconds > 0 ? Math.max(2, 1 + Math.ceil(exportDurationMs / frameDelayMs)) : 1;
    const frameIndex = Math.round(clampProgress(progress) * Math.max(0, totalFrames - 1));
    const frameSerial = String(Math.max(0, frameIndex)).padStart(3, "0");
    return `${gifBaseName}_${frameSerial}.png`;
  }

  function clampProgress(value) {
    const progress = Number(value);
    if (!Number.isFinite(progress)) {
      return 0;
    }
    return Math.max(0, Math.min(1, progress));
  }

  function formatProgressPercent(progress) {
    return `${Math.round(clampProgress(progress) * 100)}%`;
  }

  function setProgressFill(fillElement, progress) {
    if (!fillElement) {
      return;
    }
    fillElement.style.width = `${(clampProgress(progress) * 100).toFixed(1)}%`;
  }

  function getSelectedAnimationItem(card) {
    if (!card || !Array.isArray(card.animations) || !card.animations.length) {
      return null;
    }
    return card.animations.find((item) => item.index === card.selectedAnimationIndex) || card.animations[0] || null;
  }

  function getAnimationDurationSeconds(animation) {
    const duration = Number(animation && animation.duration);
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  }

  function setCardFrameScrubberValue(card, progress) {
    if (!card || !card.frameScrubber || !card.frameScrubberValue) {
      return;
    }

    const safeProgress = clampProgress(progress);
    card.frameScrubber.value = String(Math.round(safeProgress * 1000));
    card.frameScrubberValue.textContent = `${Math.round(safeProgress * 100)}%`;
  }

  function seekPlayerToAnimationProgress(player, animation, progress) {
    if (!player || !animation) {
      return false;
    }

    const durationSeconds = getAnimationDurationSeconds(animation);
    if (durationSeconds <= 0) {
      return false;
    }

    const animationName = getAnimationPlaybackName(animation);
    if (!animationName) {
      return false;
    }

    const safeProgress = clampProgress(progress);
    const targetTime = safeProgress >= 1
      ? Math.max(0, durationSeconds - 0.0001)
      : durationSeconds * safeProgress;

    const animationState = player.animationState;
    if (!animationState) {
      return false;
    }

    try {
      if (typeof animationState.clearTracks === "function") {
        animationState.clearTracks();
      }
      if (!setAnimationViaState(player, animationName, true, { skipPlay: true })) {
        return false;
      }
      const current = typeof animationState.getCurrent === "function"
        ? animationState.getCurrent(0)
        : animationState.tracks && animationState.tracks[0];
      if (!current) {
        return false;
      }

      if (typeof current.mixDuration === "number") {
        current.mixDuration = 0;
      }
      if (typeof current.mixTime === "number") {
        current.mixTime = 0;
      }
      if (typeof current.alpha === "number") {
        current.alpha = 1;
      }
      if (typeof current.trackTime === "number") {
        current.trackTime = 0;
      }
      if (typeof current.animationLast === "number") {
        current.animationLast = 0;
      }
      if (typeof current.trackLast === "number") {
        current.trackLast = 0;
      }

      if (typeof animationState.update === "function") {
        animationState.update(targetTime);
      }
      if (typeof animationState.apply === "function") {
        animationState.apply(player.skeleton);
      }

      const runtime = getPlayerRuntime(player);
      const physicsMode = runtime && runtime.Physics && typeof runtime.Physics.update === "number"
        ? runtime.Physics.update
        : undefined;
      if (player.skeleton && typeof player.skeleton.updateWorldTransform === "function") {
        player.skeleton.updateWorldTransform(physicsMode);
      }
      if (typeof player.drawFrame === "function") {
        player.drawFrame(false);
      }
      return true;
    } catch (_error) {
      return false;
    }
  }

  function seekCardToProgress(card, progress) {
    if (!card || !card.player) {
      return false;
    }
    const animationItem = getSelectedAnimationItem(card);
    if (!animationItem || !animationItem.animation) {
      return false;
    }
    const safeProgress = clampProgress(progress);
    const ok = seekPlayerToAnimationProgress(card.player, animationItem.animation, safeProgress);
    if (ok) {
      setCardFrameScrubberValue(card, safeProgress);
    }
    return ok;
  }

  function enableManualFrameControl(card) {
    if (!card) {
      return;
    }

    card.isManualFrameControl = true;
    if (card.player && typeof card.player.pause === "function") {
      try {
        card.player.pause();
      } catch (_error) {
      }
    }
  }

  function resumeAutomaticFrameControl(card) {
    if (!card) {
      return;
    }

    card.isManualFrameControl = false;
    if (card.player && typeof card.player.play === "function") {
      try {
        card.player.play();
      } catch (_error) {
      }
    }
  }

  function applyCardPlaybackSpeed(card) {
    return;
    if (!card || !card.player) {
      return;
    }
    const speed = Number(card.playbackSpeed);
    const safeSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
    if (card.player.animationState && typeof card.player.animationState.timeScale === "number") {
      card.player.animationState.timeScale = safeSpeed;
    }
    if (typeof card.player.timeScale === "number") {
      card.player.timeScale = safeSpeed;
    }
  }

  function applyCardDebugRender(card) {
    return;
    if (!card || !card.player) {
      return;
    }
    const bonesEnabled = Boolean(card.debugBonesEnabled);
    const pathsEnabled = Boolean(card.debugPathsEnabled);
    const meshesEnabled = Boolean(card.debugMeshesEnabled);
    const meshHullEnabled = Boolean(card.debugMeshHullEnabled);
    const meshTrianglesEnabled = Boolean(card.debugMeshTrianglesEnabled);
    const boundingBoxesEnabled = Boolean(card.debugBoundingBoxesEnabled);
    const clippingEnabled = Boolean(card.debugClippingEnabled);
    const enabled = bonesEnabled || pathsEnabled || meshesEnabled || meshHullEnabled || meshTrianglesEnabled || boundingBoxesEnabled || clippingEnabled;
    if (typeof card.player.debugRender === "boolean") {
      card.player.debugRender = enabled;
    }
    if (card.player.debug && typeof card.player.debug === "object") {
      if ("bones" in card.player.debug) {
        card.player.debug.bones = bonesEnabled;
      }
      if ("paths" in card.player.debug) {
        card.player.debug.paths = pathsEnabled;
      }
      if ("meshes" in card.player.debug) {
        card.player.debug.meshes = meshesEnabled || meshHullEnabled || meshTrianglesEnabled;
      }
      if ("meshHull" in card.player.debug) {
        card.player.debug.meshHull = meshHullEnabled;
      }
      if ("meshTriangles" in card.player.debug) {
        card.player.debug.meshTriangles = meshTrianglesEnabled;
      }
      if ("boundingBoxes" in card.player.debug) {
        card.player.debug.boundingBoxes = boundingBoxesEnabled;
      }
      if ("clipping" in card.player.debug) {
        card.player.debug.clipping = clippingEnabled;
      }
    }
  }

  function drawCardDebugTrail(card) {
    return;
    if (!card || !card.debugTrailCanvas) {
      return;
    }

    const show = Boolean(card.isModalOpen && card.debugTrailEnabled);
    card.debugTrailCanvas.hidden = !show;
    if (!show) {
      card.debugTrailPoints = [];
      return;
    }

    const canvas = card.mount && card.mount.querySelector ? card.mount.querySelector("canvas") : null;
    const bounds = readPlayerBounds(card.player);
    if (!canvas || !bounds) {
      return;
    }

    const width = Math.max(1, Math.round(canvas.clientWidth || canvas.width || 0));
    const height = Math.max(1, Math.round(canvas.clientHeight || canvas.height || 0));
    if (card.debugTrailCanvas.width !== width || card.debugTrailCanvas.height !== height) {
      card.debugTrailCanvas.width = width;
      card.debugTrailCanvas.height = height;
    }

    const center = {
      x: Number(bounds.x) + Number(bounds.width) / 2,
      y: Number(bounds.y) + Number(bounds.height) / 2
    };
    if (Number.isFinite(center.x) && Number.isFinite(center.y)) {
      card.debugTrailPoints.push(center);
      if (card.debugTrailPoints.length > 120) {
        card.debugTrailPoints.shift();
      }
    }

    const points = card.debugTrailPoints;
    const ctx = card.debugTrailCanvas.getContext("2d");
    if (!ctx || points.length < 2) {
      return;
    }

    let minX = points[0].x;
    let maxX = points[0].x;
    let minY = points[0].y;
    let maxY = points[0].y;
    for (const point of points) {
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
    const spanX = Math.max(1e-6, maxX - minX);
    const spanY = Math.max(1e-6, maxY - minY);
    const pad = 20;
    const drawW = Math.max(1, width - pad * 2);
    const drawH = Math.max(1, height - pad * 2);

    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255, 106, 106, 0.9)";
    ctx.beginPath();
    points.forEach((point, index) => {
      const x = pad + ((point.x - minX) / spanX) * drawW;
      const y = pad + ((point.y - minY) / spanY) * drawH;
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  }

  function getFrameStepProgress(card) {
    const animationItem = getSelectedAnimationItem(card);
    const durationSeconds = getAnimationDurationSeconds(animationItem && animationItem.animation);
    if (durationSeconds <= 0) {
      return 1 / 1000;
    }
    return Math.max(1 / 1000, 1 / Math.max(1, Math.round(durationSeconds * 60)));
  }

  function stepCardBySingleFrame(card, direction) {
    if (!card) {
      return;
    }
    enableManualFrameControl(card);
    const current = card.frameScrubber ? Number(card.frameScrubber.value || 0) / 1000 : getCardPlaybackProgress(card);
    const step = getFrameStepProgress(card);
    const next = clampProgress(current + (direction < 0 ? -step : step));
    if (!seekCardToProgress(card, next)) {
      setCardFrameScrubberValue(card, next);
    }
    refreshCardFrameScrubber(card);
  }

  function getCardPlaybackProgress(card) {
    if (!card || !card.player) {
      return 0;
    }

    const animationItem = getSelectedAnimationItem(card);
    if (!animationItem) {
      return 0;
    }

    const durationSeconds = getAnimationDurationSeconds(animationItem.animation);
    if (durationSeconds <= 0) {
      return 0;
    }

    const animationState = card.player.animationState;
    if (!animationState) {
      return 0;
    }

    const current = typeof animationState.getCurrent === "function"
      ? animationState.getCurrent(0)
      : animationState.tracks && animationState.tracks[0];
    const trackTime = Number(current && current.trackTime);
    if (!Number.isFinite(trackTime)) {
      return 0;
    }

    return clampProgress((trackTime % durationSeconds) / durationSeconds);
  }

  function refreshCardFrameScrubber(card) {
    if (
      !card
      || !card.frameScrubber
      || !card.frameScrubberValue
      || !card.frameScrubberPlayButton
      || !card.frameScrubberPauseButton
      || !card.frameStepPrevButton
      || !card.frameStepNextButton
    ) {
      return;
    }

    const animationItem = getSelectedAnimationItem(card);
    const available = Boolean(
      card.player
      && card.isModalOpen
      && animationItem
      && getAnimationDurationSeconds(animationItem.animation) > 0
    );

    card.frameScrubber.disabled = !available;
    card.frameScrubberPlayButton.disabled = !available;
    card.frameScrubberPauseButton.disabled = !available;
    card.frameStepPrevButton.disabled = !available;
    card.frameStepNextButton.disabled = !available;
    card.frameScrubberPlayButton.classList.toggle("is-active", Boolean(available && card.isManualFrameControl));
    card.frameScrubberPauseButton.classList.toggle("is-active", Boolean(available && card.isManualFrameControl));
    card.frameScrubber.title = available
      ? "拖动以定位当前动画帧"
      : (card.isModalOpen ? "当前运行时不支持拖动定位" : "仅全屏预览时可用");
    card.frameScrubberPlayButton.title = available
      ? (card.isManualFrameControl ? "恢复自动播放" : "当前为自动播放")
      : "当前不可播放";
    card.frameScrubberPauseButton.title = available ? "暂停当前动画播放" : "当前不可暂停";
    card.frameStepPrevButton.title = available ? "上一帧" : "当前不可逐帧";
    card.frameStepNextButton.title = available ? "下一帧" : "当前不可逐帧";
    card.frameScrubberWrap.hidden = !available;

    if (!available) {
      setCardFrameScrubberValue(card, 0);
      return;
    }

    if (card.isScrubbing) {
      return;
    }

    setCardFrameScrubberValue(card, getCardPlaybackProgress(card));
  }

  function stepFrameSyncLoop() {
    state.frameSyncRafId = window.requestAnimationFrame(stepFrameSyncLoop);

    for (const card of state.cards.values()) {
      if (card && card.isModalOpen) {
        drawCardDebugTrail(card);
      }
      if (!card || card.isScrubbing || card.isManualFrameControl || !card.player || !card.frameScrubberWrap || card.frameScrubberWrap.hidden) {
        continue;
      }
      setCardFrameScrubberValue(card, getCardPlaybackProgress(card));
    }
  }

  function startFrameSyncLoop() {
    if (state.frameSyncRafId) {
      return;
    }
    state.frameSyncRafId = window.requestAnimationFrame(stepFrameSyncLoop);
  }

  async function waitForAnimationFrames(frameCount) {
    const total = Math.max(1, Number(frameCount) || 1);
    for (let index = 0; index < total; index += 1) {
      await waitForAnimationFrame();
    }
  }

  function hideNonCanvasDecorations(mount) {
    if (!mount || !mount.querySelector) {
      return;
    }

    const canvas = mount.querySelector("canvas");
    if (!canvas) {
      return;
    }

    const elements = Array.from(mount.querySelectorAll("*"));
    for (const element of elements) {
      if (element === canvas) {
        continue;
      }

      if (typeof element.contains === "function" && element.contains(canvas)) {
        continue;
      }

      element.style.setProperty("display", "none", "important");
      element.style.setProperty("visibility", "hidden", "important");
      element.style.setProperty("opacity", "0", "important");
      element.setAttribute("aria-hidden", "true");
    }
  }

  async function primeExportCanvas(mount, isStaticAnimation) {
    hideNonCanvasDecorations(mount);
    await waitForDelay(isStaticAnimation ? 260 : 120);
    await waitForAnimationFrames(isStaticAnimation ? 6 : 3);
    hideNonCanvasDecorations(mount);
  }

  function updateCardExportProgress(card, progress) {
    if (!card) {
      return;
    }

    const safeProgress = clampProgress(progress);
    card.exportProgressValue.textContent = formatProgressPercent(safeProgress);
    card.exportProgressValue.title = `GIF 导出进度 ${formatProgressPercent(safeProgress)}`;
    setProgressFill(card.exportProgressFill, safeProgress);
  }

  function renderExportProgressState() {
    dom.statusText.dataset.tone = state.statusTone;

    const isActive = Boolean(state.activeGifExportCardId);
    dom.gifExportStatus.hidden = !isActive;
    dom.gifExportStatus.classList.toggle("is-active", isActive);
    if (!isActive) {
      dom.statusTextLabel.textContent = state.statusMessage;
      dom.gifExportLabel.textContent = "";
      dom.gifExportLabel.title = "";
      dom.gifExportValue.textContent = "0%";
      setProgressFill(dom.gifExportFill, 0);
      return;
    }

    dom.statusTextLabel.textContent = "";
    dom.gifExportLabel.textContent = `${state.activeGifExportLabel}，`;
    dom.gifExportLabel.title = state.activeGifExportLabel;
    dom.gifExportValue.textContent = formatProgressPercent(state.activeGifExportProgress);
    setProgressFill(dom.gifExportFill, state.activeGifExportProgress);
  }

  function setGifExportProgress(card, fileName, progress) {
    if (!card) {
      return;
    }

    const safeProgress = clampProgress(progress);
    card.exportProgressAmount = safeProgress;
    updateCardExportProgress(card, safeProgress);

    state.activeGifExportCardId = card.group.id;
    state.activeGifExportLabel = `正在导出 ${fileName}`;
    state.activeGifExportProgress = safeProgress;
    renderExportProgressState();
  }

  function clearGifExportProgress(card) {
    if (card) {
      card.exportProgressAmount = 0;
      updateCardExportProgress(card, 0);
    }

    if (!card || state.activeGifExportCardId === card.group.id) {
      state.activeGifExportCardId = "";
      state.activeGifExportLabel = "";
      state.activeGifExportProgress = 0;
    }

    renderExportProgressState();
  }

  function findActiveGifExport(exceptCard) {
    for (const card of state.cards.values()) {
      if (card !== exceptCard && card.isExportingGif) {
        return card;
      }
    }
    return null;
  }

  function waitForAnimationFrame() {
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }

  function waitForDelay(delayMs) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, delayMs);
    });
  }

  function downloadBlob(blob, fileName) {
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  }

  async function handleExportGifClick(card) {
    if (!card || card.isExportingGif) {
      return;
    }

    if (card.isExportingImage) {
      setStatus("当前正在导出图片，请稍后再导出 GIF。", "loading");
      return;
    }

    const activeExportCard = findActiveGifExport(card);
    if (activeExportCard) {
      setStatus(`正在导出 ${activeExportCard.group.fileName}，请稍候。`, "loading");
      return;
    }

    if (typeof window.GIF !== "function") {
      setStatus("GIF 导出库加载失败。", "error");
      return;
    }

    if (!card.player) {
      setStatus("当前动画尚未完成加载。", "error");
      return;
    }

    const animationItem = card.animations.find((item) => item.index === card.selectedAnimationIndex) || card.animations[0];
    if (!animationItem || !animationItem.animation) {
      setStatus("当前资源没有可导出的动画。", "error");
      return;
    }
    const durationSeconds = Number(animationItem.animation.duration || 0);
    const isStaticAnimation = !Number.isFinite(durationSeconds) || durationSeconds <= 0;
    const fileName = buildGifFileName(card);

    card.isExportingGif = true;
    card.exportProgressAmount = 0.04;
    setGifExportProgress(card, fileName, 0.04);
    syncFullscreenButtons();
    setStatus(`正在导出 ${card.group.fileName} GIF...`, "loading");

    let exportMount = null;
    let exportPlayer = null;

    try {
      const exportSize = resolveGifExportSize(card);
      setGifExportProgress(card, fileName, 0.08);
      exportMount = createHiddenExportMount(exportSize.width, exportSize.height);
      exportPlayer = await createExportPlayerForCard(card, exportMount);
      setGifExportProgress(card, fileName, 0.16);
      const canvas = exportMount.querySelector("canvas");
      if (!canvas || !canvas.width || !canvas.height) {
        throw new Error("导出画布不可用。");
      }

      const exportAnimationItems = getAnimationItems(exportPlayer, card.group.animationHints);
      const exportAnimationItem = exportAnimationItems.find((item) => item.index === animationItem.index) || exportAnimationItems[0];
      if (!exportAnimationItem || !exportAnimationItem.animation) {
        throw new Error("当前动画无法在导出播放器中重建。");
      }
      setGifExportProgress(card, fileName, 0.24);

      if (card.selectedSkinName) {
        applySkinByName(exportPlayer, card.selectedSkinName);
      }
      setGifExportProgress(card, fileName, 0.3);

      const gif = new window.GIF({
        workers: 2,
        quality: 1,
        width: canvas.width,
        height: canvas.height,
        workerScript: GIF_WORKER_SCRIPT_URL
      });
      const exportDurationMs = Math.max(100, Math.round(durationSeconds * 1000));
      const frameDelayMs = Math.max(16, Math.round(1000 / GIF_CAPTURE_FPS));
      const totalFrames = isStaticAnimation ? 1 : Math.max(2, 1 + Math.ceil(exportDurationMs / frameDelayMs));
      let capturedFrames = 0;
      const captureStartProgress = 0.3;
      const captureEndProgress = 0.74;

      const addGifFrame = (delay) => {
        gif.addFrame(canvas, {
          copy: true,
          delay
        });
        capturedFrames += 1;
        const frameProgress = captureStartProgress + (capturedFrames / totalFrames) * (captureEndProgress - captureStartProgress);
        setGifExportProgress(card, fileName, frameProgress);
      };

      setAnimationOnPlayer(exportPlayer, exportAnimationItem.animation, exportAnimationItem.index);
      await primeExportCanvas(exportMount, isStaticAnimation);
      if (isStaticAnimation) {
        addGifFrame(1000);
      } else {
        addGifFrame(frameDelayMs);

        let remainingMs = exportDurationMs;
        while (remainingMs > 0) {
          const delay = Math.min(frameDelayMs, remainingMs);
          await waitForDelay(delay);
          await waitForAnimationFrame();
          addGifFrame(delay);
          remainingMs -= delay;
        }
      }

      const blob = await new Promise((resolve, reject) => {
        gif.on("progress", (value) => {
          const renderProgress = 0.74 + clampProgress(value) * 0.24;
          setGifExportProgress(card, fileName, renderProgress);
        });
        gif.on("finished", resolve);
        gif.on("abort", () => reject(new Error("GIF 导出已中止。")));
        gif.render();
      });

      setGifExportProgress(card, fileName, 1);
      await waitForDelay(180);
      downloadBlob(blob, fileName);
      clearGifExportProgress(card);
      setStatus(`GIF 已开始下载: ${fileName}`, "success");
    } catch (error) {
      console.error(error);
      clearGifExportProgress(card);
      setStatus("GIF 导出失败: " + getErrorMessage(error), "error");
    } finally {
      disposeStandalonePlayer(exportPlayer, exportMount);
      card.isExportingGif = false;
      syncFullscreenButtons();
    }
  }

  async function handleExportImageClick(card) {
    if (!card || card.isExportingImage) {
      return;
    }

    if (card.isExportingGif) {
      setStatus("当前正在导出 GIF，请稍后再导出图片。", "loading");
      return;
    }

    if (!card.player) {
      setStatus("当前动画尚未完成加载。", "error");
      return;
    }

    let canvas = card.mount && card.mount.querySelector ? card.mount.querySelector("canvas") : null;
    if (!canvas || !canvas.width || !canvas.height) {
      setStatus("当前画面未就绪，无法导出图片。", "error");
      return;
    }

    const wasManualFrameControl = Boolean(card.isManualFrameControl);
    card.isExportingImage = true;
    syncFullscreenButtons();
    let exportMount = null;
    let exportPlayer = null;

    try {
      const progress = card.frameScrubber
        ? Number(card.frameScrubber.value || 0) / 1000
        : getCardPlaybackProgress(card);
      if (!wasManualFrameControl) {
        enableManualFrameControl(card);
      }
      seekCardToProgress(card, progress);
      const exportSize = resolveGifExportSize(card);
      exportMount = createHiddenExportMount(exportSize.width, exportSize.height);
      exportPlayer = await createExportPlayerForCard(card, exportMount);
      canvas = exportMount.querySelector("canvas");
      if (!canvas || !canvas.width || !canvas.height) {
        throw new Error("导出画布不可用。");
      }

      const animationItem = card.animations.find((item) => item.index === card.selectedAnimationIndex) || card.animations[0];
      if (!animationItem || !animationItem.animation) {
        throw new Error("当前资源没有可导出的动画。");
      }
      if (card.selectedSkinName) {
        applySkinByName(exportPlayer, card.selectedSkinName);
      }
      setAnimationOnPlayer(exportPlayer, animationItem.animation, animationItem.index);
      if (!seekPlayerToAnimationProgress(exportPlayer, animationItem.animation, progress)) {
        throw new Error("导出定位失败。");
      }
      await waitForAnimationFrame();

      const blob = await new Promise((resolve) => {
        try {
          canvas.toBlob((result) => resolve(result || null), "image/png");
        } catch (_error) {
          resolve(null);
        }
      });

      if (!blob) {
        setStatus("图片导出失败：无法读取当前画面。", "error");
        return;
      }

      const fileName = buildSnapshotFileName(card, progress);
      downloadBlob(blob, fileName);
      setStatus(`已导出当前帧图片：${fileName}`, "success");
    } catch (error) {
      console.error(error);
      setStatus("图片导出失败: " + getErrorMessage(error), "error");
    } finally {
      disposeStandalonePlayer(exportPlayer, exportMount);
      if (!wasManualFrameControl) {
        resumeAutomaticFrameControl(card);
      }
      card.isExportingImage = false;
      refreshCardFrameScrubber(card);
      syncFullscreenButtons();
    }
  }

  function resolveGifExportSize(card) {
    const fallbackCanvas = card && card.mount ? card.mount.querySelector("canvas") : null;
    const width = Math.max(
      1,
      Math.round(Number(card && card.group && card.group.renderWidth || 0))
      || Math.round(Number(fallbackCanvas && fallbackCanvas.width || 0))
      || 1024
    );
    const height = Math.max(
      1,
      Math.round(Number(card && card.group && card.group.renderHeight || 0))
      || Math.round(Number(fallbackCanvas && fallbackCanvas.height || 0))
      || 1024
    );

    return { width, height };
  }

  function createHiddenExportMount(width, height) {
    const host = document.createElement("div");
    host.style.position = "fixed";
    host.style.left = "-99999px";
    host.style.top = "0";
    host.style.width = `${width}px`;
    host.style.height = `${height}px`;
    host.style.pointerEvents = "none";
    host.style.opacity = "0";
    host.style.overflow = "hidden";
    document.body.appendChild(host);
    return host;
  }

  async function createExportPlayerForCard(card, mount) {
    const runtimeCandidates = Array.isArray(card.group.runtimeCandidates) && card.group.runtimeCandidates.length
      ? card.group.runtimeCandidates
      : defaultRuntimeOrder;

    let lastError = null;
    for (const candidate of runtimeCandidates) {
      const runtime = runtimeRegistry[candidate];
      if (!runtime || typeof runtime.SpinePlayer !== "function") {
        continue;
      }

      try {
        return await createPlayer(runtime, candidate, mount, card.group, {
          showLoading: false,
          preserveDrawingBuffer: true
        });
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("没有可用运行时。");
  }

  function setAnimationOnPlayer(player, animation, animationIndex) {
    if (!player || !animation) {
      return;
    }

    applyAnimationToPlayer(player, animation, true);

    if (typeof animationIndex === "number") {
      player.animationIndex = animationIndex;
    }
  }

  function getAnimationPlaybackName(animation) {
    if (!animation) {
      return "";
    }

    if (typeof animation === "string") {
      return animation;
    }

    if (typeof animation.name === "string" && animation.name) {
      return animation.name;
    }

    return "";
  }

  function setAnimationViaState(player, animationName, loop, options) {
    const animationState = player && player.animationState;
    if (!animationState || typeof animationState.setAnimation !== "function" || !animationName) {
      return false;
    }

    animationState.setAnimation(0, animationName, loop !== false);

    if (!(options && options.skipPlay) && typeof player.play === "function") {
      player.play();
    }

    return true;
  }

  function getPlayerRuntime(player) {
    return player && player.__spineRuntime ? player.__spineRuntime : null;
  }

  function getPlayerRuntimeKey(player) {
    return player && player.__spineRuntimeKey ? player.__spineRuntimeKey : "";
  }

  function hasFiniteBounds(bounds) {
    return Boolean(bounds)
      && Number.isFinite(bounds.x)
      && Number.isFinite(bounds.y)
      && Number.isFinite(bounds.width)
      && Number.isFinite(bounds.height)
      && bounds.width > 0
      && bounds.height > 0;
  }

  function readPlayerBounds(player) {
    const runtime = getPlayerRuntime(player);
    const skeleton = player && player.skeleton;
    if (!runtime || !runtime.Vector2 || !skeleton || typeof skeleton.getBounds !== "function") {
      return null;
    }

    const offset = new runtime.Vector2();
    const size = new runtime.Vector2();
    const physicsMode = runtime.Physics && typeof runtime.Physics.update === "number"
      ? runtime.Physics.update
      : undefined;

    try {
      if (typeof skeleton.updateWorldTransform === "function") {
        skeleton.updateWorldTransform(physicsMode);
      }
      skeleton.getBounds(offset, size, []);
    } catch (_error) {
      return null;
    }

    const bounds = {
      x: Number(offset.x),
      y: Number(offset.y),
      width: Number(size.x),
      height: Number(size.y)
    };

    return hasFiniteBounds(bounds) ? bounds : null;
  }

  function restoreSetupPose(player) {
    if (!player || !player.skeleton) {
      return false;
    }

    try {
      if (player.animationState && typeof player.animationState.clearTracks === "function") {
        player.animationState.clearTracks();
      }

      if (typeof player.skeleton.setToSetupPose === "function") {
        player.skeleton.setToSetupPose();
      } else if (typeof player.skeleton.setSlotsToSetupPose === "function") {
        player.skeleton.setSlotsToSetupPose();
      }

      const runtime = getPlayerRuntime(player);
      const physicsMode = runtime && runtime.Physics && typeof runtime.Physics.update === "number"
        ? runtime.Physics.update
        : undefined;

      if (typeof player.skeleton.updateWorldTransform === "function") {
        player.skeleton.updateWorldTransform(physicsMode);
      }

      if (typeof player.pause === "function") {
        player.pause();
      }

      clearPlayerErrorState(player);
      if (typeof player.drawFrame === "function") {
        window.requestAnimationFrame(() => {
          try {
            player.drawFrame(false);
          } catch (_drawError) {
          }
        });
      }

      return true;
    } catch (_error) {
      return false;
    }
  }

  function isAnimationPreviewSafe(player, animationName) {
    if (!player || !animationName) {
      return false;
    }

    const setupBounds = readPlayerBounds(player);
    if (!setAnimationViaState(player, animationName, true, { skipPlay: true })) {
      return false;
    }

    try {
      if (player.animationState && typeof player.animationState.update === "function") {
        player.animationState.update(0.1);
      }
      if (player.animationState && typeof player.animationState.apply === "function") {
        player.animationState.apply(player.skeleton);
      }

      const animatedBounds = readPlayerBounds(player);
      if (!hasFiniteBounds(animatedBounds)) {
        return false;
      }

      if (!hasFiniteBounds(setupBounds)) {
        return true;
      }

      const setupArea = setupBounds.width * setupBounds.height;
      const animatedArea = animatedBounds.width * animatedBounds.height;
      if (setupArea <= 0 || animatedArea <= 0) {
        return false;
      }

      return animatedArea >= setupArea * 0.2;
    } catch (_error) {
      return false;
    }
  }

  function applyPreviewAnimation(player, animation) {
    const animationName = getAnimationPlaybackName(animation) || getCurrentAnimationName(player);
    if (!animationName) {
      return false;
    }

    if (getPlayerRuntimeKey(player) === "3.8") {
      return applyAnimationToPlayer(player, animation, true);
    }

    const safeToPlay = isAnimationPreviewSafe(player, animationName);
    if (!safeToPlay) {
      restoreSetupPose(player);
      return false;
    }

    const restored = setAnimationViaState(player, animationName, true);
    if (!restored) {
      return false;
    }

    clearPlayerErrorState(player);
    if (typeof player.drawFrame === "function") {
      window.requestAnimationFrame(() => {
        try {
          player.drawFrame(false);
        } catch (_drawError) {
        }
      });
    }

    return true;
  }

  function refreshPlayerAfterPoseChange(player, animation) {
    return applyPreviewAnimation(player, animation);
  }

  function shouldUseAnimationStateFallback(error) {
    const message = getErrorMessage(error).toLowerCase();
    return message.includes("animation bounds are invalid")
      || message.includes("bounds are invalid");
  }

  function clearPlayerErrorState(player) {
    if (!player) {
      return;
    }

    try {
      player.error = false;
    } catch (_error) {
    }

    const host = player.dom || player.parent || null;
    if (!host || !host.querySelectorAll) {
      return;
    }

    host.querySelectorAll(".spine-player-error").forEach((node) => {
      if (node && node.parentNode) {
        node.parentNode.removeChild(node);
      }
    });
  }

  function buildGroupViewport(group) {
    const viewportWidth = Number(group && group.viewportWidth || 0);
    const viewportHeight = Number(group && group.viewportHeight || 0);
    const width = Math.max(1, Math.round(viewportWidth || Number(group && group.renderWidth || 0)));
    const height = Math.max(1, Math.round(viewportHeight || Number(group && group.renderHeight || 0)));
    const x = Number(group && group.viewportX);
    const y = Number(group && group.viewportY);

    if (!Boolean(group && group.hasViewportOrigin) || !Number.isFinite(x) || !Number.isFinite(y) || !width || !height) {
      return null;
    }

    return {
      x,
      y,
      width,
      height,
      padLeft: "2%",
      padRight: "2%",
      padTop: "2%",
      padBottom: "2%",
      transitionTime: 0,
      debugRender: false,
      animations: {}
    };
  }

  function applyAnimationToPlayer(player, animation, loop) {
    const animationName = getAnimationPlaybackName(animation);
    if (!player || !animationName) {
      return false;
    }

    if (getPlayerRuntimeKey(player) === "3.8") {
      player.setAnimation(animationName);
      if (typeof player.play === "function") {
        player.play();
      }
      return true;
    }

    try {
      player.setAnimation(animationName, loop !== false);
      if (typeof player.play === "function") {
        player.play();
      }
      return true;
    } catch (error) {
      if (shouldUseAnimationStateFallback(error) && setAnimationViaState(player, animationName, loop)) {
        clearPlayerErrorState(player);
        if (typeof player.drawFrame === "function") {
          window.requestAnimationFrame(() => {
            try {
              player.drawFrame(false);
            } catch (_drawError) {
            }
          });
        }
        console.warn(`[spine_gif_test] animation viewport fallback: ${animationName}`);
        return true;
      }
      throw error;
    }
  }

  function disposeStandalonePlayer(player, mount) {
    if (player) {
      try {
        releaseCanvasContext(mount);
        player.dispose();
      } catch (_error) {
      }
    }

    if (mount && mount.parentNode) {
      mount.parentNode.removeChild(mount);
    }
  }

  function buildLocalSelectionDisplay(files, sourceLabel) {
    if (sourceLabel === "文件夹") {
      const rootNames = Array.from(new Set(
        files
          .map((file, index) => getLocalRelativePath(file, index).split("/")[0] || "")
          .filter(Boolean)
      ));

      if (rootNames.length === 1) {
        return `本地文件夹: ${rootNames[0]}/`;
      }

      if (rootNames.length > 1) {
        return `本地文件夹: ${rootNames[0]}/ 等 ${rootNames.length} 个目录`;
      }

      return `本地文件夹: 已选择 ${files.length} 个文件`;
    }

    if (files.length === 1) {
      return `本地文件: ${getLocalRelativePath(files[0], 0)}`;
    }

    return `本地文件: ${getLocalRelativePath(files[0], 0)} 等 ${files.length} 个文件`;
  }

  function applySessionPayload(payload, successPrefix) {
    state.sessionId = String(payload.sessionId || "");
    state.sessionArchiveBaseName = parseArchiveBaseName(payload.archiveName);
    const groups = Array.isArray(payload.groups) ? payload.groups : [];
    const skippedCount = Number(payload.skippedCount || 0);

    if (!groups.length) {
      showEmptyState("没有找到可直接预览的 Spine 资源。");
      setStatus(
        skippedCount
          ? `没有可预览的资源，已跳过 ${skippedCount} 项不完整数据。`
          : "没有找到可直接预览的 Spine 资源。",
        "error"
      );
      updateBadges();
      return;
    }

    renderCards(groups);
    hideEmptyState();
    updateBadges();
    setStatus(
      `${successPrefix}，共找到 ${groups.length} 个 Spine${skippedCount ? `，跳过 ${skippedCount} 个不完整资源。` : "。"}`,
      "success"
    );
    queueInitialCards();
  }

  async function handleDownloadClick() {
    const selectedCards = Array.from(state.cards.values()).filter((card) => card.checkbox.checked);
    const selectedGroupIds = selectedCards.map((card) => card.group.id);
    const groupRenames = {};

    selectedCards.forEach((card) => {
      const customName = sanitizeFileNameSegment(card && card.group ? card.group.customFileName : "");
      if (!customName) {
        return;
      }

      if (customName !== String(card.group.fileName || "")) {
        groupRenames[card.group.id] = customName;
      }
    });

    if (!state.sessionId) {
      setStatus("当前没有可下载的提取会话。", "error");
      return;
    }

    if (!selectedGroupIds.length) {
      setStatus("请先勾选要下载的 Spine。", "error");
      return;
    }

    dom.downloadButton.disabled = true;
    setStatus(`正在打包 ${selectedGroupIds.length} 个已勾选 Spine...`, "loading");

    try {
      const response = await fetch("/api/download", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          sessionId: state.sessionId,
          groupIds: selectedGroupIds,
          groupRenames
        })
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `打包失败 (${response.status})`);
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = parseFileNameFromDisposition(response.headers.get("Content-Disposition")) || "selected_spine.zip";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      setStatus(`下载已开始，共打包 ${selectedGroupIds.length} 个 Spine。`, "success");
    } catch (error) {
      console.error(error);
      setStatus("下载失败: " + getErrorMessage(error), "error");
    } finally {
      updateBadges();
    }
  }

  function renderCards(groups) {
    groups.forEach((group, index) => {
      const card = createCard(group);
      card.orderIndex = index;
      state.cards.set(group.id, card);
      dom.gridContainer.appendChild(card.root);
    });
  }

  function queueInitialCards() {
    const initialCards = Array.from(state.cards.values()).slice(0, INITIAL_LOAD_COUNT);
    const now = Date.now();

    initialCards.forEach((card, index) => {
      card.isVisible = true;
      card.lastVisibleAt = now + index;
      requestCardLoad(card, "initial", now + index);
    });

    processLoadQueue();
  }

  function requestCardLoad(card, reason, timestamp) {
    const effectiveTime = typeof timestamp === "number" ? timestamp : Date.now();
    card.shouldBeLoaded = true;
    card.lastRequestedAt = effectiveTime;

    if (reason === "hover") {
      card.lastHoverAt = effectiveTime;
    }

    enqueueCardLoad(card);
  }

  function createCard(group) {
    const root = document.createElement("article");
    root.className = "spine-card";
    root.dataset.groupId = group.id;

    const toolbar = document.createElement("div");
    toolbar.className = "spine-toolbar";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "download-check";
    checkbox.title = "勾选后加入下载包";
    checkbox.addEventListener("change", updateBadges);

    const name = document.createElement("div");
    name.className = "spine-name";
    name.textContent = buildCardNameLabel(group);

    const renameInput = document.createElement("input");
    renameInput.type = "text";
    renameInput.className = "mini-select spine-name-input";
    renameInput.hidden = true;
    renameInput.maxLength = 180;
    renameInput.title = "输入后按 Enter 保存，Esc 取消";

    const frameScrubberWrap = document.createElement("label");
    frameScrubberWrap.className = "frame-scrubber";
    frameScrubberWrap.hidden = true;
    frameScrubberWrap.title = "拖动以定位当前动画帧";

    const frameScrubber = document.createElement("input");
    frameScrubber.type = "range";
    frameScrubber.min = "0";
    frameScrubber.max = "1000";
    frameScrubber.step = "1";
    frameScrubber.value = "0";
    frameScrubber.className = "frame-scrubber__input";

    const frameScrubberValue = document.createElement("span");
    frameScrubberValue.className = "frame-scrubber__value";
    frameScrubberValue.textContent = "0%";

    const frameScrubberPlayButton = document.createElement("button");
    frameScrubberPlayButton.type = "button";
    const frameScrubberPauseButton = document.createElement("button");
    frameScrubberPauseButton.type = "button";
    const frameStepPrevButton = document.createElement("button");
    frameStepPrevButton.type = "button";
    frameStepPrevButton.className = "frame-scrubber__play-button frame-scrubber__step-button";
    frameStepPrevButton.textContent = "<";
    frameStepPrevButton.title = "上一帧";
    const frameStepNextButton = document.createElement("button");
    frameStepNextButton.type = "button";
    frameStepNextButton.className = "frame-scrubber__play-button frame-scrubber__step-button";
    frameStepNextButton.textContent = ">";
    frameStepNextButton.title = "下一帧";
    frameScrubberPauseButton.className = "frame-scrubber__play-button frame-scrubber__pause-button";
    frameScrubberPauseButton.textContent = "暂停";
    frameScrubberPauseButton.title = "暂停当前动画播放";
    frameScrubberPlayButton.className = "frame-scrubber__play-button";
    frameScrubberPlayButton.textContent = "播放";
    frameScrubberPlayButton.title = "恢复自动播放";

    frameScrubberWrap.appendChild(frameScrubber);
    frameScrubberWrap.appendChild(frameScrubberValue);
    frameScrubberWrap.appendChild(frameScrubberPlayButton);
    frameScrubberWrap.appendChild(frameScrubberPauseButton);
    frameScrubberWrap.appendChild(frameStepPrevButton);
    frameScrubberWrap.appendChild(frameStepNextButton);

    const animationSelect = document.createElement("select");
    animationSelect.className = "mini-select animation-select";
    animationSelect.title = "切换动画";
    animationSelect.hidden = true;

    const exportImageButton = document.createElement("button");
    exportImageButton.type = "button";
    exportImageButton.className = "icon-button export-image-button";
    exportImageButton.textContent = "导出图片";
    exportImageButton.title = "导出当前进度对应画面";
    exportImageButton.hidden = true;
    exportImageButton.addEventListener("click", () => {
      handleExportImageClick(card);
    });

    const exportGifButton = document.createElement("button");
    exportGifButton.type = "button";
    exportGifButton.className = "icon-button export-gif-button";
    exportGifButton.textContent = "导出GIF";
    exportGifButton.title = "导出当前动画为 GIF";
    exportGifButton.hidden = true;
    exportGifButton.addEventListener("click", () => {
      handleExportGifClick(card);
    });

    const exportProgress = document.createElement("div");
    exportProgress.className = "toolbar-export-progress";
    exportProgress.hidden = true;

    const exportProgressTrack = document.createElement("div");
    exportProgressTrack.className = "mini-progress-track toolbar-export-progress__track";

    const exportProgressFill = document.createElement("div");
    exportProgressFill.className = "mini-progress-fill";
    exportProgressTrack.appendChild(exportProgressFill);

    const exportProgressValue = document.createElement("span");
    exportProgressValue.className = "toolbar-export-progress__value";
    exportProgressValue.textContent = "0%";

    exportProgress.appendChild(exportProgressTrack);
    exportProgress.appendChild(exportProgressValue);

    const skinSelect = document.createElement("select");
    skinSelect.className = "mini-select skin-select";
    skinSelect.title = "切换皮肤";
    skinSelect.hidden = true;

    const fullscreenButton = document.createElement("button");
    fullscreenButton.type = "button";
    fullscreenButton.className = "icon-button";
    fullscreenButton.textContent = "全屏";
    fullscreenButton.title = "全屏查看";
    fullscreenButton.addEventListener("click", () => {
      card.isVisible = true;
      requestCardLoad(card, "modal");
      togglePreviewModal(card);
    });

    const preview = document.createElement("div");
    preview.className = "spine-preview";

    const mount = document.createElement("div");
    mount.className = "player-mount";

    const overlay = document.createElement("div");
    overlay.className = "card-overlay";
    overlay.textContent = IDLE_CARD_MESSAGE;

    const debugPanel = document.createElement("div");
    debugPanel.className = "fullscreen-debug-controls";
    debugPanel.hidden = true;

    const speedLabel = document.createElement("label");
    speedLabel.className = "fullscreen-debug-controls__item";
    speedLabel.textContent = "";
    speedLabel.textContent = "速度";
    const speedPresets = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
    const speedList = document.createElement("div");
    speedList.className = "fullscreen-speed-list";
    const speedButtons = speedPresets.map((value) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "fullscreen-speed-option";
      button.textContent = `${value}x`;
      button.dataset.speed = String(value);
      speedList.appendChild(button);
      return button;
    });
    speedLabel.appendChild(speedList);

    const trailLabel = document.createElement("label");
    trailLabel.className = "fullscreen-debug-controls__item fullscreen-debug-controls__toggle";
    const trailToggle = document.createElement("input");
    trailToggle.type = "checkbox";
    trailLabel.appendChild(trailToggle);
    trailLabel.appendChild(document.createTextNode("轨迹"));

    const bonesLabel = document.createElement("label");
    bonesLabel.className = "fullscreen-debug-controls__item fullscreen-debug-controls__toggle";
    const bonesToggle = document.createElement("input");
    bonesToggle.type = "checkbox";
    bonesLabel.appendChild(bonesToggle);
    bonesLabel.appendChild(document.createTextNode("骨骼"));

    const pathsLabel = document.createElement("label");
    pathsLabel.className = "fullscreen-debug-controls__item fullscreen-debug-controls__toggle";
    const pathsToggle = document.createElement("input");
    pathsToggle.type = "checkbox";
    pathsLabel.appendChild(pathsToggle);
    pathsLabel.appendChild(document.createTextNode("路径"));

    const meshesLabel = document.createElement("label");
    meshesLabel.className = "fullscreen-debug-controls__item fullscreen-debug-controls__toggle";
    const meshesToggle = document.createElement("input");
    meshesToggle.type = "checkbox";
    meshesLabel.appendChild(meshesToggle);

    const meshHullLabel = document.createElement("label");
    meshHullLabel.className = "fullscreen-debug-controls__item fullscreen-debug-controls__toggle";
    const meshHullToggle = document.createElement("input");
    meshHullToggle.type = "checkbox";
    meshHullLabel.appendChild(meshHullToggle);

    const meshTrianglesLabel = document.createElement("label");
    meshTrianglesLabel.className = "fullscreen-debug-controls__item fullscreen-debug-controls__toggle";
    const meshTrianglesToggle = document.createElement("input");
    meshTrianglesToggle.type = "checkbox";
    meshTrianglesLabel.appendChild(meshTrianglesToggle);

    const boundingBoxesLabel = document.createElement("label");
    boundingBoxesLabel.className = "fullscreen-debug-controls__item fullscreen-debug-controls__toggle";
    const boundingBoxesToggle = document.createElement("input");
    boundingBoxesToggle.type = "checkbox";
    boundingBoxesLabel.appendChild(boundingBoxesToggle);

    const clippingLabel = document.createElement("label");
    clippingLabel.className = "fullscreen-debug-controls__item fullscreen-debug-controls__toggle";
    const clippingToggle = document.createElement("input");
    clippingToggle.type = "checkbox";
    clippingLabel.appendChild(clippingToggle);
    const normalizeToggleLabelAscii = (label, icon, title) => {
      while (label.childNodes.length > 1) {
        label.removeChild(label.lastChild);
      }
      label.appendChild(document.createTextNode(icon));
      label.title = title;
    };
    normalizeToggleLabelAscii(trailLabel, String.fromCodePoint(0x223F), "运动轨迹");
    normalizeToggleLabelAscii(bonesLabel, String.fromCodePoint(0x1F9B4), "骨骼");
    normalizeToggleLabelAscii(pathsLabel, String.fromCodePoint(0x1F9ED), "路径");
    normalizeToggleLabelAscii(meshesLabel, String.fromCodePoint(0x25A6), "网格");
    const normalizeToggleLabel = (label, icon, title) => {
      while (label.childNodes.length > 1) {
        label.removeChild(label.lastChild);
      }
      label.appendChild(document.createTextNode(icon));
      label.title = title;
    };
    normalizeToggleLabel(trailLabel, "〰", "运动轨迹");
    normalizeToggleLabel(bonesLabel, "🦴", "骨骼");
    normalizeToggleLabel(pathsLabel, "🧭", "路径");
    normalizeToggleLabel(meshesLabel, "▦", "网格");

    normalizeToggleLabel(meshHullLabel, "⬠", "网格外框");
    normalizeToggleLabel(meshTrianglesLabel, "△", "网格三角");
    normalizeToggleLabel(boundingBoxesLabel, "⬚", "边界框");
    normalizeToggleLabel(clippingLabel, "✂", "裁剪");

    const speedMenu = document.createElement("div");
    speedMenu.className = "fullscreen-debug-menu";
    const speedMenuButton = document.createElement("button");
    speedMenuButton.type = "button";
    speedMenuButton.className = "fullscreen-debug-mini-button";
    speedMenuButton.textContent = "⚡";
    speedMenuButton.title = "设置播放速度";
    const speedMenuPopup = document.createElement("div");
    speedMenuPopup.className = "fullscreen-debug-popup fullscreen-debug-popup--speed";
    speedMenuPopup.hidden = true;
    speedMenuPopup.appendChild(speedLabel);
    speedMenu.appendChild(speedMenuButton);
    speedMenu.appendChild(speedMenuPopup);
    speedMenuButton.textContent = String.fromCodePoint(0x26A1);
    speedMenuButton.title = "速度";

    const debugMenu = document.createElement("div");
    debugMenu.className = "fullscreen-debug-menu";
    const debugMenuButton = document.createElement("button");
    debugMenuButton.type = "button";
    debugMenuButton.className = "fullscreen-debug-mini-button";
    debugMenuButton.textContent = "🛠";
    debugMenuButton.title = "调试开关";
    const debugMenuPopup = document.createElement("div");
    debugMenuPopup.className = "fullscreen-debug-popup fullscreen-debug-popup--debug";
    debugMenuPopup.hidden = true;
    debugMenuPopup.appendChild(trailLabel);
    debugMenuPopup.appendChild(bonesLabel);
    debugMenuPopup.appendChild(pathsLabel);
    debugMenuPopup.appendChild(meshesLabel);
    debugMenuPopup.appendChild(meshHullLabel);
    debugMenuPopup.appendChild(meshTrianglesLabel);
    debugMenuPopup.appendChild(boundingBoxesLabel);
    debugMenuPopup.appendChild(clippingLabel);
    debugMenuButton.textContent = String.fromCodePoint(0x1F6E0);
    debugMenuButton.title = "Debug";
    speedMenuButton.textContent = "⚡";
    speedMenuButton.title = "设置播放速度";
    debugMenuButton.textContent = "🛠";
    debugMenuButton.title = "调试开关";
    debugMenu.appendChild(debugMenuButton);
    debugMenu.appendChild(debugMenuPopup);

    debugPanel.appendChild(speedMenu);
    debugPanel.appendChild(debugMenu);

    const debugTrailCanvas = document.createElement("canvas");
    debugTrailCanvas.className = "fullscreen-debug-trail";
    debugTrailCanvas.hidden = true;

    preview.appendChild(mount);
    preview.appendChild(overlay);
    preview.appendChild(debugTrailCanvas);
    preview.appendChild(debugPanel);
    toolbar.appendChild(checkbox);
    toolbar.appendChild(name);
    toolbar.appendChild(renameInput);
    toolbar.appendChild(frameScrubberWrap);
    toolbar.appendChild(animationSelect);
    toolbar.appendChild(exportImageButton);
    toolbar.appendChild(exportGifButton);
    toolbar.appendChild(exportProgress);
    toolbar.appendChild(skinSelect);
    toolbar.appendChild(fullscreenButton);

    root.appendChild(toolbar);
    root.appendChild(preview);

    root.addEventListener("pointerenter", () => {
      card.isHovered = true;
    });

    root.addEventListener("pointermove", () => {
      card.isHovered = true;
      card.isVisible = true;
      card.lastHoverAt = Date.now();
      card.lastVisibleAt = card.lastHoverAt;
      requestCardLoad(card, "hover", card.lastHoverAt);
      processLoadQueue();
    });

    root.addEventListener("pointerleave", () => {
      card.isHovered = false;
    });

    const card = {
      root,
      group,
      name,
      renameInput,
      frameScrubberWrap,
      frameScrubber,
      frameScrubberValue,
      frameScrubberPlayButton,
      frameScrubberPauseButton,
      frameStepPrevButton,
      frameStepNextButton,
      checkbox,
      animationSelect,
      exportImageButton,
      exportGifButton,
      exportProgress,
      exportProgressFill,
      exportProgressValue,
      skinSelect,
      fullscreenButton,
      mount,
      overlay,
      debugPanel,
      speedMenuButton,
      speedMenuPopup,
      debugMenuButton,
      debugMenuPopup,
      trailToggle,
      bonesToggle,
      pathsToggle,
      meshesToggle,
      meshHullToggle,
      meshTrianglesToggle,
      boundingBoxesToggle,
      clippingToggle,
      debugTrailCanvas,
      player: null,
      loadedWithNativeControls: false,
      animations: [],
      skins: [],
      isVisible: false,
      shouldBeLoaded: false,
      queued: false,
      loading: false,
      unloadTimer: 0,
      selectedAnimationIndex: 0,
      selectedSkinName: group.preferredSkinName || "",
      lastVisibleAt: 0,
      isHovered: false,
      lastHoverAt: 0,
      lastRequestedAt: 0,
      lastLoadedAt: 0,
      isExportingImage: false,
      isExportingGif: false,
      exportProgressAmount: 0,
      isModalOpen: false,
      placeholder: null,
      originalParent: null,
      originalNextSibling: null,
      isRenaming: false,
      isScrubbing: false,
      isManualFrameControl: false,
      playbackSpeed: 1,
      debugTrailEnabled: false,
      debugBonesEnabled: false,
      debugPathsEnabled: false,
      debugMeshesEnabled: false,
      debugMeshHullEnabled: false,
      debugMeshTrianglesEnabled: false,
      debugBoundingBoxesEnabled: false,
      debugClippingEnabled: false,
      debugTrailPoints: []
    };
    const syncSpeedButtonUi = (options) => {
      const shouldClosePopup = Boolean(options && options.closePopup);
      speedMenuButton.textContent = String.fromCodePoint(0x26A1);
      speedMenuButton.title = `Speed ${card.playbackSpeed}x`;
      speedButtons.forEach((button) => {
        const value = Number(button.dataset.speed);
        const isActive = Math.abs(value - card.playbackSpeed) < 0.0001;
        button.classList.toggle("is-active", isActive);
      });
      if (shouldClosePopup && card.speedMenuPopup) {
        card.speedMenuPopup.hidden = true;
      }
    };

    name.addEventListener("dblclick", () => {
      beginCardRename(card);
    });
    renameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitCardRename(card);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        cancelCardRename(card);
      }
    });
    renameInput.addEventListener("blur", () => {
      if (!card.isRenaming) {
        return;
      }
      commitCardRename(card, { keepEditingOnEmpty: false });
    });
    frameScrubber.addEventListener("pointerdown", () => {
      enableManualFrameControl(card);
      card.isScrubbing = true;
    });
    frameScrubber.addEventListener("pointerup", () => {
      card.isScrubbing = false;
      refreshCardFrameScrubber(card);
    });
    frameScrubber.addEventListener("pointercancel", () => {
      card.isScrubbing = false;
      refreshCardFrameScrubber(card);
    });
    frameScrubber.addEventListener("change", () => {
      card.isScrubbing = false;
      refreshCardFrameScrubber(card);
    });
    frameScrubber.addEventListener("input", () => {
      enableManualFrameControl(card);
      const progress = Number(frameScrubber.value || 0) / 1000;
      if (!seekCardToProgress(card, progress)) {
        setCardFrameScrubberValue(card, progress);
      }
    });
    frameScrubberPlayButton.addEventListener("click", () => {
      resumeAutomaticFrameControl(card);
      refreshCardFrameScrubber(card);
    });
    frameScrubberPauseButton.addEventListener("click", () => {
      enableManualFrameControl(card);
      refreshCardFrameScrubber(card);
    });
    frameStepPrevButton.addEventListener("click", () => {
      stepCardBySingleFrame(card, -1);
    });
    frameStepNextButton.addEventListener("click", () => {
      stepCardBySingleFrame(card, 1);
    });
    speedMenuButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      speedMenuPopup.hidden = false;
      debugMenuPopup.hidden = true;
    });
    debugMenuButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const nextHidden = !debugMenuPopup.hidden;
      debugMenuPopup.hidden = nextHidden;
      speedMenuPopup.hidden = true;
    });
    speedButtons.forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const speed = Number(button.dataset.speed);
        card.playbackSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
        applyCardPlaybackSpeed(card);
        syncSpeedButtonUi({ closePopup: true });
      });
    });
    trailToggle.addEventListener("change", () => {
      card.debugTrailEnabled = Boolean(trailToggle.checked);
      if (!card.debugTrailEnabled) {
        card.debugTrailPoints = [];
      }
      drawCardDebugTrail(card);
    });
    bonesToggle.addEventListener("change", () => {
      card.debugBonesEnabled = Boolean(bonesToggle.checked);
      applyCardDebugRender(card);
    });
    pathsToggle.addEventListener("change", () => {
      card.debugPathsEnabled = Boolean(pathsToggle.checked);
      applyCardDebugRender(card);
    });
    meshesToggle.addEventListener("change", () => {
      card.debugMeshesEnabled = Boolean(meshesToggle.checked);
      applyCardDebugRender(card);
    });
    meshHullToggle.addEventListener("change", () => {
      card.debugMeshHullEnabled = Boolean(meshHullToggle.checked);
      applyCardDebugRender(card);
    });
    meshTrianglesToggle.addEventListener("change", () => {
      card.debugMeshTrianglesEnabled = Boolean(meshTrianglesToggle.checked);
      applyCardDebugRender(card);
    });
    boundingBoxesToggle.addEventListener("change", () => {
      card.debugBoundingBoxesEnabled = Boolean(boundingBoxesToggle.checked);
      applyCardDebugRender(card);
    });
    clippingToggle.addEventListener("change", () => {
      card.debugClippingEnabled = Boolean(clippingToggle.checked);
      applyCardDebugRender(card);
    });
    syncSpeedButtonUi({ closePopup: true });
    updateCardNameDisplay(card);
    refreshCardFrameScrubber(card);

    return card;
  }

  function syncFullscreenButtons() {
    for (const card of state.cards.values()) {
      const isActiveModal = card.isModalOpen;
      const otherExportActive = Boolean(findActiveGifExport(card));
      card.fullscreenButton.textContent = isActiveModal ? "退出全屏" : "全屏";
      card.fullscreenButton.title = isActiveModal ? "退出浮窗预览" : "打开浮窗预览";
      if (card.debugPanel) {
        card.debugPanel.hidden = true;
      }
      card.exportImageButton.hidden = !isActiveModal;
      card.exportGifButton.hidden = !isActiveModal;
      card.exportProgress.hidden = !isActiveModal || !card.isExportingGif;
      updateCardExportProgress(card, card.exportProgressAmount || 0);
      if (!isActiveModal && card.frameScrubberWrap) {
        card.frameScrubberWrap.hidden = true;
        if (card.frameScrubber) {
          card.frameScrubber.disabled = true;
        }
      }
      card.exportImageButton.disabled = !isActiveModal || card.isExportingGif || card.isExportingImage || !card.player;
      card.exportGifButton.disabled = !isActiveModal || card.isExportingGif || card.isExportingImage || !card.animations.length || otherExportActive;
      refreshCardFrameScrubber(card);
      card.exportImageButton.textContent = card.isExportingImage ? "导出中..." : "导出图片";
      card.exportImageButton.title = card.isExportingImage
        ? "正在导出当前帧图片"
        : "导出当前进度对应画面";
      card.exportGifButton.textContent = card.isExportingGif ? "导出中..." : "导出GIF";
      card.exportGifButton.title = card.isExportingGif
        ? "正在导出 GIF"
        : (otherExportActive ? "已有其他 GIF 导出任务正在进行" : "导出当前动画为 GIF");
    }
  }

  function reloadCardPlayerForNativeControls(card) {
    if (!card) {
      return;
    }
    const expectedShowControls = Boolean(card.isModalOpen);
    if (card.player && card.loadedWithNativeControls === expectedShowControls) {
      return;
    }
    if (card.player) {
      disposeCardPlayer(card, "");
    }
    if (card.shouldBeLoaded) {
      enqueueCardLoad(card);
      processLoadQueue();
    }
  }

  function togglePreviewModal(card) {
    if (card.isModalOpen) {
      closePreviewModal();
    } else {
      openPreviewModal(card);
    }
  }

  function openPreviewModal(card) {
    if (!card) {
      return;
    }

    if (state.activeModalCardId && state.activeModalCardId !== card.group.id) {
      closePreviewModal();
    }

    if (card.isModalOpen) {
      return;
    }

    const placeholder = document.createElement("div");
    placeholder.className = "spine-card-placeholder";
    placeholder.style.height = `${card.root.offsetHeight}px`;

    card.originalParent = card.root.parentNode;
    card.originalNextSibling = card.root.nextSibling;
    card.placeholder = placeholder;
    card.isModalOpen = true;
    card.isVisible = true;
    card.lastVisibleAt = Date.now();
    state.activeModalCardId = card.group.id;

    if (card.originalParent) {
      card.originalParent.insertBefore(placeholder, card.root);
    }

    card.root.classList.add("is-modal-card");
    dom.previewModalSlot.appendChild(card.root);
    dom.previewModal.classList.add("is-active");
    dom.previewModal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    enqueueCardLoad(card);
    reloadCardPlayerForNativeControls(card);
    syncFullscreenButtons();
    processLoadQueue();
  }

  function closePreviewModal() {
    if (!state.activeModalCardId) {
      return;
    }

    const card = state.cards.get(state.activeModalCardId);
    state.activeModalCardId = "";

    if (!card) {
      dom.previewModal.classList.remove("is-active");
      dom.previewModal.setAttribute("aria-hidden", "true");
      document.body.style.overflow = "";
      syncFullscreenButtons();
      return;
    }

    card.isModalOpen = false;
    card.root.classList.remove("is-modal-card");

    if (card.originalParent) {
      if (card.originalNextSibling && card.originalNextSibling.parentNode === card.originalParent) {
        card.originalParent.insertBefore(card.root, card.originalNextSibling);
      } else if (card.placeholder && card.placeholder.parentNode === card.originalParent) {
        card.originalParent.insertBefore(card.root, card.placeholder);
      } else {
        card.originalParent.appendChild(card.root);
      }
    }

    if (card.placeholder && card.placeholder.parentNode) {
      card.placeholder.parentNode.removeChild(card.placeholder);
    }

    card.placeholder = null;
    card.originalParent = null;
    card.originalNextSibling = null;

    dom.previewModal.classList.remove("is-active");
    dom.previewModal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    card.isVisible = false;
    card.debugTrailPoints = [];
    if (card.debugTrailCanvas) {
      card.debugTrailCanvas.hidden = true;
    }
    reloadCardPlayerForNativeControls(card);
    refreshCardFrameScrubber(card);
    syncFullscreenButtons();
  }

  function enqueueCardLoad(card) {
    if (!card || card.player || card.loading || card.queued || !card.shouldBeLoaded) {
      return;
    }

    card.queued = true;
    state.loadQueue.push(card);
    processLoadQueue();
  }

  function takeNextLoadCandidate() {
    if (!state.loadQueue.length) {
      return null;
    }

    let bestIndex = -1;
    let bestPriority = null;

    for (let index = 0; index < state.loadQueue.length; index += 1) {
      const card = state.loadQueue[index];
      if (!card.shouldBeLoaded || card.player || card.loading) {
        continue;
      }

      const priority = getLoadPriority(card);
      if (!bestPriority || compareLoadPriority(priority, bestPriority) < 0) {
        bestPriority = priority;
        bestIndex = index;
      }
    }

    if (bestIndex < 0) {
      while (state.loadQueue.length) {
        const discarded = state.loadQueue.shift();
        discarded.queued = false;
      }
      return null;
    }

    const card = state.loadQueue.splice(bestIndex, 1)[0];
    card.queued = false;
    return card;
  }

  function processLoadQueue() {
    while (state.loadingCount < MAX_CONCURRENT_LOADS) {
      const card = takeNextLoadCandidate();
      if (!card) {
        return;
      }

      if (!ensureLoadCapacity(card)) {
        card.queued = true;
        state.loadQueue.unshift(card);
        return;
      }

      state.loadingCount += 1;
      card.loading = true;

      loadCardPlayer(card, state.renderToken)
        .catch((error) => {
          console.error(error);
          setCardOverlay(card, "加载失败。\n" + getErrorMessage(error), "error");
        })
        .finally(() => {
          card.loading = false;
          state.loadingCount -= 1;
          processLoadQueue();
        });
    }
  }

  function ensureLoadCapacity(incomingCard) {
    while (getActivePlayerCount() + state.loadingCount >= MAX_ACTIVE_PLAYERS) {
      const released = releaseOneFarCard(incomingCard);
      if (!released) {
        return false;
      }
    }
    return true;
  }

  function releaseOneFarCard(incomingCard) {
    const candidates = Array.from(state.cards.values())
      .filter((card) => card.player && !card.loading && card !== incomingCard && !card.isModalOpen);

    if (!candidates.length) {
      return false;
    }

    candidates.sort((left, right) => {
      const modalDelta = Number(left.isModalOpen) - Number(right.isModalOpen);
      if (modalDelta !== 0) {
        return modalDelta;
      }

      const hoverDelta = Number(left.isHovered) - Number(right.isHovered);
      if (hoverDelta !== 0) {
        return hoverDelta;
      }

      const requestDelta = (left.lastRequestedAt || 0) - (right.lastRequestedAt || 0);
      if (requestDelta !== 0) {
        return requestDelta;
      }

      const loadDelta = (left.lastLoadedAt || 0) - (right.lastLoadedAt || 0);
      if (loadDelta !== 0) {
        return loadDelta;
      }

      return (left.orderIndex || 0) - (right.orderIndex || 0);
    });

    const cardToRelease = candidates[0];
    if (!cardToRelease) {
      return false;
    }

    cardToRelease.shouldBeLoaded = false;
    disposeCardPlayer(cardToRelease, "");
    return true;
  }

  function getLoadPriority(card) {
    return {
      modalRank: card.isModalOpen ? 0 : 1,
      hoverRank: card.isHovered ? 0 : 1,
      requestRank: card.lastRequestedAt ? -card.lastRequestedAt : 0,
      orderRank: typeof card.orderIndex === "number" ? card.orderIndex : Number.MAX_SAFE_INTEGER
    };
  }

  function compareLoadPriority(left, right) {
    if (left.modalRank !== right.modalRank) {
      return left.modalRank - right.modalRank;
    }
    if (left.hoverRank !== right.hoverRank) {
      return left.hoverRank - right.hoverRank;
    }
    if (left.requestRank !== right.requestRank) {
      return left.requestRank - right.requestRank;
    }
    return left.orderRank - right.orderRank;
  }

  async function loadCardPlayer(card, renderToken) {
    setCardOverlay(card, `正在加载 ${card.group.fileName} ...`, "loading");
    const expectedShowControls = Boolean(card && card.isModalOpen);

    const runtimeCandidates = Array.isArray(card.group.runtimeCandidates) && card.group.runtimeCandidates.length
      ? card.group.runtimeCandidates
      : defaultRuntimeOrder;

    let player = null;
    let lastError = null;

    for (const candidate of runtimeCandidates) {
      if (renderToken !== state.renderToken) {
        return;
      }

      const runtime = runtimeRegistry[candidate];
      if (!runtime || typeof runtime.SpinePlayer !== "function") {
        continue;
      }

      try {
        player = await createPlayer(runtime, candidate, card.mount, card.group, {
          showControls: expectedShowControls
        });
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!player) {
      setCardOverlay(card, "加载失败。\n" + getErrorMessage(lastError || new Error("没有可用运行时。")), "error");
      return;
    }

    if (renderToken !== state.renderToken || !card.shouldBeLoaded) {
      try {
        player.dispose();
      } catch (_error) {
      }
      if (!card.shouldBeLoaded) {
        setCardOverlay(card, IDLE_CARD_MESSAGE, "idle");
      }
      return;
    }

    card.player = player;
    card.loadedWithNativeControls = expectedShowControls;
    card.lastLoadedAt = Date.now();
    attachCanvasRecovery(card, player, renderToken);
    hydrateCardControls(card);
    applyCardPlaybackSpeed(card);
    applyCardDebugRender(card);
    drawCardDebugTrail(card);
    setCardOverlay(card, "", "success", true);
  }

  function createPlayer(runtime, runtimeKey, mount, group, extraOptions) {
    return new Promise((resolve, reject) => {
      let player = null;
      let settled = false;
      let timeoutId = 0;

      function finishResolve(instance) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        resolve(instance);
      }

      function finishReject(error) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);

        if (player) {
          try {
            releaseCanvasContext(mount);
            player.dispose();
          } catch (_error) {
          }
        }

        if (mount) {
          mount.innerHTML = "";
        }

        reject(error instanceof Error ? error : new Error(String(error)));
      }

      try {
        if (mount) {
          mount.innerHTML = "";
        }

        const viewport = runtimeKey === "3.8" ? null : buildGroupViewport(group);
        const normalizedViewport = runtimeKey === "3.8"
          ? undefined
          : Object.assign({
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            padLeft: 0,
            padRight: 0,
            padTop: 0,
            padBottom: 0,
            debugRender: false
          }, viewport || {});
        const playerOptions = Object.assign({
          atlasUrl: group.atlasUrl,
          jsonUrl: group.jsonUrl,
          showControls: false,
          showLoading: true,
          backgroundColor: "09131b",
          fullScreenBackgroundColor: "050b11",
          alpha: false,
          premultipliedAlpha: group.usesPremultipliedAlpha !== false,
          mipmaps: false,
          preserveDrawingBuffer: false,
          viewport: normalizedViewport,
          success: (instance) => {
            try {
              instance.__spineRuntime = runtime;
              instance.__spineRuntimeKey = runtimeKey || "";
            } catch (_error) {
            }
            finishResolve(instance);
          },
          error: (_instance, message) => finishReject(new Error(message || "资源加载失败"))
        }, extraOptions || {});

        player = new runtime.SpinePlayer(mount, playerOptions);
      } catch (error) {
        finishReject(error);
        return;
      }

      timeoutId = window.setTimeout(() => {
        finishReject(new Error("加载超时"));
      }, 20000);
    });
  }

  function attachCanvasRecovery(card, player, renderToken) {
    const canvas = card.mount.querySelector("canvas");
    if (!canvas) {
      return;
    }

    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();

      window.setTimeout(() => {
        if (card.player !== player) {
          return;
        }

        disposeCardPlayer(card, "");
        setCardOverlay(card, "渲染上下文已重置，正在恢复...", "loading");

        if (renderToken === state.renderToken && card.shouldBeLoaded) {
          enqueueCardLoad(card);
          processLoadQueue();
        }
      }, 0);
    }, { once: true });
  }

  function releaseCanvasContext(mount) {
    const canvas = mount && mount.querySelector ? mount.querySelector("canvas") : null;
    if (!canvas) {
      return;
    }

    const contextNames = ["webgl2", "webgl", "experimental-webgl"];
    for (const contextName of contextNames) {
      let context = null;

      try {
        context = canvas.getContext(contextName);
      } catch (_error) {
        context = null;
      }

      if (!context) {
        continue;
      }

      try {
        const extension = context.getExtension("WEBGL_lose_context");
        if (extension && typeof extension.loseContext === "function") {
          extension.loseContext();
        }
      } catch (_error) {
      }

      return;
    }
  }

  function hydrateCardControls(card) {
    const group = card.group;
    const animationItems = getAnimationItems(card.player, group.animationHints);
    const skinNames = getSkinNames(card.player);
    const currentAnimationName = getCurrentAnimationName(card.player);
    const currentSkinName = getCurrentSkinName(card.player);
    const preferredSkin = currentSkinName || card.selectedSkinName || group.preferredSkinName || skinNames[0] || "";

    card.animations = animationItems;
    card.skins = skinNames;

    if (animationItems.length) {
      populateAnimationSelect(card, animationItems);
      const matchingCurrent = animationItems.find((item) => getAnimationPlaybackName(item.animation) === currentAnimationName);
      const preferredIndex = matchingCurrent
        ? matchingCurrent.index
        : animationItems.some((item) => item.index === card.selectedAnimationIndex)
          ? card.selectedAnimationIndex
          : animationItems[0].index;
      const preferredItem = animationItems.find((item) => item.index === preferredIndex) || animationItems[0];
      card.selectedAnimationIndex = preferredIndex;
      card.animationSelect.value = String(preferredIndex);
      refreshPlayerAfterPoseChange(card.player, preferredItem.animation);
      refreshCardFrameScrubber(card);
    } else {
      card.animationSelect.hidden = true;
      card.animationSelect.innerHTML = "";
      refreshCardFrameScrubber(card);
    }

    if (skinNames.length > 1) {
      populateSkinSelect(card, skinNames, preferredSkin || skinNames[0]);
    } else {
      card.selectedSkinName = preferredSkin || "";
      card.skinSelect.hidden = true;
      card.skinSelect.innerHTML = "";
    }

    if (!animationItems.length) {
      setCardOverlay(card, "当前 Spine 没有可播放动画。", "error");
    }

    syncFullscreenButtons();
  }

  function populateAnimationSelect(card, animationItems) {
    card.animationSelect.innerHTML = "";

    for (const item of animationItems) {
      const option = document.createElement("option");
      option.value = String(item.index);
      option.textContent = item.name;
      card.animationSelect.appendChild(option);
    }

    card.animationSelect.hidden = false;
    card.animationSelect.value = String(card.selectedAnimationIndex);
    card.animationSelect.onchange = () => {
      const animationIndex = Number(card.animationSelect.value);
      card.selectedAnimationIndex = animationIndex;
      playAnimation(card, animationIndex);
      refreshCardFrameScrubber(card);
    };
  }

  function populateSkinSelect(card, skinNames, selectedSkinName) {
    card.skinSelect.innerHTML = "";

    for (const skinName of skinNames) {
      const option = document.createElement("option");
      option.value = skinName;
      option.textContent = skinName;
      card.skinSelect.appendChild(option);
    }

    card.selectedSkinName = selectedSkinName || skinNames[0];
    card.skinSelect.value = card.selectedSkinName;
    card.skinSelect.hidden = false;
    card.skinSelect.onchange = () => {
      card.selectedSkinName = card.skinSelect.value;
      applySkinByName(card.player, card.selectedSkinName);
      refreshPlayerAfterPoseChange(
        card.player,
        card.animations.find((item) => item.index === card.selectedAnimationIndex)?.animation
      );
      refreshCardFrameScrubber(card);
    };
  }

  function getAnimationItems(player, hints) {
    const animations = player && player.skeleton && player.skeleton.data && player.skeleton.data.animations
      ? player.skeleton.data.animations
      : [];

    const animationHints = Array.isArray(hints) ? hints : [];
    return animations.map((animation, index) => ({
      index,
      name: animationHints[index] || animation.name,
      animation
    }));
  }

  function getCurrentAnimationName(player) {
    const animationState = player && player.animationState;
    if (!animationState) {
      return "";
    }

    const current = typeof animationState.getCurrent === "function"
      ? animationState.getCurrent(0)
      : animationState.tracks && animationState.tracks[0];

    return current && current.animation && current.animation.name
      ? current.animation.name
      : "";
  }

  function getCurrentSkinName(player) {
    const skeleton = player && player.skeleton;
    const skin = skeleton && skeleton.skin;
    return skin && typeof skin.name === "string" ? skin.name : "";
  }

  function getSkinNames(player) {
    const skins = player && player.skeleton && player.skeleton.data && Array.isArray(player.skeleton.data.skins)
      ? player.skeleton.data.skins
      : [];

    return skins
      .map((skin) => skin && skin.name ? skin.name : "")
      .filter(Boolean);
  }

  function playAnimation(card, animationIndex) {
    if (!card.player) return;

    const animationItem = card.animations.find((item) => item.index === animationIndex);
    if (!animationItem) return;

    try {
      card.isManualFrameControl = false;
      applyPreviewAnimation(card.player, animationItem.animation);
      card.selectedAnimationIndex = animationIndex;
      card.animationSelect.value = String(animationIndex);
      refreshCardFrameScrubber(card);
    } catch (error) {
      console.error(error);
      setCardOverlay(card, "动画切换失败。\n" + getErrorMessage(error), "error");
    }
  }

  function applySkinByName(player, skinName) {
    if (!player || !skinName) {
      return "";
    }

    const skeleton = player.skeleton;
    const skeletonData = skeleton && skeleton.data;
    if (!skeleton || !skeletonData) {
      return "";
    }

    try {
      if (typeof skeleton.setSkinByName === "function") {
        skeleton.setSkinByName(skinName);
      } else if (typeof skeletonData.findSkin === "function" && typeof skeleton.setSkin === "function") {
        const skin = skeletonData.findSkin(skinName);
        if (!skin) return "";
        skeleton.setSkin(skin);
      } else {
        return "";
      }

      if (typeof skeleton.setSlotsToSetupPose === "function") {
        skeleton.setSlotsToSetupPose();
      } else if (typeof skeleton.setToSetupPose === "function") {
        skeleton.setToSetupPose();
      }

      return skinName;
    } catch (_error) {
      return "";
    }
  }

  function resetGrid() {
    dom.previewModal.classList.remove("is-active");
    dom.previewModal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    state.activeModalCardId = "";

    dom.gridContainer.innerHTML = "";
    state.cards.clear();
    state.loadQueue = [];
    state.loadingCount = 0;
    updateBadges();
    dom.downloadButton.disabled = true;
  }

  function disposeCardPlayer(card, overlayMessage) {
    card.isScrubbing = false;
    card.isManualFrameControl = false;

    if (card.player) {
      try {
        releaseCanvasContext(card.mount);
        card.player.dispose();
      } catch (_error) {
      }
      card.player = null;
    }

    card.mount.innerHTML = "";
    card.player = null;
    card.loadedWithNativeControls = false;

    if (overlayMessage) {
      setCardOverlay(card, overlayMessage, "idle");
    } else if (!card.shouldBeLoaded) {
      setCardOverlay(card, IDLE_CARD_MESSAGE, "idle");
    }

    refreshCardFrameScrubber(card);
    processLoadQueue();
  }

  function disposeAllPlayers() {
    for (const card of state.cards.values()) {
      disposeCardPlayer(card, "");
    }
  }

  function getActivePlayerCount() {
    let count = 0;
    for (const card of state.cards.values()) {
      if (card.player) {
        count += 1;
      }
    }
    return count;
  }

  function setCardOverlay(card, message, tone, hide) {
    if (hide) {
      card.overlay.textContent = "";
      card.overlay.classList.add("is-hidden");
      return;
    }

    card.overlay.textContent = message;
    card.overlay.dataset.tone = tone || "idle";
    card.overlay.classList.remove("is-hidden");
  }

  function setBusy(isBusy) {
    state.isBusy = isBusy;
    dom.extractButton.disabled = isBusy;
    dom.localFolderButton.disabled = isBusy;
    dom.localFolderInput.disabled = isBusy;
    dom.urlInput.disabled = isBusy;
    dom.downloadButton.disabled = isBusy || !state.sessionId || getSelectedCount() === 0;
  }

  function setStatus(message, tone) {
    state.statusMessage = message;
    state.statusTone = tone;
    renderExportProgressState();
  }

  function getSelectedCount() {
    let count = 0;
    for (const card of state.cards.values()) {
      if (card.checkbox.checked) {
        count += 1;
      }
    }
    return count;
  }

  function updateBadges() {
    const groupCount = state.cards.size;
    const selectedCount = getSelectedCount();
    dom.groupBadge.textContent = `Spine: ${groupCount}`;
    dom.selectedBadge.textContent = `已选: ${selectedCount}`;
    dom.downloadButton.disabled = state.isBusy || !state.sessionId || selectedCount === 0;
  }

  function showEmptyState(message) {
    dom.emptyState.textContent = message;
    dom.emptyState.style.display = "grid";
  }

  function hideEmptyState() {
    dom.emptyState.style.display = "none";
  }

  function parseFileNameFromDisposition(disposition) {
    if (!disposition) {
      return "";
    }

    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match) {
      return decodeURIComponent(utf8Match[1]);
    }

    const basicMatch = disposition.match(/filename="?([^"]+)"?/i);
    return basicMatch ? basicMatch[1] : "";
  }

  function getErrorMessage(error) {
    return error && error.message ? error.message : String(error);
  }

  initialize();
})();
