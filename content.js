// content.js — Alt+左键点击图片 → 提交生成 → 轮询 → 原位替换为视频。
// 轮询由内容脚本驱动(页面常驻),每次只发短请求,生成全程不依赖单个长连接。

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 360000; // 6 分钟
const QUEUE_TIMEOUT_MS = 900000; // 排队最长等待 15 分钟

function makeOverlay(img) {
  const rect = img.getBoundingClientRect();
  const overlay = document.createElement("div");
  overlay.className = "grok-i2v-overlay";
  overlay.style.left = `${rect.left + window.scrollX}px`;
  overlay.style.top = `${rect.top + window.scrollY}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
  overlay.innerHTML = `
    <div class="grok-i2v-spinner"></div>
    <div class="grok-i2v-text">准备中…</div>
  `;
  document.body.appendChild(overlay);
  const textEl = overlay.querySelector(".grok-i2v-text");
  return {
    setText: (t) => { textEl.textContent = t; },
    remove: () => overlay.remove(),
  };
}

function replaceWithVideo(img, url) {
  const video = document.createElement("video");
  video.src = url;
  video.autoplay = true;
  video.loop = true;
  video.muted = true;
  video.controls = true;
  video.playsInline = true;
  video.className = img.className;
  video.setAttribute("data-grok-i2v", "1");

  const cs = window.getComputedStyle(img);
  if (img.width) video.width = img.width;
  if (img.height) video.height = img.height;
  video.style.cssText = img.style.cssText;
  video.style.maxWidth = cs.maxWidth;
  video.style.objectFit = "cover";

  const originalSrc = img.currentSrc || img.src;
  video.title = "Grok 生成视频 — 双击还原原图";
  video.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const restored = img.cloneNode(true);
    restored.src = originalSrc;
    video.replaceWith(restored);
  });

  img.replaceWith(video);
}

function notifyError(img, message) {
  const rect = img.getBoundingClientRect();
  const tip = document.createElement("div");
  tip.className = "grok-i2v-error";
  tip.textContent = "生成失败:" + message;
  tip.style.left = `${rect.left + window.scrollX}px`;
  tip.style.top = `${rect.top + window.scrollY}px`;
  document.body.appendChild(tip);
  setTimeout(() => tip.remove(), 8000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 直接从已加载的 <img> 用 canvas 取图并转 JPEG data URI。
// 适用于本地 file:// 图、同源图;跨域无 CORS 的图会污染 canvas → 返回 null 走后台抓取。
function extractViaCanvas(img, maxSide = 1280) {
  try {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !ih) return null;
    const scale = Math.min(1, maxSide / Math.max(iw, ih));
    const w = Math.max(1, Math.round(iw * scale));
    const h = Math.max(1, Math.round(ih * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff"; // 铺白底(JPEG 无透明)
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.92); // 被污染会抛 SecurityError
  } catch (_) {
    return null;
  }
}

// 取号:并发未满立即拿到 token,否则排队轮询(由 background 跨标签页统一计数)
async function acquireSlot(overlay) {
  const start = Date.now();
  while (Date.now() - start < QUEUE_TIMEOUT_MS) {
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "TRY_ACQUIRE" });
    } catch {
      res = null;
    }
    if (res && res.granted) return res.token;
    if (res && res.limit) overlay.setText(`排队中…(${res.active}/${res.limit} 进行中)`);
    else overlay.setText("排队中…");
    await sleep(1500);
  }
  throw new Error("排队超时");
}

async function triggerGenerate(img) {
  const src = img.currentSrc || img.src;
  if (!src) { alert("无法获取图片地址"); return; }

  const overlay = makeOverlay(img);
  let token = null;
  try {
    overlay.setText("排队中…");
    token = await acquireSlot(overlay); // 并发上限/排队

    overlay.setText("准备图片 / 提交任务…");
    const imageDataUri = extractViaCanvas(img); // 本地/同源图直接取;跨域返回 null
    const sub = await chrome.runtime.sendMessage({
      type: "SUBMIT",
      src,
      pageUrl: location.href,
      imageDataUri,
      naturalWidth: img.naturalWidth || img.width,
      naturalHeight: img.naturalHeight || img.height,
    });
    if (!sub) throw new Error("扩展无响应");
    if (!sub.ok) throw new Error(sub.error);

    const requestId = sub.request_id;
    const startedAt = Date.now();
    while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS);
      const secs = Math.round((Date.now() - startedAt) / 1000);
      overlay.setText(`Grok 正在生成视频… ${secs}s`);

      let poll;
      try {
        poll = await chrome.runtime.sendMessage({ type: "POLL", request_id: requestId });
      } catch {
        continue; // service worker 偶发休眠/重启,下次再试
      }
      if (!poll || !poll.ok) continue;
      const d = poll.data;
      if (d.status === "done" && d.video_url) {
        overlay.remove();
        replaceWithVideo(img, d.video_url);
        return;
      }
      if (["failed", "error", "expired", "cancelled"].includes(d.status)) {
        throw new Error(d.error || `状态 ${d.status}`);
      }
      // processing / queued → 继续
    }
    throw new Error("生成超时(6 分钟)");
  } catch (err) {
    overlay.remove();
    notifyError(img, String(err.message || err));
  } finally {
    if (token) {
      try { chrome.runtime.sendMessage({ type: "RELEASE", token }); } catch {}
    }
  }
}

// Alt+左键点击图片(捕获阶段,优先于页面自身处理)
document.addEventListener(
  "click",
  (e) => {
    if (!e.altKey || e.button !== 0) return;
    const target = e.target;
    if (!(target instanceof HTMLImageElement)) return;
    e.preventDefault();
    e.stopPropagation();
    triggerGenerate(target);
  },
  true
);
