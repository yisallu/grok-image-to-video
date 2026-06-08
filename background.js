// background.js — service worker
// 1) 把网页图片用 OffscreenCanvas 统一重编码成 JPEG(修复 WebP/PNG/带透明通道等被 xAI 拒绝的问题)
// 2) 异步调用视频 API:SUBMIT 拿 request_id,POLL 查询状态(每个请求都短,避开 Cloudflare 100s 上限)

// 可选的本地私有配置(config.local.js,不进 git):提供 endpoint/secret 默认值,
// 这样公开仓库保持占位符、本地无需手填。文件不存在则忽略。
try { importScripts("config.local.js"); } catch (_) {}
const LOCAL = self.LOCAL_CONFIG || {};
const LOCAL_RAW_ENDPOINT = String(LOCAL.endpoint || "");
const LOCAL_ENDPOINT_IS_LEGACY = /^https:\/\/i2v\.5203333\.xyz\/i2v\/?$/i.test(LOCAL_RAW_ENDPOINT);
const LOCAL_ENDPOINT_IS_PROXY = /\/i2v\/?$/i.test(LOCAL_RAW_ENDPOINT) && !LOCAL_ENDPOINT_IS_LEGACY;
const DEFAULT_ENDPOINT = LOCAL_ENDPOINT_IS_LEGACY
  ? "https://api.5203333.xyz"
  : (LOCAL.endpoint || "https://api.5203333.xyz");
const DEFAULT_SECRET = LOCAL_ENDPOINT_IS_PROXY ? (LOCAL.secret || "") : (LOCAL.apiKey || "");

const DEFAULTS = {
  endpoint: DEFAULT_ENDPOINT,
  secret: DEFAULT_SECRET,
  model: LOCAL.model || "grok-imagine-video-1.5-preview",
  telegramBotToken: LOCAL.telegramBotToken || "",
  telegramChatId: LOCAL.telegramChatId || LOCAL.tgChatId || "",
  archiveUrl: LOCAL.archiveUrl || "",
  archiveToken: LOCAL.archiveToken || "",
  duration: 6,
  resolution: "720p",
  aspectRatio: "auto",
  prompt:
    "Animate this image into a high-quality cinematic video. Strictly preserve the original subject, composition, colors, background, and identity/details. Use subtle natural motion and gentle camera movement. Do not morph, distort, redraw, change identity, add text, add new objects, or alter the scene.",
  promptRight: "", // 右 Alt 用的提示词;留空则回退用左 Alt 的 prompt
};

const HISTORY_KEY = "promptHistory";
const HISTORY_KEY_R = "promptHistoryRight";
const FAILURE_STATUSES = new Set([
  "failed", "error", "expired", "cancelled", "canceled", "timeout", "timed_out",
  "rejected", "blocked", "denied", "refused", "not_allowed", "disallowed",
  "aborted", "moderation_failed", "moderation_rejected",
  "content_policy_violation", "content_policy_error", "policy_violation",
  "policy_rejected", "policy_blocked", "content_rejected", "content_blocked",
  "safety_failed", "safety_rejected", "safety_violation", "safety_blocked",
  "review_failed", "failed_review",
]);
const PROCESSING_STATUSES = new Set(["", "queued", "pending", "processing", "running", "in_progress", "reviewing", "in_review"]);
const MODERATION_RE = /moderation.?failed|failed.?moderation|moderation.?rejected|content.?policy|policy.?violation|policy.?rejected|policy.?blocked|safety.?failed|failed.?safety|safety.?rejected|safety.?violation|review.?failed|failed.?review|rejected|blocked|denied|refused|not.?allowed|disallowed|violation|审查(未通过|失败|拒绝)|安全(未通过|失败|拒绝)|政策|违规|拒绝/i;

const ASPECTS = {
  "1:1": 1, "16:9": 16 / 9, "9:16": 9 / 16, "4:3": 4 / 3,
  "3:4": 3 / 4, "3:2": 3 / 2, "2:3": 2 / 3,
};

async function getSettings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  const settings = { ...DEFAULTS, ...s };
  if (isLegacyI2vEndpoint(settings.endpoint)) {
    settings.endpoint = DEFAULTS.endpoint;
    settings.secret = DEFAULT_SECRET;
    chrome.storage.sync.set({ endpoint: DEFAULTS.endpoint, secret: DEFAULT_SECRET }).catch(() => {});
  }
  return settings;
}

