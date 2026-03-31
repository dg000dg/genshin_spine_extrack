(function () {
  "use strict";

  function basename(url) {
    if (url.indexOf("data:") === 0) {
      return "";
    }
    return url.split("/").pop();
  }

  function sanitizeResourcePath(resourcePath) {
    return String(resourcePath || "").replace(/\\/g, "/").split("#")[0].split("?")[0];
  }

  function filenameFromPath(resourcePath) {
    const clean = sanitizeResourcePath(resourcePath);
    return clean.split("/").pop() || "";
  }

  function extensionFromPath(resourcePath) {
    const file = filenameFromPath(resourcePath);
    const match = file.match(/\.([^.]+)$/);
    return match ? match[1].toLowerCase() : "";
  }

  function stripWebpackHash(fileName) {
    const pieces = String(fileName || "").split(".");
    const ext = pieces.pop();
    const basePieces = pieces.filter(Boolean);

    if (basePieces.length >= 2 && /^[a-f0-9]{6,}$/i.test(basePieces[basePieces.length - 1])) {
      basePieces.pop();
    }

    return ext ? basePieces.join(".") + "." + ext : basePieces.join(".");
  }

  function normalizeResourceFileName(resourcePath) {
    return stripWebpackHash(filenameFromPath(resourcePath));
  }

  function inferModuleName(resourcePath) {
    const clean = sanitizeResourcePath(resourcePath);
    if (!clean) return "";
    if (clean.includes("/spine/")) return "spine";

    const parts = clean.split("/").filter(Boolean);
    if (parts.length >= 2) {
      return parts[parts.length - 2];
    }

    return "";
  }

  function dedupeResources(resources) {
    const seen = new Set();
    return resources.filter((resource) => {
      if (!resource || !resource.src) {
        return false;
      }

      const key = String(resource.id || "") + "@@" + resource.src;
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
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

  function readInlineExpression(source, startIndex) {
    let index = startIndex;
    while (index < source.length && /\s/.test(source[index])) {
      index += 1;
    }

    const expressionStart = index;
    let stringQuote = "";
    let escaped = false;
    let parenDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;

    for (; index < source.length; index += 1) {
      const char = source[index];
      const nextChar = source[index + 1];

      if (stringQuote) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === stringQuote) {
          stringQuote = "";
        }
        continue;
      }

      if (char === "\"" || char === "'" || char === "`") {
        stringQuote = char;
        continue;
      }

      if (char === "/" && nextChar === "*") {
        index += 2;
        while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
          index += 1;
        }
        index += 1;
        continue;
      }

      if (char === "/" && nextChar === "/") {
        index += 2;
        while (index < source.length && source[index] !== "\n") {
          index += 1;
        }
        continue;
      }

      if (char === "(") {
        parenDepth += 1;
        continue;
      }
      if (char === ")") {
        parenDepth -= 1;
        continue;
      }
      if (char === "[") {
        bracketDepth += 1;
        continue;
      }
      if (char === "]") {
        bracketDepth -= 1;
        continue;
      }
      if (char === "{") {
        braceDepth += 1;
        continue;
      }
      if (char === "}") {
        if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
          break;
        }
        braceDepth -= 1;
        continue;
      }
      if (char === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        break;
      }
    }

    return {
      expression: source.slice(expressionStart, index).trim(),
      endIndex: index
    };
  }

  function evaluateInlineExpression(expression) {
    if (!expression) return undefined;

    try {
      return Function("\"use strict\"; return (" + expression + ");")();
    } catch (_error) {
      return undefined;
    }
  }

  function extractSourceDeclaredResources(modules) {
    const capturedResources = {};

    Object.keys(modules).forEach((key) => {
      const source = modules[key].toString();
      if (!/\.(atlas|json)\b/i.test(source)) {
        return;
      }

      const resourcePattern = /["']([^"']+\.(?:atlas|json))["']\s*:/gi;
      let match;

      while ((match = resourcePattern.exec(source))) {
        const resourcePath = sanitizeResourcePath(match[1]);
        const ext = extensionFromPath(resourcePath);
        const parsed = readInlineExpression(source, resourcePattern.lastIndex);
        const value = evaluateInlineExpression(parsed.expression);

        if (ext === "atlas" && typeof value !== "string") {
          continue;
        }
        if (ext === "json" && (!value || typeof value !== "object")) {
          continue;
        }

        capturedResources[resourcePath] = value;
        resourcePattern.lastIndex = parsed.endIndex;
      }
    });

    return capturedResources;
  }

  function extractCapturedSpines(capturedResources) {
    const spineManifest = {};
    const mainManifest = [];
    const imageByFileName = {};

    Object.entries(capturedResources).forEach(([resourcePath, value]) => {
      const clean = sanitizeResourcePath(resourcePath);
      const ext = extensionFromPath(clean);
      const fileName = filenameFromPath(clean);
      const normalizedFileName = normalizeResourceFileName(clean);

      if (["png", "jpg", "jpeg", "webp"].includes(ext) && typeof value === "string") {
        const imageRecord = {
          id: normalizedFileName.replace(/\.[^.]+$/, ""),
          src: value,
          module: inferModuleName(clean)
        };
        imageByFileName[fileName] = imageRecord;
        imageByFileName[normalizedFileName] = imageRecord;
        return;
      }

      if (!["atlas", "json"].includes(ext)) {
        return;
      }

      const id = fileName.replace(/\.[^.]+$/, "");
      if (!spineManifest[id]) {
        spineManifest[id] = {
          module: inferModuleName(clean)
        };
      }

      spineManifest[id][ext] = value;
      if (!spineManifest[id].module) {
        spineManifest[id].module = inferModuleName(clean);
      }
    });

    Object.entries(spineManifest).forEach(([id, entry]) => {
      if (!entry.atlas || !entry.json) {
        delete spineManifest[id];
        return;
      }

      parseAtlasPages(entry.atlas).forEach((pageName) => {
        const imageRecord = imageByFileName[pageName] || imageByFileName[normalizeResourceFileName(pageName)];
        if (!imageRecord) {
          return;
        }

        mainManifest.push({
          id: imageRecord.id,
          src: imageRecord.src,
          module: entry.module || imageRecord.module || ""
        });
      });
    });

    return {
      SPINE_MANIFEST: spineManifest,
      MAIN_MANIFEST: dedupeResources(mainManifest)
    };
  }

  function extractCapturedStaticFiles(capturedResources) {
    return dedupeResources(
      Object.entries(capturedResources)
        .filter(([resourcePath, value]) => {
          if (typeof value !== "string") {
            return false;
          }
          const ext = extensionFromPath(resourcePath);
          return !["atlas", "json"].includes(ext);
        })
        .map(([resourcePath, value]) => {
          const normalized = normalizeResourceFileName(resourcePath);
          return {
            id: normalized.replace(/\.[^.]+$/, ""),
            src: value,
            _module: "captured"
          };
        })
    );
  }

  function extractInlineSpines(modules, webpackRequire) {
    const spineManifest = {};
    const mainManifest = [];
    const inlinePattern = /(?:["']([^"']+)["']|([A-Za-z_$][A-Za-z0-9_$]*)):\{atlas:[A-Za-z_$][A-Za-z0-9_$]*\((\d+)\),json:[A-Za-z_$][A-Za-z0-9_$]*\((\d+)\)\}/g;
    const inlineArrayPattern = /(?:id|spineId)\s*:\s*["']([^"']+)["'][\s\S]{0,320}?atlas\s*:\s*[A-Za-z_$][A-Za-z0-9_$]*\((\d+)\)\s*,\s*json\s*:\s*[A-Za-z_$][A-Za-z0-9_$]*\((\d+)\)\s*,\s*(?:img|images)\s*:\s*\[([\s\S]{0,1200}?)\]/g;
    const inlineImagePattern = /src\s*:\s*[A-Za-z_$][A-Za-z0-9_$]*\((\d+)\)(?:[\s\S]{0,120}?id\s*:\s*["']([^"']+)["'])?/g;

    function unwrapRequiredValue(value, kind) {
      if (typeof value === "string") {
        return value;
      }
      if (value && typeof value === "object") {
        if (typeof value.default === "string") {
          return value.default;
        }
        if (kind === "json") {
          try {
            return JSON.stringify(value);
          } catch (_error) {
            return "";
          }
        }
      }
      return "";
    }

    Object.keys(modules).forEach((key) => {
      const source = modules[key].toString();
      if (!source.includes(":{atlas:") || !source.includes(",json:")) {
        if (!(source.includes("atlas:") && source.includes("json:") && source.includes("id:"))) {
          return;
        }
      }

      for (const match of source.matchAll(inlinePattern)) {
        const spineId = match[1] || match[2];
        const atlasModuleId = match[3];
        const jsonModuleId = match[4];

        try {
          const atlas = unwrapRequiredValue(webpackRequire(atlasModuleId), "atlas");
          const json = unwrapRequiredValue(webpackRequire(jsonModuleId), "json");
          if (!atlas || !json) {
            continue;
          }

          spineManifest[spineId] = {
            atlas,
            json,
            module: "spine"
          };
        } catch (error) {
          console.warn("[extractInlineSpines] failed to resolve", spineId, error);
        }
      }

      for (const match of source.matchAll(inlineArrayPattern)) {
        const spineId = match[1];
        const atlasModuleId = match[2];
        const jsonModuleId = match[3];
        const imageBlock = String(match[4] || "");

        try {
          const atlas = unwrapRequiredValue(webpackRequire(atlasModuleId), "atlas");
          const json = unwrapRequiredValue(webpackRequire(jsonModuleId), "json");
          if (!atlas || !json) {
            continue;
          }

          spineManifest[spineId] = {
            atlas,
            json,
            module: "spine"
          };

          for (const imageMatch of imageBlock.matchAll(inlineImagePattern)) {
            const imageModuleId = imageMatch[1];
            const declaredId = imageMatch[2];
            const src = unwrapRequiredValue(webpackRequire(imageModuleId), "image");
            if (!src) {
              continue;
            }
            const fallbackId = normalizeResourceFileName(basename(src)).replace(/\.[^.]+$/, "") || spineId;
            mainManifest.push({
              id: declaredId || fallbackId,
              src,
              module: "spine"
            });
          }
        } catch (error) {
          console.warn("[extractInlineSpines] failed to resolve inline array spine", spineId, error);
        }
      }
    });

    return {
      SPINE_MANIFEST: spineManifest,
      MAIN_MANIFEST: dedupeResources(mainManifest)
    };
  }

  function matchSpineImagesFromStatic(spineManifest, staticResources) {
    const staticById = {};

    staticResources.forEach((resource) => {
      staticById[resource.id] = resource;
    });

    const matches = [];

    Object.entries(spineManifest).forEach(([_spineId, entry]) => {
      parseAtlasPages(entry.atlas).forEach((pageName) => {
        const pageId = normalizeResourceFileName(pageName).replace(/\.[^.]+$/, "");
        const resource = staticById[pageId];
        if (!resource) {
          return;
        }

        matches.push({
          id: resource.id,
          src: resource.src,
          module: entry.module || resource._module || ""
        });
      });
    });

    return dedupeResources(matches);
  }

  function createWebpackRequire(modules, base, runtimeGlobal) {
    const installedModules = {};

    function __webpack_require__(moduleId) {
      if (installedModules[moduleId]) return installedModules[moduleId].exports;

      const module = installedModules[moduleId] = {
        exports: {},
        id: moduleId,
        loaded: false
      };

      if (!modules[moduleId]) return "";

      modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
      module.loaded = true;
      return module.exports;
    }

    __webpack_require__.m = modules;
    __webpack_require__.amdO = {};

    __webpack_require__.r = function (exports) {
      if (typeof Symbol !== "undefined" && Symbol.toStringTag) {
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
      }
      Object.defineProperty(exports, "__esModule", { value: true });
    };

    __webpack_require__.o = function (object, property) {
      return Object.prototype.hasOwnProperty.call(object, property);
    };

    __webpack_require__.d = function (exports, name, getter) {
      if (!getter) {
        const definition = name;
        for (const key in definition) {
          if (__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
            Object.defineProperty(exports, key, {
              enumerable: true,
              get: definition[key]
            });
          }
        }
        return;
      }

      if (!__webpack_require__.o(exports, name)) {
        Object.defineProperty(exports, name, { enumerable: true, get: getter });
      }
    };

    __webpack_require__.n = function (module) {
      const getter = module && module.__esModule
        ? function () { return module.default; }
        : function () { return module; };
      __webpack_require__.d(getter, { a: getter });
      return getter;
    };

    __webpack_require__.g = (function () {
      if (runtimeGlobal && typeof runtimeGlobal === "object") {
        return runtimeGlobal;
      }
      if (typeof globalThis === "object") {
        return globalThis;
      }
      try {
        return this || Function("return this")();
      } catch (_error) {
        if (typeof window === "object") {
          return window;
        }
        return {};
      }
    })();

    __webpack_require__.nmd = function (module) {
      module.paths = [];
      if (!module.children) {
        module.children = [];
      }
      return module;
    };

    __webpack_require__.h = function () {
      return "";
    };

    __webpack_require__.u = function (chunkId) {
      return String(chunkId) + ".js";
    };

    __webpack_require__.e = function () {
      return Promise.resolve();
    };

    __webpack_require__.c = installedModules;
    __webpack_require__.p = base;

    return __webpack_require__;
  }

  function extractLegacySpines(insideModules) {
    const spines = [];
    const mains = [];

    const isLegacyManifestKey = (key) => {
      return typeof key === "string" && (key.includes("_MANIFEST") || key.startsWith("MANIFEST_"));
    };

    const getLegacyManifestName = (key) => {
      if (typeof key !== "string") {
        return "";
      }
      if (key.startsWith("MANIFEST_")) {
        return key.slice("MANIFEST_".length);
      }
      return key.replace("_MANIFEST", "");
    };

    const checkManifestValue = (value, name) => {
      const key = Array.isArray(value) ? 0 : Object.keys(value)[0];
      let candidate = value[key];
      if (!candidate) return;

      if (typeof candidate !== "object") {
        candidate = value;
      }

      if (candidate.atlas && candidate.json) {
        spines.push(value);
        Object.values(value).forEach((entry) => {
          entry.module = name || entry.module || "";
        });
        return;
      }

      if (candidate.id && candidate.src && candidate.type) {
        mains.push(value);
        value.forEach((entry) => {
          entry.module = name || entry.module || "";
        });
      }
    };

    insideModules.forEach((mod) => {
      Object.keys(mod).forEach((key) => {
        if (!isLegacyManifestKey(key)) {
          return;
        }

        const manifest = mod[key];
        const name = getLegacyManifestName(key);

        if (Array.isArray(manifest)) {
          checkManifestValue(manifest, "_" + name);
        } else if (Object.values(manifest)[0] && Object.values(manifest)[0].atlas) {
          checkManifestValue(manifest, name);
        } else {
          Object.values(manifest).forEach((entry) => checkManifestValue(entry, name));
        }
      });
    });

    let mainList = mains.reduce((buffer, entry) => entry.concat(buffer), []);
    mainList = mainList.filter((entry) => {
      if (mainList.find((other) => entry.src === other.src) && entry.module.startsWith("_")) {
        return false;
      }
      return true;
    });

    return {
      SPINE_MANIFEST: spines.reduce((buffer, entry) => Object.assign(entry, buffer), {}),
      MAIN_MANIFEST: mainList
    };
  }

  function extractSpine(modules, url, runtimeWindow) {
    const maybeFuncs = [];

    Object.keys(modules).forEach((key) => {
      const moduleFactory = modules[key];
      const source = moduleFactory.toString();
      if (source.includes("atlas:") && source.includes("json:")) {
        maybeFuncs.push(key);
      }
    });

    const webpackRequire = createWebpackRequire(modules, url, runtimeWindow);
    const insideModules = [];
    const capturedResources = {};
    const originalDefineProperty = runtimeWindow.Object.defineProperty;
    const originalAssign = runtimeWindow.Object.assign;

    runtimeWindow.Object.defineProperty = function (target, property, descriptor) {
      if (property === "__esModule") {
        insideModules.push(target);
      }
      return originalDefineProperty(target, property, descriptor);
    };

    runtimeWindow.Object.assign = function () {
      const args = Array.from(arguments);

      args.forEach((arg) => {
        if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
          return;
        }

        Object.keys(arg).forEach((resourcePath) => {
          if (/\.(atlas|json|png|jpg|jpeg|webp)$/i.test(resourcePath)) {
            capturedResources[sanitizeResourcePath(resourcePath)] = arg[resourcePath];
          }
        });
      });

      return originalAssign.apply(this, args);
    };

    try {
      maybeFuncs.forEach((key) => {
        try {
          webpackRequire(key);
        } catch (error) {
          console.warn("[extractSpine] failed to execute module", key, error);
        }
      });
    } finally {
      runtimeWindow.Object.defineProperty = originalDefineProperty;
      runtimeWindow.Object.assign = originalAssign;
    }

    const legacy = extractLegacySpines(insideModules);
    const captured = extractCapturedSpines(capturedResources);
    const sourceDeclared = extractCapturedSpines(extractSourceDeclaredResources(modules));
    const inline = extractInlineSpines(modules, webpackRequire);

    return {
      SPINE_MANIFEST: Object.assign(
        {},
        sourceDeclared.SPINE_MANIFEST,
        captured.SPINE_MANIFEST,
        inline.SPINE_MANIFEST,
        legacy.SPINE_MANIFEST
      ),
      MAIN_MANIFEST: dedupeResources([]
        .concat(sourceDeclared.MAIN_MANIFEST || [])
        .concat(legacy.MAIN_MANIFEST || [])
        .concat(captured.MAIN_MANIFEST || [])
        .concat(inline.MAIN_MANIFEST || [])
      ),
      CAPTURED_RESOURCES: capturedResources
    };
  }

  function extractStaticFiles(modules, base) {
    const matches = [];

    Object.keys(modules).forEach((key) => {
      const moduleFactory = modules[key];
      const source = moduleFactory.toString();
      const match = source.match(/[a-zA-Z0-9]\.exports\s?=\s?([a-zA-Z0-9]\.[a-zA-Z0-9]\s?\+)?\s?"(.*?)"/);

      if (!match) {
        return;
      }

      const url = match[2];
      if (!url.startsWith("data:") && !match[1]) {
        return;
      }

      let fileBaseName = basename(url);
      if (fileBaseName) {
        fileBaseName = normalizeResourceFileName(fileBaseName).replace(/\.[^.]+$/, "");
      } else {
        fileBaseName = key
          .replace(/\//g, "_")
          .replace(/\./g, "_")
          .replace(/\:/g, "_")
          .replace(/\+/g, "_");
      }

      matches.push({
        id: fileBaseName,
        src: url.includes("data:") ? url : new URL(url, base).toString(),
        _module: key
      });
    });

    return matches;
  }

  function prepareHtmlForIframe(html, url) {
    let preparedHtml = html;

    if (preparedHtml.includes("webpackJsonp")) {
      preparedHtml = preparedHtml.replace(/<script type="text\/javascript">/g, "<script type=\"text/dontexecute\">");
    } else {
      let entryName = "";
      const chunkCandidates = [];
      try {
        const eventMatch = String(new URL(url).pathname || "").match(/\/event\/([^/?#]+)/i);
        if (eventMatch && eventMatch[1]) {
          const token = String(eventMatch[1]).split("-")[0].replace(/[^A-Za-z0-9_$]/g, "");
          if (token) {
            chunkCandidates.push(`webpackChunk${token}`);
          }
        }
      } catch (_error) {
      }

      if (preparedHtml.includes("Symbol.toStringTag") && preparedHtml.includes("Object.defineProperty")) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(preparedHtml, "text/html");
        const scripts = doc.querySelectorAll("script");

        scripts.forEach((script) => {
          if (
            script.src.includes("sentry") ||
            script.textContent.includes("Sentry") ||
            script.textContent.includes("firebase")
          ) {
            script.type = "text/dontexecute";
          }

          if (script.textContent.includes("Symbol.toStringTag") && script.textContent.includes("Object.defineProperty")) {
            script.type = "text/dontexecute";
            const matches = Array.from(script.textContent.matchAll(/self\.(.*?)=self.(.*?)\|\|\[\]/g));
            for (const match of matches) {
              if (match[1] === match[2] && !entryName) {
                entryName = match[1];
              }
            }
          }
        });

        preparedHtml = doc.documentElement.outerHTML;
      }

      preparedHtml = preparedHtml.replace(
        "</head>",
        "<script>\n" +
          "window.webpackJsonp_ = [];\n" +
          "window.cachedModules = [];\n" +
          "window.loadedModules = [];\n" +
          "window.__chunkCandidates = " + JSON.stringify(chunkCandidates) + ";\n" +
          "window.__hookWebpackChunk = (name) => {\n" +
          "  if (!name) return;\n" +
          "  let target = [];\n" +
          "  const proxy = new Proxy({}, {\n" +
          "    get: (_obj, prop) => {\n" +
          "      if (prop === 'push') {\n" +
          "        return (...entries) => {\n" +
          "          cachedModules.push(...entries);\n" +
          "          return target.push(...entries);\n" +
          "        };\n" +
          "      }\n" +
          "      return target[prop];\n" +
          "    },\n" +
          "    set: (_obj, prop, value) => {\n" +
          "      target[prop] = value;\n" +
          "      return true;\n" +
          "    }\n" +
          "  });\n" +
          "  Object.defineProperty(window, name, {\n" +
          "    configurable: true,\n" +
          "    enumerable: false,\n" +
          "    get: () => proxy,\n" +
          "    set: (value) => {\n" +
          "      target = Array.isArray(value) ? value : [];\n" +
          "      if (Array.isArray(value)) {\n" +
          "        cachedModules.push(...value);\n" +
          "      }\n" +
          "    }\n" +
          "  });\n" +
          "};\n" +
          "window.__chunkCandidates.forEach(window.__hookWebpackChunk);\n" +
          "window.webpackJsonpProxy = new Proxy(webpackJsonp_, {\n" +
          "  get: (target, prop) => {\n" +
          "    if (prop === 'push') {\n" +
          "      return (...args) => {\n" +
          "        cachedModules.push(...args);\n" +
          "      };\n" +
          "    }\n" +
          "    if (prop in target) {\n" +
          "      return target[prop];\n" +
          "    }\n" +
          "    return undefined;\n" +
          "  },\n" +
          "  set: (target, prop, value) => {\n" +
          "    if (prop === 'push') {\n" +
          "      value(['inject', {\n" +
          "        inject(module, exports, __webpack_require__) {\n" +
          "          loadedModules = __webpack_require__.m;\n" +
          "        }\n" +
          "      }, [['inject']]]);\n" +
          "      return true;\n" +
          "    }\n" +
          "    target[prop] = value;\n" +
          "    return true;\n" +
          "  }\n" +
          "});\n" +
          "Object.defineProperty(window, '" + (entryName || "webpackJsonp") + "', {\n" +
          "  value: webpackJsonpProxy,\n" +
          "  writable: true,\n" +
          "  enumerable: false,\n" +
          "  configurable: false\n" +
          "});\n" +
          "</script></head>"
      );
    }

    let base = url;
    const matchVendors = preparedHtml.match(/src=\"([^\"]*?)(vendors[^\"]*?\.js)\"/);
    if (matchVendors) {
      base = matchVendors[1] || ".";
    }

    if (!base.includes("://")) {
      base = new URL(base || ".", url).toString();
    }

    preparedHtml = preparedHtml.replace("<head>", "<head><base href=\"" + base + "\">");

    return {
      html: preparedHtml,
      base
    };
  }

  async function loadHtmlInIframe(html, url) {
    const prepared = prepareHtmlForIframe(html, url);
    const iframe = document.createElement("iframe");
    iframe.srcdoc = prepared.html;
    iframe.style.display = "none";
    document.body.appendChild(iframe);

    return new Promise((resolve) => {
      iframe.onload = function () {
        resolve({ iframe, base: prepared.base });
      };
    });
  }

  function extractModulesFromChunkEntries(entries) {
    const modules = {};
    if (!Array.isArray(entries)) {
      return modules;
    }

    entries.forEach((entry) => {
      if (!Array.isArray(entry) || !entry[1] || typeof entry[1] !== "object") {
        return;
      }
      Object.assign(modules, entry[1]);
    });

    return modules;
  }

  function extractModulesFromChunkSource(source) {
    const sandbox = {};
    try {
      Function("self", "window", "globalThis", source)(sandbox, sandbox, sandbox);
    } catch (_error) {
      return {};
    }

    const modules = {};
    Object.keys(sandbox).forEach((key) => {
      if (!/^webpackChunk/i.test(key)) {
        return;
      }
      const chunkEntries = sandbox[key];
      Object.assign(modules, extractModulesFromChunkEntries(chunkEntries));
    });
    return modules;
  }

  async function extractModulesFromFrame(frame) {
    if (frame.contentWindow.cachedModules) {
      let modules = Object.assign({}, frame.contentWindow.loadedModules);
      for (const item of frame.contentWindow.cachedModules) {
        modules = Object.assign({}, modules, item[1]);
      }
      return modules;
    }

    const webpackJsonp = frame.contentWindow.webpackJsonp;
    const vendors = webpackJsonp && webpackJsonp.find((entry) => entry[0].includes("vendors"));
    if (vendors) {
      const index = webpackJsonp.find((entry) => entry[0].includes("index"));
      if (!index) {
        throw new Error("Load index.js failed.");
      }

      const runtime = webpackJsonp.find((entry) => entry[0].includes("runtime"));
      return Object.assign({}, vendors[1], index[1], runtime ? runtime[1] : {});
    }

    const modulesFromWindowChunks = {};
    Object.keys(frame.contentWindow).forEach((key) => {
      if (!/^webpackChunk/i.test(key)) {
        return;
      }
      const entries = frame.contentWindow[key];
      Object.assign(modulesFromWindowChunks, extractModulesFromChunkEntries(entries));
    });
    if (Object.keys(modulesFromWindowChunks).length) {
      return modulesFromWindowChunks;
    }

    const scriptTags = Array.from(frame.contentDocument.querySelectorAll("script[src]"));
    const modulesFromScriptSources = {};
    for (const scriptTag of scriptTags) {
      const src = scriptTag && scriptTag.src ? scriptTag.src : "";
      if (!src) {
        continue;
      }

      try {
        const response = await fetch(src);
        const source = await response.text();
        Object.assign(modulesFromScriptSources, extractModulesFromChunkSource(source));
      } catch (_error) {
      }
    }

    if (Object.keys(modulesFromScriptSources).length) {
      return modulesFromScriptSources;
    }

    throw new Error("Failed to extract webpack modules from frame.");
  }

  function normalizeSpineId(value, fallback) {
    const base = String(value || "")
      .trim()
      .replace(/[^\w.-]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return base || fallback;
  }

  function collectSpineNodesFromPuzzle(node, platform, collector) {
    if (!node || typeof node !== "object") {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item) => collectSpineNodesFromPuzzle(item, platform, collector));
      return;
    }

    if (node.name === "@puzzle/spine-player" && node.options && Array.isArray(node.options.spineList)) {
      collector.push({
        platform,
        spineList: node.options.spineList
      });
    }

    if (Array.isArray(node.nodes)) {
      collectSpineNodesFromPuzzle(node.nodes, platform, collector);
    }
    if (Array.isArray(node.children)) {
      collectSpineNodesFromPuzzle(node.children, platform, collector);
    }
  }

  function extractPuzzleSpines(runtimeWindow) {
    const result = {
      SPINE_MANIFEST: {},
      MAIN_MANIFEST: []
    };

    if (!runtimeWindow || typeof runtimeWindow !== "object") {
      return result;
    }

    const configCandidates = [];
    const directConfig = runtimeWindow.PUZZLE_RENDER_CONFIG;
    if (directConfig && typeof directConfig === "object") {
      configCandidates.push(directConfig);
    }

    Object.keys(runtimeWindow).forEach((key) => {
      if (!/^PUZZLE_CONFIG_/i.test(key)) {
        return;
      }
      const value = runtimeWindow[key];
      if (value && typeof value === "object") {
        configCandidates.push(value);
      }
    });

    if (!configCandidates.length) {
      return result;
    }

    const spineNodes = [];
    configCandidates.forEach((config) => {
      collectSpineNodesFromPuzzle(config && config.pc ? config.pc : null, "pc", spineNodes);
      collectSpineNodesFromPuzzle(config && config.h5 ? config.h5 : null, "h5", spineNodes);
      collectSpineNodesFromPuzzle(config, "global", spineNodes);
    });

    if (!spineNodes.length) {
      return result;
    }

    const seenPair = new Set();
    const idCounts = {};
    let fallbackIndex = 0;

    spineNodes.forEach((entry) => {
      const platform = entry.platform || "puzzle";
      const spineList = Array.isArray(entry.spineList) ? entry.spineList : [];

      spineList.forEach((item) => {
        const manifest = item && item.manifest && typeof item.manifest === "object"
          ? item.manifest
          : null;
        if (!manifest) {
          return;
        }

        const atlas = typeof manifest.atlas === "string" ? manifest.atlas : "";
        const json = typeof manifest.json === "string" ? manifest.json : "";
        if (!atlas || !json) {
          return;
        }

        const pairKey = `${atlas}@@${json}`;
        if (seenPair.has(pairKey)) {
          return;
        }
        seenPair.add(pairKey);

        fallbackIndex += 1;
        const rawId = item.spineName || manifest.name || item.spineId || `puzzle_spine_${fallbackIndex}`;
        const normalizedBaseId = normalizeSpineId(rawId, `puzzle_spine_${fallbackIndex}`);
        const nextCount = (idCounts[normalizedBaseId] || 0) + 1;
        idCounts[normalizedBaseId] = nextCount;
        const manifestId = nextCount > 1 ? `${normalizedBaseId}_${nextCount}` : normalizedBaseId;

        result.SPINE_MANIFEST[manifestId] = {
          atlas,
          json,
          module: `puzzle_${platform}`
        };

        const images = Array.isArray(manifest.img) ? manifest.img : [];
        images.forEach((image, imageIndex) => {
          if (!image) {
            return;
          }

          const src = typeof image.src === "string" ? image.src : (typeof image === "string" ? image : "");
          if (!src) {
            return;
          }

          const imageId = normalizeSpineId(
            image.id || `${manifestId}_img_${imageIndex + 1}`,
            `${manifestId}_img_${imageIndex + 1}`
          );

          result.MAIN_MANIFEST.push({
            id: imageId,
            src,
            module: `puzzle_${platform}`
          });
        });
      });
    });

    result.MAIN_MANIFEST = dedupeResources(result.MAIN_MANIFEST);
    return result;
  }

  async function collectPageResourcesFromHtml(html, url) {
    const loaded = await loadHtmlInIframe(html, url);
    const frame = loaded.iframe;
    const base = loaded.base;

    if (typeof regeneratorRuntime !== "undefined") {
      frame.contentWindow.regeneratorRuntime = regeneratorRuntime;
    }

    const moduleBase = new URL(".", base).toString();
    let modules = {};
    let spineResult = {
      SPINE_MANIFEST: {},
      MAIN_MANIFEST: [],
      CAPTURED_RESOURCES: {}
    };
    let staticResult = [];

    try {
      modules = await extractModulesFromFrame(frame);
    } catch (_error) {
      modules = {};
    }

    if (Object.keys(modules).length) {
      spineResult = extractSpine(modules, moduleBase, frame.contentWindow);
      staticResult = dedupeResources(
        extractStaticFiles(modules, moduleBase).concat(extractCapturedStaticFiles(spineResult.CAPTURED_RESOURCES))
      );

      spineResult.MAIN_MANIFEST = dedupeResources(
        spineResult.MAIN_MANIFEST.concat(matchSpineImagesFromStatic(spineResult.SPINE_MANIFEST, staticResult))
      );
    }

    const puzzleResult = extractPuzzleSpines(frame.contentWindow);
    spineResult.SPINE_MANIFEST = Object.assign(
      {},
      spineResult.SPINE_MANIFEST || {},
      puzzleResult.SPINE_MANIFEST || {}
    );
    spineResult.MAIN_MANIFEST = dedupeResources(
      (spineResult.MAIN_MANIFEST || []).concat(puzzleResult.MAIN_MANIFEST || [])
    );

    frame.remove();

    return {
      spineres: {
        SPINE_MANIFEST: spineResult.SPINE_MANIFEST,
        MAIN_MANIFEST: spineResult.MAIN_MANIFEST
      },
      staticres: staticResult,
      base: moduleBase
    };
  }

  async function collectPageResources(url) {
    const response = await fetch(url);
    const html = await response.text();
    return collectPageResourcesFromHtml(html, url);
  }

  window.spineGifExtractorCore = {
    collectPageResources,
    collectPageResourcesFromHtml
  };
})();
