const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomUUID, createHash } = require("crypto");
const { chromium } = require("playwright-core");
const yazl = require("yazl");

const ROOT = __dirname;
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3770);
const SESSION_TTL_MS = 30 * 60 * 1000;
const REGENERATOR_RUNTIME_CDN = "https://cdn.jsdelivr.net/npm/regenerator-runtime@0.14.1/runtime.min.js";
const GIF_WORKER_CDN_URL = "https://cdn.jsdelivr.net/npm/gif.js.optimized/dist/gif.worker.js";
const EDGE_EXECUTABLE_PATHS = [
  process.env.EDGE_PATH,
  process.env.BROWSER_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].filter(Boolean);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

let browserPromise = null;
let runnerUrl = "";
const sessionStore = new Map();

function safeSegment(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 180);
}

function sanitizeRelativePath(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const cleanParts = [];

  for (const part of parts) {
    if (part === "." || part === "..") {
      continue;
    }
    cleanParts.push(safeSegment(part));
  }

  return cleanParts.filter(Boolean).join("/");
}

function joinPosix() {
  return Array.from(arguments)
    .map((part) => String(part || "").replace(/\\/g, "/"))
    .filter(Boolean)
    .join("/")
    .replace(/\/{2,}/g, "/");
}

function decodeUrlPathSegment(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function sanitizeArchiveBaseName(value) {
  let normalized = String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 180);

  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(normalized)) {
    normalized = `${normalized}_file`;
  }

  return normalized;
}

function extractArchiveBaseName(targetUrl) {
  const raw = String(targetUrl || "").trim();
  if (!raw) {
    return "resources";
  }

  const fromPathname = (pathname) => {
    const segments = String(pathname || "")
      .split("/")
      .filter(Boolean)
      .map(decodeUrlPathSegment);
    const eventIndex = segments.findIndex((segment) => segment.toLowerCase() === "event");
    if (eventIndex >= 0 && segments[eventIndex + 1]) {
      return segments[eventIndex + 1];
    }
    if (!segments.length) {
      return "";
    }
    const lastSegment = segments[segments.length - 1];
    if (/\.[a-z0-9]+$/i.test(lastSegment) && segments.length >= 2) {
      return segments[segments.length - 2];
    }
    return lastSegment.replace(/\.[^.]+$/, "");
  };

  try {
    return sanitizeArchiveBaseName(fromPathname(new URL(raw).pathname)) || "resources";
  } catch {
    const eventMatch = raw.match(/\/event\/([^/?#]+)/i);
    if (eventMatch && eventMatch[1]) {
      return sanitizeArchiveBaseName(decodeUrlPathSegment(eventMatch[1])) || "resources";
    }
    return sanitizeArchiveBaseName(fromPathname(raw)) || "resources";
  }
}

function resolveArchiveBaseName(targetUrl, preferredBaseName) {
  return sanitizeArchiveBaseName(preferredBaseName) || extractArchiveBaseName(targetUrl);
}

function buildArchiveName(targetUrl, preferredBaseName) {
  return `${resolveArchiveBaseName(targetUrl, preferredBaseName)}.zip`;
}

function buildCacheUrl(sessionId, resourcePath) {
  const encodedPath = String(resourcePath || "")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `/api/sessions/${encodeURIComponent(sessionId)}/files/${encodedPath}`;
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendJson(res, statusCode, payload) {
  sendText(res, statusCode, JSON.stringify(payload), "application/json; charset=utf-8");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > 2 * 1024 * 1024) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", reject);
  });
}

async function readFormData(req) {
  const request = new Request("http://127.0.0.1/", {
    method: req.method,
    headers: req.headers,
    body: req,
    duplex: "half"
  });

  return request.formData();
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      let lastError = null;
      const launchCandidates = [];

      if (process.platform === "win32") {
        for (const executablePath of EDGE_EXECUTABLE_PATHS) {
          if (fs.existsSync(executablePath)) {
            launchCandidates.push({ headless: true, executablePath });
          }
        }

        launchCandidates.push({ headless: true, channel: "msedge" });
      }

      launchCandidates.push({ headless: true, channel: "chrome" });
      launchCandidates.push({ headless: true });

      for (const options of launchCandidates) {
        try {
          return await chromium.launch(options);
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError || new Error("Failed to launch a Chromium-based browser.");
    })();
  }
  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) {
    return;
  }

  try {
    const browser = await browserPromise;
    await browser.close();
  } catch (error) {
    console.error("[browser-close]", error);
  } finally {
    browserPromise = null;
  }
}

