#!/usr/bin/env python3
"""Grok 图生视频代理 (image-to-video shim) — 异步版.

复用 hermes 的 xai-oauth 凭证(自动刷新)调用 xAI grok-imagine-video。
异步设计:POST /i2v 立即返回 request_id;GET /status?id= 轮询。
每个 HTTP 请求都很短,避开 Cloudflare 100s 超时。

错误一律以 HTTP 200 + {"success": false, "error": ...} 返回,避免 Cloudflare
把 502/504 的响应体替换成它自己的 HTML 错误页。

- 监听 127.0.0.1:8799(cloudflared 隧道 i2v.5203333.xyz 提供 TLS)
- 鉴权:Authorization: Bearer <I2V_SECRET>
- 零额外依赖:标准库 + venv 已有的 httpx

环境变量:I2V_SECRET(必填)、I2V_HOST、I2V_PORT、HERMES_HOME
"""
from __future__ import annotations

import base64
import io
import json
import logging
import os
import struct
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import httpx

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def sniff_mime(b: bytes):
    if b[:8] == bytes.fromhex("89504e470d0a1a0a"):
        return "image/png"
    if b[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "image/webp"
    return None


def image_size_from_bytes(data: bytes):
    """Return (width, height) for PNG/JPEG/WebP when headers are parseable."""
    if data.startswith(bytes.fromhex("89504e470d0a1a0a")) and len(data) >= 24:
        return struct.unpack(">II", data[16:24])
    if data[:3] == b"\xff\xd8\xff":
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            while i < len(data) and data[i] == 0xFF:
                i += 1
            if i >= len(data):
                break
            marker = data[i]
            i += 1
            if marker in (0xD8, 0xD9):
                continue
            if i + 2 > len(data):
                break
            seg_len = struct.unpack(">H", data[i:i + 2])[0]
            if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
                if i + 7 <= len(data):
                    h = struct.unpack(">H", data[i + 3:i + 5])[0]
                    w = struct.unpack(">H", data[i + 5:i + 7])[0]
                    return w, h
            i += max(seg_len, 2)
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        if data[12:16] == b"VP8X" and len(data) >= 30:
            w = 1 + int.from_bytes(data[24:27], "little")
            h = 1 + int.from_bytes(data[27:30], "little")
            return w, h
        if data[12:16] == b"VP8 " and len(data) >= 30:
            w = struct.unpack("<H", data[26:28])[0] & 0x3FFF
            h = struct.unpack("<H", data[28:30])[0] & 0x3FFF
            return w, h
        if data[12:16] == b"VP8L" and len(data) >= 25:
            bits = int.from_bytes(data[21:25], "little")
            w = (bits & 0x3FFF) + 1
            h = ((bits >> 14) & 0x3FFF) + 1
            return w, h
    return None


def data_uri_bytes(data_uri: str):
    if not isinstance(data_uri, str) or not data_uri.startswith("data:") or "," not in data_uri:
        return None
    header, encoded = data_uri.split(",", 1)
    if ";base64" not in header.lower():
        return None
    try:
        return base64.b64decode(encoded, validate=False)
    except Exception:
        return None


def nearest_aspect_for_image(image: str):
    data = data_uri_bytes(image)
    if not data:
        return None, None
    size = image_size_from_bytes(data)
    if not size:
        return None, None
    w, h = size
    if not w or not h:
        return None, size
    ratio = w / h
    aspect = min(SUPPORTED_ASPECT_RATIOS, key=lambda k: abs(SUPPORTED_ASPECT_RATIOS[k] - ratio))
    return aspect, size


def candidate_referers(url: str, provided: str | None):
    """按优先级生成多个 Referer 候选:传入值 → 图片同域 → 主域 → 无。
    很多站(如 gelbooru)只认主域 Referer,不认 CDN 子域。"""
    cands = []
    if provided:
        cands.append(provided)
    try:
        p = urlparse(url)
        if p.scheme and p.netloc:
            cands.append(f"{p.scheme}://{p.netloc}/")
            parts = p.netloc.split(".")
            if len(parts) > 2:
                cands.append(f"{p.scheme}://{'.'.join(parts[-2:])}/")  # 主域
    except Exception:
        pass
    cands.append(None)  # 不带 Referer
    seen, out = set(), []
    for c in cands:
        if c not in seen:
            seen.add(c)
            out.append(c)
    return out


def fetch_image_data_uri(url: str, referer: str | None = None) -> str:
    """服务端带浏览器 UA + 多个 Referer 候选抓图(绕过防盗链),
    按 magic bytes 识别真实类型,返回 data URI。"""
    last_err = None
    for ref in candidate_referers(url, referer):
        headers = {
            "User-Agent": BROWSER_UA,
            "Accept": "image/avif,image/webp,image/png,image/*,*/*;q=0.8",
        }
        if ref:
            headers["Referer"] = ref
        try:
            r = httpx.get(url, headers=headers, timeout=60, follow_redirects=True)
            r.raise_for_status()
            data = r.content
            mime = sniff_mime(data)
            if not mime:
                ct = (r.headers.get("content-type") or "").split(";")[0].strip().lower()
                if ct in ("image/jpeg", "image/jpg", "image/png", "image/webp"):
                    mime = "image/jpeg" if ct == "image/jpg" else ct
            if mime:
                log.info("fetched image via referer=%s (%s, %d bytes)", ref, mime, len(data))
                return f"data:{mime};base64,{base64.b64encode(data).decode()}"
            last_err = RuntimeError(
                f"非受支持图片 (content-type={r.headers.get('content-type')}, {len(data)} bytes)"
            )
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError(f"图片抓取失败: {last_err}")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
# httpx 默认 INFO 会把含 bot token 的完整 URL 写进日志 —— 降级避免 token 泄露
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("grok-i2v")

SECRET = os.environ.get("I2V_SECRET", "").strip()
HOST = os.environ.get("I2V_HOST", "127.0.0.1")
PORT = int(os.environ.get("I2V_PORT", "8799"))

DEFAULT_BASE_URL = "https://api.x.ai/v1"
DEFAULT_MODEL = "grok-imagine-video-1.5-preview"
SUPPORTED_ASPECT_RATIOS = {
    "16:9": 16 / 9,
    "3:2": 3 / 2,
    "4:3": 4 / 3,
    "1:1": 1.0,
    "3:4": 3 / 4,
    "2:3": 2 / 3,
    "9:16": 9 / 16,
}
VALID_ASPECT = set(SUPPORTED_ASPECT_RATIOS)
VALID_RES = {"480p", "720p"}
FAILURE_STATUSES = {
    "failed", "error", "expired", "cancelled", "canceled", "timeout", "timed_out",
    "rejected", "blocked", "denied", "refused", "not_allowed", "disallowed",
    "aborted", "moderation_failed", "moderation_rejected",
    "content_policy_violation", "content_policy_error", "policy_violation",
    "policy_rejected", "policy_blocked", "content_rejected", "content_blocked",
    "safety_failed", "safety_rejected", "safety_violation", "safety_blocked",
    "review_failed", "failed_review",
}
PROCESSING_STATUSES = {"", "queued", "pending", "processing", "running", "in_progress", "reviewing", "in_review"}
MODERATION_KEYWORDS = (
    "moderation_failed", "failed_moderation", "moderation_rejected",
    "content_policy", "content policy", "policy_violation", "policy rejected", "policy blocked",
    "safety_failed", "failed_safety", "safety_rejected", "safety_violation",
    "review_failed", "failed_review",
    "rejected", "blocked", "denied", "refused", "not allowed", "disallowed", "violation",
    "审查未通过", "审查失败", "审查拒绝", "安全未通过", "安全失败", "安全拒绝", "政策", "违规", "拒绝",
)

# 任务表:request_id -> {created, result}。后台 worker 轮询 xAI、更新 result,
# 完成后把源图+视频推到 Telegram。get_status 直接读这里(避免和 worker 重复轮询)。
JOBS: dict = {}
JOBS_LOCK = threading.Lock()


def _prune_jobs():
    cutoff = time.time() - 3600
    for k in [k for k, v in JOBS.items() if v.get("created", 0) < cutoff]:
        JOBS.pop(k, None)


def _status_text(status) -> str:
    return str(status or "").strip().lower()


def _compact_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return str(value)


def _error_message(body, fallback: str = "上游返回失败") -> str:
    if not isinstance(body, dict):
        return _compact_text(body) or fallback
    err = body.get("error")
    if isinstance(err, str) and err.strip():
        return err.strip()
    if isinstance(err, dict):
        for key in ("message", "reason", "code", "type", "detail", "details"):
            value = err.get(key)
            text = _compact_text(value).strip()
            if text:
                return text
    for key in ("message", "reason", "failure_reason", "detail", "details"):
        value = body.get(key)
        text = _compact_text(value).strip()
        if text:
            return text
    return fallback


def _is_failure_status(status) -> bool:
    return _status_text(status) in FAILURE_STATUSES


def _has_error_payload(body) -> bool:
    if not isinstance(body, dict) or "error" not in body:
        return False
    err = body.get("error")
    if err in (None, ""):
        return False
    if isinstance(err, dict) and not err:
        return False
    return True


def _is_moderation_text(text: str) -> bool:
    haystack = str(text or "").lower()
    return any(keyword in haystack for keyword in MODERATION_KEYWORDS)


def _failure_signal_text(body) -> str:
    if not isinstance(body, dict):
        return ""
    parts = [
        body.get("status"),
        body.get("message"),
        body.get("reason"),
        body.get("failure_reason"),
        body.get("detail"),
        body.get("details"),
    ]
    err = body.get("error")
    if isinstance(err, dict):
        parts.extend(err.get(k) for k in ("message", "reason", "code", "type", "detail", "details"))
    else:
        parts.append(err)
    return " ".join(_compact_text(v) for v in parts if v)


def _is_failure_result(res: dict) -> bool:
    if not isinstance(res, dict):
        return False
    if res.get("success") is False:
        return True
    if _has_error_payload(res):
        return True
    if _is_failure_status(res.get("status")):
        return True
    return _is_moderation_text(_failure_signal_text(res))


def _failure_result(body, status=None, fallback: str = "上游返回失败") -> dict:
    st = _status_text(status if status is not None else (body or {}).get("status") if isinstance(body, dict) else "")
    msg = _error_message(body, f"状态 '{st}'" if st else fallback)
    if _is_moderation_text(f"{st} {msg}"):
        msg = "x.ai 审查未通过:" + msg
    return {"success": False, "status": st or "error", "error": msg}


# ----------------------------- Telegram 推送 -----------------------------

def _tg_creds():
    """从 hermes .env 读取 bot token 和目标 chat(纯出站,不触发 agent)。"""
    token = chat = ""
    try:
        from tools.xai_http import get_env_value
        token = (get_env_value("TELEGRAM_BOT_TOKEN") or "").strip()
        chat = (get_env_value("TELEGRAM_HOME_CHANNEL") or "").strip()
    except Exception:
        pass
    token = token or os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat = chat or os.environ.get("TELEGRAM_HOME_CHANNEL", "").strip() or os.environ.get("TG_CHAT_ID", "").strip()
    return token, chat


def _decode_data_uri(du: str):
    if du and du.startswith("data:") and "," in du:
        head, b64 = du.split(",", 1)
        mime = head[5:].split(";")[0] or "image/jpeg"
        try:
            return base64.b64decode(b64), mime
        except Exception:
            return None, None
    return None, None


def push_telegram(image_data_uri: str, video_url: str, meta: dict):
    """把源图 + 生成视频发到 Telegram。失败仅记日志,不影响主流程。"""
    token, chat = _tg_creds()
    if not token or not chat:
        log.warning("telegram 未配置,跳过推送")
        return
    api = f"https://api.telegram.org/bot{token}"
    cap = f"🎬 Grok 图生视频\n{meta.get('aspect')} · {meta.get('resolution')} · {meta.get('duration')}s"
    pr = (meta.get("prompt") or "").strip()
    if pr:
        cap += "\n" + pr[:300]

    with httpx.Client(timeout=180) as client:
        # 1) 源图
        img_bytes, mime = _decode_data_uri(image_data_uri or "")
        if img_bytes:
            ext = {"image/png": "png", "image/webp": "webp"}.get(mime, "jpg")
            try:
                client.post(f"{api}/sendPhoto",
                            data={"chat_id": chat, "caption": "源图 / source"},
                            files={"photo": (f"source.{ext}", img_bytes, mime or "image/jpeg")})
            except Exception as e:
                log.warning("sendPhoto 失败: %s", e)
        # 2) 视频:先按 URL 发,失败则下载后上传
        if video_url:
            ok = False
            try:
                r = client.post(f"{api}/sendVideo",
                                data={"chat_id": chat, "video": video_url, "caption": cap})
                ok = bool(r.json().get("ok"))
            except Exception as e:
                log.warning("sendVideo(URL) 失败: %s", e)
            if not ok:
                try:
                    vb = client.get(video_url, timeout=180).content
                    r = client.post(f"{api}/sendVideo",
                                    data={"chat_id": chat, "caption": cap},
                                    files={"video": ("video.mp4", vb, "video/mp4")})
                    ok = bool(r.json().get("ok"))
                except Exception as e:
                    log.warning("sendVideo(上传) 失败: %s", e)
            log.info("telegram 推送完成 (video ok=%s) chat=%s", ok, chat)


def _worker(request_id: str, image_data_uri: str, meta: dict):
    """后台轮询 xAI;完成即推 Telegram。结果同步写入 JOBS 供 /status 读取。"""
    deadline = time.time() + 600
    while time.time() < deadline:
        res = _query_xai(request_id)
        with JOBS_LOCK:
            if request_id in JOBS:
                JOBS[request_id]["result"] = res
        status = res.get("status")
        if status == "done":
            try:
                push_telegram(image_data_uri, res.get("video_url"), meta)
            except Exception as e:
                log.warning("telegram 推送异常: %s", e)
            return
        if _is_failure_result(res):
            return
        time.sleep(5)
    with JOBS_LOCK:
        if request_id in JOBS:
            JOBS[request_id]["result"] = {"success": False, "status": "timeout", "error": "生成超时"}


def _xai_auth_dir():
    return os.environ.get("XAI_AUTH_DIR", "/opt/cliproxyapi/auths")


def _list_xai_auth_files():
    import glob
    return sorted(glob.glob(os.path.join(_xai_auth_dir(), "xai-*.json")))


def _jwt_exp_left(token: str) -> int:
    try:
        import base64, json as _json, time
        p = token.split(".")[1]; p += "=" * (-len(p) % 4)
        pl = _json.loads(base64.urlsafe_b64decode(p))
        return int(pl.get("exp", 0) - time.time())
    except Exception:
        return 0


def _refresh_xai_auth(path: str) -> str:
    """用 refresh_token 刷新一个 auth 文件,成功则写回并返回新 access_token。"""
    try:
        import json as _json
        d = _json.load(open(path, encoding="utf-8"))
        rt = d.get("refresh_token")
        te = d.get("token_endpoint") or "https://auth.x.ai/oauth2/token"
        if not rt:
            return ""
        data = {"grant_type": "refresh_token", "refresh_token": rt}
        cid = d.get("client_id") or os.environ.get("XAI_OAUTH_CLIENT_ID", "")
        if cid:
            data["client_id"] = cid
        r = httpx.post(te, data=data, timeout=30)
        if r.status_code >= 400:
            log.warning("refresh failed %s: %s %s", os.path.basename(path), r.status_code, r.text[:120])
            return ""
        j = r.json()
        at = j.get("access_token")
        if not at:
            return ""
        d["access_token"] = at
        if j.get("refresh_token"):
            d["refresh_token"] = j["refresh_token"]
        import time as _t
        d["last_refresh"] = int(_t.time())
        _json.dump(d, open(path, "w", encoding="utf-8"))
        log.info("refreshed xai token: %s", d.get("email") or os.path.basename(path))
        return at
    except Exception as e:
        log.warning("refresh error %s: %s", os.path.basename(path), e)
        return ""


# 记住上次成功的账号文件,优先复用(减少切换)
_LAST_GOOD = {"path": None}


def _candidate_token(path: str, force_refresh: bool = False) -> str:
    """返回该 auth 文件可用的 access_token(必要时刷新);不可用返回空。"""
    import json as _json
    try:
        d = _json.load(open(path, encoding="utf-8"))
    except Exception:
        return ""
    if d.get("disabled"):
        return ""
    tok = str(d.get("access_token") or "").strip()
    if force_refresh or not tok or _jwt_exp_left(tok) < 120:
        tok = _refresh_xai_auth(path) or tok
    return tok


def resolve_creds(force_refresh: bool = False):
    """(token, base_url) — 从 cliproxyapi 的 xai auth 池里选一个有额度的账号。
    顺序:上次成功的账号 → 其余账号;自动跳过 disabled / 401 / 403(无额度)。
    通过一次轻量 GET /models 探额度(200 才用)。全失败回退 hermes / XAI_API_KEY。
    """
    files = _list_xai_auth_files()
    if _LAST_GOOD["path"] in files:
        files = [_LAST_GOOD["path"]] + [f for f in files if f != _LAST_GOOD["path"]]
    for path in files:
        tok = _candidate_token(path, force_refresh=force_refresh)
        if not tok:
            continue
        base = DEFAULT_BASE_URL
        try:
            d = __import__("json").load(open(path, encoding="utf-8"))
            base = str(d.get("base_url") or DEFAULT_BASE_URL).strip().rstrip("/")
        except Exception:
            pass
        try:
            r = httpx.get(base + "/models", headers={"Authorization": "Bearer " + tok}, timeout=20)
        except Exception:
            continue
        if r.status_code == 200:
            _LAST_GOOD["path"] = path
            return tok, base
        if r.status_code == 401:
            tok2 = _candidate_token(path, force_refresh=True)
            if tok2 and tok2 != tok:
                try:
                    r2 = httpx.get(base + "/models", headers={"Authorization": "Bearer " + tok2}, timeout=20)
                    if r2.status_code == 200:
                        _LAST_GOOD["path"] = path
                        return tok2, base
                except Exception:
                    pass
        # 403(无额度)/ 其它 → 跳过,试下一个
        log.info("skip xai account %s (/models=%s)", os.path.basename(path), r.status_code)
    # 回退:hermes 解析器 / XAI_API_KEY
    try:
        from tools.xai_http import resolve_xai_http_credentials
        c = resolve_xai_http_credentials(force_refresh=force_refresh) or {}
        tok = str(c.get("api_key") or "").strip()
        base = str(c.get("base_url") or DEFAULT_BASE_URL).strip().rstrip("/")
        if tok:
            return tok, base
    except Exception as e:
        log.warning("credential resolver failed: %s", e)
    return os.environ.get("XAI_API_KEY", "").strip(), DEFAULT_BASE_URL


def user_agent() -> str:
    try:
        from tools.xai_http import hermes_xai_user_agent

        return hermes_xai_user_agent()
    except Exception:
        return "grok-i2v-shim/2.0"


def _headers(token):
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "User-Agent": user_agent(),
    }


