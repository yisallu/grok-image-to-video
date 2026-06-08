"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const path = require("path");
const { execFile } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { randomUUID } = require("crypto");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const HOST = process.env.VIDEO_ARCHIVE_HOST || "127.0.0.1";
const PORT = Number(process.env.VIDEO_ARCHIVE_PORT || 8791);
const BASE_PATH = (process.env.VIDEO_ARCHIVE_BASE_PATH || "/grok-videos").replace(/\/+$/, "") || "";
const PUBLIC_BASE_URL = (process.env.VIDEO_ARCHIVE_PUBLIC_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.VIDEO_ARCHIVE_TOKEN || "";
const DATA_DIR = process.env.VIDEO_ARCHIVE_DATA_DIR || path.join(__dirname, "video-archive-data");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const INDEX_FILE = path.join(DATA_DIR, "videos.json");
const MAX_JSON_BYTES = Number(process.env.VIDEO_ARCHIVE_MAX_JSON_BYTES || 8 * 1024 * 1024);
const MAX_VIDEO_BYTES = Number(process.env.VIDEO_ARCHIVE_MAX_VIDEO_BYTES || 200 * 1024 * 1024);

function send(res, status, body, headers = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""));
  res.writeHead(status, {
    "Content-Length": data.length,
    "Access-Control-Allow-Origin": "*",
    ...headers,
  });
  res.end(res._headOnly ? undefined : data);
}

function json(res, status, body) {
  send(res, status, JSON.stringify(body), { "Content-Type": "application/json; charset=utf-8" });
}

function normalizeUrl(req) {
  const url = new URL(req.url || "/", "http://localhost");
  let pathname = decodeURIComponent(url.pathname);
  if (BASE_PATH && pathname.startsWith(BASE_PATH)) pathname = pathname.slice(BASE_PATH.length) || "/";
  return { pathname, searchParams: url.searchParams };
}

async function ensureStore() {
  await fsp.mkdir(MEDIA_DIR, { recursive: true });
  try {
    await fsp.access(INDEX_FILE);
  } catch (_) {
    await fsp.writeFile(INDEX_FILE, "[]\n");
  }
}

async function readIndex() {
  await ensureStore();
  try {
    const raw = await fsp.readFile(INDEX_FILE, "utf8");
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

async function writeIndex(list) {
  const tmp = INDEX_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(list, null, 2) + "\n");
  await fsp.rename(tmp, INDEX_FILE);
}

function requireAuth(req, res) {
  if (!TOKEN) {
    json(res, 500, { ok: false, error: "server missing VIDEO_ARCHIVE_TOKEN" });
    return false;
  }
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (got !== TOKEN) {
    json(res, 401, { ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function cleanText(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function cleanId(value) {
  const id = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]{6,80}$/.test(id)) throw new Error("invalid video id");
  return id;
}

function safeHttpUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http(s) video_url is allowed");
  return url.toString();
}

function publicUrlFor(fileName) {
  if (PUBLIC_BASE_URL) return `${PUBLIC_BASE_URL}/media/${encodeURIComponent(fileName)}`;
  return `${BASE_PATH}/media/${encodeURIComponent(fileName)}`;
}

async function probeVideo(filePath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "json",
      filePath,
    ], { timeout: 15000, maxBuffer: 1024 * 1024 });
    const data = JSON.parse(stdout);
    const stream = Array.isArray(data.streams) ? data.streams[0] : null;
    const width = Number(stream && stream.width);
    const height = Number(stream && stream.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  } catch (_) {}
  return null;
}

async function downloadVideo(videoUrl, fileName) {
  const outPath = path.join(MEDIA_DIR, fileName);
  const tmpPath = outPath + ".tmp";
  const resp = await fetch(videoUrl, { redirect: "follow" });
  if (!resp.ok || !resp.body) throw new Error(`video download failed: HTTP ${resp.status}`);

  const declared = Number(resp.headers.get("content-length") || 0);
  if (declared > MAX_VIDEO_BYTES) throw new Error(`video too large: ${declared} bytes`);

  let seen = 0;
  const guard = new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > MAX_VIDEO_BYTES) throw new Error(`video too large: ${seen} bytes`);
      controller.enqueue(chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(resp.body.pipeThrough(guard)), fs.createWriteStream(tmpPath));
    await fsp.rename(tmpPath, outPath);
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }
  return { bytes: seen, contentType: resp.headers.get("content-type") || "video/mp4" };
}

