// content.js — Alt+左键点击图片/视频 → 在原页面"抓图"(短暂遮罩)→ 交给 background
// 打开扩展进度页(新标签),排队/提交/轮询/进度/结果全部在新标签里完成。

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

// 图片 → JPEG data URI:① 直接画(同源/CORS-clean);② 跨域但 CDN 带 CORS(如抖音
// douyinpic):内容脚本 fetch → blob → ImageBitmap → 重画(不污染)。都失败返回 null,
// 由后台/服务端按 image_url+referer 兜底抓取。
async function imageToDataUri(img, maxSide = 1280) {
  const direct = extractViaCanvas(img, maxSide);
  if (direct) return direct;
  const src = img.currentSrc || img.src || "";
  let blob = null;
  try {
    if (/^file:/.test(src)) blob = await readLocalBlob(src); // 本地图用 XHR 读
    else if (/^https?:/.test(src)) { const r = await fetch(src); if (r.ok) blob = await r.blob(); }
  } catch (_) { blob = null; }
  if (!blob) return null;
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    return c.toDataURL("image/jpeg", 0.92);
  } catch (_) {
    return null;
  }
}

// 把 video 元素的当前帧画成 JPEG data URI(同源/blob: 不会污染,跨域会抛 SecurityError)
function frameFromVideoElement(videoEl, maxSide = 1280) {
  const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
  if (!vw || !vh) throw new Error("视频还没加载出画面");
  const scale = Math.min(1, maxSide / Math.max(vw, vh));
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(videoEl, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.92); // 跨域污染时抛错
}

// 读取本地 file:// 文件为 blob。关键:用 XMLHttpRequest 而非 fetch ——
// fetch 把 file:// 当「不透明源」按 CORS 拦截(即使开了文件权限);XHR 是本地文件的经典读法。
function readLocalBlob(url) {
  return new Promise((resolve, reject) => {
    try {
      const x = new XMLHttpRequest();
      x.open("GET", url, true);
      x.responseType = "blob";
      x.onload = () => {
        if ((x.status === 200 || x.status === 0) && x.response && x.response.size)
          resolve(x.response);
        else reject(new Error("本地读取失败 (status=" + x.status + ")"));
      };
      x.onerror = () => reject(new Error("XHR 读取本地文件失败(确认已开启「允许访问文件网址」)"));
      x.send();
    } catch (e) {
      reject(e);
    }
  });
}

// 拿到视频 blob:本地 file:// 用 XHR 读;跨域 http(s) 由后台抓(SW 不受 CORS)
async function fetchVideoBlob(src) {
  if (/^file:/.test(src)) return await readLocalBlob(src);
  const res = await chrome.runtime.sendMessage({ type: "FETCH_VIDEO", url: src });
  if (!res || !res.ok) throw new Error(res?.error || "无法获取视频数据");
  const bytes = Uint8Array.from(atob(res.b64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: res.mime || "video/mp4" });
}

// blob:(同源,不污染)→ 隐藏 video → seek 到该时刻 → 抓帧
async function captureViaBlob(src, time) {
  const blobUrl = URL.createObjectURL(await fetchVideoBlob(src));
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.src = blobUrl;
  try {
    await new Promise((resolve, reject) => {
      v.onloadeddata = resolve;
      v.onerror = () => reject(new Error("视频解码失败"));
      setTimeout(() => reject(new Error("视频加载超时")), 30000);
    });
    await new Promise((resolve) => {
      v.onseeked = resolve;
      v.currentTime = Math.max(0, Math.min(time || 0, (v.duration || 0) - 0.05 || 0));
      setTimeout(resolve, 3000); // 兜底:某些视频不触发 seeked
    });
    return frameFromVideoElement(v);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

// 通用兜底:截当前可见标签页 → 裁剪到元素区域。渲染像素,绕开 file://、跨域、canvas 污染。
// 适用于本地视频(XHR/fetch 被封)、受保护/污染的图或视频——只要画面看得见就能抓。
async function captureVisibleElement(el, maxSide = 1280) {
  // 截屏前临时隐藏视频原生控件(播放键/进度条/中央▶),截完还原,保证截到的是纯画面
  const isVid = el instanceof HTMLVideoElement;
  const hadControls = isVid && el.controls;
  if (hadControls) {
    el.controls = false;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 80)); // 等控件从渲染里消失
  }
  try {
    const rect = el.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) throw new Error("目标不在可见区域");
    const res = await chrome.runtime.sendMessage({ type: "CAPTURE_TAB" });
    if (!res || !res.ok) throw new Error(res?.error || "截屏失败");
    const shot = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("截屏解码失败"));
      im.src = res.dataUrl;
    });
    const dpr = shot.width / window.innerWidth || 1; // 截图为设备像素,据此换算
    const sx = Math.max(0, rect.left * dpr);
    const sy = Math.max(0, rect.top * dpr);
    const sw = Math.min(rect.width * dpr, shot.width - sx);
    const sh = Math.min(rect.height * dpr, shot.height - sy);
    if (sw < 4 || sh < 4) throw new Error("裁剪区域无效");
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.drawImage(shot, sx, sy, sw, sh, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.92); // data: 来源,不污染
  } finally {
    if (hadControls) el.controls = true; // 还原控件
  }
}