function cleanEndpoint(endpoint) {
  let value = String(endpoint || "").trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) value = "https://" + value;
  return value.replace(/\/+$/, "");
}

function isLegacyI2vEndpoint(endpoint) {
  return /^https:\/\/i2v\.5203333\.xyz\/i2v\/?$/i.test(String(endpoint || "").trim());
}

function videoEndpoint(endpoint) {
  const base = cleanEndpoint(endpoint);
  if (!base) return null;
  if (/\/i2v$/i.test(base)) {
    return {
      kind: "proxy",
      submitUrl: base,
      statusUrl: (id) => base.replace(/\/i2v$/i, "/status") + "?id=" + encodeURIComponent(id),
    };
  }
  let submitUrl = base;
  if (/\/v1$/i.test(submitUrl)) submitUrl += "/videos/generations";
  else if (!/\/v1\/videos\/generations$/i.test(submitUrl)) submitUrl += "/v1/videos/generations";
  const apiBase = submitUrl.replace(/\/videos\/generations$/i, "");
  return {
    kind: "api",
    submitUrl,
    statusUrl: (id) => apiBase + "/videos/" + encodeURIComponent(id),
  };
}

function errText(data, fallback = "请求失败") {
  const err = data && data.error;
  if (typeof err === "string") return err;
  if (err && typeof err.message === "string") return err.message;
  if (err && typeof err.code === "string") return err.code;
  if (data && typeof data.message === "string") return data.message;
  if (data && typeof data.reason === "string") return data.reason;
  if (data && typeof data.failure_reason === "string") return data.failure_reason;
  if (data && typeof data.detail === "string") return data.detail;
  if (data && typeof data.details === "string") return data.details;
  return fallback;
}

async function readJsonOrText(resp) {
  const text = await resp.text().catch(() => "");
  if (!text) return { data: null, text: "" };
  try {
    return { data: JSON.parse(text), text };
  } catch (_) {
    return { data: null, text };
  }
}

function responseSnippet(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean ? `: ${clean.slice(0, 160)}` : "";
}

function apiPayloadFromProxyBody(body, settings) {
  const payload = {
    model: settings.model || DEFAULTS.model,
    prompt: body.prompt || DEFAULTS.prompt,
    duration: body.duration,
    resolution: body.resolution,
    aspect_ratio: body.aspect_ratio,
  };
  const imageUrl = body.image_b64 || body.image_url;
  if (imageUrl) payload.image = { url: imageUrl };
  return payload;
}

function isFailureStatus(status) {
  return FAILURE_STATUSES.has(String(status || "").toLowerCase());
}

function failureSignalText(data) {
  if (!data || typeof data !== "object") return "";
  const parts = [
    data.status,
    data.message,
    data.reason,
    data.failure_reason,
    data.detail,
    data.details,
  ];
  const err = data.error;
  if (typeof err === "string") parts.push(err);
  else if (err && typeof err === "object") {
    parts.push(err.message, err.reason, err.code, err.type, err.detail, err.details);
  }
  return parts.filter(Boolean).join(" ");
}

function hasModerationFailureText(data) {
  return MODERATION_RE.test(failureSignalText(data));
}

function hasErrorPayload(data) {
  if (!data || !Object.prototype.hasOwnProperty.call(data, "error")) return false;
  const err = data.error;
  if (err === null || err === undefined || err === "") return false;
  if (typeof err === "object" && Object.keys(err).length === 0) return false;
  return true;
}

function normalizeFailureStatus(data, fallback = "上游返回失败") {
  const raw = String((data && data.status) || "").toLowerCase();
  const msg = errText(data, raw ? `状态 ${raw}` : fallback);
  const moderation = MODERATION_RE.test(`${raw} ${msg}`);
  return {
    success: false,
    status: raw || "error",
    error: moderation ? `x.ai 审查未通过:${msg}` : msg,
  };
}

