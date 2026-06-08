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
  concurrency: 3,
  prompt:
    "Animate this image into a high-quality cinematic video. Strictly preserve the original subject, composition, colors, background, and identity/details. Use subtle natural motion and gentle camera movement. Do not morph, distort, redraw, change identity, add text, add new objects, or alter the scene.",
  promptRight: "",
};

const $ = (id) => document.getElementById(id);

// 左右两个提示词各自一份历史(都存 chrome.storage.local)
const HISTORY_KEY = "promptHistory";        // 提示词 A
const HISTORY_KEY_R = "promptHistoryRight"; // 提示词 B

function cleanEndpoint(endpoint) {
  let value = String(endpoint || "").trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) value = "https://" + value;
  return value.replace(/\/+$/, "");
}

function videoEndpoint(endpoint) {
  const base = cleanEndpoint(endpoint);
  if (!base) return null;
  if (/\/i2v$/i.test(base)) {
    return {
      kind: "proxy",
      testUrl: base.replace(/\/i2v$/i, "/health"),
    };
  }
  let apiBase = base;
  if (/\/v1\/videos\/generations$/i.test(apiBase)) apiBase = apiBase.replace(/\/videos\/generations$/i, "");
  else if (!/\/v1$/i.test(apiBase)) apiBase += "/v1";
  return {
    kind: "api",
    testUrl: apiBase + "/models",
  };
}

function errText(data, fallback = "请求失败") {
  const err = data && data.error;
  if (typeof err === "string") return err;
  if (err && typeof err.message === "string") return err.message;
  if (data && typeof data.message === "string") return data.message;
  return fallback;
}

function setupIsReady(data) {
  const endpointInfo = videoEndpoint(data.endpoint);
  if (!endpointInfo) return false;
  return Boolean(String(data.secret || "").trim());
}

function setupSummary(data) {
  const endpointInfo = videoEndpoint(data.endpoint);
  const endpoint = cleanEndpoint(data.endpoint) || DEFAULTS.endpoint;
  const apiReady = Boolean(String(data.secret || "").trim());
  const tgReady = Boolean(String(data.telegramBotToken || "").trim() && String(data.telegramChatId || "").trim());
  const archiveReady = Boolean(String(data.archiveUrl || "").trim() && String(data.archiveToken || "").trim());
  const kind = endpointInfo?.kind === "proxy" ? "旧代理" : "API";
  const auth = apiReady ? "已配置密钥" : "缺少密钥";
  const telegram = tgReady ? "Telegram 已开" : "Telegram 关闭";
  const archive = archiveReady ? "视频站已开" : "视频站关闭";
  return `${kind} · ${auth} · ${telegram} · ${archive} · ${endpoint.replace(/^https?:\/\//i, "")}`;
}

function updateSetupVisibility(data, forceOpen = false) {
  const panel = $("connectionSettings");
  const summary = $("setupSummary");
  if (!panel || !summary) return;
  summary.textContent = setupSummary(data);
  panel.open = forceOpen || !setupIsReady(data);
}

async function getHistory(key) {
  const r = await chrome.storage.local.get({ [key]: [] });
  return Array.isArray(r[key]) ? r[key] : [];
}

async function setHistory(key, list) {
  await chrome.storage.local.set({ [key]: list });
}

function renderHistory(selId, list) {
  const sel = $(selId);
  sel.innerHTML = '<option value="">— 历史提示词(选择后填入)—</option>';
  for (const p of list) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p.length > 70 ? p.slice(0, 70) + "…" : p;
    sel.appendChild(opt);
  }
}

async function addToHistory(key, selId, prompt) {
  if (!prompt) return;
  let list = await getHistory(key);
  list = list.filter((p) => p !== prompt); // 去重
  list.unshift(prompt);                    // 最近的放最前
  await setHistory(key, list);
  renderHistory(selId, list);
}

