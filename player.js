(function () {
  "use strict";

  const assetSelect = document.getElementById("assetSelect");
  const animationSelect = document.getElementById("animationSelect");
  const reloadBtn = document.getElementById("reloadBtn");
  const statusEl = document.getElementById("status");
  const playerContainer = document.getElementById("player");

  let manifest = [];
  let currentPlayer = null;
  const runtimeCache = new Map();

  function setStatus(text, tone) {
    statusEl.textContent = text;
    statusEl.dataset.tone = tone || "idle";
  }

  function toPosix(path) {
    return String(path || "").replace(/\\/g, "/");
  }

  function safeOptionText(value) {
    return String(value || "").trim();
  }

  function getSelectedAsset() {
    const id = assetSelect.value;
    return manifest.find((item) => item.id === id) || null;
  }

  function disposePlayer() {
    if (currentPlayer && typeof currentPlayer.dispose === "function") {
      currentPlayer.dispose();
    }
    currentPlayer = null;
    playerContainer.innerHTML = "";
  }

  async function loadManifest() {
    const response = await fetch("./spine/manifest.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("无法读取 spine/manifest.json");
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
      throw new Error("manifest.json 必须是数组。");
    }

    manifest = data
      .map((item, idx) => ({
        id: safeOptionText(item.id) || "asset_" + (idx + 1),
        name: safeOptionText(item.name) || "未命名资源 " + (idx + 1),
        json: toPosix(item.json),
        atlas: toPosix(item.atlas),
        defaultAnimation: safeOptionText(item.defaultAnimation),
        defaultSkin: safeOptionText(item.defaultSkin),
        premultipliedAlpha: Boolean(item.premultipliedAlpha)
      }))
      .filter((item) => item.json && item.atlas);
  }

  function renderAssetOptions() {
    assetSelect.innerHTML = "";

    if (!manifest.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "没有可用资源";
      assetSelect.appendChild(opt);
      return;
    }

    for (const asset of manifest) {
      const opt = document.createElement("option");
      opt.value = asset.id;
      opt.textContent = asset.name;
      assetSelect.appendChild(opt);
    }
  }

  function normalizeRuntimeVersion(rawVersion) {
    const value = String(rawVersion || "").trim();
    const match = value.match(/^(\d+\.\d+)/);
    return match ? match[1] : "";
  }

  function resolveRuntimeKey(spineVersion) {
    const version = normalizeRuntimeVersion(spineVersion);
    const known = ["4.2", "4.1", "4.0", "3.8"];

    if (version && known.includes(version)) {
      return version;
    }

    if (version.startsWith("4.2")) return "4.2";
    if (version.startsWith("4.1")) return "4.1";
    if (version.startsWith("4.0")) return "4.0";
    if (version.startsWith("3.8")) return "3.8";
    return "4.2";
  }

  function getRuntimeByKey(key) {
    const registry = window.SpinePlayerRegistry || {};
    return registry[key] || registry["4.2"] || registry["4.1"] || registry["4.0"] || registry["3.8"] || null;
  }

  async function loadAssetMeta(asset) {
    if (runtimeCache.has(asset.id)) {
      return runtimeCache.get(asset.id);
    }

    const response = await fetch(asset.json, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("读取 JSON 失败: " + asset.json);
    }

    const data = await response.json();
    const animations = data && typeof data === "object" && data.animations && typeof data.animations === "object"
      ? Object.keys(data.animations)
      : [];
    const spineVersion = data && data.skeleton && data.skeleton.spine ? String(data.skeleton.spine) : "";
    const meta = {
      animations: animations,
      spineVersion: spineVersion
    };

    runtimeCache.set(asset.id, meta);
    return meta;
  }

  function renderAnimationOptions(animations, preferredAnimation) {
    animationSelect.innerHTML = "";

    if (!animations.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "无动画";
      animationSelect.appendChild(opt);
      return;
    }

    for (const name of animations) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      animationSelect.appendChild(opt);
    }

    if (preferredAnimation && animations.includes(preferredAnimation)) {
      animationSelect.value = preferredAnimation;
    }
  }

  function buildPlayer(asset, animationName, runtimeKey) {
    disposePlayer();

    const runtime = getRuntimeByKey(runtimeKey);
    if (!runtime || typeof runtime.SpinePlayer !== "function") {
      throw new Error("未找到可用 Spine 运行时: " + runtimeKey);
    }

    const options = {
      jsonUrl: asset.json,
      atlasUrl: asset.atlas,
      alpha: true,
      showControls: true,
      backgroundColor: "#f8f3e6",
      preserveDrawingBuffer: true,
      premultipliedAlpha: asset.premultipliedAlpha
    };

    if (animationName) {
      options.animation = animationName;
    }

    if (asset.defaultSkin) {
      options.skin = asset.defaultSkin;
    }

    currentPlayer = new runtime.SpinePlayer(playerContainer, options);
  }

  async function refreshPlayer() {
    const asset = getSelectedAsset();
    if (!asset) {
      disposePlayer();
      setStatus("没有可播放资源，请先配置 manifest。", "error");
      return;
    }

    try {
      const meta = await loadAssetMeta(asset);
      const runtimeKey = resolveRuntimeKey(meta.spineVersion);
      renderAnimationOptions(meta.animations, asset.defaultAnimation);
      const picked = animationSelect.value || "";
      buildPlayer(asset, picked, runtimeKey);
      setStatus("已加载: " + asset.name + (picked ? " | 动画: " + picked : "") + " | 运行时: " + runtimeKey, "ok");
    } catch (error) {
      disposePlayer();
      setStatus("加载失败: " + (error && error.message ? error.message : String(error)), "error");
    }
  }

  async function init() {
    setStatus("正在加载资源清单...", "idle");
    try {
      await loadManifest();
      renderAssetOptions();
      await refreshPlayer();
    } catch (error) {
      setStatus("初始化失败: " + (error && error.message ? error.message : String(error)), "error");
    }
  }

  assetSelect.addEventListener("change", function () {
    refreshPlayer();
  });

  animationSelect.addEventListener("change", function () {
    const asset = getSelectedAsset();
    if (!asset) return;
    const meta = runtimeCache.get(asset.id);
    const runtimeKey = resolveRuntimeKey(meta && meta.spineVersion ? meta.spineVersion : "");
    try {
      buildPlayer(asset, animationSelect.value || "", runtimeKey);
      setStatus("已切换动画: " + (animationSelect.value || "默认") + " | 运行时: " + runtimeKey, "ok");
    } catch (error) {
      setStatus("切换失败: " + (error && error.message ? error.message : String(error)), "error");
    }
  });

  reloadBtn.addEventListener("click", init);

  init();
})();