async function fetchHtml(targetUrl) {
  const response = await fetch(targetUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch activity page: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function proxyRemoteScript(res, scriptUrl) {
  const response = await fetch(scriptUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch remote script: ${response.status} ${response.statusText}`);
  }

  const scriptText = await response.text();
  sendText(res, 200, scriptText, "application/javascript; charset=utf-8");
}

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) {
    throw new Error("Invalid data URL.");
  }

  const isBase64 = Boolean(match[2]);
  const payload = match[3] || "";
  return isBase64
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");
}

async function fetchBuffer(source) {
  if (String(source || "").startsWith("data:")) {
    return dataUrlToBuffer(source);
  }

  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Failed to fetch resource: ${response.status} ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function fetchBufferCached(source, cache) {
  const key = String(source || "");
  if (cache.has(key)) {
    return cache.get(key);
  }

  const task = fetchBuffer(source);
  cache.set(key, task);
  return task;
}

function decodeAtlasTextFromBuffer(buffer) {
  const rawText = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer || "");
  const trimmed = rawText.trim();
  if (!trimmed) {
    return rawText;
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 16) {
    return rawText;
  }

  const numericValues = [];
  for (const line of lines) {
    if (!/^\d{1,3}$/.test(line)) {
      return rawText;
    }
    const value = Number(line);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return rawText;
    }
    numericValues.push(value);
  }

  try {
    return Buffer.from(numericValues).toString("utf8");
  } catch {
    return rawText;
  }
}

async function valueToBuffer(value, kind, cache) {
  if (kind === "atlas") {
    return Buffer.from(String(value || ""), "utf8");
  }

  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^(https?:|data:)/i.test(trimmed)) {
      return fetchBufferCached(trimmed, cache);
    }
    return Buffer.from(value, "utf8");
  }

  return Buffer.from(JSON.stringify(value, null, 2), "utf8");
}

async function valueToText(value, kind, cache) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^(https?:|data:)/i.test(trimmed)) {
      const buffer = await fetchBufferCached(trimmed, cache);
      if (kind === "atlas") {
        return decodeAtlasTextFromBuffer(buffer);
      }
      return buffer.toString("utf8");
    }
    if (kind === "atlas") {
      return decodeAtlasTextFromBuffer(Buffer.from(value, "utf8"));
    }
    return value;
  }

  if (kind === "atlas") {
    return String(value || "");
  }

  return JSON.stringify(value, null, 2);
}

function parseAtlasPages(atlasText) {
  if (typeof atlasText !== "string") {
    return [];
  }

  const lines = atlasText.split(/\r?\n/);
  const pages = [];

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index].trim();
    const next = (lines[index + 1] || "").trim();
    if (!current || current.includes(":")) continue;
    if (!/\.(png|jpg|jpeg|webp)$/i.test(current)) continue;
    if (!next.startsWith("size:")) continue;
    pages.push(current);
  }

  return Array.from(new Set(pages));
}

function extractAtlasPageSizes(atlasText) {
  if (typeof atlasText !== "string") {
    return [];
  }

  const lines = atlasText.split(/\r?\n/);
  const sizes = [];

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index].trim();
    const next = (lines[index + 1] || "").trim();
    if (!current || current.includes(":")) continue;
    if (!/\.(png|jpg|jpeg|webp)$/i.test(current)) continue;

    const sizeMatch = next.match(/^size:\s*([0-9.]+)\s*,\s*([0-9.]+)\s*$/i);
    if (!sizeMatch) {
      continue;
    }

    sizes.push({
      width: Math.max(1, Math.round(Number(sizeMatch[1]) || 0)),
      height: Math.max(1, Math.round(Number(sizeMatch[2]) || 0))
    });
  }

  return sizes;
}

function normalizeAtlasForDedup(atlasText) {
  const lines = String(atlasText || "").split(/\r?\n/);
  const normalized = [];

  for (let index = 0; index < lines.length; index += 1) {
    const currentLine = lines[index];
    const trimmed = currentLine.trim();
    const next = (lines[index + 1] || "").trim();

    if (
      trimmed
      && !trimmed.includes(":")
      && /\.(png|jpg|jpeg|webp)$/i.test(trimmed)
      && next.startsWith("size:")
    ) {
      normalized.push("__PAGE__");
      continue;
    }

    normalized.push(currentLine);
  }

  return normalized.join("\n");
}

function extractPreferredRenderSize(jsonText, atlasText) {
  let width = 0;
  let height = 0;
  let x = 0;
  let y = 0;
  let hasViewportOrigin = false;
  let viewportWidth = 0;
  let viewportHeight = 0;

  try {
    const data = JSON.parse(jsonText);
    const skeleton = data && data.skeleton ? data.skeleton : null;
    const skeletonWidth = Number(skeleton && skeleton.width || 0);
    const skeletonHeight = Number(skeleton && skeleton.height || 0);
    const skeletonX = Number(skeleton && skeleton.x);
    const skeletonY = Number(skeleton && skeleton.y);

    width = Math.max(width, Math.round(skeletonWidth || 0));
    height = Math.max(height, Math.round(skeletonHeight || 0));

    if (Number.isFinite(skeletonX) && Number.isFinite(skeletonY) && skeletonWidth > 0 && skeletonHeight > 0) {
      x = skeletonX;
      y = skeletonY;
      viewportWidth = skeletonWidth;
      viewportHeight = skeletonHeight;
      hasViewportOrigin = true;
    }
  } catch {
  }

  for (const size of extractAtlasPageSizes(atlasText)) {
    width = Math.max(width, Number(size.width || 0));
    height = Math.max(height, Number(size.height || 0));
  }

  return {
    x,
    y,
    viewportWidth,
    viewportHeight,
    width: Math.max(1, width || 0),
    height: Math.max(1, height || 0),
    hasViewportOrigin
  };
}

function splitFileName(fileName) {
  const value = String(fileName || "");
  const extension = path.extname(value);
  return {
    name: extension ? value.slice(0, -extension.length) : value,
    extension
  };
}

function reserveUniqueArchiveName(rawFileName, usedNames) {
  const parts = splitFileName(rawFileName);
  const baseName = safeSegment(parts.name) || "file";
  const extension = parts.extension || "";
  let candidate = `${baseName}${extension}`;
  let suffix = 2;

  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${baseName}_${suffix}${extension}`;
    suffix += 1;
  }

  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function reserveUniqueGroupBaseName(rawBaseName, usedBaseNames) {
  const baseName = safeSegment(rawBaseName) || "spine";
  let candidate = baseName;
  let suffix = 2;

  while (usedBaseNames.has(candidate.toLowerCase())) {
    candidate = `${baseName}_${suffix}`;
    suffix += 1;
  }

  usedBaseNames.add(candidate.toLowerCase());
  return candidate;
}

function flattenAtlasPageName(pageName) {
  const normalized = sanitizeRelativePath(pageName) || filenameFromPath(pageName);
  return normalized.replace(/\//g, "_");
}

function rewriteAtlasPageNames(atlasText, renamedPages) {
  if (!renamedPages || !renamedPages.size) {
    return atlasText;
  }

  const lines = String(atlasText || "").split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const currentLine = lines[index];
    const trimmed = currentLine.trim();
    const next = (lines[index + 1] || "").trim();

    if (!trimmed || trimmed.includes(":")) continue;
    if (!/\.(png|jpg|jpeg|webp)$/i.test(trimmed)) continue;
    if (!next.startsWith("size:")) continue;

    const renamed = renamedPages.get(trimmed);
    if (!renamed) {
      continue;
    }

    const indent = currentLine.match(/^\s*/);
    lines[index] = `${indent ? indent[0] : ""}${renamed}`;
  }

  return lines.join("\n");
}

function findGroupImagePath(group, pageName, index) {
  if (Array.isArray(group.imagePaths) && group.imagePaths[index]) {
    return group.imagePaths[index];
  }

  const expectedFileName = filenameFromPath(pageName);
  const expectedNormalized = normalizeResourceFileName(pageName);

  return (group.imagePaths || []).find((candidatePath) => {
    return filenameFromPath(candidatePath) === expectedFileName
      || normalizeResourceFileName(candidatePath) === expectedNormalized;
  }) || "";
}

function buildFlatArchiveEntries(group, sessionFiles, usedNames, usedGroupBases, preferredGroupBaseName = "") {
  const atlasFile = sessionFiles.get(group.atlasPath);
  const jsonFile = sessionFiles.get(group.jsonPath);
  if (!atlasFile || !jsonFile) {
    return [];
  }

  const groupBaseName = reserveUniqueGroupBaseName(
    preferredGroupBaseName || group.fileName || splitFileName(filenameFromPath(group.atlasPath)).name || "spine",
    usedGroupBases
  );

  const atlasText = atlasFile.buffer.toString("utf8");
  const pageNames = parseAtlasPages(atlasText);
  const renamedPages = new Map();
  const archiveEntries = [];

  for (let index = 0; index < pageNames.length; index += 1) {
    const pageName = pageNames[index];
    const imagePath = findGroupImagePath(group, pageName, index);
    const imageFile = imagePath ? sessionFiles.get(imagePath) : null;
    if (!imageFile) {
      continue;
    }

    const flattenedPageName = flattenAtlasPageName(pageName);
    const parts = splitFileName(flattenedPageName);
    const mergedImageBaseName = index === 0
      ? groupBaseName
      : `${groupBaseName}_${index + 1}`;
    const archiveImageName = reserveUniqueArchiveName(
      `${mergedImageBaseName || `${groupBaseName}_image_${index + 1}`}${parts.extension || path.extname(pageName) || ".png"}`,
      usedNames
    );

    renamedPages.set(pageName, archiveImageName);
    archiveEntries.push({
      archivePath: joinPosix("spine", archiveImageName),
      buffer: imageFile.buffer
    });
  }

  const atlasArchiveName = reserveUniqueArchiveName(`${groupBaseName}.atlas`, usedNames);
  const jsonArchiveName = reserveUniqueArchiveName(`${groupBaseName}.json`, usedNames);
  const rewrittenAtlasText = rewriteAtlasPageNames(atlasText, renamedPages);

  archiveEntries.unshift(
    {
      archivePath: joinPosix("spine", jsonArchiveName),
      buffer: jsonFile.buffer
    }
  );
  archiveEntries.unshift(
    {
      archivePath: joinPosix("spine", atlasArchiveName),
      buffer: Buffer.from(rewrittenAtlasText, "utf8")
    }
  );

  return archiveEntries;
}

function extractAtlasPma(text) {
  const match = String(text || "").match(/^\s*pma\s*:\s*(true|false)\s*$/im);
  return match ? match[1].toLowerCase() === "true" : false;
}

function detectSpineVersion(text) {
  const match = String(text || "").match(/"spine"\s*:\s*"([^"]+)"/);
  return match ? match[1].trim() : "";
}

function extractAnimationNameHints(text) {
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || !data.animations || typeof data.animations !== "object") {
      return [];
    }
    return Object.keys(data.animations);
  } catch {
    return [];
  }
}

