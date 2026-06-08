// progress.js — 新标签页里的生成进度页:取任务 → 排队 → 提交 → 轮询 → 显示进度 → 变视频。
// 全程在本标签内,原网页不受影响。排队/提交/轮询都复用 background 的消息接口。

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 360000;   // 6 分钟
const QUEUE_TIMEOUT_MS = 900000;  // 排队最长 15 分钟
const FAILURE_STATUSES = new Set([
  "failed", "error", "expired", "cancelled", "canceled", "timeout", "timed_out",
  "rejected", "blocked", "denied", "refused", "not_allowed", "disallowed",
  "aborted", "moderation_failed", "moderation_rejected",
  "content_policy_violation",
  "content_policy_error", "policy_violation", "policy_rejected", "policy_blocked",
  "content_rejected", "content_blocked", "safety_failed", "review_failed",
  "safety_rejected", "safety_violation", "safety_blocked", "failed_review",
]);

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeRuntimeMessageError(error) {
  const raw = String(error?.message || error || "");
  if (/EXTENSION_CONTEXT_INVALIDATED|context invalidated|extension context invalidated/i.test(raw)) {
    return "扩展刚刚重新加载过,请关闭这个进度页,刷新原网页后再 Alt+点击。";
  }
  if (/receiving end does not exist|could not establish connection|message port closed|runtime\.lastError/i.test(raw)) {
    return "扩展后台没有响应,请在 chrome://extensions 重新加载本扩展,然后刷新原网页。";
  }
  return raw || "扩展后台未响应";
}

async function sendRuntimeMessage(payload) {
  try {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
      throw new Error("EXTENSION_CONTEXT_INVALIDATED");
    }
    return await chrome.runtime.sendMessage(payload);
  } catch (error) {
    throw new Error(normalizeRuntimeMessageError(error));
  }
}

// 跟踪当前按住的是左 Alt 还是右 Alt(click 事件本身分不出左右)
let lastAltSide = "left";
window.addEventListener("keydown", (e) => {
  if (e.code === "AltLeft") lastAltSide = "left";
  else if (e.code === "AltRight") lastAltSide = "right";
}, true);

function promptSideName(altSide) {
  return altSide === "right" ? "提示词 B" : "提示词 A";
}

async function getPromptForSide(altSide) {
  const res = await sendRuntimeMessage({ type: "GET_PROMPT", altSide });
  if (!res || !res.ok) throw new Error(res?.error || "无法读取提示词");
  return String(res.prompt || "");
}

async function savePromptForSide(altSide, prompt) {
  const res = await sendRuntimeMessage({ type: "SAVE_PROMPT", altSide, prompt });
  if (!res || !res.ok) throw new Error(res?.error || "提示词保存失败");
}

function showPromptDialog(initialPrompt, altSide) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "prompt-backdrop";

    const panel = document.createElement("div");
    panel.className = "prompt-panel";

    const head = document.createElement("div");
    head.className = "prompt-head";
    const title = document.createElement("div");
    title.className = "prompt-title";
    title.textContent = "调整提示词";
    const side = document.createElement("div");
    side.className = "prompt-side";
    side.textContent = promptSideName(altSide);
    head.append(title, side);

    const textarea = document.createElement("textarea");
    textarea.className = "prompt-input";
    textarea.value = initialPrompt;
    textarea.placeholder = "输入本次生成要使用的提示词";

    const actions = document.createElement("div");
    actions.className = "prompt-actions";
    const cancel = makeBtn("取消", true);
    const start = makeBtn("生成视频", false);
    start.classList.add("primary");
    actions.append(cancel, start);

    panel.append(head, textarea, actions);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);

    const close = (value) => {
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(value);
    };
    const submit = () => close(textarea.value.trim());
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        submit();
      }
    };

    cancel.addEventListener("click", () => close(null));
    start.addEventListener("click", submit);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close(null);
    });
    document.addEventListener("keydown", onKey, true);
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }, 0);
  });
}

function setStatus(text, sub) {
  $("status").textContent = text;
  $("sub").textContent = sub || "";
}