function normalizeApiStatus(data) {
  const raw = String((data && data.status) || "").toLowerCase();
  const videoUrl = data?.video_url || data?.url || data?.video?.url;
  if (videoUrl) {
    return {
      success: true,
      status: "done",
      video_url: videoUrl,
      duration: data?.duration || data?.video?.duration,
      usage: data?.usage,
    };
  }
  if (raw === "done" || raw === "succeeded" || raw === "completed") {
    return { success: false, status: "error", error: "完成但无视频 URL" };
  }
  if (data?.success === false || hasErrorPayload(data) || isFailureStatus(raw) || hasModerationFailureText(data)) {
    return normalizeFailureStatus(data);
  }
  if (PROCESSING_STATUSES.has(raw)) {
    return { success: true, status: raw || "processing" };
  }
  return { success: true, status: raw || "processing" };
}

function normalizeProxyStatus(data) {
  const raw = String((data && data.status) || "").toLowerCase();
  const videoUrl = data?.video_url || data?.url || data?.video?.url;
  if (videoUrl || (raw === "done" && videoUrl)) {
    return { ...data, success: true, status: "done", video_url: videoUrl };
  }
  if (raw === "done" || raw === "succeeded" || raw === "completed") {
    return { success: false, status: "error", error: "完成但无视频 URL" };
  }
  if (data?.success === false || hasErrorPayload(data) || isFailureStatus(raw) || hasModerationFailureText(data)) {
    return normalizeFailureStatus(data);
  }
  if (PROCESSING_STATUSES.has(raw)) {
    return { success: true, status: raw || "processing" };
  }
  return { success: true, status: raw || "processing" };
}

function effectivePrompt(settings, altSide, promptOverride) {
  if (promptOverride !== undefined && promptOverride !== null) {
    const override = String(promptOverride).trim();
    if (override) return override;
  }
  const value = altSide === "right" ? (settings.promptRight || settings.prompt) : settings.prompt;
  return String(value || DEFAULTS.prompt).trim();
}

function telegramCaption(settings, altSide, promptOverride) {
  const prompt = effectivePrompt(settings, altSide, promptOverride);
  let cap = `Grok 图生视频\n${settings.aspectRatio || "auto"} · ${settings.resolution || ""} · ${settings.duration || ""}s`;
  const pr = String(prompt || "").trim();
  if (pr) cap += "\n" + pr.slice(0, 300);
  return cap;
}

async function postTelegramForm(token, method, form) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    body: form,
  });
  const data = await resp.json().catch(() => null);
  return !!(resp.ok && data && data.ok);
}

async function pushTelegram(msg) {
  const settings = await getSettings();
  const endpointInfo = videoEndpoint(settings.endpoint);
  if (!endpointInfo || endpointInfo.kind !== "api") return { ok: true, skipped: true };
  const token = String(settings.telegramBotToken || "").trim();
  const chatId = String(settings.telegramChatId || "").trim();
  const videoUrl = String(msg.video_url || msg.videoUrl || "").trim();
  if (!token || !chatId || !videoUrl) return { ok: true, skipped: true };

  const caption = telegramCaption(settings, msg.altSide, msg.prompt);

  try {
    const imageDataUri = String(msg.imageDataUri || "");
    if (imageDataUri.startsWith("data:")) {
      const blob = await (await fetch(imageDataUri)).blob();
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("caption", "源图 / source");
      form.append("photo", blob, "source.jpg");
      await postTelegramForm(token, "sendPhoto", form);
    }
  } catch (_) {}

  let ok = false;
  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("video", videoUrl);
    form.append("caption", caption);
    ok = await postTelegramForm(token, "sendVideo", form);
  } catch (_) {}

  if (!ok) {
    const resp = await fetch(videoUrl);
    if (!resp.ok) throw new Error(`Telegram 推送失败:视频下载失败 (${resp.status})`);
    const blob = await resp.blob();
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("caption", caption);
    form.append("video", blob, "video.mp4");
    ok = await postTelegramForm(token, "sendVideo", form);
  }

  if (!ok) throw new Error("Telegram 推送失败:Bot API 返回失败");
  return { ok: true };
}

function rememberTelegramJob(requestId, msg, endpointInfo) {
  if (!requestId || !endpointInfo || endpointInfo.kind !== "api") return;
  telegramJobs.set(requestId, {
    imageDataUri: msg.imageDataUri || "",
    altSide: msg.altSide || "left",
    prompt: msg.prompt,
    pushed: false,
    pushing: false,
    created: Date.now(),
  });
}

function cleanupTelegramJobs() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of telegramJobs) {
    if ((job.created || 0) < cutoff) telegramJobs.delete(id);
  }
}

