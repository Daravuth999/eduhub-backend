"""EduHub Author Studio backend (FastAPI + MongoDB).

Dynamic CMS layered on top of the existing Google-Sheets driven library.
The frontend merges the two sources at read time so every existing sheet
book keeps working unchanged — this backend only ADDS new capabilities.
"""
from __future__ import annotations

import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

import json
import httpx
from bson import ObjectId
from dotenv import load_dotenv
from fastapi import (APIRouter, Cookie, Depends, FastAPI, File, Form, Header,
                     HTTPException, Request, Response, UploadFile, status)
from fastapi.responses import JSONResponse
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, ConfigDict, Field
from pywebpush import WebPushException, webpush
from py_vapid import Vapid01
from starlette.middleware.cors import CORSMiddleware

from content_parser import extract_docx, parse_content

# --------------------------------------------------------------------------- #
# Config                                                                      #
# --------------------------------------------------------------------------- #
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
ADMIN_EMAILS = {
    e.strip().lower()
    for e in os.environ.get("STUDIO_ADMIN_EMAILS", "").split(",")
    if e.strip()
}
# REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
EMERGENT_AUTH_SESSION_URL = (
    "https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data"
)

# Push (Web Push / VAPID) config
VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_CLAIM_EMAIL = os.environ.get("VAPID_CLAIM_EMAIL", "mailto:admin@eduhub.app")
CRON_SECRET = os.environ.get("CRON_SECRET", "")

# Pre-parse the VAPID PEM once. pywebpush expects either a Vapid01 instance, a
# file path, or a raw base64-encoded private key string (NOT PEM). Passing PEM
# directly fails with "Could not deserialize key data". We parse here at boot
# so every subsequent webpush() call reuses this instance.
_VAPID_INSTANCE: Vapid01 | None = None
if VAPID_PRIVATE_KEY:
    try:
        _VAPID_INSTANCE = Vapid01.from_pem(VAPID_PRIVATE_KEY.encode())
    except Exception as _exc:  # noqa: BLE001
        logging.getLogger("eduhub").warning(
            "VAPID_PRIVATE_KEY could not be parsed: %s", _exc
        )

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

# Collection references for the Push Studio module
push_subscriptions = db["push_subscriptions"]
push_history = db["push_history"]
push_scheduled = db["push_scheduled"]

app = FastAPI(title="EduHub Author Studio API")
api = APIRouter(prefix="/api")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
log = logging.getLogger("eduhub")


# --------------------------------------------------------------------------- #
# Models                                                                      #
# --------------------------------------------------------------------------- #
Section = Literal["story", "conversation", "exercise"]


