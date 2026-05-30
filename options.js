const DEFAULTS = {
  endpoint: "https://your-proxy.example.com/i2v",
  secret: "",
  duration: 6,
  resolution: "720p",
  aspectRatio: "auto",
  concurrency: 3,
  prompt:
    "Animate this image into a high-quality cinematic video. Strictly preserve the original subject, composition, colors, background, and identity/details. Use subtle natural motion and gentle camera movement. Do not morph, distort, redraw, change identity, add text, add new objects, or alter the scene.",
};

const $ = (id) => document.getElementById(id);

const HISTORY_KEY = "promptHistory";
const HISTORY_MAX = 20;

async function getHistory() {
  const r = await chrome.storage.local.get({ [HISTORY_KEY]: [] });
  return Array.isArray(r[HISTORY_KEY]) ? r[HISTORY_KEY] : [];
}

async function setHistory(list) {
  await chrome.storage.local.set({ [HISTORY_KEY]: list.slice(0, HISTORY_MAX) });
}

function renderHistory(list) {
  const sel = $("promptHistory");
  sel.innerHTML = '<option value="">— 历史提示词(选择后填入)—</option>';
  for (const p of list) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p.length > 70 ? p.slice(0, 70) + "…" : p;
    sel.appendChild(opt);
  }
}

async function addToHistory(prompt) {
  if (!prompt) return;
  let list = await getHistory();
  list = list.filter((p) => p !== prompt); // 去重
  list.unshift(prompt); // 最近的放最前
  if (list.length > HISTORY_MAX) list = list.slice(0, HISTORY_MAX);
  await setHistory(list);
  renderHistory(list);
}

async function load() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $("endpoint").value = s.endpoint || DEFAULTS.endpoint;
  $("secret").value = s.secret || "";
  $("duration").value = s.duration ?? DEFAULTS.duration;
  $("resolution").value = s.resolution || DEFAULTS.resolution;
  $("aspectRatio").value = s.aspectRatio || DEFAULTS.aspectRatio;
  $("concurrency").value = s.concurrency ?? DEFAULTS.concurrency;
  $("prompt").value = s.prompt ?? ""; // 允许留空;留空=用服务端默认提示词
  renderHistory(await getHistory());
}

function setStatus(msg, ok) {
  const el = $("status");
  el.textContent = msg;
  el.className = ok ? "ok" : "err";
}

function collect() {
  let duration = parseInt($("duration").value, 10);
  if (isNaN(duration)) duration = DEFAULTS.duration;
  duration = Math.min(15, Math.max(1, duration));
  let concurrency = parseInt($("concurrency").value, 10);
  if (isNaN(concurrency)) concurrency = DEFAULTS.concurrency;
  concurrency = Math.min(10, Math.max(1, concurrency));
  return {
    endpoint: $("endpoint").value.trim() || DEFAULTS.endpoint,
    secret: $("secret").value.trim(),
    duration,
    resolution: $("resolution").value,
    aspectRatio: $("aspectRatio").value,
    concurrency,
    prompt: $("prompt").value.trim(), // 留空就存空,不再强制套默认
  };
}

async function save() {
  const data = collect();
  await chrome.storage.sync.set(data);
  await addToHistory(data.prompt); // 非空提示词进历史
  setStatus("✓ 已保存。现在可以在网页上 Alt+点击图片了。", true);
}

async function test() {
  const { endpoint, secret } = collect();
  const healthUrl = endpoint.replace(/\/i2v\/?$/, "/health");
  setStatus("测试中…", true);
  try {
    const resp = await fetch(healthUrl, {
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    });
    const data = await resp.json();
    if (data.ok && data.has_credentials) {
      setStatus("✓ 代理在线,凭证有效。", true);
    } else if (data.ok) {
      setStatus("⚠ 代理在线,但服务端无可用 xAI 凭证。", false);
    } else {
      setStatus("⚠ 代理返回异常。", false);
    }
  } catch (e) {
    setStatus("✗ 无法连接代理:" + e.message, false);
  }
}

document.addEventListener("DOMContentLoaded", load);
$("save").addEventListener("click", save);
$("test").addEventListener("click", test);

// 选择历史 → 填入文本框
$("promptHistory").addEventListener("change", (e) => {
  const v = e.target.value;
  if (v) {
    $("prompt").value = v;
    setStatus("已填入历史提示词,点「保存设置」生效。", true);
  }
});

// 删除选中的历史条目
$("delHistory").addEventListener("click", async () => {
  const sel = $("promptHistory");
  const v = sel.value;
  if (!v) {
    setStatus("请先在上方下拉选择一条要删除的历史。", false);
    return;
  }
  let list = await getHistory();
  list = list.filter((p) => p !== v);
  await setHistory(list);
  renderHistory(list);
  setStatus("已删除该条历史提示词。", true);
});