async function maybePushTelegram(requestId, data) {
  if (!data || data.status !== "done" || !data.video_url) return;
  const job = telegramJobs.get(requestId);
  if (!job || job.pushed || job.pushing) return;
  job.pushing = true;
  try {
    await pushTelegram({ ...job, video_url: data.video_url });
    job.pushed = true;
  } catch (err) {
    job.pushing = false;
    console.warn("telegram push failed", err);
  } finally {
    if (job.pushed) setTimeout(() => telegramJobs.delete(requestId), 5 * 60 * 1000);
  }
}

async function pushTelegramForRequest(msg) {
  const requestId = msg.request_id || msg.requestId || "";
  const videoUrl = msg.video_url || msg.videoUrl || "";
  const job = telegramJobs.get(requestId);
  if (job) {
    if (job.pushed || job.pushing) return { ok: true, skipped: true };
    job.pushing = true;
    try {
      await pushTelegram({ ...job, video_url: videoUrl });
      job.pushed = true;
      setTimeout(() => telegramJobs.delete(requestId), 5 * 60 * 1000);
      return { ok: true };
    } catch (err) {
      job.pushing = false;
      throw err;
    }
  }
  return await pushTelegram(msg);
}

function archiveSubmitUrl(url) {
  const base = cleanEndpoint(url);
  if (!base) return "";
  if (/\/api\/videos$/i.test(base)) return base;
  return base + "/api/videos";
}

function archivePrompt(settings, altSide, promptOverride) {
  return effectivePrompt(settings, altSide, promptOverride);
}

async function pushArchive(msg) {
  const settings = await getSettings();
  const submitUrl = archiveSubmitUrl(settings.archiveUrl);
  const token = String(settings.archiveToken || "").trim();
  const videoUrl = String(msg.video_url || msg.videoUrl || "").trim();
  if (!submitUrl || !token || !videoUrl) return { ok: true, skipped: true };

  const payload = {
    video_url: videoUrl,
    source_image: msg.imageDataUri || "",
    source_url: msg.src || "",
    page_url: msg.pageUrl || "",
    request_id: msg.request_id || msg.requestId || "",
    alt_side: msg.altSide || "left",
    prompt: archivePrompt(settings, msg.altSide, msg.prompt),
    model: settings.model || DEFAULTS.model,
    duration: Number(settings.duration) || DEFAULTS.duration,
    resolution: settings.resolution || DEFAULTS.resolution,
    aspect_ratio: settings.aspectRatio || DEFAULTS.aspectRatio,
  };

  const resp = await fetch(submitUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data?.ok) throw new Error(errText(data, `归档失败 (${resp.status})`));
  return data;
}

async function promptForSide(msg) {
  const settings = await getSettings();
  const altSide = msg.altSide === "right" ? "right" : "left";
  return { ok: true, altSide, prompt: effectivePrompt(settings, altSide) };
}

async function savePromptForSide(msg) {
  const altSide = msg.altSide === "right" ? "right" : "left";
  const prompt = String(msg.prompt ?? "").trim();
  const promptKey = altSide === "right" ? "promptRight" : "prompt";
  const historyKey = altSide === "right" ? HISTORY_KEY_R : HISTORY_KEY;

  await chrome.storage.sync.set({ [promptKey]: prompt });

  if (prompt) {
    const r = await chrome.storage.local.get({ [historyKey]: [] });
    let list = Array.isArray(r[historyKey]) ? r[historyKey] : [];
    list = list.filter((p) => p !== prompt);
    list.unshift(prompt);
    await chrome.storage.local.set({ [historyKey]: list });
  }

  return { ok: true, altSide, prompt };
}

// 待处理任务:content 抓好图 → START_JOB 暂存于此 → 进度页 GET_JOB 取走
const pendingJobs = new Map(); // jobId -> { src, pageUrl, imageDataUri, naturalWidth, naturalHeight }
const telegramJobs = new Map(); // requestId -> { imageDataUri, altSide, pushed, created }

// ===== 并发取号(跨标签页共享,放在 background;轮询式,SW 被回收也安全)=====
const SLOT_TTL = 7 * 60 * 1000; // 安全过期:超时未释放的号自动回收(略大于 6 分钟生成超时)
const activeSlots = new Map(); // token -> { ts, tabId }  绑定进度标签页,关页即释放