async function load() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  const hadLegacyEndpoint = /^https:\/\/i2v\.5203333\.xyz\/i2v\/?$/i.test(String(s.endpoint || ""));
  const endpoint = hadLegacyEndpoint ? DEFAULTS.endpoint : (s.endpoint || DEFAULTS.endpoint);
  $("endpoint").value = endpoint;
  $("secret").value = hadLegacyEndpoint ? DEFAULTS.secret : (s.secret || "");
  $("model").value = s.model || DEFAULTS.model;
  $("telegramBotToken").value = s.telegramBotToken || "";
  $("telegramChatId").value = s.telegramChatId || "";
  $("archiveUrl").value = s.archiveUrl || DEFAULTS.archiveUrl;
  $("archiveToken").value = s.archiveToken || DEFAULTS.archiveToken;
  $("duration").value = s.duration ?? DEFAULTS.duration;
  $("resolution").value = s.resolution || DEFAULTS.resolution;
  $("aspectRatio").value = s.aspectRatio || DEFAULTS.aspectRatio;
  $("concurrency").value = s.concurrency ?? DEFAULTS.concurrency;
  $("prompt").value = s.prompt ?? "";          // 允许留空
  $("promptRight").value = s.promptRight ?? ""; // 允许留空=同提示词 A
  updateSetupVisibility({
    endpoint,
    secret: $("secret").value,
    telegramBotToken: $("telegramBotToken").value,
    telegramChatId: $("telegramChatId").value,
    archiveUrl: $("archiveUrl").value,
    archiveToken: $("archiveToken").value,
  }, hadLegacyEndpoint);
  renderHistory("promptHistory", await getHistory(HISTORY_KEY));
  renderHistory("promptHistoryRight", await getHistory(HISTORY_KEY_R));
  if (hadLegacyEndpoint) {
    await chrome.storage.sync.set({ endpoint: DEFAULTS.endpoint, secret: DEFAULTS.secret });
  }
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
    model: $("model").value.trim() || DEFAULTS.model,
    telegramBotToken: $("telegramBotToken").value.trim(),
    telegramChatId: $("telegramChatId").value.trim(),
    archiveUrl: $("archiveUrl").value.trim(),
    archiveToken: $("archiveToken").value.trim(),
    duration,
    resolution: $("resolution").value,
    aspectRatio: $("aspectRatio").value,
    concurrency,
    prompt: $("prompt").value.trim(),
    promptRight: $("promptRight").value.trim(),
  };
}

async function save() {
  const data = collect();
  await chrome.storage.sync.set(data);
  await addToHistory(HISTORY_KEY, "promptHistory", data.prompt);
  await addToHistory(HISTORY_KEY_R, "promptHistoryRight", data.promptRight);
  updateSetupVisibility(data);
  setStatus("✓ 已保存。", true);
}

async function test() {
  const { endpoint, secret } = collect();
  const endpointInfo = videoEndpoint(endpoint);
  if (!endpointInfo) {
    setStatus("✗ 接口地址无效。", false);
    return;
  }
  setStatus("测试中…", true);
  try {
    const resp = await fetch(endpointInfo.testUrl, {
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    });
    const data = await resp.json().catch(() => null);
    if (endpointInfo.kind === "proxy") {
      if (data && data.ok && data.has_credentials) {
        setStatus("✓ 旧代理在线,凭证有效。", true);
      } else if (data && data.ok) {
        setStatus("⚠ 旧代理在线,但服务端无可用 xAI 凭证。", false);
      } else {
        setStatus("⚠ 旧代理返回异常。", false);
      }
    } else if (resp.ok) {
      setStatus("✓ api.5203333.xyz 在线,API Key 有效。", true);
    } else {
      setStatus("✗ API 测试失败:" + errText(data, `HTTP ${resp.status}`), false);
    }
  } catch (e) {
    setStatus("✗ 无法连接接口:" + e.message, false);
  }
}

document.addEventListener("DOMContentLoaded", load);
$("save").addEventListener("click", save);
$("test").addEventListener("click", test);

// 历史下拉:选中即填入对应文本框
function wireHistory(selId, taId, key) {
  $(selId).addEventListener("change", (e) => {
    const v = e.target.value;
    if (v) {
      $(taId).value = v;
      setStatus("已填入历史提示词,点「保存设置」生效。", true);
    }
  });
}
wireHistory("promptHistory", "prompt", HISTORY_KEY);
wireHistory("promptHistoryRight", "promptRight", HISTORY_KEY_R);

// 删除选中的历史条目
function wireDelete(btnId, selId, key) {
  $(btnId).addEventListener("click", async () => {
    const v = $(selId).value;
    if (!v) { setStatus("请先在上方下拉选择一条要删除的历史。", false); return; }
    let list = await getHistory(key);
    list = list.filter((p) => p !== v);
    await setHistory(key, list);
    renderHistory(selId, list);
    setStatus("已删除该条历史提示词。", true);
  });
}
wireDelete("delHistory", "promptHistory", HISTORY_KEY);
wireDelete("delHistoryRight", "promptHistoryRight", HISTORY_KEY_R);