function failureMessage(data) {
  const status = String(data?.status || "").toLowerCase();
  const err = data?.error;
  let msg = "";
  if (typeof err === "string") msg = err;
  else if (err && typeof err.message === "string") msg = err.message;
  else if (typeof data?.message === "string") msg = data.message;
  else if (status) msg = `状态 ${status}`;
  else msg = "上游返回失败";

  const moderation = /moderation.?failed|failed.?moderation|moderation.?rejected|content.?policy|policy.?violation|policy.?rejected|policy.?blocked|safety.?failed|failed.?safety|safety.?rejected|safety.?violation|review.?failed|failed.?review|rejected|blocked|denied|refused|not.?allowed|disallowed|violation|审查(未通过|失败|拒绝)|安全(未通过|失败|拒绝)|政策|违规|拒绝/i;
  if (moderation.test(status + " " + msg)) return "x.ai 审查未通过:" + msg;
  return msg;
}

function isFailureStatus(status) {
  return FAILURE_STATUSES.has(String(status || "").toLowerCase());
}

function showThumb(dataUri) {
  if (!dataUri) return;
  const t = $("thumb");
  t.src = dataUri;
  t.style.display = "block";
}

// 用 DOM 构建,绝不用内联事件/innerHTML 拼事件(扩展页 CSP 禁止内联脚本与 onclick)
function clearWrap() {
  const w = $("wrap");
  while (w.firstChild) w.removeChild(w.firstChild);
  return w;
}

function makeBtn(text, ghost) {
  const b = document.createElement("button");
  b.className = "btn" + (ghost ? " ghost" : "");
  b.textContent = text;
  return b;
}

function makeLink(text, url, ghost, download) {
  const a = document.createElement("a");
  a.className = "btn" + (ghost ? " ghost" : "");
  a.textContent = text;
  a.href = url;
  if (download) a.setAttribute("download", "");
  else a.target = "_blank";
  return a;
}

function showError(msg) {
  const w = clearWrap();
  const box = document.createElement("div");
  box.className = "err";
  box.textContent = "生成失败:" + msg;
  const bar = document.createElement("div");
  bar.className = "bar";
  const close = makeBtn("关闭标签页", true);
  close.addEventListener("click", () => window.close());
  bar.appendChild(close);
  w.append(box, bar);
}

function showVideo(url) {
  document.title = "Grok 生成完成";
  const w = clearWrap();
  const v = document.createElement("video");
  v.src = url;
  v.autoplay = true; v.loop = true; v.controls = true; v.playsInline = true;
  v.title = "暂停后 Alt+左键点击可用当前帧续写";
  const tip = document.createElement("div");
  tip.className = "sub";
  tip.textContent = "提示:暂停后 Alt+左键点击此视频,可用当前帧继续生成";
  const bar = document.createElement("div");
  bar.className = "bar";
  bar.append(makeLink("下载视频", url, false, true), makeLink("原始链接", url, true, false));
  w.append(v, tip, bar);

  // Alt+左键点击结果视频 → 抓当前帧 → 另开进度页续写
  v.addEventListener("click", (e) => {
    if (!e.altKey || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    promptThenContinueFromVideo(v, lastAltSide);
  }, true);
}

// 从结果视频(xAI CDN,跨域无 CORS)抓当前帧:后台取字节 → blob → seek → 抓帧
async function captureResultFrame(videoEl) {
  try { videoEl.pause(); } catch (_) {}
  const t = videoEl.currentTime || 0;
  const src = videoEl.currentSrc || videoEl.src || "";
  const res = await sendRuntimeMessage({ type: "FETCH_VIDEO", url: src });
  if (!res || !res.ok) throw new Error(res?.error || "无法获取视频数据");
  const bytes = Uint8Array.from(atob(res.b64), (c) => c.charCodeAt(0));
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: res.mime || "video/mp4" }));
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = blobUrl;
  try {
    await new Promise((resolve, reject) => {
      v.onloadeddata = resolve;
      v.onerror = () => reject(new Error("视频解码失败"));
      setTimeout(() => reject(new Error("视频加载超时")), 30000);
    });
    await new Promise((resolve) => {
      v.onseeked = resolve;
      v.currentTime = Math.max(0, Math.min(t, (v.duration || 0) - 0.05 || 0));
      setTimeout(resolve, 3000);
    });
    const vw = v.videoWidth, vh = v.videoHeight;
    const maxSide = 1280, scale = Math.min(1, maxSide / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale)), h = Math.max(1, Math.round(vh * scale));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(v, 0, 0, w, h);
    return { dataUri: c.toDataURL("image/jpeg", 0.92), w, h };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function promptThenContinueFromVideo(videoEl, altSide) {
  try {
    const side = altSide || "left";
    const currentPrompt = await getPromptForSide(side);
    const prompt = await showPromptDialog(currentPrompt, side);
    if (prompt === null) return;
    await savePromptForSide(side, prompt);
    await continueFromVideo(videoEl, side, prompt);
  } catch (err) {
    alert("续写失败:" + String(err.message || err));
  }
}

