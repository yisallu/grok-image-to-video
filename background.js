// background.js — service worker
// 1) 把网页图片用 OffscreenCanvas 统一重编码成 JPEG(修复 WebP/PNG/带透明通道等被 xAI 拒绝的问题)
// 2) 异步调用 VPS 代理:SUBMIT 拿 request_id,POLL 查询 /status(每个请求都短,避开 Cloudflare 100s 上限)

const DEFAULTS = {
  endpoint: "https://your-proxy.example.com/i2v",
  secret: "",
  duration: 6,
  resolution: "720p",
  aspectRatio: "auto",
  prompt:
    "Animate this image into a high-quality cinematic video. Strictly preserve the original subject, composition, colors, background, and identity/details. Use subtle natural motion and gentle camera movement. Do not morph, distort, redraw, change identity, add text, add new objects, or alter the scene.",
};

const ASPECTS = {
  "1:1": 1, "16:9": 16 / 9, "9:16": 9 / 16, "4:3": 4 / 3,
  "3:4": 3 / 4, "3:2": 3 / 2, "2:3": 2 / 3,
};

async function getSettings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...s };
}

// ===== 并发取号(跨标签页共享,放在 background;轮询式,SW 被回收也安全)=====
const SLOT_TTL = 10 * 60 * 1000; // 安全过期:10 分钟没释放的号自动回收
const activeSlots = new Map(); // token -> 占用时间

// 把并发上限缓存成同步变量,取号时无需 await,保证「判断+占号」原子,避免击穿上限
let concurrencyLimit = 3;
function clampLimit(v) {
  let n = parseInt(v, 10);
  if (isNaN(n)) n = 3;
  return Math.max(1, Math.min(10, n));
}
chrome.storage.sync.get({ concurrency: 3 }).then((s) => { concurrencyLimit = clampLimit(s.concurrency); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.concurrency) concurrencyLimit = clampLimit(changes.concurrency.newValue);
});

function cleanupSlots() {
  const now = Date.now();
  for (const [t, ts] of activeSlots) if (now - ts > SLOT_TTL) activeSlots.delete(t);
}

function nearestAspect(w, h) {
  if (!w || !h) return "16:9";
  const r = w / h;
  let best = "16:9", bestDiff = Infinity;
  for (const [name, val] of Object.entries(ASPECTS)) {
    const diff = Math.abs(val - r);
    if (diff < bestDiff) { bestDiff = diff; best = name; }
  }
  return best;
}

function bytesToB64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// 临时用 declarativeNetRequest 给本次抓图请求注入 Referer(伪装成从页面访问),
// 让浏览器用住宅 IP + 正确 Referer 去抓,绕开 gelbooru 等防盗链。用完即删规则。
let drnRuleSeq = 1;
async function fetchWithReferer(src, referer) {
  const ruleId = 8000 + ((drnRuleSeq++) % 1000);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [
      {
        id: ruleId,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "referer", operation: "set", value: referer }],
        },
        condition: { urlFilter: src, resourceTypes: ["xmlhttprequest"] },
      },
    ],
  });
  try {
    return await fetch(src, { cache: "no-store" });
  } finally {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
  }
}

// 取图 blob:① 浏览器缓存(图片已加载过,零联网) → ② 带 Referer 抓(住宅IP,绕防盗链)
//          → ③ 普通抓。都在浏览器端完成,不受机房 IP 封锁影响。
async function fetchImageBlob(src, referer) {
  // ① 缓存命中最省事
  try {
    const r = await fetch(src, { cache: "force-cache" });
    if (r.ok) {
      const b = await r.blob();
      if (b.size > 0) return b;
    }
  } catch (_) {}
  // ② 注入 Referer 再抓(仅 http(s);file:// 等不能用 DNR 规则)
  if (referer && /^https?:/.test(src)) {
    try {
      const r = await fetchWithReferer(src, referer);
      if (r.ok) {
        const b = await r.blob();
        if (b.size > 0) return b;
      }
    } catch (_) {}
  }
  // ③ 兜底:普通抓
  const r3 = await fetch(src);
  if (!r3.ok) throw new Error(`图片下载失败 (${r3.status})`);
  return await r3.blob();
}