function countSkinAttachments(skin) {
  if (!skin || typeof skin !== "object") return 0;

  let count = 0;

  if (Array.isArray(skin.attachments)) {
    for (const slotMap of skin.attachments) {
      if (slotMap && typeof slotMap === "object") {
        count += Object.keys(slotMap).length;
      }
    }
    return count;
  }

  if (skin.attachments && typeof skin.attachments === "object") {
    for (const slotName of Object.keys(skin.attachments)) {
      const slotMap = skin.attachments[slotName];
      if (slotMap && typeof slotMap === "object") {
        count += Object.keys(slotMap).length;
      }
    }
    return count;
  }

  for (const key of Object.keys(skin)) {
    if (["name", "bones", "constraints", "color"].includes(key)) continue;
    const slotMap = skin[key];
    if (slotMap && typeof slotMap === "object") {
      count += Object.keys(slotMap).length;
    }
  }

  return count;
}

function extractSkinHints(text) {
  try {
    const data = JSON.parse(text);
    const rawSkins = data && data.skins;
    if (!rawSkins) return [];

    const skins = Array.isArray(rawSkins)
      ? rawSkins
      : Object.keys(rawSkins).map((name) => ({ name, attachments: rawSkins[name] }));

    return skins
      .map((skin) => ({
        name: skin && skin.name ? skin.name : "",
        attachmentCount: countSkinAttachments(skin)
      }))
      .filter((skin) => skin.name);
  } catch {
    return [];
  }
}

