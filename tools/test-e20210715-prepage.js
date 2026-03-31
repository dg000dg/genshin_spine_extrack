#!/usr/bin/env node
"use strict";

const { chromium } = require("playwright-core");

const DEFAULT_APP_URL = "http://127.0.0.1:3770";
const DEFAULT_TARGET_URL = "https://webstatic.mihoyo.com/ys/event/e20210715-prepage/index.html";
const DEFAULT_GROUPS = new Set(["shenli", "xiao", "zaoyo"]);

function buildViewport(group) {
  const width = Number(group && (group.viewportWidth || group.renderWidth) || 0);
  const height = Number(group && (group.viewportHeight || group.renderHeight) || 0);
  const x = Number(group && group.viewportX);
  const y = Number(group && group.viewportY);

  if (!group || !group.hasViewportOrigin || !Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(x) || !Number.isFinite(y)) {
    return undefined;
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

async function extractSession(appUrl, targetUrl) {
  const response = await fetch(`${appUrl}/api/extract`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({ url: targetUrl })
  });

  if (!response.ok) {
    throw new Error(`提取失败: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function run() {
  const appUrl = process.argv[2] || DEFAULT_APP_URL;
  const targetUrl = process.argv[3] || DEFAULT_TARGET_URL;
  const session = await extractSession(appUrl, targetUrl);
  const targetGroups = (session.groups || []).filter((group) => DEFAULT_GROUPS.has(group.fileName));

  if (!targetGroups.length) {
    throw new Error("没有找到 shenli/xiao/zaoyo 这几个目标资源。");
  }

  const browser = await chromium.launch({
    headless: true,
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await page.goto(`${appUrl}/`, { waitUntil: "networkidle", timeout: 120000 });

    const report = [];
    for (const group of targetGroups) {
      const result = await page.evaluate(async ({ appUrl, group }) => {
        const runtime = window.SpineRuntimeRegistry && window.SpineRuntimeRegistry["4.2"];
        if (!runtime || typeof runtime.SpinePlayer !== "function") {
          throw new Error("页面里没有可用的 4.2 Spine runtime。");
        }

        const host = document.createElement("div");
        host.style.width = "720px";
        host.style.height = "720px";
        host.style.position = "fixed";
        host.style.left = "-9999px";
        host.style.top = "0";
        document.body.appendChild(host);

        const viewport = (function buildViewportFromGroup(value) {
          const width = Number(value && (value.viewportWidth || value.renderWidth) || 0);
          const height = Number(value && (value.viewportHeight || value.renderHeight) || 0);
          const x = Number(value && value.viewportX);
          const y = Number(value && value.viewportY);
          if (!value || !value.hasViewportOrigin || !Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(x) || !Number.isFinite(y)) {
            return undefined;
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
        })(group);

        const player = await new Promise((resolve, reject) => {
          new runtime.SpinePlayer(host, {
            atlasUrl: `${appUrl}${group.atlasUrl}`,
            jsonUrl: `${appUrl}${group.jsonUrl}`,
            showControls: false,
            showLoading: false,
            backgroundColor: "09131b",
            viewport,
            success: resolve,
            error: (_instance, message) => reject(new Error(message || "资源加载失败"))
          });
        });

        const readBounds = () => {
          const offset = new runtime.Vector2();
          const size = new runtime.Vector2();
          try {
            player.skeleton.updateWorldTransform(runtime.Physics.update);
            player.skeleton.getBounds(offset, size, []);
          } catch (_error) {
            return null;
          }

          const bounds = {
            x: Number(offset.x),
            y: Number(offset.y),
            width: Number(size.x),
            height: Number(size.y)
          };

          if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) {
            return null;
          }

          return bounds;
        };

        const setupBounds = readBounds();
        const firstAnimation = player.skeleton && player.skeleton.data && Array.isArray(player.skeleton.data.animations) && player.skeleton.data.animations[0]
          ? player.skeleton.data.animations[0].name
          : "";

        let animatedBounds = null;
        let animatedError = "";

        if (firstAnimation) {
          try {
            player.animationState.setAnimation(0, firstAnimation, true);
            player.animationState.update(0.1);
            player.animationState.apply(player.skeleton);
            animatedBounds = readBounds();
          } catch (error) {
            animatedError = String(error && error.message || error);
          }
        }

        try {
          player.dispose();
        } catch (_disposeError) {
        }
        host.remove();

        const setupArea = setupBounds ? setupBounds.width * setupBounds.height : 0;
        const animatedArea = animatedBounds ? animatedBounds.width * animatedBounds.height : 0;

        return {
          fileName: group.fileName,
          detectedVersion: group.detectedVersion || "",
          firstAnimation,
          setupBounds,
          animatedBounds,
          animatedError,
          safe: Boolean(animatedBounds) && (!setupArea || animatedArea >= setupArea * 0.2)
        };
      }, { appUrl, group });

      report.push(result);
    }

    console.log(JSON.stringify({
      targetUrl,
      sessionId: session.sessionId,
      groupCount: session.groupCount,
      checked: report
    }, null, 2));
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