// 抓取图片 → 解码 → 缩放(最长边 1280)→ 重编码为 JPEG(白底铺平透明)→ base64 data URI
async function fetchAsJpegDataUri(src, referer, maxSide = 1280) {
  const blob = await fetchImageBlob(src, referer);

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (e) {
    throw new Error("无法解码图片(可能是受保护或特殊格式)");
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; // JPEG 无透明通道,先铺白底
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();

  const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
  const buf = await outBlob.arrayBuffer();
  return { dataUri: "data:image/jpeg;base64," + bytesToB64(buf), w, h };
}

async function doSubmit(msg) {
  const settings = await getSettings();
  if (!settings.endpoint) throw new Error("未配置代理地址,请在设置页填写。");

  const body = {
    prompt: settings.prompt,
    duration: Number(settings.duration),
    resolution: settings.resolution,
  };

  // 取图。优先用内容脚本 canvas 直取的结果(本地 file:// / 同源图);
  // 否则后台抓取重编码;再不行交给服务端带 Referer 代抓。
  let encW = msg.naturalWidth, encH = msg.naturalHeight;
  if (msg.imageDataUri) {
    body.image_b64 = msg.imageDataUri;
  } else {
    try {
      const enc = await fetchAsJpegDataUri(msg.src, msg.pageUrl);
      body.image_b64 = enc.dataUri;
      encW = enc.w; encH = enc.h;
    } catch (e) {
      if (/^https?:/.test(msg.src)) {
        // 防盗链/CORS:让服务端带 Referer 代抓
        body.image_url = msg.src;
        if (msg.pageUrl) body.referer = msg.pageUrl;
      } else if (/^file:/.test(msg.src)) {
        throw new Error(
          "本地图片无法读取。请在 chrome://extensions → 本扩展「详细信息」→ 打开「允许访问文件网址」,或改用网页上的图片。"
        );
      } else {
        throw e;
      }
    }
  }

  body.aspect_ratio =
    settings.aspectRatio === "auto" ? nearestAspect(encW, encH) : settings.aspectRatio;

  const headers = { "Content-Type": "application/json" };
  if (settings.secret) headers["Authorization"] = `Bearer ${settings.secret}`;

  // 遇到 xAI 限流(429 / rate limit)自动退避重试,最多 4 次
  const backoffs = [4000, 8000, 16000];
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(settings.endpoint, {
      method: "POST", headers, body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => null);
    if (!data) throw new Error(`代理返回异常 (${resp.status})`);
    if (data.success) return data.request_id;

    const err = String(data.error || "");
    const rateLimited = /\b429\b|rate.?limit|too many/i.test(err);
    if (rateLimited && attempt < backoffs.length) {
      await new Promise((r) => setTimeout(r, backoffs[attempt]));
      continue; // 退避后重试
    }
    throw new Error(data.error || "提交失败");
  }
}

async function doPoll(requestId) {
  const settings = await getSettings();
  const statusUrl = settings.endpoint.replace(/\/i2v\/?$/, "/status") + "?id=" + encodeURIComponent(requestId);
  const headers = {};
  if (settings.secret) headers["Authorization"] = `Bearer ${settings.secret}`;
  const resp = await fetch(statusUrl, { headers });
  const data = await resp.json().catch(() => null);
  if (!data) throw new Error(`状态查询异常 (${resp.status})`);
  return data; // {success, status, video_url?, error?}
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "TRY_ACQUIRE") {
    cleanupSlots();
    // 同步 check-and-set,无 await → 原子,不会被并发击穿
    if (activeSlots.size < concurrencyLimit) {
      const token = Date.now() + "-" + Math.random().toString(36).slice(2);
      activeSlots.set(token, Date.now());
      sendResponse({ granted: true, token });
    } else {
      sendResponse({ granted: false, active: activeSlots.size, limit: concurrencyLimit });
    }
    return; // 同步响应
  }
  if (msg?.type === "RELEASE") {
    if (msg.token) activeSlots.delete(msg.token);
    sendResponse({ ok: true });
    return; // 同步
  }
  if (msg?.type === "SUBMIT") {
    doSubmit(msg)
      .then((request_id) => sendResponse({ ok: true, request_id }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (msg?.type === "POLL") {
    doPoll(msg.request_id)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (msg?.type === "CAPTURE_TAB") {
    // 截当前可见标签页(渲染像素,绕开 file:///跨域/canvas 污染);需 <all_urls> 主机权限
    const windowId = sender.tab?.windowId;
    const cap = windowId != null
      ? chrome.tabs.captureVisibleTab(windowId, { format: "png" })
      : chrome.tabs.captureVisibleTab({ format: "png" });
    cap.then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg?.type === "FETCH_VIDEO") {
    // 后台抓视频字节(SW 有 <all_urls>,不受 CORS 限制),供内容脚本走 blob: 抓帧
    (async () => {
      try {
        const r = await fetch(msg.url);
        if (!r.ok) throw new Error(`视频下载失败 (${r.status})`);
        const buf = await r.arrayBuffer();
        if (buf.byteLength > 25 * 1024 * 1024) throw new Error("视频过大(>25MB)");
        const mime = r.headers.get("content-type") || "video/mp4";
        sendResponse({ ok: true, b64: bytesToB64(buf), mime });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  }
});