function pickPreferredSkinName(skinHints) {
  if (!Array.isArray(skinHints) || !skinHints.length) {
    return "";
  }

  const defaultSkin = skinHints.find((skin) => skin.name === "default") || null;
  const bestNonDefaultSkin = skinHints
    .filter((skin) => skin.name !== "default")
    .sort((left, right) => right.attachmentCount - left.attachmentCount)[0] || null;

  if (!defaultSkin) {
    return bestNonDefaultSkin ? bestNonDefaultSkin.name : "";
  }

  if (!bestNonDefaultSkin) {
    return defaultSkin.name;
  }

  if (defaultSkin.attachmentCount <= 1 && bestNonDefaultSkin.attachmentCount > defaultSkin.attachmentCount) {
    return bestNonDefaultSkin.name;
  }

  if (defaultSkin.attachmentCount === 0 && bestNonDefaultSkin.attachmentCount > 0) {
    return bestNonDefaultSkin.name;
  }

  return defaultSkin.name;
}

function pickRuntimeCandidates(version) {
  if (!version) {
    return ["4.2", "4.1", "4.0", "3.8"];
  }

  if (version.startsWith("3.8")) {
    return ["3.8", "4.0", "4.1", "4.2"];
  }

  const fromMatch = version.match(/from-(4\.\d+)/i);
  if (fromMatch) {
    const currentRuntime = version.match(/^(4\.\d+)/);
    return Array.from(new Set([
      fromMatch[1],
      currentRuntime ? currentRuntime[1] : "",
      "4.2",
      "4.1",
      "4.0",
      "3.8"
    ].filter(Boolean)));
  }

  if (version.startsWith("4.2")) return ["4.2", "4.1", "4.0", "3.8"];
  if (version.startsWith("4.1")) return ["4.1", "4.2", "4.0", "3.8"];
  if (version.startsWith("4.0")) return ["4.0", "4.1", "4.2", "3.8"];
  return ["4.2", "4.1", "4.0", "3.8"];
}

function normalizeLookupKey(value) {
  return String(value || "").trim().toLowerCase();
}

function filenameFromPath(resourcePath) {
  const clean = String(resourcePath || "").replace(/\\/g, "/").split("#")[0].split("?")[0];
  return clean.split("/").pop() || "";
}

function stripWebpackHash(fileName) {
  const pieces = String(fileName || "").split(".");
  const ext = pieces.pop();
  const basePieces = pieces.filter(Boolean);

  if (basePieces.length >= 2 && /^[a-f0-9]{6,}$/i.test(basePieces[basePieces.length - 1])) {
    basePieces.pop();
  }

  return ext ? `${basePieces.join(".")}.${ext}` : basePieces.join(".");
}

function normalizeResourceFileName(resourcePath) {
  return stripWebpackHash(filenameFromPath(resourcePath));
}

function addLookupValue(map, key, value) {
  const normalized = normalizeLookupKey(key);
  if (!normalized) return;
  const bucket = map.get(normalized) || [];
  bucket.push(value);
  map.set(normalized, bucket);
}

function buildImageLookup(resources) {
  const lookup = new Map();

  for (const resource of resources || []) {
    if (!resource || !resource.src) continue;

    const extension = path.extname(String(resource.src || "")).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
      continue;
    }

    const idKey = resource.id ? normalizeLookupKey(resource.id) : "";
    const fileName = filenameFromPath(resource.src);
    const normalizedFileName = normalizeResourceFileName(resource.src);
    const withoutExt = normalizedFileName.replace(/\.[^.]+$/, "");
    const entry = {
      id: String(resource.id || ""),
      src: resource.src,
      module: String(resource.module || resource._module || ""),
      fileName,
      normalizedFileName,
      withoutExt
    };

    addLookupValue(lookup, fileName, entry);
    addLookupValue(lookup, normalizedFileName, entry);
    addLookupValue(lookup, withoutExt, entry);
    addLookupValue(lookup, idKey, entry);
  }

  return lookup;
}

function findBestImageEntry(pageName, moduleName, lookup) {
  const requestedFile = filenameFromPath(pageName);
  const normalizedFile = normalizeResourceFileName(pageName);
  const withoutExt = normalizedFile.replace(/\.[^.]+$/, "");
  const candidates = []
    .concat(lookup.get(normalizeLookupKey(requestedFile)) || [])
    .concat(lookup.get(normalizeLookupKey(normalizedFile)) || [])
    .concat(lookup.get(normalizeLookupKey(withoutExt)) || []);

  if (!candidates.length) {
    return null;
  }

  const preferredModule = String(moduleName || "");
  return candidates.find((candidate) => candidate.module === preferredModule) || candidates[0];
}