def submit_job(req: dict) -> dict:
    prompt = (req.get("prompt") or "").strip() or (
        "Animate this image into a high-quality cinematic video. Strictly preserve "
        "the original subject, composition, colors, background, and identity/details. "
        "Use subtle natural motion and gentle camera movement. Do not morph, distort, "
        "redraw, change identity, add text, add new objects, or alter the scene."
    )
    image_b64 = (req.get("image_b64") or "").strip()
    image_url = (req.get("image_url") or "").strip()
    referer = (req.get("referer") or "").strip() or None
    if image_b64:
        image = image_b64
    elif image_url:
        # 服务端代抓(带 Referer),拿真图转 data URI 再交给 xAI
        image = fetch_image_data_uri(image_url, referer)
    else:
        image = ""

    duration = max(1, min(15, int(req.get("duration") or 6)))
    requested_aspect = (req.get("aspect_ratio") or req.get("aspect") or "").strip().lower()
    auto_aspect = requested_aspect in {"", "auto", "original", "orig", "source", "原图", "原始比例"}
    aspect, image_size = nearest_aspect_for_image(image) if auto_aspect else (requested_aspect, None)
    if aspect not in VALID_ASPECT:
        aspect = "16:9"
    if auto_aspect and image_size:
        log.info("auto aspect from source image %sx%s -> %s", image_size[0], image_size[1], aspect)
    resolution = (req.get("resolution") or "720p").strip().lower()
    if resolution not in VALID_RES:
        resolution = "720p"

    payload = {
        "model": req.get("model") or DEFAULT_MODEL,
        "prompt": prompt,
        "duration": duration,
        "aspect_ratio": aspect,
        "resolution": resolution,
    }
    if image:
        payload["image"] = {"url": image}

    token, base = resolve_creds()
    if not token:
        return {"success": False, "error": "无可用 xAI 凭证(请在 cliproxyapi auths 里放有额度的 xai oauth 账号)"}

    with httpx.Client() as client:
        r = client.post(
            f"{base}/videos/generations",
            headers={**_headers(token), "x-idempotency-key": str(uuid.uuid4())},
            json=payload, timeout=60,
        )
        if r.status_code == 401:
            token, base = resolve_creds(force_refresh=True)
            r = client.post(
                f"{base}/videos/generations",
                headers={**_headers(token), "x-idempotency-key": str(uuid.uuid4())},
                json=payload, timeout=60,
            )
        if r.status_code >= 400:
            try:
                body = r.json()
            except Exception:
                body = {"error": f"submit failed ({r.status_code}): {r.text[:400]}"}
            return _failure_result(body, fallback=f"submit failed ({r.status_code}): {r.text[:400]}")
        submit_body = r.json()
        if (submit_body.get("success") is False or _has_error_payload(submit_body)
                or _is_failure_status(submit_body.get("status"))
                or _is_moderation_text(_failure_signal_text(submit_body))):
            return _failure_result(submit_body)
        request_id = submit_body.get("request_id")
        if not request_id:
            return {"success": False, "status": "error", "error": "响应缺少 request_id"}

    log.info("submitted request_id=%s (%s, %s, %ss)", request_id, aspect, resolution, duration)

    # 注册任务 + 起后台 worker(轮询 xAI,完成后推 Telegram)
    meta = {"aspect": aspect, "resolution": resolution, "duration": duration, "prompt": prompt, "image_size": image_size if 'image_size' in locals() else None}
    with JOBS_LOCK:
        _prune_jobs()
        JOBS[request_id] = {"created": time.time(),
                            "result": {"success": True, "status": "processing"}}
    threading.Thread(target=_worker, args=(request_id, image, meta), daemon=True).start()

    return {"success": True, "request_id": request_id,
            "resolution": resolution, "requested_resolution": resolution,
            "aspect_ratio": aspect, "image_size": image_size if 'image_size' in locals() else None,
            "duration": duration}


