// progress.js — 新标签页里的生成进度页:取任务 → 排队 → 提交 → 轮询 → 显示进度 → 变视频。
// 全程在本标签内,原网页不受影响。排队/提交/轮询都复用 background 的消息接口。

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 360000;   // 6 分钟
const QUEUE_TIMEOUT_MS = 900000;  // 排队最长 15 分钟

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setStatus(text, sub) {
  $("status").textContent = text;
  $("sub").textContent = sub || "";
}

function showThumb(dataUri) {
  if (!dataUri) return;
  const t = $("thumb");
  t.src = dataUri;
  t.style.display = "block";
}

function showError(msg) {
  $("wrap").innerHTML =
    `<div class="err">生成失败<br><br>${escapeHtml(msg)}</div>` +
    `<div class="bar"><button class="btn ghost" onclick="window.close()">关闭标签页</button></div>`;
}

function showVideo(url) {
  document.title = "Grok 生成完成";
  $("wrap").innerHTML =
    `<video src="${encodeURI(url)}" autoplay loop controls playsinline></video>` +
    `<div class="bar">` +
      `<a class="btn" href="${encodeURI(url)}" download>下载视频</a>` +
      `<a class="btn ghost" href="${encodeURI(url)}" target="_blank">原始链接</a>` +
    `</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function acquireSlot() {
  const start = Date.now();
  while (Date.now() - start < QUEUE_TIMEOUT_MS) {
    let res = null;
    try { res = await chrome.runtime.sendMessage({ type: "TRY_ACQUIRE" }); } catch (_) {}
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

  const resp = await chrome.runtime.sendMessage({ type: "GET_JOB", jobId });
  const job = resp && resp.job;
  if (!job) { showError("任务数据丢失(可能页面被刷新)"); return; }

  showThumb(job.imageDataUri);

  let token = null;
  try {
    setStatus("排队中…");
    token = await acquireSlot();

    setStatus("提交任务…");
    const sub = await chrome.runtime.sendMessage({
      type: "SUBMIT",
      src: job.src,
      pageUrl: job.pageUrl,
      imageDataUri: job.imageDataUri,
      naturalWidth: job.naturalWidth,
      naturalHeight: job.naturalHeight,
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
      try { poll = await chrome.runtime.sendMessage({ type: "POLL", request_id: requestId }); } catch (_) {}
      if (!poll || !poll.ok) continue;
      const d = poll.data;
      if (d.status === "done" && d.video_url) { showVideo(d.video_url); return; }
      if (["failed", "error", "expired", "cancelled"].includes(d.status)) {
        throw new Error(d.error || `状态 ${d.status}`);
      }
    }
    throw new Error("生成超时(6 分钟)");
  } catch (err) {
    showError(String(err.message || err));
  } finally {
    if (token) { try { chrome.runtime.sendMessage({ type: "RELEASE", token }); } catch (_) {} }
  }
}

run();
