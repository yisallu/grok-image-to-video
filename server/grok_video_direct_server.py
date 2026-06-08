#!/usr/bin/env python3
"""Clean Grok video provider for CLIProxyAPI.

This service exposes a small OpenAI-style video API on localhost and calls
api.x.ai directly with the existing xai-* OAuth files.
"""
from __future__ import annotations

import base64
import glob
import hashlib
import json
import logging
import os
import sqlite3
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import httpx


HOST = os.environ.get("GROK_VIDEO_HOST", "127.0.0.1")
PORT = int(os.environ.get("GROK_VIDEO_PORT", "18320"))
XAI_AUTH_DIR = os.environ.get("XAI_AUTH_DIR", "/opt/cliproxyapi/auths")
DEFAULT_BASE_URL = os.environ.get("XAI_BASE_URL", "https://api.x.ai/v1").rstrip("/")
UPSTREAM_MODEL = os.environ.get("GROK_VIDEO_UPSTREAM_MODEL", "grok-imagine-video-1.5-preview")
USAGE_DB_PATH = os.environ.get("USAGE_DB_PATH", "/var/lib/docker/volumes/cpa-manager-plus-data/_data/usage.sqlite")
PUBLIC_MODELS = ["grok-imagine-video", "grok-imagine-video-1.5-preview"]

FAILURE_STATUSES = {
    "failed", "error", "expired", "cancelled", "canceled", "timeout", "timed_out",
    "rejected", "blocked", "denied", "refused", "not_allowed", "disallowed",
    "aborted", "moderation_failed", "moderation_rejected",
    "content_policy_violation", "content_policy_error", "policy_violation",
    "policy_rejected", "policy_blocked", "content_rejected", "content_blocked",
    "safety_failed", "safety_rejected", "safety_violation", "safety_blocked",
    "review_failed", "failed_review",
}

MODERATION_WORDS = (
    "moderation_failed", "failed_moderation", "moderation_rejected",
    "content_policy", "content policy", "policy_violation", "policy rejected",
    "policy blocked", "safety_failed", "failed_safety", "safety_rejected",
    "safety_violation", "review_failed", "failed_review", "rejected", "blocked",
    "denied", "refused", "not allowed", "disallowed", "violation",
    "审查未通过", "审查失败", "审查拒绝", "安全未通过", "安全失败", "安全拒绝",
    "政策", "违规", "拒绝",
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("grok-video-direct")

_LAST_GOOD = {"path": None}


def compact(value) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return str(value)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def mask_account(value: str) -> str:
    if "@" not in value:
        return value[:3] + "***" if len(value) > 3 else value
    name, domain = value.split("@", 1)
    return f"{name[:3]}***@{domain}"


def auth_meta(path: str, data: dict) -> dict:
    file_name = os.path.basename(path)
    provider = str(data.get("type") or data.get("provider") or "xai")
    account = str(data.get("email") or data.get("account") or data.get("sub") or file_name)
    auth_index = str(data.get("auth_index") or data.get("authIndex") or "").strip()
    if not auth_index:
        parts = [provider, account, str(data.get("sub") or ""), file_name]
        auth_index = sha256_text("|".join(parts))[:16]
    return {
        "auth_index": auth_index,
        "account": account,
        "label": str(data.get("label") or account),
        "file_name": file_name,
        "provider": provider,
        "project_id": data.get("project_id") or data.get("projectId"),
        "source": mask_account(account),
        "source_hash": sha256_text(account),
    }


def safe_raw_json(payload: dict) -> str:
    try:
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))[:8000]
    except Exception:
        return "{}"


def json_response(handler: BaseHTTPRequestHandler, code: int, obj: dict):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.end_headers()
    handler.wfile.write(data)


def read_json(handler: BaseHTTPRequestHandler) -> dict:
    raw = handler.rfile.read(int(handler.headers.get("Content-Length") or 0))
    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return {}


def jwt_exp_left(token: str) -> int:
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        payload = json.loads(base64.urlsafe_b64decode(part))
        return int(payload.get("exp", 0) - time.time())
    except Exception:
        return 0