async function saveVideo(req, res) {
  if (!requireAuth(req, res)) return;
  const body = await readJsonBody(req);
  const videoUrl = safeHttpUrl(body.video_url || body.videoUrl);
  const id = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + randomUUID().slice(0, 8);
  const fileName = `${id}.mp4`;
  const downloaded = await downloadVideo(videoUrl, fileName);
  const dimensions = await probeVideo(path.join(MEDIA_DIR, fileName));

  const item = {
    id,
    created_at: new Date().toISOString(),
    file: fileName,
    url: publicUrlFor(fileName),
    original_url: videoUrl,
    bytes: downloaded.bytes,
    content_type: downloaded.contentType,
    video_width: dimensions ? dimensions.width : null,
    video_height: dimensions ? dimensions.height : null,
    prompt: cleanText(body.prompt, 600),
    model: cleanText(body.model, 100),
    request_id: cleanText(body.request_id || body.requestId, 120),
    source_url: cleanText(body.source_url || body.sourceUrl, 1000),
    page_url: cleanText(body.page_url || body.pageUrl, 1000),
    aspect_ratio: cleanText(body.aspect_ratio || body.aspectRatio, 20),
    resolution: cleanText(body.resolution, 20),
    duration: Number(body.duration || 0) || null,
    alt_side: cleanText(body.alt_side || body.altSide, 20),
  };

  const list = await readIndex();
  list.unshift(item);
  await writeIndex(list.slice(0, 1000));
  json(res, 200, { ok: true, item });
}