// 进度标签页被关闭时,自动释放它占用的所有并发槽(避免关掉未完成的页导致槽泄漏、卡"排队中")
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [token, info] of activeSlots) {
    if (info && info.tabId === tabId) activeSlots.delete(token);
  }
});

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
  for (const [t, info] of activeSlots) if (now - (info?.ts || 0) > SLOT_TTL) activeSlots.delete(t);
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

// 把图(data URI)按原比例放进"指定目标比例"画布、四周补黑边 → 画面零拉伸。
async function letterboxToAspect(dataUri, aspect, maxSide = 1280) {
  const blob = await (await fetch(dataUri)).blob();
  const bmp = await createImageBitmap(blob);
  const iw = bmp.width, ih = bmp.height;
  const [aw, ah] = String(aspect).split(":").map(Number);
  const targetRatio = (aw && ah) ? aw / ah : iw / ih;

  // 目标画布尺寸:在 maxSide 限制内,保持目标比例
  let cw, ch;
  if (targetRatio >= 1) { cw = maxSide; ch = Math.round(maxSide / targetRatio); }
  else { ch = maxSide; cw = Math.round(maxSide * targetRatio); }

  // 原图等比缩放后居中放入(contain),四周留黑边
  const scale = Math.min(cw / iw, ch / ih);
  const dw = Math.round(iw * scale), dh = Math.round(ih * scale);
  const dx = Math.round((cw - dw) / 2), dy = Math.round((ch - dh) / 2);

  const canvas = new OffscreenCanvas(cw, ch);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000000"; // 黑边
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(bmp, 0, 0, iw, ih, dx, dy, dw, dh);
  if (bmp.close) bmp.close();

  const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
  const buf = await outBlob.arrayBuffer();
  return { dataUri: "data:image/jpeg;base64," + bytesToB64(buf) };
}

// 选最接近原图的目标比例,再 letterbox(补黑边、零拉伸)。返回 { dataUri, aspect }。
async function letterboxToNearestAspect(dataUri, maxSide = 1280) {
  const blob = await (await fetch(dataUri)).blob();
  const bmp = await createImageBitmap(blob);
  const aspect = nearestAspect(bmp.width, bmp.height);
  if (bmp.close) bmp.close();
  const { dataUri: out } = await letterboxToAspect(dataUri, aspect, maxSide);
  return { dataUri: out, aspect };
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
  const endpointInfo = videoEndpoint(settings.endpoint);
  if (!endpointInfo) throw new Error("代理地址无效,请在设置页填写。");

  // 弹窗确认的本次 prompt 优先;没有携带时再按左/右 Alt 设置回退。
  const chosenPrompt = effectivePrompt(settings, msg.altSide, msg.prompt);
  const body = {
    prompt: chosenPrompt,
    duration: Number(settings.duration),
    resolution: settings.resolution,
  };

  // 取图。优先用内容脚本 canvas 直取的结果(本地 file:// / 同源图);
  // 否则后台抓取重编码;再不行交给服务端带 Referer 代抓。
  let rawDataUri = msg.imageDataUri || null;
  if (!rawDataUri) {
    try {
      const enc = await fetchAsJpegDataUri(msg.src, msg.pageUrl);
      rawDataUri = enc.dataUri;
    } catch (e) {
      if (/^https?:/.test(msg.src)) {
        // 防盗链/CORS:让服务端带 Referer 代抓(此分支无法本地 letterbox,交服务端按比例处理)
        body.image_url = msg.src;
        if (msg.pageUrl) body.referer = msg.pageUrl;
        body.aspect_ratio = settings.aspectRatio && settings.aspectRatio !== "auto"
          ? settings.aspectRatio : "auto";
      } else if (/^file:/.test(msg.src)) {
        throw new Error(
          "本地图片无法读取。请在 chrome://extensions → 本扩展「详细信息」→ 打开「允许访问文件网址」,或改用网页上的图片。"
        );
      } else {
        throw e;
      }
    }
  }

  if (rawDataUri) {
    if (settings.aspectRatio === "auto") {
      // 自动:letterbox 到最接近原图的比例,画面零拉伸、四周补黑边
      const lb = await letterboxToNearestAspect(rawDataUri);
      body.image_b64 = lb.dataUri;
      body.aspect_ratio = lb.aspect;
    } else {
      // 指定比例:也 letterbox 到该比例,避免拉伸
      const lb = await letterboxToAspect(rawDataUri, settings.aspectRatio);
      body.image_b64 = lb.dataUri;
      body.aspect_ratio = settings.aspectRatio;
    }
  }

  const headers = { "Content-Type": "application/json" };
  if (settings.secret) headers["Authorization"] = `Bearer ${settings.secret}`;

  // 遇到 xAI 限流(429 / rate limit)自动退避重试,最多 4 次
  const backoffs = [4000, 8000, 16000];
  for (let attempt = 0; ; attempt++) {
    const submitBody = endpointInfo.kind === "api" ? apiPayloadFromProxyBody(body, settings) : body;
    const resp = await fetch(endpointInfo.submitUrl, {
      method: "POST", headers, body: JSON.stringify(submitBody),
    });
    const { data, text } = await readJsonOrText(resp);
    if (!data) {
      throw new Error(`视频接口返回异常 (${resp.status}) ${endpointInfo.submitUrl}${responseSnippet(text)}`);
    }
    if (endpointInfo.kind === "proxy") {
      if (data.success) return data.request_id;
    } else if (resp.ok && (data.request_id || data.id)) {
      const requestId = data.request_id || data.id;
      rememberTelegramJob(requestId, {
        ...msg,
        prompt: chosenPrompt,
        imageDataUri: rawDataUri || body.image_b64 || msg.imageDataUri || "",
      }, endpointInfo);
      return requestId;
    }

    const err = errText(data, `提交失败 (${resp.status})`);
    const rateLimited = /\b429\b|rate.?limit|too many/i.test(err);
    if (rateLimited && attempt < backoffs.length) {
      await new Promise((r) => setTimeout(r, backoffs[attempt]));
      continue; // 退避后重试
    }
    throw new Error(`${err} [${endpointInfo.submitUrl}]`);
  }
}