def get_status(request_id: str) -> dict:
    """优先返回后台 worker 写入 JOBS 的结果;无任务记录再按后端直查。"""
    with JOBS_LOCK:
        job = JOBS.get(request_id)
    if job:
        return job.get("result") or {"success": True, "status": "processing"}
    return _query_xai(request_id)


def _query_xai(request_id: str) -> dict:
    token, base = resolve_creds()
    if not token:
        return {"success": False, "error": "无可用 xAI 凭证"}
    with httpx.Client() as client:
        r = client.get(f"{base}/videos/{request_id}", headers=_headers(token), timeout=30)
        if r.status_code == 202:
            return {"success": True, "status": "processing"}
        if r.status_code >= 400:
            try:
                body = r.json()
            except Exception:
                body = {"error": f"status check failed ({r.status_code}): {r.text[:300]}"}
            return _failure_result(body, status="error",
                                   fallback=f"status check failed ({r.status_code}): {r.text[:300]}")
        body = r.json()

    st = (body.get("status") or "").lower()
    if st == "done" or (body.get("video") or {}).get("url"):
        url = (body.get("video") or {}).get("url")
        if not url:
            return {"success": False, "status": "error", "error": "完成但无视频 URL"}
        return {"success": True, "status": "done", "video_url": url,
                "duration": (body.get("video") or {}).get("duration"),
                "usage": body.get("usage")}
    if (body.get("success") is False or _has_error_payload(body) or _is_failure_status(st)
            or _is_moderation_text(_failure_signal_text(body))):
        return _failure_result(body, status=st)
    return {"success": True, "status": st or "processing"}