async function deleteVideo(req, res, rawId) {
  if (!requireAuth(req, res)) return;
  const id = cleanId(rawId);
  const list = await readIndex();
  const idx = list.findIndex((item) => item && item.id === id);
  if (idx === -1) return json(res, 404, { ok: false, error: "video not found" });

  const [item] = list.splice(idx, 1);
  await writeIndex(list);

  let deletedFile = false;
  const fileName = path.basename(String(item.file || ""));
  if (/^[a-zA-Z0-9_.-]+\.mp4$/.test(fileName)) {
    await fsp.unlink(path.join(MEDIA_DIR, fileName)).then(() => {
      deletedFile = true;
    }).catch((err) => {
      if (err && err.code !== "ENOENT") throw err;
    });
  }
  json(res, 200, { ok: true, id, deleted_file: deletedFile });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function ratioStyle(item) {
  const width = Number(item.video_width || 0);
  const height = Number(item.video_height || 0);
  if (width > 0 && height > 0) return `--ratio:${width} / ${height};`;

  const raw = String(item.aspect_ratio || "").trim();
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (match) {
    const w = Number(match[1]);
    const h = Number(match[2]);
    if (w > 0 && h > 0) return `--ratio:${w} / ${h};`;
  }
  return "--ratio:16 / 9;";
}

function pageHtml(list) {
  const cards = list.map((v) => `
    <article class="card" data-id="${escapeHtml(v.id)}" style="${escapeHtml(ratioStyle(v))}">
      <video src="${escapeHtml(v.url)}" controls loop preload="metadata"></video>
      <div class="meta">
        <time>${escapeHtml(new Date(v.created_at).toLocaleString("zh-CN", { hour12: false }))}</time>
        <div class="actions">
          <a href="${escapeHtml(v.url)}" download>下载</a>
          <button class="delete-btn" type="button" data-id="${escapeHtml(v.id)}" disabled>删除</button>
        </div>
      </div>
      <div class="tags">
        ${v.resolution ? `<span>${escapeHtml(v.resolution)}</span>` : ""}
        ${v.aspect_ratio ? `<span>${escapeHtml(v.aspect_ratio)}</span>` : ""}
        ${v.duration ? `<span>${escapeHtml(v.duration)}s</span>` : ""}
        ${v.model ? `<span>${escapeHtml(v.model)}</span>` : ""}
      </div>
    </article>`).join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Grok 视频归档</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #181818; background: #f6f7f8; }
    header { position: sticky; top: 0; z-index: 2; padding: 14px 20px; border-bottom: 1px solid #ddd; background: rgba(246,247,248,.94); backdrop-filter: blur(10px); }
    h1 { margin: 0; font-size: 20px; font-weight: 760; }
    .count { color: #666; font-size: 13px; margin-top: 2px; }
    .top { max-width: 1280px; margin: 0 auto; display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; }
    .admin { display: flex; gap: 8px; align-items: center; }
    input { width: min(34vw, 280px); height: 34px; padding: 6px 9px; border: 1px solid #ccc; border-radius: 6px; background: #fff; font: inherit; }
    button { height: 34px; padding: 0 10px; border: 1px solid #ccc; border-radius: 6px; background: #fff; color: #222; font: 600 13px inherit; cursor: pointer; }
    button:hover:not(:disabled) { background: #f1f1f1; }
    button:disabled { opacity: .42; cursor: default; }
    main { max-width: 1440px; margin: 0 auto; padding: 14px; }
    .grid { column-width: 280px; column-gap: 14px; }
    .card { display: inline-block; width: 100%; margin: 0 0 14px; break-inside: avoid; background: #fff; border: 1px solid #dedede; border-radius: 8px; overflow: hidden; vertical-align: top; }
    video { display: block; width: 100%; aspect-ratio: var(--ratio, 16 / 9); background: #111; object-fit: contain; }
    .meta, .tags { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 12px 0; }
    .meta { justify-content: space-between; color: #666; }
    .actions { display: flex; gap: 9px; align-items: center; }
    a { color: #0969da; text-decoration: none; }
    .delete-btn { height: auto; padding: 0; border: 0; color: #b42318; background: transparent; }
    .delete-btn:hover:not(:disabled) { background: transparent; text-decoration: underline; }
    .tags { padding-bottom: 12px; }
    span { padding: 2px 7px; border: 1px solid #ddd; border-radius: 999px; color: #555; font-size: 12px; background: #fafafa; }
    .empty { margin: 20vh auto 0; max-width: 420px; color: #666; text-align: center; }
    @media (max-width: 700px) {
      .top { grid-template-columns: 1fr; }
      .admin { align-items: stretch; }
      input { flex: 1; width: 100%; min-width: 0; }
    }
  </style>
</head>
<body>
  <header>
    <div class="top">
      <div>
        <h1>Grok 视频归档</h1>
        <div class="count"><span id="videoCount">${list.length}</span> 个视频</div>
      </div>
      <div class="admin">
        <input id="archiveToken" type="password" autocomplete="off" placeholder="Token">
        <button id="saveToken" type="button">保存</button>
        <button id="clearToken" type="button">清除</button>
      </div>
    </div>
  </header>
  <main>${list.length ? `<section class="grid">${cards}</section>` : `<div class="empty">还没有收到视频。</div>`}</main>
  <script>
    (() => {
      const tokenInput = document.getElementById("archiveToken");
      const saveToken = document.getElementById("saveToken");
      const clearToken = document.getElementById("clearToken");
      const countEl = document.getElementById("videoCount");
      const storageKey = "grokVideoArchiveToken";

      function currentToken() {
        return (tokenInput.value || "").trim();
      }

      function updateDeleteState() {
        const ready = Boolean(currentToken());
        document.querySelectorAll(".delete-btn").forEach((button) => {
          button.disabled = !ready;
        });
      }

      tokenInput.value = localStorage.getItem(storageKey) || "";
      updateDeleteState();

      tokenInput.addEventListener("input", updateDeleteState);
      saveToken.addEventListener("click", () => {
        localStorage.setItem(storageKey, currentToken());
        updateDeleteState();
      });
      clearToken.addEventListener("click", () => {
        tokenInput.value = "";
        localStorage.removeItem(storageKey);
        updateDeleteState();
      });

      document.querySelectorAll(".card video").forEach((video) => {
        video.addEventListener("loadedmetadata", () => {
          if (!video.videoWidth || !video.videoHeight) return;
          const card = video.closest(".card");
          if (card) card.style.setProperty("--ratio", video.videoWidth + " / " + video.videoHeight);
        }, { once: true });
      });

      document.addEventListener("click", async (event) => {
        const button = event.target.closest(".delete-btn");
        if (!button) return;
        const id = button.dataset.id || "";
        if (!id || !currentToken()) return;
        if (!confirm("删除这个视频?")) return;
        button.disabled = true;
        try {
          const resp = await fetch("api/videos/" + encodeURIComponent(id), {
            method: "DELETE",
            headers: { "Authorization": "Bearer " + currentToken() },
          });
          const data = await resp.json().catch(() => null);
          if (!resp.ok || !data || !data.ok) throw new Error((data && data.error) || "删除失败");
          const card = button.closest(".card");
          if (card) card.remove();
          if (countEl) countEl.textContent = String(Math.max(0, Number(countEl.textContent || 0) - 1));
        } catch (err) {
          alert(String(err.message || err));
          updateDeleteState();
        }
      });
    })();
  </script>
</body>
</html>`;
}

async function serveMedia(req, pathname, res) {
  const name = path.basename(pathname.replace(/^\/media\//, ""));
  if (!/^[a-zA-Z0-9_.-]+\.mp4$/.test(name)) return send(res, 404, "not found");
  const file = path.join(MEDIA_DIR, name);
  try {
    const stat = await fsp.stat(file);
    const range = String(req.headers.range || "");
    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      if (!match) return send(res, 416, "invalid range");
      let start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : stat.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        res.end();
        return;
      }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, {
        "Content-Type": "video/mp4",
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=31536000",
      });
      if (res._headOnly) {
        res.end();
        return;
      }
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": stat.size,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000",
    });
    if (res._headOnly) {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  } catch (_) {
    send(res, 404, "not found");
  }
}

async function route(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    });
    res.end();
    return;
  }

  const { pathname } = normalizeUrl(req);
  const method = req.method === "HEAD" ? "GET" : req.method;
  res._headOnly = req.method === "HEAD";
  try {
    if (method === "GET" && (pathname === "/" || pathname === "")) {
      const list = await readIndex();
      return send(res, 200, pageHtml(list), { "Content-Type": "text/html; charset=utf-8" });
    }
    if (method === "GET" && pathname === "/health") return json(res, 200, { ok: true, count: (await readIndex()).length });
    if (method === "GET" && pathname === "/api/videos") return json(res, 200, { ok: true, items: await readIndex() });
    if (method === "POST" && pathname === "/api/videos") return await saveVideo(req, res);
    if (method === "DELETE" && pathname.startsWith("/api/videos/")) {
      return await deleteVideo(req, res, pathname.replace(/^\/api\/videos\//, ""));
    }
    if (method === "GET" && pathname.startsWith("/media/")) return await serveMedia(req, pathname, res);
    send(res, 404, "not found");
  } catch (err) {
    json(res, 500, { ok: false, error: String(err.message || err) });
  }
}

ensureStore().then(() => {
  http.createServer(route).listen(PORT, HOST, () => {
    console.log(`video archive listening on http://${HOST}:${PORT}${BASE_PATH || "/"}`);
  });
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