function guessContentType(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

function createFileRecord(resourcePath, buffer, contentType) {
  return {
    path: resourcePath,
    buffer,
    contentType
  };
}

function compareGroupsByImageSize(left, right) {
  const sizeDelta = Number(right && right.imageByteSize || 0) - Number(left && left.imageByteSize || 0);
  if (sizeDelta !== 0) {
    return sizeDelta;
  }

  return String(left && left.fileName || "").localeCompare(String(right && right.fileName || ""), "zh-CN");
}

function stripFileExtension(fileName) {
  return String(fileName || "").replace(/\.[^.]+$/, "");
}

function dirnamePosix(filePath) {
  const dir = path.posix.dirname(String(filePath || "").replace(/\\/g, "/"));
  return dir === "." ? "" : dir;
}

function decodeUtf8Buffer(buffer) {
  return Buffer.isBuffer(buffer)
    ? buffer.toString("utf8").replace(/^\uFEFF/, "")
    : String(buffer || "").replace(/^\uFEFF/, "");
}

function resolveRelativeFilePath(basePath, relativePath) {
  const joined = path.posix.normalize(path.posix.join(
    dirnamePosix(basePath),
    String(relativePath || "").replace(/\\/g, "/")
  ));

  return sanitizeRelativePath(joined);
}

function buildLocalFileLookup(localFiles) {
  const exactMap = new Map();
  const imageLookup = new Map();

  for (const file of localFiles) {
    exactMap.set(normalizeLookupKey(file.relativePath), file);

    if (![".png", ".jpg", ".jpeg", ".webp"].includes(file.extension)) {
      continue;
    }

    addLookupValue(imageLookup, file.relativePath, file);
    addLookupValue(imageLookup, file.fileName, file);
    addLookupValue(imageLookup, normalizeResourceFileName(file.relativePath), file);
    addLookupValue(imageLookup, normalizeResourceFileName(file.fileName), file);
    addLookupValue(imageLookup, stripFileExtension(normalizeResourceFileName(file.fileName)), file);
  }

  return {
    exactMap,
    imageLookup
  };
}

function findBestLocalImageEntry(pageName, atlasPath, lookup) {
  const exactPath = resolveRelativeFilePath(atlasPath, pageName);
  const requestedFile = filenameFromPath(pageName);
  const normalizedFile = normalizeResourceFileName(pageName);
  const withoutExt = stripFileExtension(normalizedFile);

  return lookup.exactMap.get(normalizeLookupKey(exactPath))
    || (lookup.imageLookup.get(normalizeLookupKey(exactPath)) || [])[0]
    || (lookup.imageLookup.get(normalizeLookupKey(requestedFile)) || [])[0]
    || (lookup.imageLookup.get(normalizeLookupKey(normalizedFile)) || [])[0]
    || (lookup.imageLookup.get(normalizeLookupKey(withoutExt)) || [])[0]
    || null;
}

function pickLocalJsonFile(atlasFile, jsonFiles, usedJsonPaths) {
  const sameDirFiles = jsonFiles.filter((file) => file.dir === atlasFile.dir && !usedJsonPaths.has(file.relativePath));
  const atlasBase = stripFileExtension(atlasFile.fileName);

  const exactMatch = sameDirFiles.find((file) => stripFileExtension(file.fileName) === atlasBase);
  if (exactMatch) {
    return exactMatch;
  }

  if (sameDirFiles.length === 1) {
    return sameDirFiles[0];
  }

  const globalExactMatch = jsonFiles.find((file) => {
    return !usedJsonPaths.has(file.relativePath) && stripFileExtension(file.fileName) === atlasBase;
  });

  return globalExactMatch || null;
}

async function buildSessionData(sessionId, targetUrl, collected, preferredArchiveBaseName = "") {
  const fileStore = new Map();
  const bufferCache = new Map();
  const groups = [];
  const skipped = [];
  const dedupeKeys = new Set();
  const imageLookup = buildImageLookup(
    []
      .concat(collected && collected.spineres ? collected.spineres.MAIN_MANIFEST || [] : [])
      .concat(collected && collected.staticres ? collected.staticres : [])
  );

  const spineManifest = collected && collected.spineres && collected.spineres.SPINE_MANIFEST
    ? collected.spineres.SPINE_MANIFEST
    : {};

  const entries = Object.entries(spineManifest).sort((left, right) => left[0].localeCompare(right[0], "zh-CN"));

  for (let index = 0; index < entries.length; index += 1) {
    const [rawId, entry] = entries[index];
    if (!entry || !entry.atlas || !entry.json) {
      skipped.push({ id: rawId, reason: "缺少 atlas 或 json。" });
      continue;
    }

    const displayName = String(rawId || "").trim() || `spine_${index + 1}`;
    const groupFolderName = safeSegment(displayName) || `spine_${index + 1}`;
    const moduleFolder = sanitizeRelativePath(entry.module || "spine") || "spine";
    const groupDir = joinPosix(moduleFolder, groupFolderName);
    const atlasFileName = `${groupFolderName}.atlas`;
    const jsonFileName = `${groupFolderName}.json`;
    const atlasPath = joinPosix(groupDir, atlasFileName);
    const jsonPath = joinPosix(groupDir, jsonFileName);

    const atlasText = await valueToText(entry.atlas, "atlas", bufferCache);
    const jsonText = await valueToText(entry.json, "json", bufferCache);
    const dedupeKey = createHash("sha1")
      .update(normalizeAtlasForDedup(atlasText))
      .update("\n---\n")
      .update(jsonText)
      .digest("hex");
    if (dedupeKeys.has(dedupeKey)) {
      skipped.push({
        id: displayName,
        reason: "重复 Spine（骨骼与图集数据一致），已自动去重。"
      });
      continue;
    }
    dedupeKeys.add(dedupeKey);

    const stagedFiles = [
      createFileRecord(atlasPath, Buffer.from(atlasText, "utf8"), "text/plain; charset=utf-8"),
      createFileRecord(jsonPath, Buffer.from(jsonText, "utf8"), "application/json; charset=utf-8")
    ];

    const pageNames = parseAtlasPages(atlasText);
    const imagePaths = [];
    const missingPages = [];
    let imageByteSize = 0;

    for (const pageName of pageNames) {
      const match = findBestImageEntry(pageName, entry.module || "", imageLookup);
      if (!match) {
        missingPages.push(pageName);
        continue;
      }

      const resourcePath = joinPosix(groupDir, sanitizeRelativePath(pageName) || filenameFromPath(pageName));
      const imageBuffer = await fetchBufferCached(match.src, bufferCache);
      stagedFiles.push(createFileRecord(resourcePath, imageBuffer, guessContentType(resourcePath)));
      imagePaths.push(resourcePath);
      imageByteSize += imageBuffer.length;
    }

    if (missingPages.length) {
      skipped.push({
        id: displayName,
        reason: `缺少贴图资源: ${missingPages.join(", ")}`
      });
      continue;
    }

    const detectedVersion = detectSpineVersion(jsonText);
    const skinHints = extractSkinHints(jsonText);
    const preferredRenderSize = extractPreferredRenderSize(jsonText, atlasText);
    const groupId = `group_${index + 1}`;

    for (const file of stagedFiles) {
      fileStore.set(file.path, {
        buffer: file.buffer,
        contentType: file.contentType
      });
    }

    groups.push({
      id: groupId,
      fileName: displayName,
      module: String(entry.module || ""),
      atlasUrl: buildCacheUrl(sessionId, atlasPath),
      jsonUrl: buildCacheUrl(sessionId, jsonPath),
      atlasPath,
      jsonPath,
      imagePaths,
      imageByteSize,
      viewportX: preferredRenderSize.x,
      viewportY: preferredRenderSize.y,
      viewportWidth: preferredRenderSize.viewportWidth,
      viewportHeight: preferredRenderSize.viewportHeight,
      hasViewportOrigin: preferredRenderSize.hasViewportOrigin,
      renderWidth: preferredRenderSize.width,
      renderHeight: preferredRenderSize.height,
      usesPremultipliedAlpha: extractAtlasPma(atlasText),
      detectedVersion,
      runtimeCandidates: pickRuntimeCandidates(detectedVersion),
      animationHints: extractAnimationNameHints(jsonText),
      skinHints,
      preferredSkinName: pickPreferredSkinName(skinHints),
      files: stagedFiles.map((file) => file.path)
    });
  }

  groups.sort(compareGroupsByImageSize);

  return {
    id: sessionId,
    targetUrl,
    archiveName: buildArchiveName(targetUrl, preferredArchiveBaseName),
    createdAt: Date.now(),
    groups,
    skipped,
    files: fileStore
  };
}

async function buildLocalSessionData(sessionId, uploadedFiles, sourceLabel = "local_spine") {
  const fileStore = new Map();
  const groups = [];
  const skipped = [];
  const localFiles = uploadedFiles
    .map((file, index) => {
      const relativePath = sanitizeRelativePath(file.relativePath || file.name || `file_${index}`);
      const fileName = filenameFromPath(relativePath);
      const extension = path.extname(fileName).toLowerCase();

      return {
        relativePath,
        fileName,
        extension,
        dir: dirnamePosix(relativePath),
        buffer: file.buffer,
        contentType: guessContentType(relativePath)
      };
    })
    .filter((file) => file.relativePath && file.fileName);

  const atlasFiles = localFiles
    .filter((file) => file.extension === ".atlas")
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath, "zh-CN"));
  const jsonFiles = localFiles
    .filter((file) => file.extension === ".json")
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath, "zh-CN"));
  const usedJsonPaths = new Set();
  const lookup = buildLocalFileLookup(localFiles);

  for (let index = 0; index < atlasFiles.length; index += 1) {
    const atlasFile = atlasFiles[index];
    const jsonFile = pickLocalJsonFile(atlasFile, jsonFiles, usedJsonPaths);
    const displayName = stripFileExtension(atlasFile.fileName) || `spine_${index + 1}`;

    if (!jsonFile) {
      skipped.push({ id: displayName, reason: "缺少 atlas 或 json。" });
      continue;
    }

    usedJsonPaths.add(jsonFile.relativePath);

    const atlasText = decodeUtf8Buffer(atlasFile.buffer);
    const jsonText = decodeUtf8Buffer(jsonFile.buffer);
    const pageNames = parseAtlasPages(atlasText);
    const imagePaths = [];
    const missingPages = [];
    let imageByteSize = 0;
    const stagedFiles = [
      createFileRecord(atlasFile.relativePath, atlasFile.buffer, atlasFile.contentType),
      createFileRecord(jsonFile.relativePath, jsonFile.buffer, jsonFile.contentType)
    ];
    const stagedPathSet = new Set([atlasFile.relativePath, jsonFile.relativePath]);

    for (const pageName of pageNames) {
      const imageFile = findBestLocalImageEntry(pageName, atlasFile.relativePath, lookup);
      if (!imageFile) {
        missingPages.push(pageName);
        continue;
      }

      imagePaths.push(imageFile.relativePath);
      imageByteSize += imageFile.buffer.length;
      if (stagedPathSet.has(imageFile.relativePath)) {
        continue;
      }

      stagedPathSet.add(imageFile.relativePath);
      stagedFiles.push(createFileRecord(imageFile.relativePath, imageFile.buffer, imageFile.contentType));
    }

    if (missingPages.length) {
      skipped.push({
        id: displayName,
        reason: `缺少贴图资源: ${missingPages.join(", ")}`
      });
      continue;
    }

    for (const file of stagedFiles) {
      fileStore.set(file.path, {
        buffer: file.buffer,
        contentType: file.contentType
      });
    }

    const detectedVersion = detectSpineVersion(jsonText);
    const skinHints = extractSkinHints(jsonText);
    const preferredRenderSize = extractPreferredRenderSize(jsonText, atlasText);
    const groupId = `local_group_${index + 1}`;

    groups.push({
      id: groupId,
      fileName: displayName,
      module: atlasFile.dir,
      atlasUrl: buildCacheUrl(sessionId, atlasFile.relativePath),
      jsonUrl: buildCacheUrl(sessionId, jsonFile.relativePath),
      atlasPath: atlasFile.relativePath,
      jsonPath: jsonFile.relativePath,
      imagePaths,
      imageByteSize,
      viewportX: preferredRenderSize.x,
      viewportY: preferredRenderSize.y,
      viewportWidth: preferredRenderSize.viewportWidth,
      viewportHeight: preferredRenderSize.viewportHeight,
      hasViewportOrigin: preferredRenderSize.hasViewportOrigin,
      renderWidth: preferredRenderSize.width,
      renderHeight: preferredRenderSize.height,
      usesPremultipliedAlpha: extractAtlasPma(atlasText),
      detectedVersion,
      runtimeCandidates: pickRuntimeCandidates(detectedVersion),
      animationHints: extractAnimationNameHints(jsonText),
      skinHints,
      preferredSkinName: pickPreferredSkinName(skinHints),
      files: stagedFiles.map((file) => file.path)
    });
  }

  groups.sort(compareGroupsByImageSize);

  return {
    id: sessionId,
    targetUrl: safeSegment(sourceLabel) || "local_spine",
    archiveName: buildArchiveName(sourceLabel || "local_spine"),
    createdAt: Date.now(),
    groups,
    skipped,
    files: fileStore
  };
}