async function doPoll(requestId) {
  const settings = await getSettings();
  const endpointInfo = videoEndpoint(settings.endpoint);
  if (!endpointInfo) throw new Error("代理地址无效,请在设置页填写。");
  const statusUrl = endpointInfo.statusUrl(requestId);
  const headers = {};
  if (settings.secret) headers["Authorization"] = `Bearer ${settings.secret}`;
  const resp = await fetch(statusUrl, { headers });
  if (endpointInfo.kind === "api" && resp.status === 202) {
    return { success: true, status: "processing" };
  }
  const { data, text } = await readJsonOrText(resp);
  if (!data) throw new Error(`状态查询异常 (${resp.status}) ${statusUrl}${responseSnippet(text)}`);
  if (endpointInfo.kind === "proxy") return normalizeProxyStatus(data); // {success, status, video_url?, error?}
  if (!resp.ok) throw new Error(errText(data, `状态查询失败 (${resp.status})`));
  const normalized = normalizeApiStatus(data);
  cleanupTelegramJobs();
  maybePushTelegram(requestId, normalized).catch(() => {});
  return normalized;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "TRY_ACQUIRE") {
    cleanupSlots();
    // 同步 check-and-set,无 await → 原子,不会被并发击穿
    if (activeSlots.size < concurrencyLimit) {
      const token = Date.now() + "-" + Math.random().toString(36).slice(2);
      activeSlots.set(token, { ts: Date.now(), tabId: sender.tab?.id });
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
  if (msg?.type === "PUSH_TELEGRAM") {
    pushTelegramForRequest(msg)
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (msg?.type === "PUSH_ARCHIVE") {
    pushArchive(msg)
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (msg?.type === "GET_PROMPT") {
    promptForSide(msg)
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (msg?.type === "SAVE_PROMPT") {
    savePromptForSide(msg)
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (msg?.type === "START_JOB") {
    // content 抓完图把任务交来:暂存 + 打开进度页新标签(进度/轮询/结果都在那)
    const jobId = "job-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    pendingJobs.set(jobId, msg.job);
    chrome.tabs.create({
      url: chrome.runtime.getURL("progress.html") + "?job=" + jobId,
      active: false, // 后台打开,不打断当前浏览
    });
    sendResponse({ ok: true, jobId });
    return; // 同步
  }
  if (msg?.type === "GET_JOB") {
    // 进度页启动后来取任务数据(取走即删,避免泄漏占内存)
    const job = pendingJobs.get(msg.jobId) || null;
    pendingJobs.delete(msg.jobId);
    sendResponse({ ok: true, job });
    return; // 同步
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