class Handler(BaseHTTPRequestHandler):
    server_version = "grok-i2v/2.0"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

    def _json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _authed(self) -> bool:
        if not SECRET:
            return True
        return self.headers.get("Authorization", "") == f"Bearer {SECRET}"

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        if path in ("/health", ""):
            tok, _ = resolve_creds()
            self._json(200, {"ok": True, "has_credentials": bool(tok)})
            return
        if path == "/status":
            if not self._authed():
                self._json(200, {"success": False, "error": "unauthorized"})
                return
            qs = parse_qs(parsed.query)
            rid = (qs.get("id") or [""])[0]
            if not rid:
                self._json(200, {"success": False, "error": "missing id"})
                return
            try:
                self._json(200, get_status(rid))
            except Exception as e:
                log.warning("status failed: %s", e)
                self._json(200, {"success": False, "status": "error", "error": str(e)})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/i2v":
            self._json(404, {"error": "not found"})
            return
        if not self._authed():
            self._json(200, {"success": False, "error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            req = json.loads(raw or b"{}")
        except Exception as e:
            self._json(200, {"success": False, "error": f"bad json: {e}"})
            return
        try:
            self._json(200, submit_job(req))
        except Exception as e:
            log.warning("submit failed: %s", e)
            self._json(200, {"success": False, "error": str(e)})

    def log_message(self, fmt, *args):
        log.info("%s - %s", self.address_string(), fmt % args)


def main():
    if not SECRET:
        log.warning("I2V_SECRET 未设置 —— 接口不鉴权,仅本地调试!")
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    log.info("grok-i2v (async) listening on http://%s:%d", HOST, PORT)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