function buildSessionPayload(session) {
  return {
    sessionId: session.id,
    targetUrl: session.targetUrl,
    archiveName: session.archiveName,
    groupCount: session.groups.length,
    skippedCount: session.skipped.length,
    groups: session.groups.map((group) => ({
      id: group.id,
      fileName: group.fileName,
      module: group.module,
      atlasUrl: group.atlasUrl,
      jsonUrl: group.jsonUrl,
      imageByteSize: Number(group.imageByteSize || 0),
      viewportX: Number(group.viewportX || 0),
      viewportY: Number(group.viewportY || 0),
      viewportWidth: Number(group.viewportWidth || 0),
      viewportHeight: Number(group.viewportHeight || 0),
      hasViewportOrigin: Boolean(group.hasViewportOrigin),
      renderWidth: Number(group.renderWidth || 0),
      renderHeight: Number(group.renderHeight || 0),
      usesPremultipliedAlpha: group.usesPremultipliedAlpha,
      detectedVersion: group.detectedVersion,
      runtimeCandidates: group.runtimeCandidates,
      animationHints: group.animationHints,
      skinHints: group.skinHints,
      preferredSkinName: group.preferredSkinName
    })),
    skipped: session.skipped
  };
}

function pruneSessions() {
  const now = Date.now();
  for (const [sessionId, session] of sessionStore.entries()) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      sessionStore.delete(sessionId);
    }
  }
}