class User(BaseModel):
    model_config = ConfigDict(extra="ignore")
    user_id: str
    email: str
    name: str
    picture: str | None = ""
    is_admin: bool = False
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class Block(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: str = "paragraph"
    text: str = ""


class Chapter(BaseModel):
    model_config = ConfigDict(extra="allow")
    title: str = "Main"
    blocks: list[Block] = []


class BookPayload(BaseModel):
    """Client → server book shape (studio save)."""
    model_config = ConfigDict(extra="ignore")
    slug: str | None = None
    title: str
    subtitle: str = ""
    author: str = "Classroom Library"
    section: Section = "story"
    coverEmoji: str = "📖"
    coverImage: str = ""
    coverGradient: str = "linear-gradient(155deg, #2a2140 0%, #4a3a6a 100%)"
    accent: str = "#D4A843"
    badge: str = ""
    level: str = ""
    readingMinutes: int = 6
    price: int = 0
    published: bool = True
    newUntil: str = ""
    contentType: str = ""
    format: str = "blocks"
    chapters: list[Chapter] = []
    content: str = ""  # when format == markdown


class ParseRequest(BaseModel):
    text: str
    default_chapter: str = "Main"


# --------------------------------------------------------------------------- #
# Auth helpers                                                                #
# --------------------------------------------------------------------------- #
def slugify(raw: str) -> str:
    s = (raw or "").lower().strip()
    s = re.sub(r"\s+", "-", s)
    s = re.sub(r"[^a-z0-9-]", "", s)
    return s or f"book-{uuid.uuid4().hex[:8]}"


async def current_user(
    session_token: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> User | None:
    token = session_token
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
    if not token:
        return None
    sess = await db.user_sessions.find_one({"session_token": token}, {"_id": 0})
    if not sess:
        return None
    expires_at = sess.get("expires_at")
    if isinstance(expires_at, str):
        expires_at = datetime.fromisoformat(expires_at)
    if expires_at and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at and expires_at < datetime.now(timezone.utc):
        return None
    user = await db.users.find_one({"user_id": sess["user_id"]}, {"_id": 0})
    if not user:
        return None
    # keep created_at parseable
    ca = user.get("created_at")
    if isinstance(ca, str):
        try:
            user["created_at"] = datetime.fromisoformat(ca)
        except Exception:  # noqa: BLE001
            user["created_at"] = datetime.now(timezone.utc)
    return User(**user)


async def require_user(user: User | None = Depends(current_user)) -> User:
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


async def require_admin(user: User = Depends(require_user)) -> User:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


# --------------------------------------------------------------------------- #
# Auth routes                                                                 #
# --------------------------------------------------------------------------- #
@api.post("/auth/google")
async def auth_google(payload: dict, response: Response):
    """Exchange Emergent session_id for a persistent session cookie."""
    session_id = (payload or {}).get("session_id")
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id is required")

    async with httpx.AsyncClient(timeout=15) as hc:
        r = await hc.get(
            EMERGENT_AUTH_SESSION_URL,
            headers={"X-Session-ID": session_id},
        )
    if r.status_code != 200:
        log.warning("emergent auth failed status=%s body=%s", r.status_code, r.text[:200])
        raise HTTPException(status_code=401, detail="Invalid session_id")

    data = r.json() or {}
    email = (data.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=401, detail="Auth response missing email")

    is_admin = email in ADMIN_EMAILS if ADMIN_EMAILS else True
    # ^^ When no allowlist is configured, every signed-in user is treated
    # as admin (developer mode). Production deploys set STUDIO_ADMIN_EMAILS.

    user_doc = await db.users.find_one({"email": email}, {"_id": 0})
    now = datetime.now(timezone.utc)
    if user_doc:
        user_id = user_doc["user_id"]
        await db.users.update_one(
            {"user_id": user_id},
            {"$set": {
                "name": data.get("name") or user_doc.get("name", ""),
                "picture": data.get("picture") or user_doc.get("picture", ""),
                "is_admin": is_admin,
                "last_login": now.isoformat(),
            }},
        )
    else:
        user_id = f"user_{uuid.uuid4().hex[:12]}"
        await db.users.insert_one({
            "user_id": user_id,
            "email": email,
            "name": data.get("name") or "",
            "picture": data.get("picture") or "",
            "is_admin": is_admin,
            "created_at": now.isoformat(),
            "last_login": now.isoformat(),
        })

    session_token = data.get("session_token") or uuid.uuid4().hex
    await db.user_sessions.insert_one({
        "user_id": user_id,
        "session_token": session_token,
        "expires_at": (now + timedelta(days=7)).isoformat(),
        "created_at": now.isoformat(),
    })

    response.set_cookie(
        key="session_token",
        value=session_token,
        httponly=True,
        secure=True,
        samesite="none",
        path="/",
        max_age=7 * 24 * 60 * 60,
    )
    # v8.1 — mobile Safari ITP drops 3rd-party cookies across cross-site
    # redirects (vercel.app <-> onrender.com). We also return the token so
    # the frontend can cache it in localStorage and fall back to
    # `Authorization: Bearer` on devices where the cookie is blocked.
    return {
        "user_id": user_id,
        "email": email,
        "name": data.get("name") or "",
        "picture": data.get("picture") or "",
        "is_admin": is_admin,
        "session_token": session_token,
    }


@api.get("/auth/me")
async def auth_me(user: User | None = Depends(current_user)):
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return {
        "user_id": user.user_id,
        "email": user.email,
        "name": user.name,
        "picture": user.picture,
        "is_admin": user.is_admin,
    }


@api.post("/auth/logout")
async def auth_logout(
    response: Response,
    session_token: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    # Accept token via cookie OR Authorization: Bearer — needed for
    # mobile clients that use the localStorage fallback.
    token = session_token
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
    if token:
        await db.user_sessions.delete_one({"session_token": token})
    response.delete_cookie("session_token", path="/", samesite="none", secure=True)
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Books — public read                                                         #
# --------------------------------------------------------------------------- #
CANONICAL_BOOK_FIELDS = {
    "slug", "title", "subtitle", "author", "section", "coverEmoji",
    "coverImage", "coverGradient", "accent", "badge", "level",
    "readingMinutes", "price", "published", "newUntil", "contentType",
    "format", "chapters", "content", "revision", "_authoredAt", "_authoredBy",
}


def _clean_book(doc: dict) -> dict:
    out = {k: v for k, v in doc.items() if k in CANONICAL_BOOK_FIELDS}
    # Ensure all chapters/blocks are clean dicts (no ObjectIds)
    chapters = out.get("chapters") or []
    out["chapters"] = [
        {
            "title": str(c.get("title") or "Main"),
            "blocks": [
                {k: v for k, v in b.items() if not k.startswith("_")}
                for b in (c.get("blocks") or [])
                if isinstance(b, dict)
            ],
        }
        for c in chapters
        if isinstance(c, dict)
    ]
    return out


@api.get("/books")
async def list_books():
    """Return every published book, latest revision per slug."""
    cursor = db.books.find(
        {"published": True},
        {"_id": 0},
    ).sort([("slug", 1), ("revision", -1)])
    seen: set[str] = set()
    out: list[dict] = []
    async for doc in cursor:
        slug = doc.get("slug") or ""
        if not slug or slug in seen:
            continue
        seen.add(slug)
        out.append(_clean_book(doc))
    return {"success": True, "books": out}


@api.get("/books/{slug}")
async def get_book(slug: str):
    doc = await db.books.find_one(
        {"slug": slug, "published": True},
        {"_id": 0},
        sort=[("revision", -1)],
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Book not found")
    return {"success": True, "book": _clean_book(doc)}


# --------------------------------------------------------------------------- #
# Studio — admin CRUD                                                         #
# --------------------------------------------------------------------------- #
@api.get("/studio/books")
async def studio_list_books(admin: User = Depends(require_admin)):
    """All slugs (latest revision) for the studio browse tab."""
    cursor = db.books.find({}, {"_id": 0}).sort([("slug", 1), ("revision", -1)])
    seen: set[str] = set()
    out: list[dict] = []
    async for doc in cursor:
        slug = doc.get("slug") or ""
        if not slug or slug in seen:
            continue
        seen.add(slug)
        out.append(_clean_book(doc))
    return {"success": True, "books": out}


@api.get("/studio/books/{slug}")
async def studio_get_book(slug: str, admin: User = Depends(require_admin)):
    doc = await db.books.find_one({"slug": slug}, {"_id": 0}, sort=[("revision", -1)])
    if not doc:
        raise HTTPException(status_code=404, detail="Book not found")
    return {"success": True, "book": _clean_book(doc)}


@api.post("/studio/books")
async def studio_save_book(payload: BookPayload, admin: User = Depends(require_admin)):
    """Append-only save — writes a new revision document."""
    slug = slugify(payload.slug or payload.title)
    # compute next revision
    latest = await db.books.find_one({"slug": slug}, {"_id": 0, "revision": 1},
                                      sort=[("revision", -1)])
    next_rev = int((latest or {}).get("revision") or 0) + 1
    now = datetime.now(timezone.utc).isoformat()
    doc = payload.model_dump()
    # If format is markdown and chapters empty, auto-parse content
    if doc.get("format") == "markdown" and not doc.get("chapters"):
        parsed = parse_content(doc.get("content") or "")
        doc["chapters"] = parsed["chapters"]
        doc["format"] = "blocks"
    doc.update({
        "slug": slug,
        "revision": next_rev,
        "_authoredAt": now,
        "_authoredBy": admin.email,
    })
    await db.books.insert_one(doc)
    log.info("studio: saved slug=%s rev=%s by=%s", slug, next_rev, admin.email)
    return {"success": True, "slug": slug, "revision": next_rev, "book": _clean_book(doc)}


@api.post("/studio/books/{slug}/publish")
async def studio_publish(slug: str, admin: User = Depends(require_admin)):
    res = await db.books.update_many({"slug": slug}, {"$set": {"published": True}})
    return {"success": True, "matched": res.matched_count, "modified": res.modified_count}


@api.post("/studio/books/{slug}/unpublish")
async def studio_unpublish(slug: str, admin: User = Depends(require_admin)):
    res = await db.books.update_many({"slug": slug}, {"$set": {"published": False}})
    return {"success": True, "matched": res.matched_count, "modified": res.modified_count}


@api.delete("/studio/books/{slug}")
async def studio_delete(slug: str, admin: User = Depends(require_admin)):
    res = await db.books.delete_many({"slug": slug})
    return {"success": True, "deleted": res.deleted_count}


# --------------------------------------------------------------------------- #
# Studio — smart parse / upload                                               #
# --------------------------------------------------------------------------- #
@api.post("/studio/parse")
async def studio_parse(payload: ParseRequest, admin: User = Depends(require_admin)):
    """Raw text → structured chapters+blocks."""
    return {"success": True, **parse_content(payload.text, payload.default_chapter)}


@api.post("/studio/upload")
async def studio_upload(
    file: UploadFile = File(...),
    admin: User = Depends(require_admin),
):
    """Upload .txt / .md / .docx → parsed chapters."""
    raw = await file.read()
    name = (file.filename or "").lower()
    if name.endswith(".docx"):
        try:
            text = extract_docx(raw)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"DOCX parse failed: {e}")
    elif name.endswith((".txt", ".md", ".markdown")):
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("utf-8", errors="ignore")
    else:
        raise HTTPException(status_code=400, detail="Only .docx / .txt / .md supported")
    parsed = parse_content(text, default_chapter="Chapter 1")
    return {"success": True, "raw_text": text, **parsed}


# --------------------------------------------------------------------------- #
# Health + legacy status                                                      #
# --------------------------------------------------------------------------- #
@api.get("/")
async def root():
    return {"message": "EduHub Author Studio API", "ok": True}


@api.get("/health")
async def health():
    try:
        await db.command("ping")
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


# Legacy status-check endpoints (kept for compatibility)
class StatusCheck(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    client_name: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class StatusCheckCreate(BaseModel):
    client_name: str


@api.post("/status", response_model=StatusCheck)
async def create_status_check(input: StatusCheckCreate):
    obj = StatusCheck(**input.model_dump())
    doc = obj.model_dump()
    doc["timestamp"] = doc["timestamp"].isoformat()
    await db.status_checks.insert_one(doc)
    return obj


@api.get("/status", response_model=list[StatusCheck])
async def get_status_checks():
    checks = await db.status_checks.find({}, {"_id": 0}).to_list(1000)
    for c in checks:
        if isinstance(c.get("timestamp"), str):
            c["timestamp"] = datetime.fromisoformat(c["timestamp"])
    return checks


# --------------------------------------------------------------------------- #
# Push Studio — subscriptions, send, schedule, history                         #
# --------------------------------------------------------------------------- #
class PushSubscribePayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    studentId: str
    endpoint: str
    keys: dict
    userAgent: str | None = ""
    group: str | None = "default"


class PushSendStudioPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title: str
    body: str
    url: str | None = "/"
    target: Literal["everyone", "students", "group"] = "everyone"
    studentIds: list[str] = []
    group: str | None = ""
    sentBy: str = ""


class PushSchedulePayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title: str
    body: str
    url: str | None = "/"
    target: Literal["everyone", "students", "group"] = "everyone"
    studentIds: list[str] = []
    group: str | None = ""
    sendAt: str  # ISO 8601
    createdBy: str = ""


def _build_target_query(target: str, studentIds: list[str], group: str | None) -> dict:
    """Translate target spec → MongoDB query for push_subscriptions."""
    if target == "everyone":
        return {}
    if target == "students":
        ids = [s for s in (studentIds or []) if s]
        if not ids:
            return {"studentId": {"$in": []}}
        return {"studentId": {"$in": ids}}
    if target == "group":
        return {"group": group or ""}
    return {}


async def _fan_out_push(
    subs_query: dict,
    title: str,
    body: str,
    url: str,
) -> tuple[int, int]:
    """Fan out a push notification to every matching subscription.

    Returns (sent, failed). Subscriptions whose endpoint is permanently gone
    (HTTP 404/410) are removed from the collection so the next send is fast.
    """
    if not _VAPID_INSTANCE:
        log.warning("push: VAPID_PRIVATE_KEY missing or invalid — skipping fan-out")
        return 0, 0

    payload = json.dumps({"title": title, "body": body, "url": url or "/"})
    sent = 0
    failed = 0
    dead_endpoints: list[str] = []

    cursor = push_subscriptions.find(subs_query, {"_id": 0})
    async for sub in cursor:
        endpoint = sub.get("endpoint")
        keys = sub.get("keys") or {}
        if not endpoint or not keys:
            failed += 1
            continue
        try:
            webpush(
                subscription_info={"endpoint": endpoint, "keys": keys},
                data=payload,
                vapid_private_key=_VAPID_INSTANCE,
                vapid_claims={"sub": VAPID_CLAIM_EMAIL},
            )
            sent += 1
        except WebPushException as exc:
            failed += 1
            resp = getattr(exc, "response", None)
            if resp is not None and getattr(resp, "status_code", 0) in (404, 410):
                dead_endpoints.append(endpoint)
            else:
                code = getattr(resp, "status_code", 0) if resp else 0
                log.warning("push: webpush err endpoint=%s status=%s exc=%s",
                            endpoint[:60], code, str(exc)[:200])
        except Exception as exc:  # noqa: BLE001
            failed += 1
            log.warning("push: send error endpoint=%s err=%s: %s",
                        endpoint[:60], type(exc).__name__, str(exc)[:200])

    if dead_endpoints:
        await push_subscriptions.delete_many({"endpoint": {"$in": dead_endpoints}})

    return sent, failed


async def require_studio_user(user: User = Depends(require_user)) -> User:
    """Any authenticated studio user (teacher OR super-admin)."""
    return user


def _is_super_admin(user: User) -> bool:
    return bool(user and user.is_admin)


def _serialize_history_doc(doc: dict) -> dict:
    out = {k: v for k, v in doc.items() if k != "_id"}
    if "_id" in doc:
        out["id"] = str(doc["_id"])
    sa = out.get("sentAt")
    if isinstance(sa, datetime):
        out["sentAt"] = sa.isoformat()
    return out


def _serialize_scheduled_doc(doc: dict) -> dict:
    out = {k: v for k, v in doc.items() if k != "_id"}
    out["id"] = str(doc["_id"])
    return out


# ---- Subscribe (baseline, used by the frontend hook) -----------------------
@api.post("/push/subscribe")
async def push_subscribe(payload: PushSubscribePayload):
    """Idempotent: upsert by endpoint."""
    now = datetime.now(timezone.utc).isoformat()
    doc = {
        "studentId": payload.studentId,
        "endpoint": payload.endpoint,
        "keys": payload.keys,
        "userAgent": payload.userAgent or "",
        "group": payload.group or "default",
        "subscribedAt": now,
    }
    await push_subscriptions.update_one(
        {"endpoint": payload.endpoint},
        {"$set": doc},
        upsert=True,
    )
    return {"ok": True}


@api.post("/push/unsubscribe")
async def push_unsubscribe(payload: dict):
    endpoint = (payload or {}).get("endpoint")
    if not endpoint:
        raise HTTPException(status_code=400, detail="endpoint is required")
    await push_subscriptions.delete_one({"endpoint": endpoint})
    return {"ok": True}


@api.get("/push/vapid-public-key")
async def push_vapid_public_key():
    return {"publicKey": VAPID_PUBLIC_KEY}


# ---- Diagnostic (admin-only) ------------------------------------------------
@api.get("/push/_diag")
async def push_diag(user: User = Depends(require_admin)):
    """One-shot health check for the push pipeline. Hit from any browser."""
    out: dict = {
        "vapid_public_key_present": bool(VAPID_PUBLIC_KEY),
        "vapid_public_key_len": len(VAPID_PUBLIC_KEY),
        "vapid_private_key_present": bool(VAPID_PRIVATE_KEY),
        "vapid_private_key_len": len(VAPID_PRIVATE_KEY),
        "vapid_private_key_starts_with_pem_header": VAPID_PRIVATE_KEY.startswith("-----BEGIN"),
        "vapid_private_key_has_real_newlines": "\n" in VAPID_PRIVATE_KEY,
        "vapid_private_key_has_literal_backslash_n": "\\n" in VAPID_PRIVATE_KEY and "\n" not in VAPID_PRIVATE_KEY,
        "vapid_claim_email": VAPID_CLAIM_EMAIL,
        "cron_secret_present": bool(CRON_SECRET),
        "subscriptions_total": await push_subscriptions.count_documents({}),
        "history_total": await push_history.count_documents({}),
        "scheduled_pending": await push_scheduled.count_documents({"status": "pending"}),
    }

    # Try to parse the private key — uses the SAME code path as the live send.
    try:
        from py_vapid import Vapid01 as _V
        v = _V.from_pem(VAPID_PRIVATE_KEY.encode())
        _ = v.private_key
        out["vapid_private_key_parses"] = True
        out["vapid_private_key_parse_error"] = None
        out["vapid_instance_loaded_at_boot"] = _VAPID_INSTANCE is not None
    except Exception as exc:  # noqa: BLE001
        out["vapid_private_key_parses"] = False
        out["vapid_private_key_parse_error"] = f"{type(exc).__name__}: {exc}"
        out["vapid_instance_loaded_at_boot"] = _VAPID_INSTANCE is not None

    # Try a *dry-run* sign — same code path as a real send but to a fake target.
    # Use a real EC public key so the encryption layer doesn't trip; only the
    # endpoint is fake. A 0/4xx response means signing+encryption worked.
    try:
        import base64 as _b64
        from cryptography.hazmat.primitives import serialization as _ser
        from cryptography.hazmat.primitives.asymmetric import ec as _ec
        _tmp = _ec.generate_private_key(_ec.SECP256R1())
        _pub = _tmp.public_key().public_bytes(
            _ser.Encoding.X962, _ser.PublicFormat.UncompressedPoint)
        _p256dh = _b64.urlsafe_b64encode(_pub).rstrip(b"=").decode()
        _auth = _b64.urlsafe_b64encode(b"\x01" * 16).rstrip(b"=").decode()
        webpush(
            subscription_info={
                "endpoint": "https://fcm.googleapis.com/fcm/send/__diag_invalid__",
                "keys": {"p256dh": _p256dh, "auth": _auth},
            },
            data="diag",
            vapid_private_key=_VAPID_INSTANCE,
            vapid_claims={"sub": VAPID_CLAIM_EMAIL},
        )
        out["dry_run_sign"] = "ok-signed-and-delivered (unexpected)"
    except WebPushException as exc:
        resp = getattr(exc, "response", None)
        code = getattr(resp, "status_code", 0) if resp else 0
        out["dry_run_sign"] = (
            f"ok-signed-but-endpoint-rejected-status-{code}"
            if code in (0, 400, 404, 410)
            else f"webpush-error-{code}: {exc}"
        )
    except Exception as exc:  # noqa: BLE001
        out["dry_run_sign"] = f"sign-failed: {type(exc).__name__}: {str(exc)[:200]}"

    # Show the first subscription's endpoint host (if any) — helps spot
    # whether subscriptions are FCM (Chrome/Edge) vs Apple (iOS Safari) vs Mozilla.
    sample = await push_subscriptions.find_one({}, {"_id": 0, "endpoint": 1, "studentId": 1, "group": 1})
    if sample:
        ep = sample.get("endpoint", "")
        host = ep.split("/", 3)[2] if ep.startswith("http") else "?"
        out["sample_subscription"] = {
            "studentId": sample.get("studentId"),
            "group": sample.get("group"),
            "endpoint_host": host,
        }
    return out


# ---- Send (teacher or super-admin) -----------------------------------------
@api.post("/push/send-studio")
async def push_send_studio(
    payload: PushSendStudioPayload,
    user: User = Depends(require_studio_user),
):
    if payload.target == "students" and not payload.studentIds:
        raise HTTPException(status_code=400, detail="studentIds required when target=students")
    if payload.target == "group" and not payload.group:
        raise HTTPException(status_code=400, detail="group required when target=group")

    query = _build_target_query(payload.target, payload.studentIds, payload.group)
    sent, failed = await _fan_out_push(query, payload.title, payload.body, payload.url or "/")

    # sentBy: trust the authenticated user, but record the client-supplied
    # value when present (for legacy reasons).
    sender_email = (payload.sentBy or "").strip().lower() or user.email
    history_doc = {
        "title": payload.title,
        "body": payload.body,
        "url": payload.url or "/",
        "target": payload.target,
        "studentIds": payload.studentIds,
        "group": payload.group or "",
        "sentBy": sender_email,
        "sentAt": datetime.now(timezone.utc),
        "sent": sent,
        "failed": failed,
    }
    await push_history.insert_one(history_doc)
    return {"sent": sent, "failed": failed}


# ---- Schedule (super-admin only) -------------------------------------------
@api.post("/push/schedule")
async def push_schedule(
    payload: PushSchedulePayload,
    user: User = Depends(require_admin),
):
    try:
        send_at = datetime.fromisoformat(payload.sendAt.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail="sendAt must be a valid ISO 8601 datetime")
    if send_at.tzinfo is None:
        send_at = send_at.replace(tzinfo=timezone.utc)
    if send_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="sendAt must be in the future")

    doc = {
        "title": payload.title,
        "body": payload.body,
        "url": payload.url or "/",
        "target": payload.target,
        "studentIds": payload.studentIds,
        "group": payload.group or "",
        "sendAt": send_at.isoformat(),
        "createdBy": (payload.createdBy or "").strip().lower() or user.email,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "status": "pending",
    }
    res = await push_scheduled.insert_one(doc)
    return {"id": str(res.inserted_id), "sendAt": send_at.isoformat()}


@api.delete("/push/schedule/{job_id}")
async def push_schedule_delete(job_id: str, user: User = Depends(require_admin)):
    try:
        oid = ObjectId(job_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid job_id")
    await push_scheduled.delete_one({"_id": oid})
    return {"ok": True}


# ---- History ---------------------------------------------------------------
@api.get("/push/history")
async def push_history_list(
    limit: int = 50,
    skip: int = 0,
    user: User = Depends(require_studio_user),
):
    limit = max(1, min(int(limit or 50), 200))
    skip = max(0, int(skip or 0))
    base_q: dict = {} if _is_super_admin(user) else {"sentBy": user.email}

    total = await push_history.count_documents(base_q)
    cursor = push_history.find(base_q).sort("sentAt", -1).skip(skip).limit(limit)
    items = [_serialize_history_doc(d) async for d in cursor]
    return {"items": items, "total": total}


# ---- Scheduled (super-admin only) ------------------------------------------
@api.get("/push/scheduled")
async def push_scheduled_list(user: User = Depends(require_admin)):
    cursor = push_scheduled.find({"status": "pending"}).sort("sendAt", 1)
    items = [_serialize_scheduled_doc(d) async for d in cursor]
    return {"items": items}


# ---- Subscriber count ------------------------------------------------------
@api.get("/push/subscribers/count")
async def push_subscribers_count(
    target: str = "everyone",
    studentIds: str = "",
    group: str = "",
    user: User = Depends(require_studio_user),
):
    ids = [s.strip() for s in (studentIds or "").split(",") if s.strip()]
    if target not in ("everyone", "students", "group"):
        raise HTTPException(status_code=400, detail="invalid target")
    query = _build_target_query(target, ids, group or None)
    count = await push_subscriptions.count_documents(query)
    return {"count": count}


# ---- Run-due (super-admin OR x-cron-secret) --------------------------------
@api.post("/push/schedule/run-due")
async def push_schedule_run_due(
    request: Request,
    x_cron_secret: str | None = Header(default=None, alias="x-cron-secret"),
    user: User | None = Depends(current_user),
):
    is_admin = _is_super_admin(user) if user else False
    secret_ok = bool(CRON_SECRET) and x_cron_secret == CRON_SECRET
    if not (is_admin or secret_ok):
        raise HTTPException(status_code=403, detail="forbidden")

    now = datetime.now(timezone.utc)
    cursor = push_scheduled.find({"status": "pending"})
    processed = 0
    async for job in cursor:
        send_at_raw = job.get("sendAt")
        try:
            send_at = (
                send_at_raw
                if isinstance(send_at_raw, datetime)
                else datetime.fromisoformat(str(send_at_raw).replace("Z", "+00:00"))
            )
        except Exception:  # noqa: BLE001
            continue
        if send_at.tzinfo is None:
            send_at = send_at.replace(tzinfo=timezone.utc)
        if send_at > now:
            continue

        query = _build_target_query(
            job.get("target", "everyone"),
            job.get("studentIds") or [],
            job.get("group") or None,
        )
        sent, failed = await _fan_out_push(
            query, job.get("title", ""), job.get("body", ""), job.get("url", "/")
        )

        # Record in history + mark scheduled job done
        await push_history.insert_one({
            "title": job.get("title", ""),
            "body": job.get("body", ""),
            "url": job.get("url", "/"),
            "target": job.get("target", "everyone"),
            "studentIds": job.get("studentIds") or [],
            "group": job.get("group") or "",
            "sentBy": job.get("createdBy") or "scheduler",
            "sentAt": datetime.now(timezone.utc),
            "sent": sent,
            "failed": failed,
            "scheduledJobId": str(job["_id"]),
        })
        await push_scheduled.update_one(
            {"_id": job["_id"]},
            {"$set": {
                "status": "sent",
                "sentAt": datetime.now(timezone.utc).isoformat(),
                "result": {"sent": sent, "failed": failed},
            }},
        )
        processed += 1

    return {"processed": processed}


# --------------------------------------------------------------------------- #
# Patch landing page — serves the Push Studio deliverable files                #
# --------------------------------------------------------------------------- #
PATCHES_DIR = ROOT_DIR / "patches"

PATCH_FILES: dict[str, dict] = {
    "server": {
        "filename": "server.py",
        "ext": "py",
        "title": "Backend — Push Studio API routes",
        "tab_label": "server.py",
        "target_path": "eduhub-backend-master/server.py",
        "github_edit": "https://github.com/Daravuth999/eduhub-backend/edit/master/server.py",
        "blurb": (
            "FastAPI server with the new /api/push/* routes (send-studio, schedule, "
            "scheduled, history, subscribers/count, run-due) plus the baseline "
            "subscribe / vapid-public-key endpoints. Adds three Mongo collections: "
            "push_subscriptions, push_history, push_scheduled."
        ),
    },
    "requirements": {
        "filename": "requirements.txt",
        "ext": "txt",
        "title": "Backend — requirements.txt (3-line addition)",
        "tab_label": "requirements.txt",
        "target_path": "eduhub-backend-master/requirements.txt",
        "github_edit": "https://github.com/Daravuth999/eduhub-backend/edit/master/requirements.txt",
        "blurb": (
            "Adds three deps required by the Push Studio backend: pywebpush "
            "(fan-out), py-vapid (key generation), cryptography (transitive). "
            "Original 11 unpinned entries are preserved verbatim."
        ),
    },
    "push-studio": {
        "filename": "PushStudio.jsx",
        "ext": "jsx",
        "title": "Frontend — Push Studio page (Compose / Scheduled / History)",
        "tab_label": "PushStudio.jsx",
        "target_path": "src/studio/PushStudio.jsx",
        "github_edit": "https://github.com/Daravuth999/eduhub-studio-test/new/master/src/studio",
        "blurb": (
            "Self-contained Studio page with three tabs: Compose (title/body/url, "
            "audience selector, debounced subscriber count, live phone preview, "
            "Send Now + Schedule), Scheduled (super-admin only — list, delete, "
            "Run-due button), and History (paginated, expandable rows, scoped per role)."
        ),
    },
    "studio-page": {
        "filename": "StudioPage.jsx",
        "ext": "jsx",
        "title": "Frontend — StudioPage shell with the new Push tab",
        "tab_label": "StudioPage.jsx",
        "target_path": "src/studio/StudioPage.jsx",
        "github_edit": "https://github.com/Daravuth999/eduhub-studio-test/edit/master/src/studio/StudioPage.jsx",
        "blurb": (
            "Three surgical changes: import PushStudio, add Bell to the lucide-react "
            "imports, append { key:'push', label:'Push', Icon:Bell } to TABS, and "
            "render <PushStudio /> inside the existing view-switcher when tab==='push'."
        ),
    },
    "use-push": {
        "filename": "usePushNotifications.js",
        "ext": "js",
        "title": "Frontend — Web Push subscribe hook",
        "tab_label": "usePushNotifications.js",
        "target_path": "src/eduhub/hooks/usePushNotifications.js",
        "github_edit": "https://github.com/Daravuth999/eduhub-studio-test/new/master/src/eduhub/hooks",
        "blurb": (
            "New baseline hook the spec asked us to MODIFY (it didn't yet exist). "
            "Accepts (studentId, groupName), registers/uses the existing service "
            "worker, fetches the VAPID public key, subscribes via PushManager, and "
            "POSTs { studentId, endpoint, keys, userAgent, group } to "
            "/api/push/subscribe."
        ),
    },
    "dashboard": {
        "filename": "Dashboard.jsx",
        "ext": "jsx",
        "title": "Frontend — Dashboard wires up the Push hook",
        "tab_label": "Dashboard.jsx",
        "target_path": "src/eduhub/pages/Dashboard.jsx",
        "github_edit": "https://github.com/Daravuth999/eduhub-studio-test/edit/master/src/eduhub/pages/Dashboard.jsx",
        "blurb": (
            "One-line addition: usePushNotifications(student?.studentId, "
            "student?.group || student?.batch || 'default'). AuthContext doesn't "
            "expose a group field today, so the call falls back to 'default' — "
            "Push Studio targeting by group still works on subsequent enrolments."
        ),
    },
    "sw": {
        "filename": "sw.js",
        "ext": "js",
        "title": "Frontend — Service Worker with Web Push handlers (v1.2)",
        "tab_label": "sw.js",
        "target_path": "public/sw.js",
        "github_edit": "https://github.com/Daravuth999/eduhub-studio-test/edit/master/public/sw.js",
        "blurb": (
            "Two surgical edits on top of your existing SW: bumps SW_VERSION "
            "from v1.1.0 → v1.2.0 (forces every browser to evict caches and "
            "pick up the new code), and appends `push` + `notificationclick` "
            "listeners at the very bottom. The browser needs the `push` "
            "listener to actually render notifications — without it, "
            "pywebpush delivers but nothing appears on screen. Restored the "
            "missing `||` fallbacks that were lost in markdown formatting."
        ),
    },
    "push-bell": {
        "filename": "PushNotificationBell.jsx",
        "ext": "jsx",
        "title": "Frontend — Bell button to enable/disable notifications",
        "tab_label": "PushNotificationBell.jsx",
        "target_path": "src/eduhub/components/PushNotificationBell.jsx",
        "github_edit": "https://github.com/Daravuth999/eduhub-studio-test/new/master/src/eduhub/components",
        "blurb": (
            "NEW component. Self-contained bell button that calls the existing "
            "usePushNotifications hook (default import, signature "
            "(studentId, groupName)). Matches your committed backend payload "
            "shape — no env var changes needed (VAPID key auto-fetched). "
            "Styled to match your aurora header (cyan/violet/magenta accents)."
        ),
    },
    "header": {
        "filename": "Header.jsx",
        "ext": "jsx",
        "title": "Frontend — Header.jsx with bell wired in (2-line addition)",
        "tab_label": "Header.jsx",
        "target_path": "src/eduhub/components/Header.jsx",
        "github_edit": "https://github.com/Daravuth999/eduhub-studio-test/edit/master/src/eduhub/components/Header.jsx",
        "blurb": (
            "Surgical: 1 import line + 4 lines that render <PushNotificationBell> "
            "inside the existing isAuthenticated block. ALL safe-area / iOS "
            "notch logic, telegram link, student pill, sign-out button — "
            "preserved byte-for-byte."
        ),
    },
}


def _read_patch_file(filename: str) -> str:
    p = (PATCHES_DIR / filename).resolve()
    if PATCHES_DIR.resolve() not in p.parents and p != PATCHES_DIR.resolve():
        raise HTTPException(status_code=400, detail="invalid path")
    if not p.exists():
        raise HTTPException(status_code=404, detail="patch file not found")
    return p.read_text(encoding="utf-8")


_LANG_BY_EXT = {"py": "python", "jsx": "jsx", "js": "javascript", "ts": "typescript",
                "tsx": "tsx", "css": "css", "json": "json", "md": "markdown", "html": "html"}

_LANDING_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>EduHub Push Studio — Patch deliverables</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/styles/github-dark.min.css" />
  <script defer src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/highlight.min.js"></script>
  <style>
    :root {
      --bg: #0a0a0f;
      --card: rgba(255,255,255,0.04);
      --card-strong: rgba(255,255,255,0.06);
      --border: rgba(255,255,255,0.08);
      --border-strong: rgba(255,255,255,0.16);
      --text: #F4E5C1;
      --text-muted: rgba(244,229,193,0.55);
      --gold: #D4A843;
      --aurora: linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at 20% 0%, #2D1F3E 0%, #0d0a16 70%);
      color: var(--text);
      font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      padding: 32px 24px 64px;
    }
    .wrap { max-width: 1100px; margin: 0 auto; }
    header { display: flex; align-items: center; gap: 14px; margin-bottom: 6px; }
    .logo {
      width: 40px; height: 40px; border-radius: 12px;
      background: rgba(212,168,67,0.12);
      border: 1px solid rgba(212,168,67,0.4);
      display: grid; place-items: center;
    }
    h1 {
      font-size: 22px; font-weight: 700; letter-spacing: -0.01em;
      margin: 0; line-height: 1.2;
    }
    .sub {
      color: var(--text-muted);
      font-size: 13px; margin: 4px 0 24px;
    }
    .meta-bar {
      display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 24px;
    }
    .pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 12px; border-radius: 999px;
      background: var(--card); border: 1px solid var(--border);
      color: var(--text); font-size: 11px; text-transform: uppercase;
      letter-spacing: 0.18em; font-weight: 700;
      text-decoration: none;
    }
    .pill.aurora {
      background: var(--aurora); color: #1a1420;
      border: 1px solid rgba(255,225,154,0.6);
    }
    nav.tabs {
      display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 18px;
    }
    .tab {
      padding: 9px 14px; border-radius: 999px;
      background: var(--card); border: 1px solid var(--border);
      color: var(--text); font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.16em;
      cursor: pointer; transition: all 0.15s;
      display: inline-flex; align-items: center; gap: 6px;
    }
    .tab:hover { background: var(--card-strong); border-color: var(--border-strong); }
    .tab.active {
      background: var(--aurora); color: #1a1420;
      border: 1px solid rgba(255,225,154,0.6);
    }
    .tab .ext {
      font-family: 'JetBrains Mono', monospace;
      font-size: 9.5px; letter-spacing: 0;
      padding: 1px 5px; border-radius: 4px;
      background: rgba(0,0,0,0.18);
      color: rgba(255,255,255,0.55);
    }
    .tab.active .ext { background: rgba(0,0,0,0.18); color: rgba(0,0,0,0.55); }

    .panel {
      background: var(--card); border: 1px solid var(--border);
      border-radius: 18px; overflow: hidden;
    }
    .panel-head {
      padding: 18px 22px; border-bottom: 1px solid var(--border);
      display: flex; flex-wrap: wrap; align-items: center; gap: 14px;
    }
    .panel-head .title {
      font-size: 15px; font-weight: 700; letter-spacing: -0.005em;
    }
    .panel-head .target {
      font-family: 'JetBrains Mono', monospace; font-size: 11.5px;
      color: var(--text-muted);
    }
    .panel-head .spacer { flex: 1; }
    .btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 7px 13px; border-radius: 999px;
      font-size: 10.5px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.16em;
      text-decoration: none; cursor: pointer;
      transition: all 0.15s;
      border: 1px solid var(--border-strong);
      background: var(--card-strong); color: var(--text);
    }
    .btn:hover { background: rgba(255,255,255,0.10); }
    .btn.aurora {
      background: var(--aurora); color: #1a1420;
      border: 1px solid rgba(255,225,154,0.6);
    }
    .btn.aurora:hover { filter: brightness(1.05); }

    .blurb {
      padding: 14px 22px 0;
      font-size: 13px; line-height: 1.55;
      color: rgba(244,229,193,0.78);
      max-width: 820px;
    }

    .code-wrap {
      position: relative;
      margin: 14px 22px 22px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: rgba(0,0,0,0.35);
      overflow: hidden;
    }
    .code-bar {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 14px;
      border-bottom: 1px solid var(--border);
      font-family: 'JetBrains Mono', monospace;
      font-size: 11.5px;
      color: var(--text-muted);
    }
    .copy-btn {
      margin-left: auto;
      padding: 4px 10px; border-radius: 6px;
      background: rgba(255,255,255,0.06);
      border: 1px solid var(--border);
      color: var(--text); cursor: pointer;
      font-size: 10.5px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.12em;
      transition: all 0.15s;
    }
    .copy-btn:hover { background: rgba(255,255,255,0.12); }
    .copy-btn.ok { background: rgba(34,197,94,0.18); border-color: rgba(34,197,94,0.4); color: #bbf7d0; }
    pre { margin: 0; max-height: 560px; overflow: auto; }
    pre code.hljs {
      padding: 16px 18px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12.5px; line-height: 1.55;
      background: transparent !important;
    }
    .footer {
      margin-top: 26px;
      color: var(--text-muted);
      font-size: 11.5px;
      display: flex; flex-wrap: wrap; gap: 18px; align-items: center;
    }
    .swatch { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #22c55e; }
    [hidden] { display: none !important; }
    .icon { width: 14px; height: 14px; }
    @media (max-width: 640px) {
      body { padding: 22px 14px 48px; }
      .panel-head { padding: 14px 16px; }
      .blurb, .code-wrap { margin-left: 16px; margin-right: 16px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="logo">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#D4A843" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>
        </svg>
      </div>
      <div>
        <h1>EduHub · Push Studio · Patch deliverables</h1>
        <div class="sub">5 files — backend FastAPI + frontend React. Click a tab to view, copy or open in GitHub.</div>
      </div>
    </header>

    <div class="meta-bar">
      <span class="pill aurora"><span class="swatch" style="background:#1a1420"></span> 5 files ready</span>
      <span class="pill">Backend · 1</span>
      <span class="pill">Frontend · 4</span>
      <a class="pill" href="/api/patch/index.json">JSON index →</a>
    </div>

    <nav class="tabs" id="tabs"></nav>

    <main id="panels"></main>

    <div class="footer">
      <span>Generated by the EduHub agent · Plus Jakarta Sans + JetBrains Mono · highlight.js github-dark.</span>
    </div>
  </div>

<script>
const PATCHES = __PATCHES_JSON__;
const tabsEl = document.getElementById('tabs');
const panelsEl = document.getElementById('panels');

function langFor(ext) {
  return ({ py:'python', jsx:'jsx', js:'javascript', ts:'typescript', tsx:'tsx', css:'css', json:'json' }[ext] || 'plaintext');
}

function panelHTML(key, p) {
  return `
    <section class="panel" id="panel-${key}" data-key="${key}">
      <div class="panel-head">
        <div>
          <div class="title">${p.title}</div>
          <div class="target">${p.target_path}</div>
        </div>
        <div class="spacer"></div>
        <a class="btn" href="/api/patch/${key}/raw" target="_blank">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Raw
        </a>
        <a class="btn aurora" href="${p.github_edit}" target="_blank" rel="noopener">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>
          Open in GitHub
        </a>
      </div>
      <div class="blurb">${p.blurb}</div>
      <div class="code-wrap">
        <div class="code-bar">
          <span>${p.filename}</span>
          <button class="copy-btn" data-copy="${key}">Copy</button>
        </div>
        <pre><code class="language-${langFor(p.ext)} hljs" id="code-${key}">Loading…</code></pre>
      </div>
    </section>
  `;
}

const order = Object.keys(PATCHES);
order.forEach((key, i) => {
  const p = PATCHES[key];
  const tab = document.createElement('button');
  tab.className = 'tab' + (i === 0 ? ' active' : '');
  tab.dataset.key = key;
  tab.innerHTML = `<span>${p.tab_label}</span><span class="ext">${p.ext}</span>`;
  tab.onclick = () => activate(key);
  tabsEl.appendChild(tab);
  panelsEl.insertAdjacentHTML('beforeend', panelHTML(key, p));
  if (i !== 0) document.getElementById('panel-' + key).hidden = true;
});

function activate(key) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.key === key));
  document.querySelectorAll('.panel').forEach(p => { p.hidden = (p.dataset.key !== key); });
  loadCode(key);
  history.replaceState(null, '', '#' + key);
}

const loaded = new Set();
async function loadCode(key) {
  if (loaded.has(key)) return;
  const codeEl = document.getElementById('code-' + key);
  try {
    const res = await fetch(`/api/patch/${key}/raw`);
    const txt = await res.text();
    codeEl.textContent = txt;
    if (window.hljs) hljs.highlightElement(codeEl);
    loaded.add(key);
  } catch (e) {
    codeEl.textContent = 'Failed to load: ' + e;
  }
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('.copy-btn');
  if (!b) return;
  const key = b.dataset.copy;
  const codeEl = document.getElementById('code-' + key);
  try {
    await navigator.clipboard.writeText(codeEl.textContent);
    b.classList.add('ok');
    const orig = b.textContent;
    b.textContent = 'Copied ✓';
    setTimeout(() => { b.classList.remove('ok'); b.textContent = orig; }, 1400);
  } catch { b.textContent = 'Copy failed'; }
});

// Activate from hash if present, else first
const hashKey = (location.hash || '').replace('#','');
activate(order.includes(hashKey) ? hashKey : order[0]);
window.addEventListener('load', () => {
  // Pre-load the first tab's code
  loadCode(order[0]);
});
</script>
</body>
</html>
"""


@api.get("/patch", include_in_schema=False)
@api.get("/patch/", include_in_schema=False)
async def patch_landing():
    """Landing page listing every deliverable file."""
    payload: dict = {}
    for key, meta in PATCH_FILES.items():
        payload[key] = {
            "filename": meta["filename"],
            "ext": meta["ext"],
            "title": meta["title"],
            "tab_label": meta["tab_label"],
            "target_path": meta["target_path"],
            "github_edit": meta["github_edit"],
            "blurb": meta["blurb"],
        }
    html = _LANDING_HTML.replace("__PATCHES_JSON__", json.dumps(payload))
    return Response(content=html, media_type="text/html; charset=utf-8")


@api.get("/patch/index.json", include_in_schema=False)
async def patch_index():
    return {"patches": PATCH_FILES}


@api.get("/patch/{key}", include_in_schema=False)
async def patch_view(key: str):
    """Same landing page, opened on a specific tab via URL fragment redirect."""
    if key not in PATCH_FILES:
        raise HTTPException(status_code=404, detail="patch key not found")
    return Response(
        status_code=302,
        headers={"Location": f"/api/patch#{key}"},
    )


@api.get("/patch/{key}/raw", include_in_schema=False)
async def patch_raw(key: str):
    if key not in PATCH_FILES:
        raise HTTPException(status_code=404, detail="patch key not found")
    meta = PATCH_FILES[key]
    text = _read_patch_file(meta["filename"])
    media = "text/plain; charset=utf-8"
    return Response(content=text, media_type=media)


# --------------------------------------------------------------------------- #
# Wire up                                                                     #
# --------------------------------------------------------------------------- #
app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    # Ensure useful indexes
    await db.books.create_index([("slug", 1), ("revision", -1)])
    await db.books.create_index("published")
    await db.users.create_index("email", unique=True)
    await db.users.create_index("user_id", unique=True)
    await db.user_sessions.create_index("session_token", unique=True)
    await db.user_sessions.create_index("expires_at")
    await push_subscriptions.create_index("endpoint", unique=True)
    await push_subscriptions.create_index("studentId")
    await push_subscriptions.create_index("group")
    await push_history.create_index([("sentAt", -1)])
    await push_history.create_index("sentBy")
    await push_scheduled.create_index([("status", 1), ("sendAt", 1)])
    log.info("startup: indexes ready | admin emails=%s",
             "ANY" if not ADMIN_EMAILS else ",".join(ADMIN_EMAILS))


@app.on_event("shutdown")
async def shutdown():
    client.close()