async function continueFromVideo(videoEl, altSide, prompt) {
  const old = document.title;
  try {
    document.title = "抓取当前帧…";
    const frame = await captureResultFrame(videoEl);
    const startRes = await sendRuntimeMessage({
      type: "START_JOB",
      job: {
        src: videoEl.currentSrc || videoEl.src,
        pageUrl: location.href,
        imageDataUri: frame.dataUri,
        naturalWidth: frame.w,
        naturalHeight: frame.h,
        altSide: altSide || "left",
        prompt,
      },
    });
    if (!startRes || !startRes.ok) throw new Error(startRes?.error || "启动续写任务失败");
    document.title = old;
  } catch (err) {
    document.title = old;
    alert("续写失败:" + String(err.message || err));
  }
}

async function acquireSlot() {
  const start = Date.now();
  while (Date.now() - start < QUEUE_TIMEOUT_MS) {
    let res = null;
    let backendError = false;
    try {
      res = await sendRuntimeMessage({ type: "TRY_ACQUIRE" });
    } catch (err) {
      backendError = true;
      setStatus("等待扩展后台…", String(err.message || err));
    }
    if (backendError) {
      await sleep(1500);
      continue;
    }
    if (res && res.granted) return res.token;
    if (res && res.limit) setStatus("排队中…", `${res.active}/${res.limit} 进行中`);
    else setStatus("排队中…");
    await sleep(1500);
  }
  throw new Error("排队超时");
}

async function run() {
  const jobId = new URLSearchParams(location.search).get("job");
  if (!jobId) { showError("缺少任务 ID"); return; }

  let token = null;
  try {
    const resp = await sendRuntimeMessage({ type: "GET_JOB", jobId });
    const job = resp && resp.job;
    if (!job) { showError("任务数据丢失(可能页面被刷新)"); return; }

    showThumb(job.imageDataUri);

    setStatus("排队中…");
    token = await acquireSlot();

    setStatus("提交任务…");
    const sub = await sendRuntimeMessage({
      type: "SUBMIT",
      src: job.src,
      pageUrl: job.pageUrl,
      imageDataUri: job.imageDataUri,
      naturalWidth: job.naturalWidth,
      naturalHeight: job.naturalHeight,
      altSide: job.altSide,
      prompt: job.prompt,
    });
    if (!sub) throw new Error("扩展无响应");
    if (!sub.ok) throw new Error(sub.error);

    const requestId = sub.request_id;
    const startedAt = Date.now();
    while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS);
      const secs = Math.round((Date.now() - startedAt) / 1000);
      setStatus("Grok 正在生成视频…", `${secs}s · 通常 1–3 分钟`);

      let poll = null;
      try {
        poll = await sendRuntimeMessage({ type: "POLL", request_id: requestId });
      } catch (err) {
        setStatus("等待状态查询…", String(err.message || err));
      }
      if (!poll) continue;
      if (!poll.ok) throw new Error(poll.error || "状态查询失败");
      const d = poll.data;
      if (d?.success === false || isFailureStatus(d?.status)) {
        throw new Error(failureMessage(d));
      }
      if (d.status === "done" && d.video_url) {
        const pushPayload = {
          request_id: requestId,
          video_url: d.video_url,
          imageDataUri: job.imageDataUri,
          src: job.src,
          pageUrl: job.pageUrl,
          altSide: job.altSide,
          prompt: job.prompt,
        };
        sendRuntimeMessage({
          type: "PUSH_TELEGRAM",
          ...pushPayload,
        }).catch(() => {});
        sendRuntimeMessage({
          type: "PUSH_ARCHIVE",
          ...pushPayload,
        }).catch(() => {});
        showVideo(d.video_url);
        return;
      }
    }
    throw new Error("生成超时(6 分钟)");
  } catch (err) {
    showError(String(err.message || err));
  } finally {
    if (token) await sendRuntimeMessage({ type: "RELEASE", token }).catch(() => {});
  }
}

run();