setInterval(pruneSessions, 5 * 60 * 1000).unref();

async function collectResources(targetUrl) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    const html = await fetchHtml(targetUrl);
    await page.goto(runnerUrl, { waitUntil: "domcontentloaded" });
    await page.addScriptTag({ url: REGENERATOR_RUNTIME_CDN });
    await page.addScriptTag({ path: path.join(ROOT, "extractor-core.js") });

    return await page.evaluate(async ({ sourceHtml, url }) => {
      return window.spineGifExtractorCore.collectPageResourcesFromHtml(sourceHtml, url);
    }, { sourceHtml: html, url: targetUrl });
  } finally {
    await page.close();
  }
}

async function handleExtract(res, targetUrl, preferredArchiveBaseName = "") {
  const collected = await collectResources(targetUrl);
  const sessionId = randomUUID();
  const session = await buildSessionData(sessionId, targetUrl, collected, preferredArchiveBaseName);

  sessionStore.set(sessionId, session);
  sendJson(res, 200, buildSessionPayload(session));
}

async function handleLocalPreview(req, res) {
  const formData = await readFormData(req);
  const manifestText = String(formData.get("manifest") || "").trim();
  let manifest = [];

  try {
    manifest = JSON.parse(manifestText || "[]");
  } catch {
    sendText(res, 400, "Invalid upload manifest.");
    return;
  }

  if (!Array.isArray(manifest) || !manifest.length) {
    sendText(res, 400, "请先选择本地文件或文件夹。");
    return;
  }

  const uploadedFiles = [];
  for (const item of manifest) {
    if (!item || !item.fieldName) {
      continue;
    }

    const file = formData.get(String(item.fieldName));
    if (!file || typeof file.arrayBuffer !== "function") {
      continue;
    }

    uploadedFiles.push({
      name: String(item.name || file.name || ""),
      relativePath: String(item.relativePath || item.name || file.name || ""),
      buffer: Buffer.from(await file.arrayBuffer())
    });
  }

  if (!uploadedFiles.length) {
    sendText(res, 400, "没有收到可用的本地文件。");
    return;
  }

  const sessionId = randomUUID();
  const session = await buildLocalSessionData(sessionId, uploadedFiles, "local_spine");
  sessionStore.set(sessionId, session);
  sendJson(res, 200, buildSessionPayload(session));
}