def refresh_auth(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        refresh_token = data.get("refresh_token")
        endpoint = data.get("token_endpoint") or "https://auth.x.ai/oauth2/token"
        if not refresh_token:
            return ""
        body = {"grant_type": "refresh_token", "refresh_token": refresh_token}
        client_id = data.get("client_id") or os.environ.get("XAI_OAUTH_CLIENT_ID", "")
        if client_id:
            body["client_id"] = client_id
        resp = httpx.post(endpoint, data=body, timeout=30)
        if resp.status_code >= 400:
            log.warning("refresh failed %s: %s %s", os.path.basename(path), resp.status_code, resp.text[:160])
            return ""
        fresh = resp.json()
        token = fresh.get("access_token")
        if not token:
            return ""
        data["access_token"] = token
        if fresh.get("refresh_token"):
            data["refresh_token"] = fresh["refresh_token"]
        data["last_refresh"] = int(time.time())
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        log.info("refreshed xai token: %s", data.get("email") or os.path.basename(path))
        return token
    except Exception as exc:
        log.warning("refresh error %s: %s", os.path.basename(path), exc)
        return ""


def auth_files():
    return sorted(glob.glob(os.path.join(XAI_AUTH_DIR, "xai-*.json")))


def load_token(path: str, force_refresh: bool = False) -> tuple[str, str, dict | None]:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return "", DEFAULT_BASE_URL, None
    meta = auth_meta(path, data)
    if data.get("disabled"):
        return "", DEFAULT_BASE_URL, meta
    base_url = str(data.get("base_url") or DEFAULT_BASE_URL).rstrip("/")
    token = str(data.get("access_token") or "").strip()
    if force_refresh or not token or jwt_exp_left(token) < 120:
        token = refresh_auth(path) or token
        try:
            with open(path, encoding="utf-8") as f:
                meta = auth_meta(path, json.load(f))
        except Exception:
            pass
    return token, base_url, meta


def resolve_creds(force_refresh: bool = False) -> tuple[str, str, dict | None]:
    files = auth_files()
    if _LAST_GOOD["path"] in files:
        files = [_LAST_GOOD["path"]] + [p for p in files if p != _LAST_GOOD["path"]]
    for path in files:
        token, base_url, meta = load_token(path, force_refresh=force_refresh)
        if not token:
            continue
        try:
            resp = httpx.get(base_url + "/models", headers={"Authorization": "Bearer " + token}, timeout=20)
        except Exception:
            continue
        if resp.status_code == 200:
            _LAST_GOOD["path"] = path
            return token, base_url, meta
        if resp.status_code == 401:
            token, base_url, meta = load_token(path, force_refresh=True)
            if token:
                try:
                    resp = httpx.get(base_url + "/models", headers={"Authorization": "Bearer " + token}, timeout=20)
                    if resp.status_code == 200:
                        _LAST_GOOD["path"] = path
                        return token, base_url, meta
                except Exception:
                    pass
        log.info("skip xai account %s (/models=%s)", os.path.basename(path), resp.status_code)
    return "", DEFAULT_BASE_URL, None


def headers(token: str) -> dict:
    return {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "User-Agent": "grok-video-direct/1.0",
    }


def public_model(model: str) -> str:
    return model if model in PUBLIC_MODELS else "grok-imagine-video"


def upstream_model(model: str) -> str:
    if model == "grok-imagine-video-1.5-preview":
        return model
    return UPSTREAM_MODEL


def text_from_messages(messages) -> str:
    parts = []
    if not isinstance(messages, list):
        return ""
    for message in messages:
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for item in content:
                if isinstance(item, dict):
                    text = item.get("text") or item.get("input_text")
                    if isinstance(text, str):
                        parts.append(text)
                elif isinstance(item, str):
                    parts.append(item)
    return "\n".join(p for p in parts if p)


def normalize_create_payload(payload: dict) -> dict:
    requested_model = str(payload.get("model") or "grok-imagine-video")
    prompt = payload.get("prompt") or payload.get("input") or text_from_messages(payload.get("messages"))
    if isinstance(prompt, list):
        prompt = text_from_messages(prompt)

    out = {
        "model": public_model(requested_model),
        "prompt": str(prompt or ""),
    }
    for key in ("duration", "seconds"):
        if payload.get(key) is not None:
            out["duration"] = int(float(payload.get(key)))
            break
    if payload.get("resolution"):
        out["resolution"] = str(payload.get("resolution"))
    if payload.get("aspect_ratio"):
        out["aspect_ratio"] = str(payload.get("aspect_ratio"))
    elif payload.get("aspect"):
        out["aspect_ratio"] = str(payload.get("aspect"))

    image = payload.get("image")
    if not image:
        image = payload.get("image_url") or payload.get("reference_image") or payload.get("prompt_image")
    if isinstance(image, str):
        out["image"] = {"url": image}
    elif isinstance(image, dict):
        out["image"] = image
    if out.get("image") and out["model"] == "grok-imagine-video":
        out["model"] = UPSTREAM_MODEL
    return out


def should_retry_text_to_video(body: dict, data: dict, status_code: int) -> bool:
    if status_code != 400 or body.get("image") or body.get("model") == "grok-imagine-video":
        return False
    text = error_message(data, "").lower()
    return "text-to-video" in text and "not supported" in text


def error_message(body, fallback: str) -> str:
    if not isinstance(body, dict):
        return compact(body) or fallback
    err = body.get("error")
    if isinstance(err, str) and err:
        return err
    if isinstance(err, dict):
        for key in ("message", "reason", "code", "type", "detail", "details"):
            text = compact(err.get(key)).strip()
            if text:
                return text
    for key in ("message", "reason", "failure_reason", "detail", "details"):
        text = compact(body.get(key)).strip()
        if text:
            return text
    return fallback


def failure_signal_text(body: dict) -> str:
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
    return " ".join(compact(v) for v in parts if v)


def is_failure(body: dict) -> bool:
    if not isinstance(body, dict):
        return False
    status = str(body.get("status") or "").lower()
    if body.get("success") is False:
        return True
    if status in FAILURE_STATUSES:
        return True
    text = failure_signal_text(body).lower()
    return any(word in text for word in MODERATION_WORDS)


def failure_response(body: dict, status: str = "", fallback: str = "upstream failed") -> dict:
    raw_status = str(status or (body or {}).get("status") or "error").lower()
    msg = error_message(body, fallback)
    if any(word in (raw_status + " " + msg).lower() for word in MODERATION_WORDS):
        msg = "x.ai 审查未通过:" + msg
    return {"success": False, "status": raw_status, "error": msg}


def record_usage_event(
    meta: dict | None,
    *,
    request_id: str,
    model: str,
    resolved_model: str,
    endpoint: str,
    method: str,
    path: str,
    status_code: int | None,
    latency_ms: int | None,
    failed: bool,
    response_body: dict | None = None,
    fail_summary: str = "",
):
    if not meta or not USAGE_DB_PATH or not os.path.exists(USAGE_DB_PATH):
        return
    now = int(time.time() * 1000)
    timestamp = datetime.fromtimestamp(now / 1000, timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
    summary = fail_summary
    if failed and not summary:
        summary = error_message(response_body or {}, "xai request failed")
    raw = {
        "provider": "xai",
        "model": resolved_model,
        "requested_model": model,
        "endpoint": endpoint,
        "method": method,
        "path": path,
        "auth_type": "oauth",
        "auth_index": meta["auth_index"],
        "source": meta["source"],
        "source_hash": meta["source_hash"],
        "account_snapshot": meta["account"],
        "auth_label_snapshot": meta["label"],
        "auth_file_snapshot": meta["file_name"],
        "auth_provider_snapshot": meta["provider"],
        "auth_project_id_snapshot": meta.get("project_id"),
        "status_code": status_code,
        "latency_ms": latency_ms,
        "failed": failed,
        "fail_summary": summary or None,
        "response": response_body or {},
    }
    values = {
        "request_id": request_id or None,
        "event_hash": sha256_text(f"{now}|{uuid.uuid4()}|{request_id}|{endpoint}|{meta['auth_index']}"),
        "timestamp_ms": now,
        "timestamp": timestamp,
        "provider": "xai",
        "model": resolved_model or model or "grok-imagine-video",
        "endpoint": endpoint,
        "method": method,
        "path": path,
        "auth_type": "oauth",
        "auth_index": meta["auth_index"],
        "source": meta["source"],
        "source_hash": meta["source_hash"],
        "api_key_hash": None,
        "account_snapshot": meta["account"],
        "auth_label_snapshot": meta["label"],
        "auth_file_snapshot": meta["file_name"],
        "auth_provider_snapshot": meta["provider"],
        "auth_project_id_snapshot": meta.get("project_id"),
        "auth_snapshot_at_ms": now,
        "requested_model": model,
        "resolved_model": resolved_model,
        "input_tokens": 0,
        "output_tokens": 0,
        "reasoning_tokens": 0,
        "cached_tokens": 0,
        "cache_tokens": 0,
        "total_tokens": 0,
        "latency_ms": latency_ms,
        "failed": 1 if failed else 0,
        "raw_json": safe_raw_json(raw),
        "created_at_ms": now,
        "executor_type": "GrokVideoDirect",
        "cache_read_tokens": 0,
        "cache_creation_tokens": 0,
        "fail_status_code": status_code,
        "fail_summary": summary[:1000] if summary else None,
        "fail_body": compact(response_body)[:4000] if failed and response_body else None,
    }
    try:
        with sqlite3.connect(USAGE_DB_PATH, timeout=2) as con:
            con.execute("pragma busy_timeout=2000")
            existing = {row[1] for row in con.execute("pragma table_info(usage_events)")}
            values = {key: value for key, value in values.items() if key in existing}
            columns = list(values)
            placeholders = ",".join("?" for _ in columns)
            con.execute(
                f"insert or ignore into usage_events ({','.join(columns)}) values ({placeholders})",
                [values[key] for key in columns],
            )
    except Exception as exc:
        log.warning("usage event write failed: %s", exc)


def create_video(payload: dict) -> tuple[int, dict]:
    token, base_url, meta = resolve_creds()
    if not token:
        return 503, {"success": False, "status": "error", "error": "auth_unavailable: no xai oauth available"}
    requested_model = public_model(str(payload.get("model") or "grok-imagine-video"))
    body = normalize_create_payload(payload)
    if not body.get("prompt"):
        return 400, {"success": False, "status": "error", "error": "prompt is required"}
    started = int(time.time() * 1000)
    try:
        resp = httpx.post(
            base_url + "/videos/generations",
            headers={**headers(token), "x-idempotency-key": str(uuid.uuid4())},
            json=body,
            timeout=60,
        )
        if resp.status_code == 401:
            token, base_url, meta = resolve_creds(force_refresh=True)
            started = int(time.time() * 1000)
            resp = httpx.post(
                base_url + "/videos/generations",
                headers={**headers(token), "x-idempotency-key": str(uuid.uuid4())},
                json=body,
                timeout=60,
            )
    except Exception as exc:
        log.exception("create request failed")
        record_usage_event(
            meta,
            request_id="",
            model=requested_model,
            resolved_model=body.get("model") or requested_model,
            endpoint="POST /v1/videos/generations",
            method="POST",
            path="/v1/videos/generations",
            status_code=None,
            latency_ms=int(time.time() * 1000) - started,
            failed=True,
            response_body={"error": str(exc)},
            fail_summary=str(exc),
        )
        return 502, {"success": False, "status": "error", "error": str(exc)}

    try:
        data = resp.json()
    except Exception:
        data = {"error": resp.text[:400]}

    if should_retry_text_to_video(body, data, resp.status_code):
        body = dict(body)
        body["model"] = "grok-imagine-video"
        started = int(time.time() * 1000)
        try:
            resp = httpx.post(
                base_url + "/videos/generations",
                headers={**headers(token), "x-idempotency-key": str(uuid.uuid4())},
                json=body,
                timeout=60,
            )
            if resp.status_code == 401:
                token, base_url, meta = resolve_creds(force_refresh=True)
                started = int(time.time() * 1000)
                resp = httpx.post(
                    base_url + "/videos/generations",
                    headers={**headers(token), "x-idempotency-key": str(uuid.uuid4())},
                    json=body,
                    timeout=60,
                )
            try:
                data = resp.json()
            except Exception:
                data = {"error": resp.text[:400]}
        except Exception as exc:
            log.exception("create retry request failed")
            record_usage_event(
                meta,
                request_id="",
                model=requested_model,
                resolved_model=body.get("model") or requested_model,
                endpoint="POST /v1/videos/generations",
                method="POST",
                path="/v1/videos/generations",
                status_code=None,
                latency_ms=int(time.time() * 1000) - started,
                failed=True,
                response_body={"error": str(exc)},
                fail_summary=str(exc),
            )
            return 502, {"success": False, "status": "error", "error": str(exc)}

    request_id = data.get("request_id") or data.get("id") or ""
    latency = int(time.time() * 1000) - started
    if resp.status_code >= 400 or is_failure(data):
        failed_obj = failure_response(data, fallback=f"create failed ({resp.status_code})")
        record_usage_event(
            meta,
            request_id=str(request_id),
            model=requested_model,
            resolved_model=body.get("model") or requested_model,
            endpoint="POST /v1/videos/generations",
            method="POST",
            path="/v1/videos/generations",
            status_code=resp.status_code,
            latency_ms=latency,
            failed=True,
            response_body=data,
            fail_summary=failed_obj.get("error") or "",
        )
        code = 200 if is_failure(data) else resp.status_code
        return code, failed_obj

    if not request_id:
        record_usage_event(
            meta,
            request_id="",
            model=requested_model,
            resolved_model=body.get("model") or requested_model,
            endpoint="POST /v1/videos/generations",
            method="POST",
            path="/v1/videos/generations",
            status_code=502,
            latency_ms=latency,
            failed=True,
            response_body=data,
            fail_summary="upstream response missing request_id",
        )
        return 502, {"success": False, "status": "error", "error": "upstream response missing request_id"}
    record_usage_event(
        meta,
        request_id=str(request_id),
        model=requested_model,
        resolved_model=body.get("model") or requested_model,
        endpoint="POST /v1/videos/generations",
        method="POST",
        path="/v1/videos/generations",
        status_code=resp.status_code,
        latency_ms=latency,
        failed=False,
        response_body={"request_id": request_id, "status": data.get("status") or "queued"},
    )
    return 200, {
        "id": request_id,
        "request_id": request_id,
        "object": "video.generation",
        "model": requested_model,
        "status": data.get("status") or "queued",
    }


def poll_video(request_id: str) -> tuple[int, dict]:
    token, base_url, meta = resolve_creds()
    if not token:
        return 503, {"success": False, "status": "error", "error": "auth_unavailable: no xai oauth available"}
    started = int(time.time() * 1000)
    try:
        resp = httpx.get(base_url + "/videos/" + request_id, headers=headers(token), timeout=30)
        if resp.status_code == 401:
            token, base_url, meta = resolve_creds(force_refresh=True)
            started = int(time.time() * 1000)
            resp = httpx.get(base_url + "/videos/" + request_id, headers=headers(token), timeout=30)
    except Exception as exc:
        log.exception("poll request failed")
        record_usage_event(
            meta,
            request_id=request_id,
            model="grok-imagine-video",
            resolved_model=UPSTREAM_MODEL,
            endpoint="GET /v1/videos/:request_id",
            method="GET",
            path="/v1/videos/:request_id",
            status_code=None,
            latency_ms=int(time.time() * 1000) - started,
            failed=True,
            response_body={"error": str(exc)},
            fail_summary=str(exc),
        )
        return 502, {"success": False, "status": "error", "error": str(exc)}

    if resp.status_code == 202:
        return 202, {"success": True, "status": "processing", "id": request_id}
    try:
        data = resp.json()
    except Exception:
        data = {"error": resp.text[:400]}

    if resp.status_code >= 400:
        failed_obj = failure_response(data, status="error", fallback=f"poll failed ({resp.status_code})")
        record_usage_event(
            meta,
            request_id=request_id,
            model="grok-imagine-video",
            resolved_model=UPSTREAM_MODEL,
            endpoint="GET /v1/videos/:request_id",
            method="GET",
            path="/v1/videos/:request_id",
            status_code=resp.status_code,
            latency_ms=int(time.time() * 1000) - started,
            failed=True,
            response_body=data,
            fail_summary=failed_obj.get("error") or "",
        )
        return resp.status_code, failed_obj

    status = str(data.get("status") or "").lower()
    video = data.get("video") if isinstance(data.get("video"), dict) else {}
    video_url = data.get("video_url") or data.get("url") or video.get("url")
    if video_url or status in {"done", "succeeded", "completed"}:
        if not video_url:
            record_usage_event(
                meta,
                request_id=request_id,
                model="grok-imagine-video",
                resolved_model=UPSTREAM_MODEL,
                endpoint="GET /v1/videos/:request_id",
                method="GET",
                path="/v1/videos/:request_id",
                status_code=502,
                latency_ms=int(time.time() * 1000) - started,
                failed=True,
                response_body=data,
                fail_summary="done but video url is missing",
            )
            return 502, {"success": False, "status": "error", "error": "done but video url is missing"}
        record_usage_event(
            meta,
            request_id=request_id,
            model="grok-imagine-video",
            resolved_model=UPSTREAM_MODEL,
            endpoint="GET /v1/videos/:request_id",
            method="GET",
            path="/v1/videos/:request_id",
            status_code=resp.status_code,
            latency_ms=int(time.time() * 1000) - started,
            failed=False,
            response_body={"request_id": request_id, "status": status or "done", "has_video_url": bool(video_url)},
        )
        return 200, {
            "success": True,
            "id": request_id,
            "status": "done",
            "video_url": video_url,
            "video": {"url": video_url, "duration": video.get("duration")},
            "duration": video.get("duration") or data.get("duration"),
            "usage": data.get("usage"),
        }
    if is_failure(data):
        failed_obj = failure_response(data, status=status)
        record_usage_event(
            meta,
            request_id=request_id,
            model="grok-imagine-video",
            resolved_model=UPSTREAM_MODEL,
            endpoint="GET /v1/videos/:request_id",
            method="GET",
            path="/v1/videos/:request_id",
            status_code=resp.status_code,
            latency_ms=int(time.time() * 1000) - started,
            failed=True,
            response_body=data,
            fail_summary=failed_obj.get("error") or "",
        )
        return 200, failed_obj
    return 200, {"success": True, "id": request_id, "status": status or "processing"}


class Handler(BaseHTTPRequestHandler):
    server_version = "grok-video-direct/1.0"

    def log_message(self, fmt, *args):
        log.info("%s - %s", self.address_string(), fmt % args)

    def do_OPTIONS(self):
        json_response(self, 204, {})

    def do_GET(self):
        path = urlparse(self.path).path
        if path in {"/", "/health"}:
            token, _, _ = resolve_creds()
            json_response(self, 200, {"ok": True, "has_credentials": bool(token), "models": PUBLIC_MODELS})
            return
        if path == "/v1/models":
            json_response(self, 200, {"object": "list", "data": [{"id": m, "object": "model"} for m in PUBLIC_MODELS]})
            return
        prefix = "/v1/videos/"
        if path.startswith(prefix):
            request_id = path[len(prefix):].strip("/")
            code, obj = poll_video(request_id)
            json_response(self, code, obj)
            return
        json_response(self, 404, {"success": False, "status": "error", "error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        payload = read_json(self)
        if path in {"/v1/videos/generations", "/v1/video/generations"}:
            code, obj = create_video(payload)
            json_response(self, code, obj)
            return
        if path == "/v1/chat/completions" and str(payload.get("model") or "") in PUBLIC_MODELS:
            request_id = payload.get("request_id") or payload.get("task_id") or payload.get("id")
            if request_id and not any(payload.get(k) for k in ("prompt", "input", "messages", "image", "image_url")):
                code, obj = poll_video(str(request_id))
            else:
                code, obj = create_video(payload)
            json_response(self, code, obj)
            return
        json_response(self, 404, {"success": False, "status": "error", "error": "not found"})


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    log.info("listening on http://%s:%s, upstream=%s", HOST, PORT, DEFAULT_BASE_URL)
    server.serve_forever()


if __name__ == "__main__":
    main()