// 抓取 video 当前帧:
// ① 直接画原元素(同源 http / blob:,全质量);
// ② 跨域 http(s):后台抓字节 → blob → seek 抓帧(全质量,无需可见);
// ③ 本地 file:// 等无法读字节、canvas 必污染的源:隐藏原生控件 → 截当前可见画面 → 裁剪(画面干净)。
async function captureVideoFrame(videoEl) {
  try { videoEl.pause(); } catch (_) {}
  const t = videoEl.currentTime || 0;
  try {
    return frameFromVideoElement(videoEl); // 同源/blob: 直接成功
  } catch (_) {}
  const src = videoEl.currentSrc || videoEl.src || "";
  if (/^https?:/.test(src)) {
    try { return await captureViaBlob(src, t); } catch (_) {} // 跨域:后台抓字节 blob 抓帧
  }
  // 本地视频:Chrome 禁止读其帧字节、canvas 必污染 → 截图裁剪是唯一干净方案(已隐藏控件)
  return await captureVisibleElement(videoEl);
}

// content 只负责"抓图"(canvas/视频帧/截屏都依赖原页面 DOM),抓完把任务交给 background:
// background 打开扩展内置进度页(新标签),排队/提交/轮询/进度/结果全在新标签里完成。
async function triggerGenerate(el, capture) {
  const isVideo = el instanceof HTMLVideoElement;
  const src = el.currentSrc || el.src;
  if (!src && !isVideo && !capture) { alert("无法获取图片地址"); return; }

  const overlay = makeOverlay(el);
  try {
    let imageDataUri, natW, natH;
    if (capture) {
      overlay.setText("抓取当前帧…");
      const r = await capture();
      imageDataUri = r.dataUri; natW = r.w; natH = r.h;
    } else if (isVideo) {
      overlay.setText("抓取当前帧…");
      imageDataUri = await captureVideoFrame(el);
      natW = el.videoWidth; natH = el.videoHeight;
    } else {
      overlay.setText("抓取图片…");
      imageDataUri = await imageToDataUri(el); // 含跨域 CORS CDN(抖音等)兜底
      if (!imageDataUri) {
        try { imageDataUri = await captureVisibleElement(el); } catch (_) {} // 本地图/受保护图:截屏裁剪
      }
      natW = el.naturalWidth || el.width; natH = el.naturalHeight || el.height;
    }

    // 交给 background 开进度页;进度与结果都在新标签里
    await chrome.runtime.sendMessage({
      type: "START_JOB",
      job: {
        src,
        pageUrl: location.href,
        imageDataUri,
        naturalWidth: natW,
        naturalHeight: natH,
      },
    });
    overlay.remove(); // 原页面遮罩用完即撤,转圈交给新标签
  } catch (err) {
    overlay.remove();
    notifyError(el, String(err.message || err));
  }
}

// 占位/模糊层等"假图"特征(抖音图文会把 noop.jpeg 占位层叠在真图 webp 上)
const PLACEHOLDER_RE = /noop|placeholder|blank|loading|spacer|1x1|transparent/i;

// 选出点击点下"真正在看的那张"媒体:必须覆盖点击点、可见、非占位,
// 排序 非占位 → 最不透明 → 面积最大。解决:① 透明覆盖层挡住真图;
// ② 抖音图文把占位层叠在真图上;③ 多图轮播多张叠放时抓错图(只有当前居中那张覆盖点击点)。
function pickMediaAtPoint(x, y, target) {
  // 快路径:点击目标本身就是非占位的图/视频
  if (target instanceof HTMLImageElement || target instanceof HTMLVideoElement) {
    const s = (target.currentSrc || target.src || "").toLowerCase();
    if (!PLACEHOLDER_RE.test(s)) return target;
  }
  const seen = new Set();
  const cands = [];
  const consider = (n) => {
    if (seen.has(n)) return;
    seen.add(n);
    if (!(n instanceof HTMLImageElement) && !(n instanceof HTMLVideoElement)) return;
    const r = n.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return; // 必须覆盖点击点
    if (r.width < 40 || r.height < 40) return;
    const cs = getComputedStyle(n);
    if (cs.visibility === "hidden" || cs.display === "none") return;
    const op = parseFloat(cs.opacity);
    if (op < 0.05) return;
    const src = (n.currentSrc || n.src || "").toLowerCase();
    cands.push({ el: n, ph: PLACEHOLDER_RE.test(src) ? 1 : 0, op, area: r.width * r.height });
  };
  document.elementsFromPoint(x, y).forEach(consider);
  document.querySelectorAll("img, video").forEach(consider);
  cands.sort((a, b) => (a.ph - b.ph) || (b.op - a.op) || (b.area - a.area));
  if (cands.length) return cands[0].el;
  return (target instanceof HTMLImageElement || target instanceof HTMLVideoElement) ? target : null;
}

// Alt+左键点击图片或视频(捕获阶段,优先于页面自身处理)
// 多图轮播:切到想要的那张再 Alt+点击,抓的就是当前居中显示的那张
// 视频:先暂停到想要的帧,再 Alt+点击,即以当前帧为源图生成
document.addEventListener(
  "click",
  (e) => {
    if (!e.altKey || e.button !== 0) return;
    const el = pickMediaAtPoint(e.clientX, e.clientY, e.target);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    triggerGenerate(el);
  },
  true
);