function handleAssetRequest(req, res, requestUrl) {
  const parts = requestUrl.pathname.split("/").filter(Boolean);
  const sessionIndex = parts.indexOf("sessions");
  const filesIndex = parts.indexOf("files");

  if (sessionIndex < 0 || filesIndex < 0 || filesIndex <= sessionIndex + 1) {
    sendText(res, 404, "Not found.");
    return;
  }

  const sessionId = decodeUrlPathSegment(parts[sessionIndex + 1]);
  const session = sessionStore.get(sessionId);
  if (!session) {
    sendText(res, 404, "Session expired or not found.");
    return;
  }

  const resourceParts = parts.slice(filesIndex + 1).map(decodeUrlPathSegment);
  const resourcePath = sanitizeRelativePath(resourceParts.join("/"));
  const asset = session.files.get(resourcePath);

  if (!asset) {
    sendText(res, 404, "Asset not found.");
    return;
  }

  res.writeHead(200, {
    "Content-Type": asset.contentType,
    "Cache-Control": "no-store"
  });
  res.end(asset.buffer);
}

async function handleDownload(req, res) {
  const rawBody = await readBody(req);
  let payload;

  try {
    payload = JSON.parse(rawBody || "{}");
  } catch {
    sendText(res, 400, "Invalid JSON body.");
    return;
  }

  const sessionId = String(payload.sessionId || "").trim();
  const requestedGroupIds = Array.isArray(payload.groupIds) ? payload.groupIds.map((item) => String(item)) : [];
  const requestedGroupRenames = payload && typeof payload.groupRenames === "object" && payload.groupRenames
    ? payload.groupRenames
    : {};
  const session = sessionStore.get(sessionId);

  if (!session) {
    sendText(res, 404, "Session expired or not found.");
    return;
  }

  const selectedGroups = session.groups.filter((group) => requestedGroupIds.includes(group.id));
  if (!selectedGroups.length) {
    sendText(res, 400, "Please select at least one Spine item.");
    return;
  }

  const zipFile = new yazl.ZipFile();
  const archiveName = String(session.archiveName || buildArchiveName(session.targetUrl));

  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(archiveName)}`,
    "Cache-Control": "no-store"
  });

  zipFile.outputStream.pipe(res);

  const usedArchiveNames = new Set();
  const usedGroupBaseNames = new Set();

  for (const group of selectedGroups) {
    const preferredName = sanitizeArchiveBaseName(requestedGroupRenames[group.id] || "");
    const archiveEntries = buildFlatArchiveEntries(
      group,
      session.files,
      usedArchiveNames,
      usedGroupBaseNames,
      preferredName
    );

    for (const entry of archiveEntries) {
      zipFile.addBuffer(entry.buffer, entry.archivePath);
    }
  }

  zipFile.end();

  await new Promise((resolve, reject) => {
    res.on("finish", resolve);
    res.on("close", resolve);
    res.on("error", reject);
  });
}

function serveStatic(req, res) {
  const requestUrl = new URL(req.url, "http://127.0.0.1");
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = path.join(ROOT, pathname);

  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendText(res, 404, "Not found.");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    "Cache-Control": "no-store"
  });

  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, "http://127.0.0.1");

    if (req.method === "GET" && requestUrl.pathname === "/__runner__") {
      sendText(
        res,
        200,
        "<!doctype html><html><head><meta charset=\"utf-8\"></head><body><div id=\"runner\"></div></body></html>",
        "text/html; charset=utf-8"
      );
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        sessions: sessionStore.size
      });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/vendor/gif.worker.js") {
      await proxyRemoteScript(res, GIF_WORKER_CDN_URL);
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/extract") {
      const rawBody = await readBody(req);
      let payload;

      try {
        payload = JSON.parse(rawBody || "{}");
      } catch {
        sendText(res, 400, "Invalid JSON body.");
        return;
      }

      const targetUrl = String(payload.url || "").trim();
      const archiveBaseName = String(payload.archiveBaseName || "").trim();
      if (!/^https?:\/\//i.test(targetUrl)) {
        sendText(res, 400, "Please provide a valid http/https URL.");
        return;
      }

      await handleExtract(res, targetUrl, archiveBaseName);
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/local-preview") {
      await handleLocalPreview(req, res);
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/download") {
      await handleDownload(req, res);
      return;
    }

    if (req.method === "GET" && requestUrl.pathname.startsWith("/api/sessions/")) {
      handleAssetRequest(req, res, requestUrl);
      return;
    }

    if (req.method === "GET") {
      serveStatic(req, res);
      return;
    }

    sendText(res, 405, "Method not allowed.");
  } catch (error) {
    console.error("[server-error]", error);
    if (!res.headersSent) {
      sendText(res, 500, String(error && error.message ? error.message : error));
    } else {
      res.end();
    }
  }
});

server.on("error", (error) => {
  if (error && error.code === "EADDRINUSE") {
    console.error(`端口占用：${HOST}:${PORT} 已被其他进程使用。`);
    console.error("请先关闭已运行的旧实例，或改用其他端口后再启动。");
    process.exit(1);
  }

  console.error("[server-listen-error]", error);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const actualHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  runnerUrl = `http://${actualHost}:${PORT}/__runner__`;
  console.log(`Server running at http://${actualHost}:${PORT}`);
});

process.on("SIGINT", async () => {
  await closeBrowser();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closeBrowser();
  process.exit(0);
});
