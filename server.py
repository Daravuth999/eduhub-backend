"""EduHub Author Studio backend (FastAPI + MongoDB).

Dynamic CMS layered on top of the existing Google-Sheets driven library.
The frontend merges the two sources at read time so every existing sheet
book keeps working unchanged   this backend only ADDS new capabilities.
"""
from __future__ import annotations

import logging
import os
import re
import base64
import io
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

import json
import httpx

# â”€â”€ LUCKY DRAW SURGERY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
from lucky_draw import (
    register_lucky_draw_routes,
    generate_and_publish_lucky_code,
    ensure_lucky_draw_indexes,
)
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
from bson import ObjectId
from dotenv import load_dotenv
from fastapi import (APIRouter, Cookie, Depends, FastAPI, File, Form, Header,
                     HTTPException, Request, Response, UploadFile, status)
from fastapi.responses import JSONResponse, StreamingResponse
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorGridFSBucket
from pydantic import BaseModel, ConfigDict, Field
from pywebpush import WebPushException, webpush
from py_vapid import Vapid01
from starlette.middleware.cors import CORSMiddleware

from content_parser import extract_docx, parse_content

# ─────────────────────────────────────────────────────────────
# Phase 1 GAS→Mongo migration preflight: wallet service import
# Safe default: unavailable if import fails; no student behavior change.
# ─────────────────────────────────────────────────────────────
try:
    import wallet_service
    _WALLET_SERVICE_AVAILABLE = True
except Exception as _wallet_service_import_error:
    wallet_service = None
    _WALLET_SERVICE_AVAILABLE = False
    logging.getLogger(__name__).warning(
        "migration preflight wallet_service unavailable: %s",
        _wallet_service_import_error,
    )


# ── AI Scene Builder (Gemini engine — isolated module) ─────────────────── #
# gemini_engine.py lives alongside server.py and has zero side-effects.      #
# If the file is missing the feature is simply disabled; nothing else breaks. #
try:
    from gemini_engine import generate_scene as _gemini_generate_scene
    from gemini_engine import is_enabled as _gemini_enabled
    from gemini_engine import GEMINI_MODEL
except ImportError:  # gemini_engine.py not yet deployed
    async def _gemini_generate_scene(**_kw):  # type: ignore[misc]
        raise RuntimeError("gemini_engine.py is not installed on this server.")
    def _gemini_enabled() -> bool:  # type: ignore[misc]
        return False
    GEMINI_MODEL = None

# ── Premium AI Tools (Phase 1 — isolated module) ────────────────────────── #
# premium_ai_tools.py registers admin AI config + student decode-block /     #
# executive-upgrade routes onto the existing /api router. Same defensive     #
# import pattern as gemini_engine above: missing file → feature disabled,    #
# every other route keeps working.                                           #
try:
    from premium_ai_tools import register_premium_ai_routes
except ImportError:  # premium_ai_tools.py not yet deployed
    def register_premium_ai_routes(*_a, **_kw):  # type: ignore[misc]
        logging.getLogger("eduhub").warning(
            "premium_ai_tools.py not installed — Premium AI Tools disabled."
        )

# ── EduTalk (Phase 2A — isolated module) ────────────────────────────────── #
# edutalk_tools.py registers admin EduTalk config + student start / message  #
# / session routes onto the existing /api router. Same defensive import      #
# pattern: missing file → EduTalk disabled, every other route keeps working. #
try:
    from edutalk_tools import register_edutalk_routes
except ImportError:  # edutalk_tools.py not yet deployed
    def register_edutalk_routes(*_a, **_kw):  # type: ignore[misc]
        logging.getLogger("eduhub").warning(
            "edutalk_tools.py not installed — EduTalk disabled."
        )

# --------------------------------------------------------------------------- #
# PHASE 3: edutalk_tier_config_tools.py registers tier-aware AI feature       #
# config + promotion CRUD onto the existing /api router. Same defensive       #
# import pattern: missing file → Phase 3 features disabled, every other       #
# route (Phase 1 + Phase 2A EduTalk) keeps working unchanged.                 #
# --------------------------------------------------------------------------- #
try:
    from edutalk_tier_config_tools import register_tier_config_routes
except ImportError:  # edutalk_tier_config_tools.py not yet deployed
    def register_tier_config_routes(*_a, **_kw):  # type: ignore[misc]
        logging.getLogger("eduhub").warning(
            "edutalk_tier_config_tools.py not installed — Phase 3 tier config disabled."
        )

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

# ElevenLabs AI Voice (teacher-side TTS for chapter audio)
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY", "")
# Default voice falls back to "Rachel" (21m00Tcm4TlvDq8ikWAM) which is in
# every ElevenLabs account's starter voice library. Override per-deploy via
# the ELEVENLABS_DEFAULT_VOICE env var with any 20-char voice_id.
ELEVENLABS_DEFAULT_VOICE = os.environ.get(
    "ELEVENLABS_DEFAULT_VOICE", "21m00Tcm4TlvDq8ikWAM"
)
_VOICE_ID_RE = re.compile(r"^[A-Za-z0-9]{20}$")
ELEVENLABS_MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_v3")

# Public-facing backend URL â€” used to build absolute audio stream URLs
# so both the student PWA (vercel.app) and Author Studio can play the audio.
# Set in Render env vars as PUBLIC_BACKEND_URL.
PUBLIC_BACKEND_URL = os.environ.get(
    "PUBLIC_BACKEND_URL",
    "https://eduhub-backend-td3a.onrender.com",
).rstrip("/")


def _repair_pem(raw: str) -> str:
    """Hosting UIs sometimes flatten or re-encode multi-line PEM values.
    Repair the most common breakages so we get usable PEM:
      - strip surrounding quotes/whitespace
      - if value is base64-encoded PEM (starts with 'LS0t'), decode it
      - replace literal '\\n' with real newlines
      - if the key is on a single line, re-wrap the base64 body at 64 chars
    Returns a string that should pass cryptography's PEM parser.
    """
    if not raw:
        return raw
    s = raw.strip().strip('"').strip("'")

    # Case A: the whole value is base64 of a PEM block.
    # PEM headers begin with '-----BEGIN' which b64-encodes to start with 'LS0t'.
    if s.startswith("LS0t") and "-----" not in s:
        try:
            import base64 as _b64
            decoded = _b64.b64decode(s + "=" * (-len(s) % 4)).decode("utf-8", errors="strict")
            if "-----BEGIN" in decoded:
                s = decoded.strip()
        except Exception:  # noqa: BLE001
            pass  # Fall through to other repair attempts.

    # Case B: literal backslash-n
    if "\\n" in s and "\n" not in s:
        s = s.replace("\\n", "\n")

    # Already valid multi-line? keep as-is.
    if "\n" in s:
        return s

    # Case C: single-line   re-wrap body at 64 chars.
    import re as _re
    m = _re.match(r"-----BEGIN ([A-Z ]+)-----(.*)-----END \1-----", s)
    if not m:
        return s
    header, body, footer = m.group(1), m.group(2).strip(), m.group(1)
    body_clean = "".join(body.split())
    wrapped = "\n".join(body_clean[i:i + 64] for i in range(0, len(body_clean), 64))
    return f"-----BEGIN {header}-----\n{wrapped}\n-----END {footer}-----"


VAPID_PRIVATE_KEY = _repair_pem(VAPID_PRIVATE_KEY)

# Pre-parse the VAPID PEM once. pywebpush expects either a Vapid01 instance, a
# file path, or a raw base64-encoded private key string (NOT PEM). Passing PEM
# directly fails with "Could not deserialize key data". We parse here at boot
# so every subsequent webpush() call reuses this instance.
_VAPID_INSTANCE: Vapid01 | None = None
_VAPID_BOOT_ERROR: str = ""
if VAPID_PRIVATE_KEY:
    try:
        _VAPID_INSTANCE = Vapid01.from_pem(VAPID_PRIVATE_KEY.encode())
    except Exception as _exc:  # noqa: BLE001
        _VAPID_BOOT_ERROR = f"{type(_exc).__name__}: {_exc}"
        logging.getLogger("eduhub").warning(
            "VAPID_PRIVATE_KEY could not be parsed at boot: %s", _VAPID_BOOT_ERROR
        )

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

# GridFS bucket for ElevenLabs AI voice audio (avoids multi-MB inline base64)
audio_bucket = None  # initialised in startup()

# --------------------------------------------------------------------------- #
# Cloudflare R2 audio upload helper - Phase 1 (new ElevenLabs generations)    #
#                                                                             #
# Design contract:                                                            #
#   - _r2_config() returns a dict only when ALL five R2 env vars are set.     #
#     If any var is missing it returns None and the caller uses GridFS.       #
#   - _upload_audio_to_r2() NEVER raises. On any failure it logs a warning    #
#     and returns None so the caller falls back to GridFS automatically.      #
#   - boto3 is imported lazily inside the function so a missing package       #
#     silently disables R2 without breaking any other route.                  #
#   - The GridFS stream endpoint /api/studio/audio/{filename} is untouched.   #
#   - Existing GridFS audio continues to play regardless of R2 state.         #
# --------------------------------------------------------------------------- #

def _r2_config():
    """Return R2 credentials dict if all five env vars are present, else None.

    Required Render env vars (set ONLY in the Render dashboard, never in code):
        R2_ACCOUNT_ID         Cloudflare account ID
        R2_ACCESS_KEY_ID      R2 API token key ID  (Object Read & Write on bucket)
        R2_SECRET_ACCESS_KEY  R2 API token secret
        R2_BUCKET_NAME        R2 bucket name  (e.g. audiobook)
        R2_PUBLIC_URL         Public base URL  (e.g. https://pub-<hash>.r2.dev)
    """
    required = [
        "R2_ACCOUNT_ID",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "R2_BUCKET_NAME",
        "R2_PUBLIC_URL",
    ]
    cfg = {k: os.environ.get(k, "").strip() for k in required}
    if all(cfg.values()):
        return cfg
    return None


async def _upload_audio_to_r2(audio_bytes, audio_id, metadata):
    """Upload MP3 bytes to Cloudflare R2 and return the public URL.

    Returns:
        str  - public R2 URL on success  e.g. https://pub-xxx.r2.dev/<uuid>.mp3
        None - on any failure (env vars missing, boto3 absent, network error)

    This function NEVER raises. All failures are logged as WARNING and
    return None so the caller can fall back to GridFS transparently.

    The boto3 S3 upload runs in a thread-pool executor so it never blocks
    the FastAPI async event loop.
    """
    cfg = _r2_config()
    if cfg is None:
        return None  # R2 not configured - silent GridFS fallback

    try:
        import boto3  # type: ignore[import-not-found]
        from botocore.config import Config as _BotocoreConfig  # type: ignore[import-not-found]
        import asyncio as _asyncio

        endpoint    = f"https://{cfg['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
        filename    = f"{audio_id}.mp3"
        bucket      = cfg["R2_BUCKET_NAME"]
        public_base = cfg["R2_PUBLIC_URL"].rstrip("/")

        def _do_upload(_b=audio_bytes, _fn=filename, _bkt=bucket, _ep=endpoint):
            s3 = boto3.client(
                "s3",
                endpoint_url=_ep,
                aws_access_key_id=cfg["R2_ACCESS_KEY_ID"],
                aws_secret_access_key=cfg["R2_SECRET_ACCESS_KEY"],
                region_name="auto",
                config=_BotocoreConfig(signature_version="s3v4"),
            )
            s3.put_object(
                Bucket=_bkt,
                Key=_fn,
                Body=_b,
                ContentType="audio/mpeg",
                Metadata={str(k): str(v) for k, v in (metadata or {}).items()},
            )

        loop = _asyncio.get_event_loop()
        await loop.run_in_executor(None, _do_upload)

        r2_url = f"{public_base}/{filename}"
        log.info(
            "r2: uploaded %s (%d bytes) bucket=%s url=%s",
            filename, len(audio_bytes), bucket, r2_url,
        )
        return r2_url

    except ImportError:
        log.warning(
            "r2: boto3 not installed - add boto3>=1.34 to requirements.txt "
            "to enable R2 uploads. Falling back to GridFS."
        )
        return None

    except Exception as _r2_err:  # noqa: BLE001
        log.warning(
            "r2: upload failed for %s.mp3 - %s: %s - falling back to GridFS.",
            audio_id, type(_r2_err).__name__, _r2_err,
        )
        return None

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
    """Client ? server book shape (studio save)."""
    model_config = ConfigDict(extra="ignore")
    slug: str | None = None
    title: str
    subtitle: str = ""
    author: str = "Classroom Library"
    section: Section = "story"
    coverEmoji: str = "??"
    coverImage: str = ""
    coverGradient: str = "linear-gradient(155deg, #2a2140 0%, #4a3a6a 100%)"
    accent: str = "#D4A843"
    badge: str = ""
    level: str = ""
    readingMinutes: int = 6
    price: int = 0
    # v9.2   Library tier classification. When empty, the frontend auto-derives
    # from price using the band: free=0, standard=1-100, premium=101-500,
    # limited=>500. Studio editors may set this explicitly to one of:
    # "free" | "standard" | "premium" | "limited".
    tier: str = ""
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
# ElevenLabs AI Voice helper (teacher-side only, never called by students)    #
# --------------------------------------------------------------------------- #
async def _elevenlabs_generate(text: str, voice_id: str) -> dict:
    """Call ElevenLabs text-to-speech with-timestamps endpoint.
    Returns { audio_base64, word_timestamps } or raises HTTPException.
    Never called by students â€” teacher-side only.
    """
    if not ELEVENLABS_API_KEY:
        raise HTTPException(status_code=503, detail="ELEVENLABS_API_KEY not configured.")

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps"
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
    }
    body = {
        "text": text,
        "model_id": ELEVENLABS_MODEL,
        "output_format": "mp3_44100_128",
    }

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(60.0, connect=10.0),
        follow_redirects=True,
    ) as cli:
        r = await cli.post(url, headers=headers, json=body)
        if r.status_code != 200:
            raise HTTPException(
                status_code=502,
                detail=f"ElevenLabs error {r.status_code}: {r.text[:200]}"
            )
        data = r.json()

    # Convert character-level alignment to word-level timestamps
    audio_base64 = data.get("audio_base64", "")
    alignment = data.get("alignment", {})
    chars = alignment.get("characters", [])
    char_starts = alignment.get("character_start_times_seconds", [])
    char_ends = alignment.get("character_end_times_seconds", [])

    word_timestamps = []
    current_word = ""
    word_start = 0.0
    word_end = 0.0

    for i, ch in enumerate(chars):
        char_str = ch if isinstance(ch, str) else str(ch)
        t_start = char_starts[i] if i < len(char_starts) else 0.0
        t_end = char_ends[i] if i < len(char_ends) else 0.0

        if char_str == " " or char_str == "\n":
            if current_word.strip():
                word_timestamps.append({
                    "word": current_word.strip(),
                    "start": round(word_start, 3),
                    "end": round(word_end, 3),
                })
            current_word = ""
        else:
            if not current_word:
                word_start = t_start
            current_word += char_str
            word_end = t_end

    # flush last word
    if current_word.strip():
        word_timestamps.append({
            "word": current_word.strip(),
            "start": round(word_start, 3),
            "end": round(word_end, 3),
        })

    return {
        "audio_base64": audio_base64,
        "word_timestamps": word_timestamps,
    }


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
    # v8.1   mobile Safari ITP drops 3rd-party cookies across cross-site
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
    # Accept token via cookie OR Authorization: Bearer   needed for
    # mobile clients that use the localStorage fallback.
    token = session_token
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
    if token:
        await db.user_sessions.delete_one({"session_token": token})
    response.delete_cookie("session_token", path="/", samesite="none", secure=True)
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Books   public read                                                         #
# --------------------------------------------------------------------------- #
CANONICAL_BOOK_FIELDS = {
    "slug", "title", "subtitle", "author", "section", "coverEmoji",
    "coverImage", "coverGradient", "accent", "badge", "level",
    "readingMinutes", "price", "tier", "published", "newUntil", "contentType",
    "format", "chapters", "content", "revision", "_authoredAt", "_authoredBy",
    "ai_voice",
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
# Studio   admin CRUD                                                         #
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
    """Append-only save   writes a new revision document."""
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

    # ---- Feature 4: notify all subscribers when a new book is published ----
    # Surgical addition: never blocks publish on push failure.
    try:
        if res.modified_count > 0:
            book_title = slug.replace("-", " ").title()
            await _fan_out_push(
                {},  # everyone
                title="New lesson available!",
                body=f"{book_title} is now in your library. Start reading!",
                url="/library",
            )
    except Exception:  # noqa: BLE001
        pass  # push failure never blocks publish

    return {"success": True, "matched": res.matched_count, "modified": res.modified_count}


@api.post("/studio/books/{slug}/unpublish")
async def studio_unpublish(slug: str, admin: User = Depends(require_admin)):
    res = await db.books.update_many({"slug": slug}, {"$set": {"published": False}})
    return {"success": True, "matched": res.matched_count, "modified": res.modified_count}


@api.get("/studio/voices")
async def studio_list_voices(admin: User = Depends(require_admin)):
    """List available ElevenLabs voices for the teacher voice picker.

    Teacher-side only (require_admin). The xi-api-key never leaves the
    server â€” the browser only receives sanitized {voice_id, name, ...}.
    """
    if not ELEVENLABS_API_KEY:
        raise HTTPException(
            status_code=503, detail="ELEVENLABS_API_KEY not configured."
        )

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(20.0, connect=10.0)
    ) as cli:
        r = await cli.get(
            "https://api.elevenlabs.io/v1/voices",
            headers={"xi-api-key": ELEVENLABS_API_KEY},
        )
        if r.status_code != 200:
            raise HTTPException(
                status_code=502,
                detail=f"ElevenLabs voices list error {r.status_code}: {r.text[:200]}",
            )
        data = r.json()

    voices = []
    for v in data.get("voices", []) or []:
        labels = v.get("labels", {}) or {}
        voices.append({
            "voice_id": v.get("voice_id", ""),
            "name": v.get("name", ""),
            "category": v.get("category", ""),
            "description": v.get("description", "") or "",
            "preview_url": v.get("preview_url", "") or "",
            "gender": labels.get("gender", "") or "",
            "accent": labels.get("accent", "") or "",
            "age": labels.get("age", "") or "",
            "use_case": labels.get("use_case", "") or labels.get("use case", "") or "",
        })

    return {
        "default_voice_id": ELEVENLABS_DEFAULT_VOICE,
        "voices": voices,
    }


@api.get("/studio/audio/{audio_filename}")
async def studio_audio_stream(audio_filename: str, request: Request):
    """Stream AI-generated audio from MongoDB GridFS with proper Range
    support.

    Public â€” no auth required so student PWA can play it directly.

    v10 (2026-05) surgical audio fix:
      Previously this endpoint advertised `Accept-Ranges: bytes` but
      IGNORED the actual `Range:` request header and always streamed the
      entire file from byte 0. iOS Safari (and any HTML5 <audio> after a
      pause/seek/network blip) sends `Range: bytes=<pos>-` to resume â€”
      the old code answered every such request with the full file from
      offset 0, which made resume / seek / scrub appear to "restart"
      audio for the student. Combined with the ID3 stitcher bug above,
      this produced the visible "audio cuts off after 1â€“2 minutes" bug.

      Now: parse Range, seek into the GridFS stream, and return either a
      proper 206 Partial Content or a 200 with Content-Length. Other
      callers, headers, caching semantics are unchanged.
    """
    try:
        gridout = await audio_bucket.open_download_stream_by_name(audio_filename)
    except Exception:
        raise HTTPException(status_code=404, detail="Audio not found.")

    total_size = int(getattr(gridout, "length", 0) or 0)
    range_header = request.headers.get("range") or request.headers.get("Range")

    # Helper: stream bytes [start, end] inclusive from GridFS.
    async def _range_iter(start: int, end: int):
        # GridOut.seek + read works on motor's AsyncIOMotorGridOut.
        try:
            await gridout.seek(start)
        except Exception:
            # Older motor builds may expose .seek synchronously; try that too.
            try:
                gridout.seek(start)
            except Exception:
                pass
        remaining = end - start + 1
        # 64 KiB chunks â€” small enough for low-memory iOS PWA, big enough
        # to keep the wire warm.
        chunk_size = 64 * 1024
        while remaining > 0:
            data = await gridout.read(min(chunk_size, remaining))
            if not data:
                break
            yield data
            remaining -= len(data)

    # No Range header â†’ standard 200 with Content-Length when known.
    if not range_header or total_size <= 0:
        async def _full_iter():
            chunk_size = 64 * 1024
            while True:
                data = await gridout.read(chunk_size)
                if not data:
                    break
                yield data

        headers = {
            "Cache-Control": "public, max-age=31536000, immutable",
            "Accept-Ranges": "bytes",
        }
        if total_size > 0:
            headers["Content-Length"] = str(total_size)
        return StreamingResponse(
            _full_iter(),
            media_type="audio/mpeg",
            headers=headers,
        )

    # Parse "bytes=START-END" / "bytes=START-" / "bytes=-SUFFIX".
    m = re.match(r"^\s*bytes=(\d*)-(\d*)\s*$", range_header, re.IGNORECASE)
    if not m:
        # Unparseable Range â€” respond with the full file as a fallback.
        return StreamingResponse(
            _range_iter(0, total_size - 1),
            media_type="audio/mpeg",
            headers={
                "Cache-Control": "public, max-age=31536000, immutable",
                "Accept-Ranges": "bytes",
                "Content-Length": str(total_size),
            },
        )

    start_s, end_s = m.group(1), m.group(2)
    if start_s == "" and end_s == "":
        # "bytes=-" with both sides empty is invalid â†’ 416
        return Response(status_code=416, headers={"Content-Range": f"bytes */{total_size}"})
    if start_s == "":
        # Suffix range: last N bytes.
        suffix = int(end_s)
        if suffix <= 0:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{total_size}"})
        start = max(0, total_size - suffix)
        end = total_size - 1
    else:
        start = int(start_s)
        end = int(end_s) if end_s else total_size - 1
    if start >= total_size or start < 0 or end < start:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{total_size}"})
    end = min(end, total_size - 1)
    length = end - start + 1

    return StreamingResponse(
        _range_iter(start, end),
        status_code=206,
        media_type="audio/mpeg",
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "Accept-Ranges": "bytes",
            "Content-Range": f"bytes {start}-{end}/{total_size}",
            "Content-Length": str(length),
        },
    )


@api.post("/studio/books/{slug}/elevenlabs")
async def studio_elevenlabs_generate(
    slug: str,
    payload: dict,
    admin: User = Depends(require_admin),
):
    """Generate AI voice for one chapter using ElevenLabs.
    Teacher-side only. Never called by students.
    Injects audio_url + wordTimestamps into chapter blocks.
    Saves a new book revision to MongoDB.
    """
    chapter_index = int(payload.get("chapterIndex", 0))
    # Defensive: reject human-readable names like "Rachel" â€” ElevenLabs
    # requires a 20-char alphanumeric voice_id. If the client somehow sends
    # anything else (stale cached frontend, manual API caller, etc.), fall
    # back to the configured default instead of 404-ing.
    raw_voice = str(payload.get("voice") or "").strip()
    if _VOICE_ID_RE.match(raw_voice):
        voice_id = raw_voice
    else:
        if raw_voice:
            log.warning(
                "elevenlabs: rejected invalid voice value %r â€” using default %s",
                raw_voice, ELEVENLABS_DEFAULT_VOICE,
            )
        voice_id = ELEVENLABS_DEFAULT_VOICE

    # Define now early â€” used in GridFS metadata and ai_voice meta below
    now = datetime.now(timezone.utc).isoformat()

    # Load current book (latest revision).
    # The frontend passes the saved book directly in the payload after
    # auto-saving, which avoids any MongoDB replication race condition.
    # Fall back to find_one for backward compatibility.
    import asyncio
    book = payload.get("book") or None
    if not book:
        book = await db.books.find_one(
            {"slug": slug},
            {"_id": 0},
            sort=[("revision", -1)],
        )
    if not book:
        await asyncio.sleep(0.5)
        book = await db.books.find_one(
            {"slug": slug},
            {"_id": 0},
            sort=[("revision", -1)],
        )
    if not book:
        raise HTTPException(
            status_code=404,
            detail=f"Book '{slug}' not found. Please click Save Revision first, then Generate AI Voice."
        )

    chapters = book.get("chapters", [])
    if chapter_index >= len(chapters):
        raise HTTPException(status_code=400, detail="Chapter index out of range.")

    chapter = chapters[chapter_index]
    blocks = chapter.get("blocks", [])

    # Collect all text from this chapter for ElevenLabs
    full_text = " ".join(
        b.get("text", "")
        for b in blocks
        if b.get("type", "paragraph") in (
            "paragraph", "transcript", "text", "paragraphs", "heading", "quote"
        )
        and b.get("text", "").strip()
    )

    if not full_text.strip():
        raise HTTPException(status_code=400, detail="Chapter has no readable text.")

    # Call ElevenLabs
    result = await _elevenlabs_generate(full_text, voice_id)
    audio_b64 = result["audio_base64"]
    word_timestamps = result["word_timestamps"]

    # -- Audio storage: R2-first, GridFS fallback -----------------------------
    # FIX v9.9 (preserved): motor GridFSBucket.upload_from_stream() needs a
    # file-like object - raw bytes raise AttributeError: no attribute 'read'.
    #
    # Phase 1 R2 addition:
    #   Try _upload_audio_to_r2() first. On success the returned public URL is
    #   stored in the book block and GridFS is NOT written - saving Atlas
    #   storage. On any failure (env vars absent, boto3 missing, network error)
    #   _upload_audio_to_r2 returns None and the code falls through to the
    #   original GridFS path unchanged.
    #
    #   The existing GridFS stream endpoint /api/studio/audio/{filename} is
    #   completely untouched and continues to serve every previously-generated
    #   audio file indefinitely.
    audio_bytes = base64.b64decode(audio_b64)
    audio_id    = str(uuid.uuid4())

    # Attempt R2 upload - returns None silently if R2 is not configured.
    r2_url = await _upload_audio_to_r2(
        audio_bytes,
        audio_id,
        {
            "slug":          slug,
            "chapter_index": str(chapter_index),
            "voice":         voice_id,
            "created_at":    now,
            "created_by":    admin.email,
        },
    )

    if r2_url:
        # R2 success - use the Cloudflare public URL; GridFS intentionally NOT
        # written. frontend media-urls.js already handles r2.dev URLs.
        audio_url = r2_url
        log.info(
            "elevenlabs: audio stored on R2 slug=%s chapter=%s",
            slug, chapter_index,
        )
    else:
        # GridFS fallback - original behaviour, byte-for-byte unchanged.
        try:
            await audio_bucket.upload_from_stream(
                f"{audio_id}.mp3",
                io.BytesIO(audio_bytes),
                metadata={
                    "slug":          slug,
                    "chapter_index": chapter_index,
                    "voice":         voice_id,
                    "created_at":    now,
                    "created_by":    admin.email,
                },
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("elevenlabs: GridFS upload failed for slug=%s", slug)
            raise HTTPException(
                status_code=500,
                detail=f"Failed to store generated audio: {type(exc).__name__}: {exc}",
            ) from exc
        audio_url = f"{PUBLIC_BACKEND_URL}/api/studio/audio/{audio_id}.mp3"
        log.info(
            "elevenlabs: audio stored on GridFS slug=%s chapter=%s",
            slug, chapter_index,
        )

    # Inject into blocks:
    # 1. Remove any existing ElevenLabs audio block
    blocks = [b for b in blocks if not b.get("_elevenlabs_audio")]

    # 2. Append new audio block (after existing content so teacher MP3 stays primary)
    blocks.append({
        "type": "audio",
        "text": audio_url,
        "heading": f"AI Voice â€” {chapter.get('title', 'Chapter')}",
        "_elevenlabs_audio": True,
        "_audio_id": audio_id,
    })

    # 3. Distribute word timestamps across transcript blocks proportionally
    transcript_blocks = [
        (i, b) for i, b in enumerate(blocks)
        if b.get("type") == "transcript" and b.get("text", "").strip()
    ]

    if transcript_blocks and word_timestamps:
        total_chars = sum(
            len(b.get("text", "")) for _, b in transcript_blocks
        )
        cursor = 0
        for block_idx, block in transcript_blocks:
            block_len = len(block.get("text", ""))
            proportion = block_len / total_chars if total_chars > 0 else 0
            slice_size = max(1, round(proportion * len(word_timestamps)))
            block_words = word_timestamps[cursor: cursor + slice_size]
            cursor += slice_size
            if block_words:
                blocks[block_idx] = {
                    **block,
                    "wordTimestamps": block_words,
                    "start": block_words[0]["start"],
                    "end": block_words[-1]["end"],
                }

    # Update chapter
    chapters[chapter_index] = {**chapter, "blocks": blocks}

    # Add ai_voice metadata to book
    ai_voice_meta = book.get("ai_voice", {})
    ai_voice_meta[str(chapter_index)] = {
        "voice": voice_id,
        "generated_at": now,
        "word_count": len(word_timestamps),
    }

    # Save new revision (append-only â€” same as studio_save_book)
    latest = await db.books.find_one(
        {"slug": slug}, {"_id": 0, "revision": 1},
        sort=[("revision", -1)]
    )
    next_rev = int((latest or {}).get("revision") or 0) + 1

    updated_doc = {
        **book,
        "chapters": chapters,
        "ai_voice": ai_voice_meta,
        "revision": next_rev,
        "_authoredAt": now,
        "_authoredBy": admin.email,
    }
    updated_doc.pop("_id", None)

    await db.books.insert_one(updated_doc)
    log.info(
        "elevenlabs: generated voice for slug=%s chapter=%s voice=%s words=%s rev=%s",
        slug, chapter_index, voice_id, len(word_timestamps), next_rev,
    )

    return {
        "success": True,
        "slug": slug,
        "chapterIndex": chapter_index,
        "wordCount": len(word_timestamps),
        "revision": next_rev,
        "voice": voice_id,
    }


@api.delete("/studio/books/{slug}")
async def studio_delete(slug: str, admin: User = Depends(require_admin)):
    res = await db.books.delete_many({"slug": slug})
    return {"success": True, "deleted": res.deleted_count}


# --------------------------------------------------------------------------- #
# Studio   smart parse / upload                                               #
# --------------------------------------------------------------------------- #
@api.post("/studio/parse")
async def studio_parse(payload: ParseRequest, admin: User = Depends(require_admin)):
    """Raw text ? structured chapters+blocks."""
    return {"success": True, **parse_content(payload.text, payload.default_chapter)}


@api.post("/studio/upload")
async def studio_upload(
    file: UploadFile = File(...),
    admin: User = Depends(require_admin),
):
    """Upload .txt / .md / .docx ? parsed chapters."""
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
# Push Studio   subscriptions, send, schedule, history                         #
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
    """Translate target spec ? MongoDB query for push_subscriptions.

    Surgical fix (Push Studio "By Student ID = 0 subscribers" bug):
      * The teacher's textarea, the on-disk `studentId` field, and the
        student's login `cleanId` are NOT guaranteed to share the same
        casing or whitespace (AuthContext.jsx only `.trim()`s on login  
        it never lowercases   so `push_subscriptions.studentId` may be
        stored as `stu094`, `STU094`, `Stu094`, or even `" stu094 "`
        depending on what was typed at first login).
      * Previous attempt used a strict anchored regex `^stu094$/i` which
        DID handle case differences but still missed any subscription
        whose stored value had stray whitespace.
      * `everyone` and `group` paths are intentionally left byte-identical
        with the prior implementation   only the `students` branch is
        touched.
    """
    if target == "everyone":
        return {}
    if target == "students":
        # Strip every typed ID, drop empties, then de-duplicate while
        # preserving the original casing for logging clarity.
        cleaned: list[str] = []
        seen: set[str] = set()
        for raw in (studentIds or []):
            if not isinstance(raw, str):
                continue
            s = raw.strip()
            if not s:
                continue
            key = s.lower()
            if key in seen:
                continue
            seen.add(key)
            cleaned.append(s)
        if not cleaned:
            return {"studentId": {"$in": []}}
        # Whitespace- AND case-insensitive match: allows the stored
        # value to have leading / trailing whitespace AND any casing
        # variant (the AuthContext login flow does not normalise case
        # before subscribing).
        import re as _re
        return {
            "$or": [
                {
                    "studentId": {
                        "$regex": rf"^\s*{_re.escape(s)}\s*$",
                        "$options": "i",
                    }
                }
                for s in cleaned
            ]
        }
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
        log.warning("push: _VAPID_INSTANCE not loaded (boot error: %s)   skipping fan-out",
                    _VAPID_BOOT_ERROR or "VAPID_PRIVATE_KEY missing")
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


# ---- Diagnostic (public   returns booleans only, no secrets) ---------------
@api.get("/push/_diag")
async def push_diag():
    """Public health check for the push pipeline. Returns only booleans/counts
    (no key material). Hit from any browser to see why pushes might be failing."""
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

    # Try to parse the private key   uses the SAME code path as the live send.
    try:
        from py_vapid import Vapid01 as _V
        v = _V.from_pem(VAPID_PRIVATE_KEY.encode())
        _ = v.private_key
        out["vapid_private_key_parses"] = True
        out["vapid_private_key_parse_error"] = None
        out["vapid_instance_loaded_at_boot"] = _VAPID_INSTANCE is not None
        out["vapid_boot_error"] = _VAPID_BOOT_ERROR or None
    except Exception as exc:  # noqa: BLE001
        out["vapid_private_key_parses"] = False
        out["vapid_private_key_parse_error"] = f"{type(exc).__name__}: {exc}"
        out["vapid_instance_loaded_at_boot"] = _VAPID_INSTANCE is not None
        out["vapid_boot_error"] = _VAPID_BOOT_ERROR or None

    # Try a *dry-run* sign   same code path as a real send but to a fake target.
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

    # Show the first subscription's endpoint host (if any)   helps spot
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

    # Surface VAPID misconfiguration so the UI never shows silent 0/0.
    if not _VAPID_INSTANCE:
        raise HTTPException(
            status_code=500,
            detail=(
                f"VAPID key not loaded on the server. "
                f"Boot error: {_VAPID_BOOT_ERROR or 'VAPID_PRIVATE_KEY missing'}. "
                f"Visit /api/push/_diag for details."
            ),
        )

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
# Points-Credit Push (Option 3)   surgical add-on, no edits above this line.   #
# --------------------------------------------------------------------------- #
#
# Purpose
# -------
# When a student credits another student via the existing P2P `sendPoints`
# GAS flow, the recipient's phone never receives a push because the
# `/api/push/send-studio` endpoint is teacher-gated. This module adds a
# new sibling endpoint POST /api/push/notify-credit that:
#
#   1) Re-validates the SENDER's studentId+password against the GAS Points
#      backend (`?action=login`) with a 60-second in-process LRU cache, so
#      we never trust the client to identify itself and never hammer GAS.
#   2) Enforces per-pair rate limiting (max 2 fires / 5 s)   protects the
#      Points backend and the recipient from spam.
#   3) Server-renders a fixed bilingual Khmer + English notification body
#      using ONLY a validated `amount` int. Title/body are NEVER accepted
#      from the client   that would let any caller send arbitrary copy.
#   4) Reuses the EXISTING `_fan_out_push()` helper unchanged, targeting
#      `{"studentId": recipientStudentId}` so every device the recipient
#      is subscribed on lights up.
#   5) Idempotency via a unique index on `transferId` in a NEW collection
#      `push_credit_log` (TTL 24 h). Duplicate calls return
#      {"ok": True, "duplicate": True} without fanning out again.
#   6) Killswitch: PUSH_CREDIT_NOTIFY_ENABLED=false ? 204 No Content. Read
#      PER-REQUEST from `os.environ` so a Render env-var flip takes effect
#      on the next request without code redeploy.
#   7) Audit trail in `push_history` with extra fields {source, amount,
#      recipientStudentId, senderStudentId, transferId, killswitch}.
#      Existing field names + types are preserved byte-for-byte so the
#      Author Studio history UI keeps rendering today's rows. New rows
#      use `sentBy="credit-push:{senderId}"` so Studio's per-teacher
#      filter (`sentBy == user.email`) silently excludes them   only
#      super-admins see them in the Studio history view.
#   8) Recipient-side dedupe: when `<PointsCreditPushBridge />` fires for
#      a credit that the sender already pushed (P2P primary path), we
#      detect the recent `credit-p2p` row for the same recipient+amount
#      and short-circuit so the recipient's phone only buzzes ONCE per
#      transfer. Without this, a single P2P transfer would surface two
#      pushes (sender modal ? primary; recipient bridge ? fallback ~12 s
#      later via usePoints poll ? duplicate) because the legacy
#      `myportal-latest-reward` storage shape never persisted the
#      `from` field.
#
# Nothing above this line was modified. The /api/push/send-studio,
# /api/push/_diag, _fan_out_push(), _build_target_query() helpers and
# every other /api/push/* route, env var, and collection remain untouched.

import asyncio
import hashlib
import re as _re_credit
import time as _time_credit
from collections import deque
from datetime import timedelta as _credit_timedelta
from typing import Deque

push_credit_log = db["push_credit_log"]


def _credit_killswitch_enabled() -> bool:
    """Per-request killswitch read. Flipping PUSH_CREDIT_NOTIFY_ENABLED in
    Render env vars takes effect on the next call (Render auto-restart
    re-imports the module, but even within the same process this stays
    fresh because we read os.environ on every call)."""
    return (
        os.environ.get("PUSH_CREDIT_NOTIFY_ENABLED", "true").strip().lower()
        == "true"
    )


# GAS Points backend login endpoint. Falls back to the same URL the frontend
# already exposes publicly via src/eduhub/pages/portal/lib/api.ts so a fresh
# deploy works without operator intervention. Override in Render env vars
# to point at a different deployment.
GAS_POINTS_LOGIN_URL = os.environ.get(
    "GAS_POINTS_LOGIN_URL",
    "https://script.google.com/macros/s/AKfycbzRktKyql2I_FbPESNRpCrFDlse-qNd9_Opv9si-g-j2lcanOUPP49IzcyA59lFqVycdA/exec",
)

# Speaking Lab treasury credentials (env vars set in Render dashboard)
SL_TREASURY_ID       = os.environ.get("SL_TREASURY_ID", "stu092")
SL_TREASURY_PASSWORD = os.environ.get("SL_TREASURY_PASSWORD", "")


# Portal GAS backend URL â€” used for server-to-server password sync after reset.
# Set in Render env vars. Falls back to the same URL the frontend already uses.
GAS_PORTAL_URL = os.environ.get(
    "GAS_PORTAL_URL",
    "https://script.google.com/macros/s/AKfycbw_hGdyYmWukTCzaZoxuKMv34mYpQMXd7JtSFzpMpRjGd947eM70u-a1xTUJYA894FwAQ/exec",
)

# Shared secret used to authenticate server-to-server GAS calls.
# Set this in both Render env vars AND GAS Script Properties as GAS_ADMIN_SECRET.
# Generate any long random string: python3 -c "import secrets; print(secrets.token_hex(32))"
GAS_ADMIN_SECRET = os.environ.get("GAS_ADMIN_SECRET", "")

# Evaluation GAS backend URL â€” used for archiving student evaluation rows
# on deactivation. Set in Render env vars as GAS_EVAL_URL.
GAS_EVAL_URL = os.environ.get(
    "GAS_EVAL_URL",
    "https://script.google.com/macros/s/AKfycbxqGH9JuGhVn9V5UuhYeOOyI-vk7E41jXm0hrVp9Pj-Ukuw_HcNcR0C8bflmFTPq1YRDA/exec",
)

# PasswordSync GAS URL â€” standalone script that handles syncPassword, syncName.
# Writes to Sheet 1 (16L90CI5j - Main Database): Password, Name columns only.
# Set in Render env vars as GAS_SYNC_URL.
GAS_SYNC_URL = os.environ.get(
    "GAS_SYNC_URL",
    "https://script.google.com/macros/s/AKfycbx1GGyX0Nfz6SYVvkeY_99g4lAKaDmPgeF2EwQFNgX82RjpNWgYJlxMyu2R3lQtCuG4Wg/exec",
)

# Tuition GAS URL â€” Evaluation sheet GAS script that owns TuitionStatus,
# LastPaymentDate, NextDueDate columns in Sheet 2 (1oATjsiZio).
# This is where updateTuition must be added and called.
# Set in Render env vars as GAS_TUITION_URL.
GAS_TUITION_URL = os.environ.get(
    "GAS_TUITION_URL",
    "https://script.google.com/macros/s/AKfycbx1GGyX0Nfz6SYVvkeY_99g4lAKaDmPgeF2EwQFNgX82RjpNWgYJlxMyu2R3lQtCuG4Wg/exec",
)

# In-process credential cache. Key: sha256(studentId + ":" + password).
# Value: (expires_at_epoch_seconds, ok_bool). 60 s TTL.
_CREDIT_CRED_CACHE: dict[str, tuple[float, bool]] = {}
_CREDIT_CRED_TTL = 60.0
_CREDIT_CRED_MAX = 1024  # bound the dict so it can't grow unbounded

# In-process per-pair rate limiter. Key: (senderStudentId, recipientStudentId).
# Value: deque of recent fire timestamps (epoch seconds).
_CREDIT_RATE_BUCKETS: dict[tuple[str, str], Deque[float]] = {}
_CREDIT_RATE_WINDOW_S = 5.0
_CREDIT_RATE_MAX_PER_WINDOW = 2

# Recipient-bridge dedupe window   see __doc__ above.
_CREDIT_DEDUPE_WINDOW_S = 60

# Last successful fire timestamp   surfaced via /_diag for ops visibility.
_CREDIT_LAST_FIRE_AT: datetime | None = None

# Lazy index creation   `asyncio.Lock()` is created on first use so the
# module imports cleanly on Python versions where module-level Lock()
# instantiation behaves differently (3.10+ is fine, but defensive coding
# keeps boot strictly side-effect-free).
_CREDIT_INDEXES_READY = False
_CREDIT_INDEX_LOCK: asyncio.Lock | None = None

_CREDIT_ID_RE = _re_credit.compile(r"^[A-Za-z0-9_-]+$")


async def _ensure_credit_indexes() -> None:
    """Create unique index on transferId + 24 h TTL on createdAt. Idempotent.
    Lazy-init the asyncio Lock so module load has zero side effects."""
    global _CREDIT_INDEXES_READY, _CREDIT_INDEX_LOCK
    if _CREDIT_INDEXES_READY:
        return
    if _CREDIT_INDEX_LOCK is None:
        # Tiny race window here is benign because create_index is idempotent.
        _CREDIT_INDEX_LOCK = asyncio.Lock()
    async with _CREDIT_INDEX_LOCK:
        if _CREDIT_INDEXES_READY:
            return
        try:
            await push_credit_log.create_index("transferId", unique=True)
            await push_credit_log.create_index(
                "createdAt", expireAfterSeconds=86400
            )
            _CREDIT_INDEXES_READY = True
            log.info("credit-push: push_credit_log indexes ready")
        except Exception as exc:  # noqa: BLE001
            log.warning("credit-push: index create failed: %s", str(exc)[:200])


def _credit_cache_key(student_id: str, password: str) -> str:
    return hashlib.sha256(
        f"{student_id}:{password}".encode("utf-8")
    ).hexdigest()


def _credit_cache_get(key: str) -> bool | None:
    rec = _CREDIT_CRED_CACHE.get(key)
    if not rec:
        return None
    expires_at, ok = rec
    if _time_credit.time() >= expires_at:
        _CREDIT_CRED_CACHE.pop(key, None)
        return None
    return ok


def _credit_cache_put(key: str, ok: bool) -> None:
    if len(_CREDIT_CRED_CACHE) > _CREDIT_CRED_MAX:
        # Cheap eviction   drop expired entries first.
        now_ts = _time_credit.time()
        stale = [k for k, (exp, _) in _CREDIT_CRED_CACHE.items() if exp <= now_ts]
        for k in stale[:128]:
            _CREDIT_CRED_CACHE.pop(k, None)
    _CREDIT_CRED_CACHE[key] = (_time_credit.time() + _CREDIT_CRED_TTL, ok)


def _credit_rate_check(sender_id: str, recipient_id: str) -> bool:
    """Return True if the (sender, recipient) pair is within the rate budget."""
    pair = (sender_id, recipient_id)
    now_ts = _time_credit.time()
    bucket = _CREDIT_RATE_BUCKETS.setdefault(pair, deque())
    while bucket and (now_ts - bucket[0]) > _CREDIT_RATE_WINDOW_S:
        bucket.popleft()
    if len(bucket) >= _CREDIT_RATE_MAX_PER_WINDOW:
        return False
    bucket.append(now_ts)
    if len(_CREDIT_RATE_BUCKETS) > 4096:
        for k in list(_CREDIT_RATE_BUCKETS.keys())[:512]:
            if not _CREDIT_RATE_BUCKETS[k]:
                _CREDIT_RATE_BUCKETS.pop(k, None)
    return True


async def _credit_revalidate_with_gas(student_id: str, password: str) -> bool:
    """Confirm (studentId, password) against GAS PointsBackend `?action=login`.

    Mirrors the client's POST-then-GET fallback so we work against both the
    secured and legacy GAS deployments. Returns True iff the response carries
    `{"success": true}`. Never raises   callers translate False into 401.
    """
    cache_key = _credit_cache_key(student_id, password)
    cached = _credit_cache_get(cache_key)
    if cached is not None:
        return cached
    if not GAS_POINTS_LOGIN_URL:
        return False

    ok = False
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(8.0, connect=4.0),
            follow_redirects=True,
        ) as cli:
            try:
                r1 = await cli.post(
                    GAS_POINTS_LOGIN_URL,
                    data={"action": "login", "id": student_id, "password": password},
                )
                if r1.status_code == 200:
                    try:
                        j1 = r1.json()
                        if isinstance(j1, dict) and j1.get("success") is True:
                            ok = True
                    except Exception:  # noqa: BLE001
                        pass
            except Exception:  # noqa: BLE001
                pass

            if not ok:
                try:
                    r2 = await cli.get(
                        GAS_POINTS_LOGIN_URL,
                        params={
                            "action": "login",
                            "id": student_id,
                            "password": password,
                            "t": str(int(_time_credit.time() * 1000)),
                        },
                    )
                    if r2.status_code == 200:
                        try:
                            j2 = r2.json()
                            if isinstance(j2, dict) and j2.get("success") is True:
                                ok = True
                        except Exception:  # noqa: BLE001
                            pass
                except Exception:  # noqa: BLE001
                    pass
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "credit-push: GAS login revalidation error: %s",
            str(exc)[:200],
        )
        ok = False

    _credit_cache_put(cache_key, ok)
    return ok


async def _credit_recent_p2p_exists(recipient_id: str, amount: int) -> bool:
    """Has a `credit-p2p` row landed in push_history for this (recipient, amount)
    within the last _CREDIT_DEDUPE_WINDOW_S seconds? Used to suppress a
    recipient-bridge fire when the sender's modal already pushed the same
    credit. Looks at sentAt + recipientStudentId + amount + source   all
    additive fields we own, so the query is fast and non-colliding."""
    cutoff = datetime.now(timezone.utc) - _credit_timedelta(
        seconds=_CREDIT_DEDUPE_WINDOW_S
    )
    try:
        existing = await push_history.find_one(
            {
                "source": "credit-p2p",
                "recipientStudentId": recipient_id,
                "amount": amount,
                "sentAt": {"$gte": cutoff},
            },
            {"_id": 1},
        )
        return existing is not None
    except Exception as exc:  # noqa: BLE001
        log.warning("credit-push: dedupe lookup error: %s", str(exc)[:200])
        return False


class PushNotifyCreditPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    senderStudentId: str
    senderPassword: str
    recipientStudentId: str
    amount: int
    transferId: str | None = None


def _credit_validate_id(value: str, label: str) -> str:
    if not value or not isinstance(value, str):
        raise HTTPException(status_code=400, detail=f"{label} required")
    v = value.strip()
    if not v or len(v) > 64 or not _CREDIT_ID_RE.match(v):
        raise HTTPException(status_code=400, detail=f"{label} invalid")
    return v


@api.post("/push/notify-credit")
async def push_notify_credit(
    payload: PushNotifyCreditPayload,
    request: Request,
):
    """Fire a server-rendered Khmer+English credit notification to the
    recipient's subscribed devices. Used by both the sender's client (P2P
    primary path) and the recipient's <PointsCreditPushBridge /> fallback
    for non-P2P credits. Killswitch + rate-limit + auth + dedupe + idempotency
    + audit. See the module docstring above for the full design rationale."""
    global _CREDIT_LAST_FIRE_AT

    # ---- Killswitch (per-request)   bypasses every side effect below. ---
    if not _credit_killswitch_enabled():
        return Response(status_code=204)

    if not GAS_POINTS_LOGIN_URL:
        raise HTTPException(
            status_code=503,
            detail=(
                "GAS_POINTS_LOGIN_URL not configured   set the env var to "
                "the PointsBackend exec URL and redeploy."
            ),
        )

    await _ensure_credit_indexes()

    # ---- Validation -------------------------------------------------------
    sender_id = _credit_validate_id(payload.senderStudentId, "senderStudentId")
    recipient_id = _credit_validate_id(
        payload.recipientStudentId, "recipientStudentId"
    )
    if not isinstance(payload.amount, int) or payload.amount < 1 or payload.amount > 100000:
        raise HTTPException(status_code=400, detail="amount must be int in 1..100000")
    pwd = (payload.senderPassword or "").strip()
    if not pwd or len(pwd) > 128:
        raise HTTPException(status_code=400, detail="senderPassword required")

    transfer_id = (payload.transferId or "").strip()
    if not transfer_id:
        transfer_id = (
            f"{sender_id}:{recipient_id}:{payload.amount}:{int(_time_credit.time())}"
        )
    if len(transfer_id) > 128:
        raise HTTPException(status_code=400, detail="transferId too long")

    is_self_detect = sender_id == recipient_id

    # ---- Rate limit (per pair) -------------------------------------------
    if not _credit_rate_check(sender_id, recipient_id):
        raise HTTPException(status_code=429, detail="rate-limited")

    # ---- Auth: revalidate sender against GAS (cached 60 s) ---------------
    auth_ok = await _credit_revalidate_with_gas(sender_id, pwd)
    if not auth_ok:
        raise HTTPException(status_code=401, detail="sender auth failed")

    # ---- Recipient-bridge dedupe -----------------------------------------
    # Only the recipient-side fallback (sender == recipient) can collide
    # with a sender-side P2P fire. Skip the fan-out + audit if a recent
    # credit-p2p row already covered this recipient+amount.
    if is_self_detect and await _credit_recent_p2p_exists(
        recipient_id, payload.amount
    ):
        return {"sent": 0, "failed": 0, "duplicate": True, "deduped": "p2p-recent"}

    # ---- Idempotency: insert log row first; duplicate ? no fan-out -------
    now_dt = datetime.now(timezone.utc)
    try:
        await push_credit_log.insert_one({
            "transferId": transfer_id,
            "senderStudentId": sender_id,
            "recipientStudentId": recipient_id,
            "amount": payload.amount,
            "createdAt": now_dt,
        })
    except Exception as exc:  # noqa: BLE001
        if "duplicate" in str(exc).lower() or "E11000" in str(exc):
            return {"ok": True, "duplicate": True, "sent": 0, "failed": 0}
        log.warning(
            "credit-push: log insert error tid=%s err=%s",
            transfer_id[:60], str(exc)[:200],
        )
        raise HTTPException(status_code=500, detail="log insert failed")

    # ---- Server-rendered Khmer + English template ------------------------
    # Bilingual Khmer + English. Khmer is written as literal UTF-8 so the
    # source file MUST be saved as UTF-8 (Python 3 default). Do NOT re-encode
    # via PowerShell Set-Content or any tool that may transcode to cp1252.
    title = f"+{payload.amount} ពិន្ទុបានបន្ថែម! / Points Credited!"
    body = (
        f"អ្នកទទួលបាន +{payload.amount} ពិន្ទុ។ / "
        f"+{payload.amount} points added to your account."
    )
    url_target = "/portal/me"

    # ---- Fan out via the EXISTING helper (unchanged) ---------------------
    sent, failed = await _fan_out_push(
        {"studentId": recipient_id}, title, body, url_target,
    )

    # ---- Audit row in push_history (matches existing shape + extras) -----
    source = "credit-detect" if is_self_detect else "credit-p2p"
    history_doc = {
        "title": title,
        "body": body,
        "url": url_target,
        "target": "students",
        "studentIds": [recipient_id],
        "group": "",
        "sentBy": f"credit-push:{sender_id}",
        "sentAt": now_dt,
        "sent": sent,
        "failed": failed,
        # Extra fields   additive, never collide with existing schema.
        "source": source,
        "amount": payload.amount,
        "recipientStudentId": recipient_id,
        "senderStudentId": sender_id,
        "transferId": transfer_id,
        "killswitch": False,
    }
    try:
        await push_history.insert_one(history_doc)
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "credit-push: history insert error tid=%s err=%s",
            transfer_id[:60], str(exc)[:200],
        )

    _CREDIT_LAST_FIRE_AT = now_dt
    log.info(
        "credit-push: sent=%d failed=%d source=%s amount=%d recipient=%s sender=%s",
        sent, failed, source, payload.amount, recipient_id[:32], sender_id[:32],
    )

    # â”€â”€ Speaking Lab live roster hook â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    # If this transfer goes to the treasury (stu092), check if the sender
    # is paying an entry fee for an active session.  If so, their name
    # appears on the teacher board automatically â€” no manual join needed.
    # FIX (Phase 1): use env-backed SL_TREASURY_ID + normalized comparison
    # so "STU092", " stu092 ", "Stu092" etc. all route to Speaking Lab
    # auto-entry. Treasury can be rotated via the SL_TREASURY_ID env var
    # without a code change. The auto-entry task itself is also tolerant
    # of mixed-case sender IDs, missing Mongo records, and fee mismatches.
    if (
        _norm_student_id(recipient_id) == _norm_student_id(SL_TREASURY_ID)
        and not is_self_detect
    ):
        asyncio.create_task(
            _sl_try_auto_enter(sender_id, payload.amount, source="notify_credit")
        )
    # â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    return {"sent": sent, "failed": failed, "duplicate": False}


@api.get("/push/notify-credit/_diag")
async def push_notify_credit_diag():
    """Public health probe   only counts/booleans, never secrets."""
    await _ensure_credit_indexes()
    try:
        total = await push_credit_log.count_documents({})
    except Exception:  # noqa: BLE001
        total = -1
    try:
        history_p2p = await push_history.count_documents({"source": "credit-p2p"})
    except Exception:  # noqa: BLE001
        history_p2p = -1
    try:
        history_detect = await push_history.count_documents(
            {"source": "credit-detect"}
        )
    except Exception:  # noqa: BLE001
        history_detect = -1
    return {
        "enabled": _credit_killswitch_enabled(),
        "credit_log_total": total,
        "rate_limit_keys_in_memory": len(_CREDIT_RATE_BUCKETS),
        "credential_cache_size": len(_CREDIT_CRED_CACHE),
        "last_fire_at": (
            _CREDIT_LAST_FIRE_AT.isoformat() if _CREDIT_LAST_FIRE_AT else None
        ),
        "history_credit_p2p_total": history_p2p,
        "history_credit_detect_total": history_detect,
        "gas_points_login_url_present": bool(GAS_POINTS_LOGIN_URL),
        "indexes_ready": _CREDIT_INDEXES_READY,
        "dedupe_window_seconds": _CREDIT_DEDUPE_WINDOW_S,
    }




# --------------------------------------------------------------------------- #
# Patch landing page   serves the Push Studio deliverable files                #
# --------------------------------------------------------------------------- #
PATCHES_DIR = ROOT_DIR / "patches"

PATCH_FILES: dict[str, dict] = {
    "server": {
        "filename": "server.py",
        "ext": "py",
        "title": "Backend   Push Studio API routes",
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
        "title": "Backend   requirements.txt (3-line addition)",
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
        "title": "Frontend   Push Studio page (Compose / Scheduled / History)",
        "tab_label": "PushStudio.jsx",
        "target_path": "src/studio/PushStudio.jsx",
        "github_edit": "https://github.com/Daravuth999/eduhub-studio-test/new/master/src/studio",
        "blurb": (
            "Self-contained Studio page with three tabs: Compose (title/body/url, "
            "audience selector, debounced subscriber count, live phone preview, "
            "Send Now + Schedule), Scheduled (super-admin only   list, delete, "
            "Run-due button), and History (paginated, expandable rows, scoped per role)."
        ),
    },
    "studio-page": {
        "filename": "StudioPage.jsx",
        "ext": "jsx",
        "title": "Frontend   StudioPage shell with the new Push tab",
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
        "title": "Frontend   Web Push subscribe hook",
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
        "title": "Frontend   Dashboard wires up the Push hook",
        "tab_label": "Dashboard.jsx",
        "target_path": "src/eduhub/pages/Dashboard.jsx",
        "github_edit": "https://github.com/Daravuth999/eduhub-studio-test/edit/master/src/eduhub/pages/Dashboard.jsx",
        "blurb": (
            "One-line addition: usePushNotifications(student?.studentId, "
            "student?.group || student?.batch || 'default'). AuthContext doesn't "
            "expose a group field today, so the call falls back to 'default'   "
            "Push Studio targeting by group still works on subsequent enrolments."
        ),
    },
    "sw": {
        "filename": "sw.js",
        "ext": "js",
        "title": "Frontend   Service Worker with Web Push handlers (v1.2)",
        "tab_label": "sw.js",
        "target_path": "public/sw.js",
        "github_edit": "https://github.com/Daravuth999/eduhub-studio-test/edit/master/public/sw.js",
        "blurb": (
            "Two surgical edits on top of your existing SW: bumps SW_VERSION "
            "from v1.1.0 ? v1.2.0 (forces every browser to evict caches and "
            "pick up the new code), and appends `push` + `notificationclick` "
            "listeners at the very bottom. The browser needs the `push` "
            "listener to actually render notifications   without it, "
            "pywebpush delivers but nothing appears on screen. Restored the "
            "missing `||` fallbacks that were lost in markdown formatting."
        ),
    },
    "push-bell": {
        "filename": "PushNotificationBell.jsx",
        "ext": "jsx",
        "title": "Frontend   Bell button to enable/disable notifications",
        "tab_label": "PushNotificationBell.jsx",
        "target_path": "src/eduhub/components/PushNotificationBell.jsx",
        "github_edit": "https://github.com/Daravuth999/eduhub-studio-test/new/master/src/eduhub/components",
        "blurb": (
            "NEW component. Self-contained bell button that calls the existing "
            "usePushNotifications hook (default import, signature "
            "(studentId, groupName)). Matches your committed backend payload "
            "shape   no env var changes needed (VAPID key auto-fetched). "
            "Styled to match your aurora header (cyan/violet/magenta accents)."
        ),
    },
    "header": {
        "filename": "Header.jsx",
        "ext": "jsx",
        "title": "Frontend   Header.jsx with bell wired in (2-line addition)",
        "tab_label": "Header.jsx",
        "target_path": "src/eduhub/components/Header.jsx",
        "github_edit": "https://github.com/Daravuth999/eduhub-studio-test/edit/master/src/eduhub/components/Header.jsx",
        "blurb": (
            "Surgical: 1 import line + 4 lines that render <PushNotificationBell> "
            "inside the existing isAuthenticated block. ALL safe-area / iOS "
            "notch logic, telegram link, student pill, sign-out button   "
            "preserved byte-for-byte."
        ),
    },
    "icon-192": {
        "filename": "icon-192.png",
        "ext": "png",
        "title": "Asset   Push notification icon (192 192, 33 KB)",
        "tab_label": "icon-192.png",
        "target_path": "public/icons/icon-192.png",
        "github_edit": "https://github.com/Daravuth999/eduhub-studio-test/upload/master/public/icons",
        "blurb": (
            "EduHub logo resized + optimized to 192 192 PNG (33 KB, was 1.8 MB). "
            "Drop into public/icons/ so push notification banners show your logo "
            "instead of the browser default. Same icon used by sw.js and manifest."
        ),
        "binary": True,
    },
    "icon-512": {
        "filename": "icon-512.png",
        "ext": "png",
        "title": "Asset   High-res app icon (512 512, 212 KB)",
        "tab_label": "icon-512.png",
        "target_path": "public/icons/icon-512.png",
        "github_edit": "https://github.com/Daravuth999/eduhub-studio-test/upload/master/public/icons",
        "blurb": (
            "Larger version for iOS Add-to-Home-Screen splash + Android adaptive "
            "icons. Listed in manifest.json. Same logo, just bigger."
        ),
        "binary": True,
    },
    # --- v9.2   Surgery Patch (treasury fix + reader page-flip + tier classification) ---
    "v92-treasury": {
        "filename": "purchaseService.js",
        "ext": "js",
        "title": "Surgery   Treasury wallet ID (stu001 ? stu092)",
        "tab_label": "purchaseService.js",
        "target_path": "src/eduhub/pages/library/books/purchaseService.js",
        "github_edit": "https://github.com/Daravuth999/eduhub-studio-test/edit/master/src/eduhub/pages/library/books/purchaseService.js",
        "blurb": (
            "Single-line constant change: `TREASURY_ID` fallback flipped from "
            "`\"stu001\"` to `\"stu092\"`. The env-var override "
            "REACT_APP_LIBRARY_TREASURY_ID is preserved. All sendPoints / "
            "isUnlocked / SELF_TREASURY guard logic is byte-identical to the "
            "previous build   only the default treasury wallet identifier "
            "changes, so points spent on paid books now correctly credit "
            "stu092 instead of the regular student wallet."
        ),
    },
    "v92-tier-service": {
        "filename": "booksService.js",
        "ext": "js",
        "title": "Surgery   Library tier classifier (free / standard / premium / limited)",
        "tab_label": "booksService.js",
        "target_path": "src/eduhub/pages/library/books/booksService.js",
        "github_edit": "https://github.com/Daravuth999/eduhub-studio-test/edit/master/src/eduhub/pages/library/books/booksService.js",
        "blurb": (
            "Adds `normalizeTier(raw, price, badge)` plus exported "
            "`TIER_PRICE_BANDS` / `TIER_ORDER`. `normalizeBook` now stamps "
            "`b.tier` on every book using author override ? badge LIMITED ? "
            "price band (free=0, standard=1-100, premium=101-500, "
            "limited=501+). Sheet column aliases `[tier, edition, class, "
            "category, plan]` and the multi-row PROMOTABLE list both honour "
            "the new field. Existing book objects without a tier column light "
            "up automatically   zero data migration."
        ),
    },
    "v92-reader": {
        "filename": "ReaderPage.jsx",
        "ext": "jsx",
        "title": "Surgery   Reader: media page-flip + transcript auto-flip",
        "tab_label": "ReaderPage.jsx",
        "target_path": "src/eduhub/pages/library/reader/ReaderPage.jsx",
        "github_edit": "https://github.com/Daravuth999/eduhub-studio-test/edit/master/src/eduhub/pages/library/reader/ReaderPage.jsx",
        "blurb": (
            "Removes `audio` / `video` / `embed` / `transcript` from "
            "NON_SPLITTABLE_TYPES so chapters with embedded media keep "
            "page-flipping instead of collapsing into a tall scroll. Audio "
            "playback already survives flips through the existing "
            "BookAudioProvider mini-player. Adds `transcriptPageMap` + "
            "`useBookAudio` subscription that auto-advances pages following "
            "the audio cursor when transcript blocks declare start/end "
            "timestamps   manual page-turn (`go` / `jumpTo`) stamps "
            "userOverrideUntilRef for ~3 s so deliberate navigation always "
            "wins. mcq / fillblank still cluster as one sub-page."
        ),
    },
    "v92-library": {
        "filename": "LibraryPage.jsx",
        "ext": "jsx",
        "title": "Surgery   Library tier filter chips (Free / Standard / Premium / Limited)",
        "tab_label": "LibraryPage.jsx",
        "target_path": "src/eduhub/pages/library/LibraryPage.jsx",
        "github_edit": "https://github.com/Daravuth999/eduhub-studio-test/edit/master/src/eduhub/pages/library/LibraryPage.jsx",
        "blurb": (
            "Two surgical inserts: (1) appends Free / Standard / Premium / "
            "Limited chips to the existing filter row (data-testids "
            "library-filter-{free|standard|premium|limited}); (2) extends "
            "the filter switch-case so activeFilter ? {free,standard,"
            "premium,limited} narrows shelves by `it.tier`. All other shelf "
            "logic, search, ContinueReading, purchase flow, sync button   "
            "preserved byte-for-byte."
        ),
    },
    "v92-card": {
        "filename": "BookCard.jsx",
        "ext": "jsx",
        "title": "Surgery   BookCard tier ribbon",
        "tab_label": "BookCard.jsx",
        "target_path": "src/eduhub/pages/library/components/BookCard.jsx",
        "github_edit": "https://github.com/Daravuth999/eduhub-studio-test/edit/master/src/eduhub/pages/library/components/BookCard.jsx",
        "blurb": (
            "Adds the `TIER_META` palette (free=teal   standard=blue   "
            "premium=gold   limited=platinum-pulse), a corner tier ribbon "
            "(data-testid card-tier-{tier}), and a `data-tier` attribute on "
            "the card root. Limited-tier cards get a 2.4 s pulsing halo. "
            "Free-tier cards skip the ribbon since the price chip already "
            "labels them. All existing parallax / sheen / NEW pill / "
            "content-type chip / lock overlay / tap-burst behaviour "
            "untouched."
        ),
    },
    "v92-server": {
        "filename": "server.py",
        "ext": "py",
        "title": "Surgery   server.py BookPayload.tier + CANONICAL_BOOK_FIELDS",
        "tab_label": "server.py",
        "target_path": "eduhub-backend-master/server.py",
        "github_edit": "https://github.com/Daravuth999/eduhub-backend/edit/master/server.py",
        "blurb": (
            "Two surgical additions: (1) `BookPayload.tier: str = \"\"` so "
            "Studio can persist explicit tiers in MongoDB; (2) "
            "`CANONICAL_BOOK_FIELDS` whitelists `\"tier\"` so the cleaned "
            "/api/books response includes it. Existing payloads without a "
            "tier still validate (default empty); existing books without a "
            "tier field still serialize cleanly (omitted from response). No "
            "change to auth, push, patches, indexes, or any /api route "
            "behaviour."
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
  <title>EduHub Push Studio   Patch deliverables</title>
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
        <h1>EduHub   Push Studio   Patch deliverables</h1>
        <div class="sub">5 files   backend FastAPI + frontend React. Click a tab to view, copy or open in GitHub.</div>
      </div>
    </header>

    <div class="meta-bar">
      <span class="pill aurora"><span class="swatch" style="background:#1a1420"></span> 5 files ready</span>
      <span class="pill">Backend   1</span>
      <span class="pill">Frontend   4</span>
      <a class="pill" href="/api/patch/index.json">JSON index ?</a>
    </div>

    <nav class="tabs" id="tabs"></nav>

    <main id="panels"></main>

    <div class="footer">
      <span>Generated by the EduHub agent   Plus Jakarta Sans + JetBrains Mono   highlight.js github-dark.</span>
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
  const isBinary = !!p.binary;
  const previewBlock = isBinary
    ? `<div class="code-wrap" style="display:flex;align-items:center;justify-content:center;padding:28px;background:repeating-conic-gradient(rgba(255,255,255,0.04) 0% 25%,transparent 0% 50%) 0 0/24px 24px,#1a1420">
         <img src="/api/patch/${key}/raw" alt="${p.filename}"
              style="max-width:240px;max-height:240px;border-radius:18px;box-shadow:0 12px 40px rgba(0,0,0,0.6);background:rgba(255,255,255,0.04)">
       </div>`
    : `<div class="code-wrap">
         <div class="code-bar">
           <span>${p.filename}</span>
           <button class="copy-btn" data-copy="${key}">Copy</button>
         </div>
         <pre><code class="language-${langFor(p.ext)} hljs" id="code-${key}">Loading </code></pre>
       </div>`;

  return `
    <section class="panel" id="panel-${key}" data-key="${key}" data-binary="${isBinary}">
      <div class="panel-head">
        <div>
          <div class="title">${p.title}</div>
          <div class="target">${p.target_path}</div>
        </div>
        <div class="spacer"></div>
        <a class="btn" href="/api/patch/${key}/raw" target="_blank" download="${p.filename}">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          ${isBinary ? "Download" : "Raw"}
        </a>
        <a class="btn aurora" href="${p.github_edit}" target="_blank" rel="noopener">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>
          ${isBinary ? "Upload to GitHub" : "Open in GitHub"}
        </a>
      </div>
      <div class="blurb">${p.blurb}</div>
      ${previewBlock}
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
  const panel = document.getElementById('panel-' + key);
  // Skip code loading entirely for binary panels.
  if (panel && panel.dataset.binary === 'true') { loaded.add(key); return; }
  const codeEl = document.getElementById('code-' + key);
  if (!codeEl) { loaded.add(key); return; }
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
    b.textContent = 'Copied ?';
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
            "binary": bool(meta.get("binary")),
        }
    html = _LANDING_HTML.replace("__PATCHES_JSON__", json.dumps(payload))
    return Response(content=html, media_type="text/html; charset=utf-8")


@api.get("/patch/index.json", include_in_schema=False)
async def patch_index():
    return {"patches": PATCH_FILES}


def _serve_patch_payload(key: str, force_attachment: bool = False) -> Response:
    """Shared file-fetch helper used by `{key}.ext` and `{key}/download`.

    `force_attachment=True` makes the browser save instead of inline-render.
    """
    if key not in PATCH_FILES:
        raise HTTPException(status_code=404, detail="patch key not found")
    meta = PATCH_FILES[key]
    p = (PATCHES_DIR / meta["filename"]).resolve()
    if PATCHES_DIR.resolve() not in p.parents:
        raise HTTPException(status_code=400, detail="invalid path")
    if not p.exists():
        raise HTTPException(status_code=404, detail="file missing on disk")

    ext = meta["ext"].lower()
    if meta.get("binary"):
        media = {
            "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
            "gif": "image/gif", "webp": "image/webp", "ico": "image/x-icon",
            "svg": "image/svg+xml",
        }.get(ext, "application/octet-stream")
        body: Any = p.read_bytes()
    else:
        media = "text/plain; charset=utf-8"
        body = p.read_text(encoding="utf-8")

    headers: dict = {}
    if force_attachment:
        headers["Content-Disposition"] = f'attachment; filename="{meta["filename"]}"'
    return Response(content=body, media_type=media, headers=headers)


# Note: dotted + /download routes are registered BEFORE `/patch/{key}` so the
# greedy str path-param doesn't swallow the dotted form.
@api.get("/patch/{key}.{ext}", include_in_schema=False)
async def patch_dotted(key: str, ext: str):
    """Plain-text raw view at /api/patch/<key>.<ext>   convenient for iPhone
    long-press copy and curl-friendly URLs (e.g. `purchaseService.js` looks
    like a real file path)."""
    if key not in PATCH_FILES:
        raise HTTPException(status_code=404, detail="patch key not found")
    meta = PATCH_FILES[key]
    if str(meta.get("ext", "")).lower() != ext.lower():
        # Allow generic aliases (txt) so ` /v92-server.txt` still works.
        if ext.lower() not in {"txt", "raw"}:
            raise HTTPException(status_code=404, detail="ext mismatch")
    return _serve_patch_payload(key, force_attachment=False)


@api.get("/patch/{key}/download", include_in_schema=False)
async def patch_download(key: str):
    """Forces a Save-As download with the original filename   handy on
    desktop browsers and the GitHub mobile app file-upload picker."""
    return _serve_patch_payload(key, force_attachment=True)


@api.get("/patch/{key}/raw", include_in_schema=False)
async def patch_raw(key: str):
    if key not in PATCH_FILES:
        raise HTTPException(status_code=404, detail="patch key not found")
    meta = PATCH_FILES[key]
    p = (PATCHES_DIR / meta["filename"]).resolve()
    if PATCHES_DIR.resolve() not in p.parents:
        raise HTTPException(status_code=400, detail="invalid path")
    if not p.exists():
        raise HTTPException(status_code=404, detail="file missing on disk")

    # Binary assets (icons etc)   serve as-is with correct content-type.
    if meta.get("binary"):
        ext = meta["ext"].lower()
        media = {
            "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
            "gif": "image/gif", "webp": "image/webp", "ico": "image/x-icon",
            "svg": "image/svg+xml",
        }.get(ext, "application/octet-stream")
        return Response(content=p.read_bytes(), media_type=media)

    # Text patches   return plain text.
    return Response(content=p.read_text(encoding="utf-8"),
                    media_type="text/plain; charset=utf-8")


@api.get("/patch/{key}", include_in_schema=False)
async def patch_view(key: str):
    """Same landing page, opened on a specific tab via URL fragment redirect."""
    if key not in PATCH_FILES:
        raise HTTPException(status_code=404, detail="patch key not found")
    return Response(
        status_code=302,
        headers={"Location": f"/api/patch#{key}"},
    )


# --------------------------------------------------------------------------- #
# Teacher-block push helpers (surgical additions, gated by require_admin       #
# until require_teacher dependency arrives in the teacher block merge).        #
#                                                                              #
# These endpoints are NEW. They do not modify any existing route, do not       #
# write to push_subscriptions, and only CALL the existing _fan_out_push        #
# helper unchanged. They are designed so the future teacher block can call     #
# them internally OR be merged cleanly without further changes here.           #
# --------------------------------------------------------------------------- #
class TeacherPushPointsPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    delta: int


class TeacherPushRestrictionPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    message: str | None = None


class TeacherPushReminderPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    message: str | None = None


class TeacherPushSpeakingPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    group: Literal["A", "B", "all"] = "all"


# Feature 1   Teacher Awards Points -> Auto Push
@api.post("/teacher/students/{student_id}/push-points")
async def teacher_push_points(
    student_id: str,
    payload: TeacherPushPointsPayload,
    user: User = Depends(require_admin),
):
    """Fire push to a single student after their points were adjusted.
    Wrapped in try/except   push failure must never break the points save flow."""
    try:
        if payload.delta > 0:
            # Bilingual Khmer + English. Literal UTF-8 strings — NEVER use
            # PowerShell Set-Content or any tool that may transcode to cp1252,
            # which is what produced the previous Khmer mojibake (UTF-8 bytes
            # of "ពិន្ទុ" interpreted as cp1252) on iPhone notification banners.
            sent, failed = await _fan_out_push(
                {"studentId": student_id},
                title=f"🎉 +{payload.delta} ពិន្ទុបានបន្ថែម! / Points Credited!",
                body=(
                    f"អ្នកទទួលបាន +{payload.delta} ពិន្ទុ ✨\n"
                    f"You received +{payload.delta} points. Keep it up!"
                ),
                url="/portal",
            )
        else:
            sent, failed = await _fan_out_push(
                {"studentId": student_id},
                title="Points updated",
                body=f"Your points were adjusted by {payload.delta}.",
                url="/portal",
            )
        return {"ok": True, "sent": sent, "failed": failed}
    except Exception as exc:  # noqa: BLE001
        log.warning("teacher push-points failed for %s: %s", student_id, exc)
        return {"ok": False, "sent": 0, "failed": 0, "error": str(exc)[:200]}


# Feature 2   Restriction Warning Push
@api.post("/teacher/students/{student_id}/push-restriction")
async def teacher_push_restriction(
    student_id: str,
    payload: TeacherPushRestrictionPayload,
    user: User = Depends(require_admin),
):
    """Fire push when a teacher sets a restriction on a student.
    Wrapped in try/except   push failure must never break the scores save flow."""
    try:
        body_text = (payload.message or "").strip() or (
            "Your account has been restricted. Contact your teacher."
        )
        sent, failed = await _fan_out_push(
            {"studentId": student_id},
            title="Account restricted",
            body=body_text,
            url="/portal",
        )
        return {"ok": True, "sent": sent, "failed": failed}
    except Exception as exc:  # noqa: BLE001
        log.warning("teacher push-restriction failed for %s: %s", student_id, exc)
        return {"ok": False, "sent": 0, "failed": 0, "error": str(exc)[:200]}


# Feature 3   Tuition Reminder Button
@api.post("/teacher/students/{student_id}/push-reminder")
async def teacher_push_reminder(
    student_id: str,
    payload: TeacherPushReminderPayload,
    user: User = Depends(require_admin),
):
    """Send a tuition reminder push to a single student. Used by:
      - the teacher's StudentEditDrawer (Payment tab) when merged later
      - the Quick Push tab in PushStudio for arbitrary student IDs (Feature 6)
    """
    try:
        body_text = (payload.message or "").strip() or (
            "Your tuition payment is overdue. Please settle today."
        )
        sent, failed = await _fan_out_push(
            {"studentId": student_id},
            title="Tuition reminder",
            body=body_text,
            url="/portal",
        )
        return {"ok": True, "sent": sent, "failed": failed}
    except Exception as exc:  # noqa: BLE001
        log.warning("teacher push-reminder failed for %s: %s", student_id, exc)
        return {"ok": False, "sent": 0, "failed": 0, "error": str(exc)[:200]}


# Feature 6   Speaking Test Results Ready Push
@api.post("/teacher/push/speaking-results")
async def teacher_push_speaking_results(
    payload: TeacherPushSpeakingPayload,
    user: User = Depends(require_admin),
):
    """Fan-out a 'speaking test results are ready' push to a group of students.
    group="A" -> {"group": "A"}, "B" -> {"group": "B"}, "all" -> {} (everyone).
    """
    try:
        if payload.group == "A":
            query: dict = {"group": "A"}
        elif payload.group == "B":
            query = {"group": "B"}
        else:
            query = {}
        sent, failed = await _fan_out_push(
            query,
            title="Speaking test results are ready",
            body="Your speaking test results are ready. Check your portal now!",
            url="/portal",
        )
        return {"ok": True, "sent": sent, "failed": failed}
    except Exception as exc:  # noqa: BLE001
        log.warning("teacher push speaking-results failed: %s", exc)
        return {"ok": False, "sent": 0, "failed": 0, "error": str(exc)[:200]}


# --------------------------------------------------------------------------- #
# ============================================================================ #
#  EduHub Student Auth + Management   v10.0 Surgical Patch                     #
#  Generated: 2026-01                                                          #
#                                                                              #
#  HOW TO APPLY                                                                #
#  ------------                                                                #
#  Open server.py and locate line 2396 (the section divider that reads):       #
#                                                                              #
#      # --------------------------------------------------------------------- #
#      # Wire up                                                               #
#      # --------------------------------------------------------------------- #
#                                                                              #
#  Paste the entire body of this file IMMEDIATELY ABOVE that divider.          #
#  Then add the four index-creation lines inside startup() (see end of file).  #
#                                                                              #
#  Zero lines of existing server.py are modified. Append-only.                 #
# ============================================================================ #


# -- Student Auth + Management v10.0 ---------------------------------------- #
# Surgical addition   zero existing code modified above this block.           #
# Adds:                                                                        #
#   /api/auth/student/login | logout | me                                     #
#   /api/teacher/students CRUD (auto passphrase, ID reuse, soft-delete)       #
# Collections: students, student_sessions                                     #
# --------------------------------------------------------------------------- #
import bcrypt as _bcrypt_lib
import secrets

# passlib removed: using bcrypt directly
TURNSTILE_SECRET_KEY = os.environ.get("TURNSTILE_SECRET_KEY", "")

# Word lists for human-friendly passphrase generation
_ADJECTIVES = [
    "blue", "green", "red", "gold", "silver", "bright", "swift", "calm",
    "bold", "kind", "warm", "cool", "dark", "soft", "brave", "clear",
    "sharp", "loud", "deep", "wild",
]
_NOUNS = [
    "river", "moon", "star", "hill", "lake", "tree", "wind", "rain",
    "fire", "stone", "cloud", "bird", "leaf", "wave", "sun", "rose",
    "book", "road", "bell", "door",
]


def _generate_passphrase() -> str:
    """Generate a 3-token passphrase: adjective-noun-number.

    Example: ``blue-river-42``. Easy to read aloud, easy to type, and
    >= 56 bits of entropy when the lists are public   sufficient for a
    school PWA when paired with bcrypt cost-12 hashing.
    """
    adj = secrets.choice(_ADJECTIVES)
    noun = secrets.choice(_NOUNS)
    number = secrets.randbelow(90) + 10  # 10..99
    return f"{adj}-{noun}-{number}"


# --------------------------------------------------------------------------- #
# Pydantic model                                                              #
# --------------------------------------------------------------------------- #
class Student(BaseModel):
    model_config = ConfigDict(extra="ignore")
    student_id: str
    clean_id: str
    display_name: str
    group: str = ""
    is_active: bool = True
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    last_login: datetime | None = None


# --------------------------------------------------------------------------- #
# current_student() dependency   cookie first, Bearer fallback (Safari ITP)   #
# --------------------------------------------------------------------------- #
async def current_student(
    student_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> Student | None:
    token = student_session
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
    if not token:
        return None
    sess = await db.student_sessions.find_one({"session_token": token}, {"_id": 0})
    if not sess:
        return None
    expires = sess.get("expires_at")
    if expires:
        exp_dt = datetime.fromisoformat(expires) if isinstance(expires, str) else expires
        if exp_dt.tzinfo is None:
            exp_dt = exp_dt.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) > exp_dt:
            return None
    doc = await db.students.find_one(
        {"student_id": sess["student_id"]},
        {"_id": 0, "password_hash": 0},
    )
    if not doc or doc.get("is_active") is False:
        return None
    return Student(**doc)


async def require_student(
    student: Student | None = Depends(current_student),
) -> Student:
    if not student:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return student


# --------------------------------------------------------------------------- #
# Cloudflare Turnstile verification helper                                    #
# --------------------------------------------------------------------------- #
async def _verify_turnstile(token: str) -> bool:
    if not TURNSTILE_SECRET_KEY:
        log.warning("student-auth: TURNSTILE_SECRET_KEY not set   dev mode bypass")
        return True
    if not token:
        return False
    async with httpx.AsyncClient(timeout=10) as hc:
        r = await hc.post(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            data={"secret": TURNSTILE_SECRET_KEY, "response": token},
        )
    return bool((r.json() if r.status_code == 200 else {}).get("success"))


# --------------------------------------------------------------------------- #
# Student auth endpoints                                                      #
# --------------------------------------------------------------------------- #
@api.post("/auth/student/login")
async def student_login(payload: dict, response: Response):
    clean_id = (payload.get("clean_id") or "").strip().lower()
    password = payload.get("password") or ""
    turnstile_token = payload.get("turnstile_token") or ""

    if not clean_id or not password:
        raise HTTPException(status_code=400, detail="clean_id and password are required")

    if not await _verify_turnstile(turnstile_token):
        raise HTTPException(status_code=401, detail="Bot check failed")

    doc = await db.students.find_one(
        {"clean_id": clean_id, "is_active": {"$ne": False}},
        {"_id": 0},
    )
    # Identical 401 for missing user and wrong password   prevents enumeration.
    _pw_ok = False
    if doc:
        _stored_hash = (doc.get("password_hash") or "").strip()
        if _stored_hash:
            try:
                _pw_ok = _bcrypt_lib.checkpw(
                    password.encode("utf-8"), _stored_hash.encode("utf-8")
                )
            except Exception:
                _pw_ok = False
    if not doc or not _pw_ok:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    now = datetime.now(timezone.utc)
    session_token = uuid.uuid4().hex
    await db.student_sessions.insert_one({
        "student_id": doc["student_id"],
        "session_token": session_token,
        "expires_at": (now + timedelta(days=30)).isoformat(),
        "created_at": now.isoformat(),
    })
    await db.students.update_one(
        {"student_id": doc["student_id"]},
        {"$set": {"last_login": now.isoformat()}},
    )
    response.set_cookie(
        key="student_session",
        value=session_token,
        httponly=True,
        secure=True,
        samesite="none",
        path="/",
        max_age=30 * 24 * 60 * 60,  # 30 days
    )
    return {
        "student_id": doc["student_id"],
        "clean_id": doc["clean_id"],
        "display_name": doc["display_name"],
        "group": doc.get("group", ""),
        "session_token": session_token,  # for Mobile Safari Bearer fallback
    }


@api.get("/auth/student/me")
async def student_me(student: Student = Depends(require_student)):
    return {
        "student_id": student.student_id,
        "clean_id": student.clean_id,
        "display_name": student.display_name,
        "group": student.group,
    }


@api.post("/auth/student/logout")
async def student_logout(
    response: Response,
    student_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    token = student_session
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
    if token:
        await db.student_sessions.delete_one({"session_token": token})
    response.delete_cookie(
        "student_session", path="/", samesite="none", secure=True,
    )
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Teacher / admin endpoints   student CRUD                                    #
# --------------------------------------------------------------------------- #
async def _archive_student_in_gas(clean_id: str) -> bool:
    """Archive all month-sheet evaluation rows for this student to the Archive tab,
    then blank those rows so the next student on this ID starts clean.
    Never raises. Returns True on confirmed GAS success, False otherwise.
    """
    if not GAS_EVAL_URL or not GAS_ADMIN_SECRET:
        log.warning(
            "archive-student: GAS_EVAL_URL or GAS_ADMIN_SECRET not set "
            "â€” rows NOT archived for %s.", clean_id,
        )
        return False
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(15.0, connect=5.0),
            follow_redirects=True,
        ) as cli:
            r = await cli.post(
                GAS_EVAL_URL,
                data={
                    "action": "archiveStudent",
                    "studentId": clean_id,
                    "adminSecret": GAS_ADMIN_SECRET,
                },
            )
            if r.status_code == 200:
                try:
                    j = r.json()
                    if isinstance(j, dict) and j.get("ok") is True:
                        log.info(
                            "archive-student: archived %s month(s) for %s",
                            j.get("archivedMonths", "?"), clean_id,
                        )
                        return True
                except Exception:  # noqa: BLE001
                    pass
        log.warning("archive-student: GAS did not confirm for %s", clean_id)
        return False
    except Exception as exc:  # noqa: BLE001
        log.warning("archive-student: GAS unreachable for %s â€” %s", clean_id, exc)
        return False


async def _sync_password_to_gas(clean_id: str, plain_password: str) -> bool:
    """Push the new plaintext password to the GAS Portal Sheet Password column.

    This keeps the Google Sheet credential in sync with MongoDB after a
    teacher-initiated password reset.  The Sheet password is what GAS
    PointsBackend / GameBackend / PortalBackend validate against â€” without
    this sync, those backends keep accepting the OLD password forever, which
    is fine for read-only data but breaks any write that re-authenticates
    (sendPoints, library purchase, etc.) once the student changes their login.

    Never raises â€” a GAS outage must never block or roll back the MongoDB
    reset.  Returns True if the GAS confirmed success, False otherwise.
    The caller logs the outcome; the student always gets their new password
    regardless.
    """
    if not GAS_SYNC_URL or not GAS_ADMIN_SECRET:
        log.warning(
            "password-sync: GAS_SYNC_URL or GAS_ADMIN_SECRET not set â€” "
            "Sheet password NOT updated for %s. Set both env vars to enable sync.",
            clean_id,
        )
        return False
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, connect=5.0),
            follow_redirects=True,
        ) as cli:
            r = await cli.post(
                GAS_SYNC_URL,
                data={
                    "action": "syncPassword",
                    "studentId": clean_id,
                    "newPassword": plain_password,
                    "adminSecret": GAS_ADMIN_SECRET,
                },
            )
            if r.status_code == 200:
                try:
                    j = r.json()
                    if isinstance(j, dict) and j.get("ok") is True:
                        log.info("password-sync: Sheet updated for %s", clean_id)
                        return True
                except Exception:  # noqa: BLE001
                    pass
        log.warning("password-sync: GAS did not confirm for %s", clean_id)
        return False
    except Exception as exc:  # noqa: BLE001
        log.warning("password-sync: GAS unreachable for %s â€” %s", clean_id, exc)
        return False


async def _sync_name_to_gas(clean_id: str, display_name: str) -> bool:
    """Push the new display name to the GAS standalone Password Sync script.

    Called on ID reactivation so the previous student's name is overwritten.
    Without this, getStudentData returns the old occupant's name forever.
    Never raises â€” a GAS outage must never block reactivation.
    """
    if not GAS_SYNC_URL or not GAS_ADMIN_SECRET:
        log.warning(
            "name-sync: GAS_SYNC_URL or GAS_ADMIN_SECRET not set â€” "
            "Sheet name NOT updated for %s.", clean_id,
        )
        return False
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, connect=5.0),
            follow_redirects=True,
        ) as cli:
            r = await cli.post(
                GAS_SYNC_URL,
                data={
                    "action": "syncName",
                    "studentId": clean_id,
                    "newName": display_name,
                    "adminSecret": GAS_ADMIN_SECRET,
                },
            )
            if r.status_code == 200:
                try:
                    j = r.json()
                    if isinstance(j, dict) and j.get("ok") is True:
                        log.info("name-sync: Sheet updated %s -> %s", clean_id, display_name)
                        return True
                except Exception:  # noqa: BLE001
                    pass
        log.warning("name-sync: GAS did not confirm for %s", clean_id)
        return False
    except Exception as exc:  # noqa: BLE001
        log.warning("name-sync: GAS unreachable for %s â€” %s", clean_id, exc)
        return False



@api.post("/teacher/students")
async def teacher_create_student(
    payload: dict,
    admin: User = Depends(require_admin),
):
    """Create a student with an auto-generated passphrase password.

    * If ``clean_id`` exists and is INACTIVE  ? reactivate with new password.
    * If ``clean_id`` exists and is ACTIVE    ? 409 conflict.

    The plaintext password is returned **once** in the response body and
    never persisted anywhere except as a bcrypt hash.
    """
    clean_id = (payload.get("clean_id") or "").strip().lower()
    display_name = (payload.get("display_name") or "").strip()
    group = (payload.get("group") or "").strip()

    if not clean_id or not display_name:
        raise HTTPException(
            status_code=400, detail="clean_id and display_name are required",
        )

    plain_password = _generate_passphrase()
    password_hash = _bcrypt_lib.hashpw(plain_password.encode("utf-8"), _bcrypt_lib.gensalt(rounds=12)).decode("utf-8")
    now = datetime.now(timezone.utc)

    existing = await db.students.find_one({"clean_id": clean_id}, {"_id": 0})

    if existing:
        if existing.get("is_active"):
            raise HTTPException(
                status_code=409,
                detail=f"Student ID '{clean_id}' is already active. "
                       "Deactivate first to reuse.",
            )
        # ID reuse   reactivate with fresh credentials
        await db.students.update_one(
            {"clean_id": clean_id},
            {"$set": {
                "display_name": display_name,
                "group": group,
                "password_hash": password_hash,
                "is_active": True,
                "enrolled_at": now.isoformat(),
                "last_login": None,
            }},
        )
        await db.student_sessions.delete_many(
            {"student_id": existing["student_id"]},
        )
        student_id = existing["student_id"]
        action = "reactivated"
    else:
        student_id = f"stu_{uuid.uuid4().hex[:12]}"
        await db.students.insert_one({
            "student_id": student_id,
            "clean_id": clean_id,
            "display_name": display_name,
            "group": group,
            "password_hash": password_hash,
            "is_active": True,
            "created_at": now.isoformat(),
            "enrolled_at": now.isoformat(),
            "last_login": None,
        })
        action = "created"

    log.info("teacher: student %s %s by %s", clean_id, action, admin.email)
    # Fire-and-forget GAS syncs â€” never block the credential card response.
    import asyncio as _asyncio_create
    _asyncio_create.create_task(_sync_password_to_gas(clean_id, plain_password))
    # Always sync the name to GAS â€” on reactivation this overwrites the previous
    # occupant's stale name; on brand-new creation this ensures the GAS sheet row
    # (which may exist from a pre-MongoDB migration) shows the correct new name.
    _asyncio_create.create_task(_sync_name_to_gas(clean_id, display_name))

    return {
        "action": action,
        "student_id": student_id,
        "clean_id": clean_id,
        "display_name": display_name,
        "group": group,
        "enrolled_at": now.isoformat(),
        "password": plain_password,  # shown ONCE   never stored, never logged
        "login_url": "https://eduhub-studio-test.vercel.app",
    }


@api.get("/teacher/students")
async def teacher_list_students(admin: User = Depends(require_admin)):
    # Primary source: MongoDB db.students (populated via teacher CRUD)
    # Return ALL students so the frontend can show inactive ones with
    # the Reuse ID button. The login endpoint still enforces is_active:True.
    cursor = db.students.find({}, {"_id": 0, "password_hash": 0})
    students = await cursor.to_list(length=2000)
    for s in students:
        if "enrolled_at" not in s:
            s["enrolled_at"] = s.get("created_at", "")

    # If db.students is empty, fall back to GAS_PORTAL_URL?action=getStudents
    # This covers schools whose student roster lives entirely in Google Sheets.
    if not students and GAS_PORTAL_URL:
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(12.0, connect=6.0),
                follow_redirects=True,
            ) as cli:
                r = await cli.get(
                    GAS_PORTAL_URL,
                    params={"action": "getStudents"},
                )
                if r.status_code == 200:
                    try:
                        gas_data = r.json()
                        # GAS may return [{id, name, group, level, schedule, ...}]
                        # or {students: [...]} â€” handle both
                        raw = gas_data if isinstance(gas_data, list) else gas_data.get("students") or gas_data.get("data") or []
                        for row in raw:
                            if not isinstance(row, dict):
                                continue
                            sid = (
                                row.get("student_id") or row.get("studentId") or
                                row.get("id") or row.get("clean_id") or ""
                            ).strip()
                            name = (
                                row.get("display_name") or row.get("name") or
                                row.get("displayName") or sid
                            ).strip()
                            group = str(
                                row.get("group") or row.get("schedule") or
                                row.get("batch") or "A"
                            ).strip()
                            level = str(
                                row.get("level") or row.get("Level") or "Beginner"
                            ).strip()
                            if not sid:
                                continue
                            students.append({
                                "student_id": sid,
                                "clean_id": sid,
                                "display_name": name,
                                "group": group,
                                "level": level,
                                "is_active": True,
                                "source": "gas",
                            })
                        if students:
                            log.info("teacher_list_students: loaded %d students from GAS fallback", len(students))
                    except Exception as parse_exc:
                        log.warning("teacher_list_students: GAS parse error: %s", str(parse_exc)[:200])
        except Exception as gas_exc:
            log.warning("teacher_list_students: GAS fetch error: %s", str(gas_exc)[:200])

    return {"students": students}


@api.patch("/teacher/students/{student_id}")
async def teacher_update_student(
    student_id: str,
    payload: dict,
    admin: User = Depends(require_admin),
):
    allowed = {"display_name", "group"}
    updates = {k: v for k, v in payload.items() if k in allowed and v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields to update")

    # Fetch the doc BEFORE updating so we have clean_id for the GAS sync.
    # clean_id is the Google Sheets student row key â€” student_id is the internal
    # MongoDB UUID and is NOT what GAS stores.
    doc = await db.students.find_one(
        {"student_id": student_id}, {"_id": 0, "clean_id": 1},
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Student not found")

    result = await db.students.update_one(
        {"student_id": student_id}, {"$set": updates},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Student not found")

    # If display_name was updated, mirror it to Google Sheets so that GAS
    # getStudentData, Tuition Reminder, and the Portal all see the new name.
    # Fire-and-forget â€” a GAS outage must never block or roll back the update.
    if "display_name" in updates:
        import asyncio as _asyncio_patch
        _asyncio_patch.create_task(
            _sync_name_to_gas(doc["clean_id"], updates["display_name"])
        )

    return {"ok": True}


@api.post("/teacher/students/{student_id}/reset-password")
async def teacher_reset_password(
    student_id: str,
    admin: User = Depends(require_admin),
):
    """Generate a new passphrase and invalidate all sessions."""
    plain_password = _generate_passphrase()
    result = await db.students.update_one(
        {"student_id": student_id},
        {"$set": {"password_hash": _bcrypt_lib.hashpw(plain_password.encode("utf-8"), _bcrypt_lib.gensalt(rounds=12)).decode("utf-8")}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Student not found")
    await db.student_sessions.delete_many({"student_id": student_id})
    doc = await db.students.find_one(
        {"student_id": student_id}, {"_id": 0, "password_hash": 0},
    )
    log.info("teacher: password reset for %s by %s", student_id, admin.email)
    # Fire-and-forget â€” never delay the credential card response.
    import asyncio as _asyncio_reset
    _asyncio_reset.create_task(_sync_password_to_gas(doc["clean_id"], plain_password))

    return {
        "ok": True,
        "student_id": student_id,
        "clean_id": doc["clean_id"],
        "display_name": doc["display_name"],
        "group": doc.get("group", ""),
        "password": plain_password,  # shown ONCE
        "login_url": "https://eduhub-studio-test.vercel.app",
    }


async def _update_tuition_in_gas(
    clean_id: str,
    tuition_status: str | None,
    last_payment_date: str | None,
    next_due_date: str | None,
    payment_amount: str | None,
) -> dict:
    """Write TuitionStatus / LastPaymentDate / NextDueDate (and optionally
    PaymentAmount) to the Students tab in GAS.

    SAFE COLUMNS ONLY â€” never touches StudentID, Name, Password, restriction,
    evaluation scores, month tabs, Archive tab, Comments, Coupons, Redemptions,
    Strength / Weakness / Improvement.

    Returns {"ok": True} on confirmed GAS success.
    Raises RuntimeError with a human-readable message on any failure â€” the
    caller MUST surface this; never fake success.
    """
    if not GAS_TUITION_URL or not GAS_ADMIN_SECRET:
        raise RuntimeError(
            "updateTuition: GAS_TUITION_URL or GAS_ADMIN_SECRET not configured "
            "â€” set both Render env vars to enable tuition management."
        )
    payload: dict = {
        "action": "updateTuition",
        "studentId": clean_id,
        "adminSecret": GAS_ADMIN_SECRET,
    }
    if tuition_status is not None:
        payload["tuitionStatus"] = tuition_status
    if last_payment_date is not None:
        payload["lastPaymentDate"] = last_payment_date
    if next_due_date is not None:
        payload["nextDueDate"] = next_due_date
    if payment_amount is not None:
        payload["paymentAmount"] = payment_amount

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(15.0, connect=5.0),
            follow_redirects=True,
        ) as cli:
            r = await cli.post(GAS_TUITION_URL, data=payload)
        if r.status_code == 200:
            try:
                j = r.json()
                if isinstance(j, dict) and j.get("ok") is True:
                    log.info(
                        "updateTuition: GAS confirmed for %s status=%s next=%s",
                        clean_id, tuition_status, next_due_date,
                    )
                    return j
                err_msg = j.get("message") or j.get("error") or j.get("detail") or "GAS returned ok:false"
                raise RuntimeError(f"GAS update failed: {err_msg}")
            except (ValueError, AttributeError):
                raise RuntimeError("GAS returned non-JSON response â€” update may not have applied")
        raise RuntimeError(f"GAS HTTP {r.status_code} â€” update not applied")
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"GAS unreachable: {exc}") from exc


@api.patch("/teacher/students/{student_id}/tuition")
async def teacher_update_tuition(
    student_id: str,
    payload: dict,
    admin: User = Depends(require_admin),
):
    """Controlled tuition update â€” teacher clicks Mark Paid / Mark Unpaid /
    Extend 1 Month / Set Custom Due Date.

    Accepted actions:
        mark_paid          â€” sets Paid, today as LastPaymentDate, safe NextDueDate
        mark_unpaid        â€” sets Unpaid, clears LastPaymentDate
        extend_one_month   â€” adds 1 month to NextDueDate (today if overdue/missing)
        set_custom_due_date â€” sets NextDueDate to caller-provided YYYY-MM-DD

    NEVER writes: StudentID, Name, Password, restriction, evaluation scores,
    month tabs, Archive, Comments, Coupons, Redemptions, Strength/Weakness/Improvement.

    On any GAS failure: returns HTTP 502 with the GAS error message.
    Never fakes success.
    """
    import re as _re
    import calendar as _cal
    from datetime import date as _date

    action = (payload.get("action") or "").strip()
    if action not in {"mark_paid", "mark_unpaid", "extend_one_month", "set_custom_due_date"}:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid action '{action}'. Accepted: mark_paid, mark_unpaid, "
                   "extend_one_month, set_custom_due_date",
        )

    doc = await db.students.find_one(
        {"student_id": student_id},
        {"_id": 0, "clean_id": 1, "display_name": 1},
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Student not found")
    clean_id: str = doc["clean_id"]

    # Helper: parse YYYY.MM.DD, YYYY-MM-DD, or full ISO timestamp (2026-05-31T17:00:00.000Z)
    _ISO = _re.compile(r"^(\d{4})[.\-](\d{2})[.\-](\d{2})")

    def _parse_iso(s: str | None) -> _date | None:
        if not s:
            return None
        m = _ISO.match(str(s).strip())
        if not m:
            return None
        try:
            return _date(int(m[1]), int(m[2]), int(m[3]))
        except ValueError:
            return None

    def _fmt(d: _date) -> str:
        return d.strftime("%Y.%m.%d")  # matches sheet format: 2026.05.28

    def _add_one_month(d: _date) -> _date:
        """Add exactly one calendar month, clamping to month-end on overflow."""
        month = d.month % 12 + 1
        year  = d.year + (1 if d.month == 12 else 0)
        day   = min(d.day, _cal.monthrange(year, month)[1])
        return _date(year, month, day)

    today = _date.today()

    tuition_status:    str | None = None
    last_payment_date: str | None = None
    next_due_date:     str | None = None
    payment_amount:    str | None = None

    if action == "mark_paid":
        tuition_status    = "Paid"
        last_payment_date = _fmt(today)
        # Retrieve current NextDueDate from GAS for safe advancement
        current_ndd_str: str | None = payload.get("currentNextDueDate")
        current_ndd = _parse_iso(current_ndd_str)
        if current_ndd and current_ndd >= today:
            # Advance from the existing future/today due date
            next_due_date = _fmt(_add_one_month(current_ndd))
        else:
            # Overdue or missing â€” advance from today
            next_due_date = _fmt(_add_one_month(today))
        # Optional: carry explicit PaymentAmount if provided
        if payload.get("paymentAmount") is not None:
            payment_amount = str(payload["paymentAmount"])

    elif action == "mark_unpaid":
        tuition_status    = "Unpaid"
        last_payment_date = ""   # clears the cell

    elif action == "extend_one_month":
        current_ndd_str = payload.get("currentNextDueDate")
        current_ndd = _parse_iso(current_ndd_str)
        if current_ndd and current_ndd >= today:
            next_due_date = _fmt(_add_one_month(current_ndd))
        else:
            next_due_date = _fmt(_add_one_month(today))

    elif action == "set_custom_due_date":
        raw = (payload.get("customDueDate") or "").strip()
        custom = _parse_iso(raw)
        if not custom:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid customDueDate '{raw}'. Must be YYYY-MM-DD.",
            )
        next_due_date = _fmt(custom)

    # Call GAS â€” surface any failure as 502
    try:
        gas_result = await _update_tuition_in_gas(
            clean_id=clean_id,
            tuition_status=tuition_status,
            last_payment_date=last_payment_date,
            next_due_date=next_due_date,
            payment_amount=payment_amount,
        )
    except RuntimeError as gas_err:
        log.error(
            "teacher_update_tuition: GAS error for student %s (%s): %s",
            student_id, clean_id, gas_err,
        )
        raise HTTPException(status_code=502, detail=str(gas_err))

    log.info(
        "teacher_update_tuition: %s action=%s clean_id=%s by %s",
        student_id, action, clean_id, admin.email,
    )
    return {
        "ok": True,
        "action": action,
        "clean_id": clean_id,
        "tuitionStatus":    tuition_status,
        "lastPaymentDate":  last_payment_date,
        "nextDueDate":      next_due_date,
        "paymentAmount":    payment_amount,
        "gas": gas_result,
    }


@api.delete("/teacher/students/{student_id}")
async def teacher_deactivate_student(
    student_id: str,
    admin: User = Depends(require_admin),
):
    """Soft deactivate. Never hard-deletes. ID is reusable for a new student."""
    doc = await db.students.find_one({"student_id": student_id}, {"_id": 0, "clean_id": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Student not found")

    result = await db.students.update_one(
        {"student_id": student_id},
        {"$set": {"is_active": False}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Student not found")
    await db.student_sessions.delete_many({"student_id": student_id})

    # Archive GAS evaluation rows â€” true fire-and-forget via create_task so the
    # 15-second GAS timeout NEVER blocks this endpoint.
    import asyncio as _asyncio_deact
    _asyncio_deact.create_task(_archive_student_in_gas(doc["clean_id"]))

    log.info("teacher: deactivated student %s by %s", student_id, admin.email)
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Startup indexes   ADD these four lines inside the existing startup()        #
# function body, immediately before the final log.info line.                  #
# --------------------------------------------------------------------------- #
#
#     # Student Auth v10.0 indexes
#     await db.students.create_index("clean_id", unique=True)
#     await db.students.create_index("student_id", unique=True)
#     await db.student_sessions.create_index("session_token", unique=True)
#     await db.student_sessions.create_index("expires_at")
#
# -- End Student Auth + Management v10.0 ------------------------------------ #
# Wire up                                                                     #
# --------------------------------------------------------------------------- #
from restriction_realtime import build_router as _build_status_router
@api.post("/studio/audio/migrate-inline")
async def studio_audio_migrate_inline(admin: User = Depends(require_admin)):
    """One-time migration: find all book blocks with inline base64 audio,
    upload to GridFS, replace block.text with the stream URL.
    Safe to run multiple times (idempotent).
    """
    fixed_books = 0
    fixed_blocks = 0
    cursor = db.books.find({}, {"_id": 0})
    async for book in cursor:
        changed = False
        now = datetime.now(timezone.utc).isoformat()
        for ch in book.get("chapters", []):
            for block in ch.get("blocks", []):
                txt = block.get("text", "")
                if not isinstance(txt, str): continue
                if not txt.startswith("data:audio/"): continue
                # Extract base64 payload
                try:
                    header, b64data = txt.split(",", 1)
                    audio_bytes = base64.b64decode(b64data)
                except Exception:
                    continue
                audio_id = str(uuid.uuid4())
                # FIX v9.9: wrap raw bytes in BytesIO (GridFS needs file-like)
                await audio_bucket.upload_from_stream(
                    f"{audio_id}.mp3", io.BytesIO(audio_bytes),
                    metadata={"slug": book.get("slug",""), "migrated_at": now},
                )
                block["text"] = f"{PUBLIC_BACKEND_URL}/api/studio/audio/{audio_id}.mp3"
                block["_audio_id"] = audio_id
                changed = True
                fixed_blocks += 1
        if changed:
            # Save as new revision
            latest = await db.books.find_one(
                {"slug": book["slug"]}, {"_id": 0, "revision": 1},
                sort=[("revision", -1)]
            )
            next_rev = int((latest or {}).get("revision") or 0) + 1
            doc = {**book, "revision": next_rev, "_authoredAt": now,
                   "_authoredBy": "migration"}
            doc.pop("_id", None)
            await db.books.insert_one(doc)
            fixed_books += 1
    log.info("audio-migration: fixed %s blocks in %s books", fixed_blocks, fixed_books)
    return {"ok": True, "fixed_books": fixed_books, "fixed_blocks": fixed_blocks}


# ─────────────────────────────────────────────────────────────────────────── #
# AI SCENE BUILDER — v1.0                                                     #
# POST /api/studio/books/{slug}/ai-scene                                      #
#                                                                             #
# Admin-only. Calls Gemini to generate a structured speaking-first scene.     #
# Returns preview blocks ONLY — does NOT modify the live book.                #
# The Author manually reviews and applies blocks via the Studio UI.           #
#                                                                             #
# ElevenLabs pipeline: completely untouched.                                  #
# MongoDB books collection: NOT mutated here.                                 #
# Students: cannot reach this endpoint (require_admin gate).                  #
# ─────────────────────────────────────────────────────────────────────────── #

@api.get("/studio/ai-scene-status")
async def studio_ai_scene_status(admin: User = Depends(require_admin)):
    """Check if AI Scene Builder is available (GEMINI_API_KEY is set).
    Safe to call on page load — returns {enabled: bool}.
    """
    return {
        "enabled": _gemini_enabled(),
        "model": GEMINI_MODEL if _gemini_enabled() else None,
    }


@api.post("/studio/books/{slug}/ai-scene")
async def studio_ai_scene_generate(
    slug: str,
    payload: dict,
    admin: User = Depends(require_admin),
):
    """Generate an AI scene preview using Gemini.

    Admin-only. Returns structured preview blocks.
    Does NOT save or modify the live book.
    The author must explicitly review and copy blocks into the Editor.

    Request payload:
        topic            str  — scene topic / context
        level            str  — "A1" | "A2" | "B1"
        style            str  — "Adventure"|"Funny"|"Mystery"|"Emotional"|"Classroom"
        includeKhmer     bool — include Khmer helper metadata (default: false)
        generateQuiz     bool — include MCQ block (default: true)
        generateVocab    bool — include vocabulary block (default: true)
        generateSpeaking bool — include speaking prompt block (default: true)

    Response:
        { success, sceneId, geminiRaw, previewBlocks, warnings, generatedAt }
    """
    if not _gemini_enabled():
        raise HTTPException(
            status_code=503,
            detail=(
                "AI Scene Builder is not configured. "
                "Add GEMINI_API_KEY to Render environment variables to enable it."
            ),
        )

    # ── Validate request params ─────────────────────────────────────────
    topic = str(payload.get("topic") or "").strip()
    if not topic:
        raise HTTPException(status_code=400, detail="topic is required.")

    level = str(payload.get("level") or "A2").strip().upper()
    if level not in ("A1", "A2", "B1"):
        level = "A2"

    style = str(payload.get("style") or "Adventure").strip().title()
    if style not in ("Adventure", "Funny", "Mystery", "Emotional", "Classroom"):
        style = "Adventure"

    include_khmer    = bool(payload.get("includeKhmer", False))
    generate_quiz    = bool(payload.get("generateQuiz", True))
    generate_vocab   = bool(payload.get("generateVocab", True))
    generate_speaking = bool(payload.get("generateSpeaking", True))

    log.info(
        "ai_scene: generating for slug=%s topic=%r level=%s style=%s admin=%s",
        slug, topic, level, style, admin.email,
    )

    # ── Call Gemini (isolated in gemini_engine.py) ──────────────────────
    scene_id = f"scene_{uuid.uuid4().hex[:12]}"
    now = datetime.now(timezone.utc).isoformat()

    try:
        gemini_data = await _gemini_generate_scene(
            topic=topic,
            level=level,
            style=style,
            include_khmer=include_khmer,
        )
    except RuntimeError as exc:
        log.error("ai_scene: Gemini runtime error: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        log.error("ai_scene: Gemini validation error: %s", exc)
        raise HTTPException(
            status_code=422,
            detail=f"AI returned invalid content after 2 attempts. Please retry. ({exc})",
        ) from exc
    except Exception as exc:
        log.exception("ai_scene: unexpected error calling Gemini")
        raise HTTPException(
            status_code=500,
            detail=f"AI Scene generation failed unexpectedly: {type(exc).__name__}",
        ) from exc

    # ── Convert Gemini output → EduHub-compatible preview blocks ────────
    # All blocks use EXISTING block types (paragraph, heading, quote, mcq).
    # Extra underscore-prefixed metadata is silently ignored by the reader.
    # This is PREVIEW ONLY — no book is modified here.

    warnings: list[str] = []
    preview_blocks: list[dict] = []

    # 1. Heading — scene title
    title_text = gemini_data.get("title", "").strip()
    if title_text:
        preview_blocks.append({
            "type": "heading",
            "text": title_text,
            "_aiGenerated": True,
            "_sceneId": scene_id,
            "_learningFocus": "speaking_fluency",
        })

    # 2. Paragraph — English story text (PRIMARY speaking content)
    english_text = gemini_data.get("englishText", "").strip()
    if english_text:
        para_block: dict = {
            "type": "paragraph",
            "text": english_text,
            "_aiGenerated": True,
            "_sceneId": scene_id,
            "_learningFocus": "speaking_fluency",
            "_level": level,
            "_style": style,
        }
        # Khmer is stored as HIDDEN metadata only — never a visible paragraph
        khmer_help = gemini_data.get("optionalKhmerHelp", "").strip()
        if khmer_help and include_khmer:
            para_block["_khmerHelp"] = khmer_help
        preview_blocks.append(para_block)
    else:
        warnings.append("Gemini did not return English story text.")

    # 3. Audio script placeholder (author generates real audio via ElevenLabs)
    audio_script = gemini_data.get("audioScript", "").strip()
    if audio_script:
        preview_blocks.append({
            "type": "paragraph",
            "text": f"[Audio script — use ElevenLabs to generate audio]\n{audio_script}",
            "_isAudioScriptPlaceholder": True,
            "_audioScript": audio_script,
            "_aiGenerated": True,
            "_sceneId": scene_id,
        })

    # 4. Speaking prompt — classroom interaction
    speaking_prompt = gemini_data.get("speakingPrompt", "").strip()
    if generate_speaking and speaking_prompt:
        preview_blocks.append({
            "type": "quote",
            "text": f"\U0001f3a4 Speaking Challenge: {speaking_prompt}",
            "_aiGenerated": True,
            "_sceneId": scene_id,
            "_learningFocus": "speaking_fluency",
            "_blockRole": "speaking_prompt",
        })

    # 5. Vocabulary list
    vocab_list = gemini_data.get("vocabulary", [])
    if generate_vocab and vocab_list:
        vocab_lines = []
        for item in vocab_list[:5]:
            word    = str(item.get("word",    "")).strip()
            meaning = str(item.get("meaning", "")).strip()
            if word and meaning:
                vocab_lines.append(f"\u2022 {word}: {meaning}")
        if vocab_lines:
            preview_blocks.append({
                "type": "paragraph",
                "text": "\U0001f4da Vocabulary\n" + "\n".join(vocab_lines),
                "_aiGenerated": True,
                "_sceneId": scene_id,
                "_blockRole": "vocabulary",
            })

    # 6. MCQ comprehension question
    cq = gemini_data.get("comprehensionQuestion", {})
    if generate_quiz and isinstance(cq, dict) and cq.get("question"):
        question      = str(cq.get("question", "")).strip()
        choices       = cq.get("choices", [])
        answer        = str(cq.get("answer", "")).strip()
        valid_choices = [str(c).strip() for c in choices if str(c).strip()]
        if question and len(valid_choices) >= 2 and answer:
            preview_blocks.append({
                "type": "mcq",
                "question": question,
                "choices": valid_choices,
                "answer": answer,
                "_aiGenerated": True,
                "_sceneId": scene_id,
                "_learningFocus": "comprehension",
            })
        else:
            warnings.append("Comprehension question was malformed and was skipped.")

    # 7. Image prompt note (author sources or generates image separately)
    image_prompt = gemini_data.get("imagePrompt", "").strip()
    if image_prompt:
        preview_blocks.append({
            "type": "paragraph",
            "text": f"[Image prompt — replace with an image block after sourcing]\n{image_prompt}",
            "_isImagePromptPlaceholder": True,
            "_imagePrompt": image_prompt,
            "_aiGenerated": True,
            "_sceneId": scene_id,
        })

    # ── Persist job record (audit trail — non-fatal if it fails) ────────
    try:
        await db.ai_scene_jobs.insert_one({
            "sceneId":       scene_id,
            "slug":          slug,
            "status":        "preview_ready",
            "adminEmail":    admin.email,
            "topic":         topic,
            "level":         level,
            "style":         style,
            "includeKhmer":  include_khmer,
            "geminiRaw":     gemini_data,
            "previewBlocks": preview_blocks,
            "warnings":      warnings,
            "createdAt":     now,
        })
    except Exception as exc:
        log.warning("ai_scene: job record insert failed (non-fatal): %s", exc)
        warnings.append("Job record could not be persisted (preview is still valid).")

    log.info(
        "ai_scene: preview_ready slug=%s sceneId=%s blocks=%d warnings=%d",
        slug, scene_id, len(preview_blocks), len(warnings),
    )

    return {
        "success":      True,
        "sceneId":      scene_id,
        "slug":         slug,
        "geminiRaw":    gemini_data,
        "previewBlocks": preview_blocks,
        "warnings":     warnings,
        "generatedAt":  now,
    }


@api.get("/studio/ai-scene/{scene_id}")
async def studio_ai_scene_get(
    scene_id: str,
    admin: User = Depends(require_admin),
):
    """Retrieve a previously generated AI scene preview by sceneId.
    Admin-only. Allows the Author to reload a generated scene.
    """
    doc = await db.ai_scene_jobs.find_one({"sceneId": scene_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail=f"AI scene '{scene_id}' not found.")
    return doc


app.include_router(_build_status_router(db, _fan_out_push, require_admin))
# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

# ─── Phase 1 Speaking Lab P2P-pool reliability helpers ────────────────
#
# These helpers replace the previous _sl_try_auto_enter() with a version
# that is tolerant of:
#
#   1. Mixed-case sender / treasury IDs            (STU004 == stu004)
#   2. Students missing from db.students            (PWA-only / GAS-only
#                                                    records still enter
#                                                    the pool with a
#                                                    fallback display
#                                                    name and a
#                                                    diagnostic event).
#   3. Fee mismatches                               (exact session match
#                                                    first; latest
#                                                    waiting/active pool
#                                                    session as fallback,
#                                                    diagnostic recorded).
#   4. Missing lucky codes on existing entries      (repair instead of
#                                                    silently returning).
#   5. Legacy entries inserted via manual /enter    (deduplicate by
#                                                    student_id first;
#                                                    fall back to
#                                                    display_name_key
#                                                    for legacy rows).
#
# Diagnostic events are written to db.speaking_lab_pool_events so admins
# can answer "why did/didn't stu004 appear in the pool?" via the new
# GET /api/speaking-lab/sessions/{id}/pool-diagnostics endpoint.
#
# The /api/push/notify-credit endpoint is unchanged in shape (same
# request body, same response, same audit row) — only the internal hook
# that schedules this task now uses the env-backed SL_TREASURY_ID and
# normalized comparisons.

def _norm_student_id(value) -> str:
    """Canonical student_id for comparisons.

    Strips whitespace (including stray \\n / \\r picked up from sheets),
    drops zero-width spaces, and lowercases. Returns "" for None / non-
    strings. Safe to call on every ID before any equality check or Mongo
    query.
    """
    if value is None:
        return ""
    s = str(value)
    # Strip ASCII + common Unicode whitespace and zero-width chars.
    for ch in ("\\u200b", "\\u200c", "\\u200d", "\\ufeff"):
        s = s.replace(ch, "")
    return s.strip().lower()


async def _sl_log_pool_event(
    session_id,
    student_id: str,
    amount: int,
    status: str,
    reason: str = "",
    source: str = "my_portal_p2p",
    display_name: str = "",
    extra=None,
) -> None:
    """Insert a structured diagnostic row into speaking_lab_pool_events.

    `status` is one of:
      "accepted" "repaired" "rejected" "warned" "duplicate"

    Never raises — diagnostics must never break the pool flow.
    """
    try:
        doc = {
            "session_id":   session_id,
            "student_id":   _norm_student_id(student_id),
            "raw_student_id": student_id,
            "display_name": display_name,
            "amount":       int(amount or 0),
            "status":       status,
            "reason":       reason,
            "source":       source,
            "created_at":   datetime.now(timezone.utc).isoformat(),
        }
        if extra and isinstance(extra, dict):
            doc.update({k: v for k, v in extra.items() if k not in doc})
        await db.speaking_lab_pool_events.insert_one(doc)
    except Exception as exc:  # noqa: BLE001
        log.warning("sl.pool.event log error: %s", str(exc)[:200])


async def _sl_find_target_session(amount: int, schedule: str):
    """Return (session_doc, fee_match_kind).

    fee_match_kind is one of:
      "exact_schedule" "exact_any_schedule"
      "fallback_schedule" "fallback_any" "none"

    1. Try exact entry_fee + schedule match.
    2. Try exact entry_fee match for any schedule.
    3. Fallback: latest waiting/active session for this schedule
       (regardless of entry_fee).
    4. Fallback: latest waiting/active session anywhere.
    """
    if schedule:
        sess = await SL_SESSIONS.find_one(
            {
                "schedule":  schedule,
                "entry_fee": amount,
                "status":    {"$in": ["waiting", "active"]},
            },
            sort=[("created_at", -1)],
        )
        if sess:
            return sess, "exact_schedule"
    sess = await SL_SESSIONS.find_one(
        {
            "entry_fee": amount,
            "status":    {"$in": ["waiting", "active"]},
        },
        sort=[("created_at", -1)],
    )
    if sess:
        return sess, "exact_any_schedule"
    if schedule:
        sess = await SL_SESSIONS.find_one(
            {
                "schedule": schedule,
                "status":   {"$in": ["waiting", "active"]},
            },
            sort=[("created_at", -1)],
        )
        if sess:
            return sess, "fallback_schedule"
    sess = await SL_SESSIONS.find_one(
        {"status": {"$in": ["waiting", "active"]}},
        sort=[("created_at", -1)],
    )
    if sess:
        return sess, "fallback_any"
    return None, "none"


async def _sl_try_auto_enter(
    sender_id: str,
    amount: int,
    *,
    source: str = "notify_credit",
) -> dict:
    """Robust auto-enter for a P2P pool entry.

    Always returns a dict so callers (or future endpoints) can inspect
    the result; never raises. The dict shape is:
      {
        "status": "accepted" | "repaired" | "rejected" | "duplicate"
                  | "warned",
        "reason": str,
        "session_id": str | None,
        "student_id": str | None,
        "display_name": str | None,
      }
    """
    norm_id = _norm_student_id(sender_id)
    if not norm_id:
        return {"status": "rejected", "reason": "empty_sender_id",
                "session_id": None, "student_id": None,
                "display_name": None}

    try:
        # 1. Look up sender in db.students (try multiple normalized fields).
        student_doc = await db.students.find_one(
            {"$or": [
                {"clean_id":   norm_id},
                {"student_id": norm_id},
                # Tolerate legacy uppercase / unstripped rows.
                {"clean_id":   sender_id.strip()},
                {"student_id": sender_id.strip()},
                {"clean_id":   sender_id.strip().upper()},
                {"student_id": sender_id.strip().upper()},
            ]},
            {"display_name": 1, "name": 1, "group": 1,
             "schedule": 1, "clean_id": 1, "_id": 0},
        )

        if student_doc:
            display_name = (
                student_doc.get("display_name")
                or student_doc.get("name")
                or norm_id
            )
            schedule = (
                student_doc.get("group")
                or student_doc.get("schedule")
                or ""
            ).upper()
            mongo_fallback = False
        else:
            # NEW: do not silently reject — the student exists in Google
            # Sheets / My Portal but not in db.students. Allow fallback
            # entry so paid players are never lost.
            display_name = norm_id
            schedule = ""
            mongo_fallback = True
            log.info("sl.pool.p2p.warning: %s not in db.students — using fallback", norm_id)

        # 2. Resolve the target session.
        session_doc, fee_match_kind = await _sl_find_target_session(amount, schedule)
        if not session_doc:
            await _sl_log_pool_event(
                None, norm_id, amount, "rejected",
                reason="no_active_session",
                source=source, display_name=display_name,
                extra={"schedule_hint": schedule,
                       "mongo_fallback": mongo_fallback},
            )
            log.info(
                "sl.pool.p2p.rejected: no_active_session sender=%s amount=%d schedule=%s",
                norm_id, amount, schedule,
            )
            return {"status": "rejected", "reason": "no_active_session",
                    "session_id": None, "student_id": norm_id,
                    "display_name": display_name}

        session_id = session_doc["session_id"]
        session_entry_fee = int(session_doc.get("entry_fee") or 0)
        warnings: list[str] = []
        if mongo_fallback:
            warnings.append(
                "student_not_found_in_mongo_but_entry_created_with_fallback"
            )
        if fee_match_kind not in ("exact_schedule", "exact_any_schedule"):
            warnings.append(
                f"fee_mismatch_or_no_exact_session_fee:paid={amount},session_fee={session_entry_fee}"
            )

        # 3. Dedup — student_id FIRST, then legacy display_name_key.
        norm_dn_key = (display_name or norm_id).lower()
        existing = await SL_ENTRIES.find_one(
            {"session_id": session_id, "student_id": norm_id},
            {"_id": 0},
        )
        legacy_match = False
        if not existing:
            legacy = await SL_ENTRIES.find_one(
                {"session_id": session_id,
                 "display_name_key": norm_dn_key,
                 "$or": [
                     {"student_id": {"$exists": False}},
                     {"student_id": None},
                     {"student_id": ""},
                     # Manual /enter inserts a synthetic "sl-<hex>" id —
                     # treat that as a legacy row that can be linked to
                     # the real student.
                     {"student_id": {"$regex": "^sl-"}},
                 ]},
                {"_id": 0},
            )
            if legacy:
                legacy_match = True
                # Link the legacy row to the real student so future
                # lookups dedup correctly. Lucky-code repair follows.
                try:
                    await SL_ENTRIES.update_one(
                        {"session_id": session_id,
                         "display_name_key": norm_dn_key},
                        {"$set": {"student_id": norm_id,
                                  "display_name": display_name,
                                  "linked_from_legacy_at":
                                      datetime.now(timezone.utc).isoformat()}},
                    )
                except Exception as exc:  # noqa: BLE001
                    log.warning("sl.pool.legacy link error: %s", str(exc)[:200])
                existing = await SL_ENTRIES.find_one(
                    {"session_id": session_id, "student_id": norm_id},
                    {"_id": 0},
                ) or legacy

        if existing:
            # Repair: ensure this student has a lucky code. If missing,
            # generate one now and broadcast — this fixes the original
            # bug where students paid but never appeared on the draw UI.
            lucky_doc = await db.speaking_lab_lucky_codes.find_one(
                {"session_id": session_id, "student_id": norm_id},
                {"_id": 0, "code": 1},
            )
            if not lucky_doc or not lucky_doc.get("code"):
                # Use the session fee if the paid amount was off so the
                # pool total stays consistent with the session config.
                code_amount = (
                    amount
                    if fee_match_kind in ("exact_schedule", "exact_any_schedule")
                    else (session_entry_fee or amount)
                )
                await generate_and_publish_lucky_code(
                    db, _sl_publish, session_id, norm_id, display_name,
                    amount=code_amount, log=log,
                )
                await _sl_log_pool_event(
                    session_id, norm_id, amount, "repaired",
                    reason="missing_lucky_code_repaired" + (
                        " | legacy_linked" if legacy_match else ""
                    ),
                    source=source, display_name=display_name,
                    extra={"warnings": warnings,
                           "fee_match_kind": fee_match_kind,
                           "mongo_fallback": mongo_fallback},
                )
                log.info("sl.pool.p2p.repaired: %s lucky_code generated session=%s",
                         norm_id, session_id)
                return {"status": "repaired",
                        "reason": "missing_lucky_code_repaired",
                        "session_id": session_id,
                        "student_id": norm_id,
                        "display_name": display_name}
            await _sl_log_pool_event(
                session_id, norm_id, amount, "duplicate",
                reason="already_in_pool",
                source=source, display_name=display_name,
                extra={"warnings": warnings,
                       "fee_match_kind": fee_match_kind},
            )
            log.info("sl.pool.p2p.duplicate: %s already in session %s",
                     norm_id, session_id)
            return {"status": "duplicate", "reason": "already_in_pool",
                    "session_id": session_id, "student_id": norm_id,
                    "display_name": display_name}

        # 4. Fresh insert + publish + lucky code.
        position = (
            await SL_ENTRIES.count_documents({"session_id": session_id})
        ) + 1
        entered_at = datetime.now(timezone.utc).isoformat()
        entry_doc = {
            "session_id":       session_id,
            "student_id":       norm_id,
            "display_name":     display_name,
            "display_name_key": norm_dn_key,
            "position":         position,
            "entered_at":       entered_at,
            "source":           source,
        }
        if mongo_fallback:
            entry_doc["mongo_fallback"] = True
        try:
            await SL_ENTRIES.insert_one(entry_doc)
        except Exception as exc:  # noqa: BLE001
            # Race / unique-index collision on (session_id,
            # display_name_key). Fetch what is now there and treat as a
            # duplicate insert; lucky-code path still runs below to
            # ensure repair.
            if "duplicate" in str(exc).lower() or "E11000" in str(exc):
                existing = await SL_ENTRIES.find_one(
                    {"session_id": session_id,
                     "display_name_key": norm_dn_key},
                    {"_id": 0},
                )
                await _sl_log_pool_event(
                    session_id, norm_id, amount, "duplicate",
                    reason="unique_index_race",
                    source=source, display_name=display_name,
                    extra={"warnings": warnings},
                )
            else:
                await _sl_log_pool_event(
                    session_id, norm_id, amount, "rejected",
                    reason=f"insert_error:{str(exc)[:120]}",
                    source=source, display_name=display_name,
                )
                log.warning("sl.pool.p2p.rejected insert_error: %s",
                            str(exc)[:200])
                return {"status": "rejected",
                        "reason": "insert_error",
                        "session_id": session_id,
                        "student_id": norm_id,
                        "display_name": display_name}

        await _sl_publish(session_id, {
            "type":         "entry",
            "student_id":   norm_id,
            "display_name": display_name,
            "position":     position,
            "entered_at":   entered_at,
        })

        # Lucky code (same P2P payment that put the student on the roster
        # also buys their lucky code). Idempotent in lucky_draw.py.
        code_amount = (
            amount
            if fee_match_kind in ("exact_schedule", "exact_any_schedule")
            else (session_entry_fee or amount)
        )
        await generate_and_publish_lucky_code(
            db, _sl_publish, session_id, norm_id, display_name,
            amount=code_amount, log=log,
        )

        await _sl_log_pool_event(
            session_id, norm_id, amount,
            "warned" if warnings else "accepted",
            reason=" | ".join(warnings) if warnings else "ok",
            source=source, display_name=display_name,
            extra={"position": position,
                   "fee_match_kind": fee_match_kind,
                   "mongo_fallback": mongo_fallback,
                   "session_entry_fee": session_entry_fee},
        )
        log.info(
            "sl.pool.p2p.accepted: %s (pos=%d) entered session %s paid=%d fee=%d kind=%s",
            display_name, position, session_id, amount,
            session_entry_fee, fee_match_kind,
        )
        return {"status": "warned" if warnings else "accepted",
                "reason": " | ".join(warnings) or "ok",
                "session_id": session_id,
                "student_id": norm_id,
                "display_name": display_name}
    except Exception as exc:  # noqa: BLE001
        log.warning("sl.pool.p2p.error: %s", str(exc)[:300])
        try:
            await _sl_log_pool_event(
                None, sender_id, amount, "rejected",
                reason=f"unhandled_exception:{type(exc).__name__}:{str(exc)[:120]}",
                source=source,
            )
        except Exception:  # noqa: BLE001
            pass
        return {"status": "rejected",
                "reason": f"unhandled_exception:{type(exc).__name__}",
                "session_id": None,
                "student_id": _norm_student_id(sender_id),
                "display_name": None}

# SPEAKING LAB â€” Live session, SSE roster, points grant
# Added safely â€” no existing function modified.
# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

# Collection aliases
SL_SESSIONS = db.speaking_lab_sessions
SL_ENTRIES  = db.speaking_lab_entries

# â”€â”€ Pydantic models â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

class SLSessionCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    schedule: str
    entry_fee: int = 0

class SLEnterRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    session_code: str
    student_name: str

class SLPointsGrant(BaseModel):
    model_config = ConfigDict(extra="ignore")
    studentID: str
    points: int
    source: str | None = "speaking-lab"
    description: str | None = ""

class SLAttendancePayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    schedule: str
    date: str
    present: list[str]

# â”€â”€ SSE pub/sub (in-process, single Render instance) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

_sl_subs: dict[str, set[asyncio.Queue]] = {}
_sl_lock = asyncio.Lock()

async def _sl_publish(session_id: str, event: dict) -> None:
    async with _sl_lock:
        queues = list(_sl_subs.get(session_id, set()))
    for q in queues:
        try:
            q.put_nowait(event)
        except Exception:
            pass

def _sl_sse(event: dict) -> bytes:
    return ("data: " + json.dumps(event) + chr(10) + chr(10)).encode()

# â”€â”€ Points grant â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@api.post("/points/grant")
async def sl_grant_points(
    payload: SLPointsGrant,
    admin: User = Depends(require_admin),
):
    """Grant points from treasury (stu092) to student via GAS P2P.
    Appears in student P2P statement as sent from treasury wallet.
    """
    if not 1 <= payload.points <= 1000:
        raise HTTPException(status_code=400, detail="points out of range")

    if not SL_TREASURY_PASSWORD:
        raise HTTPException(
            status_code=503,
            detail="SL_TREASURY_PASSWORD not set on Render â€” add it in Environment settings.",
        )

    # 1. Resolve student clean_id (push subscriptions use clean_id)
    stu_doc = await db.students.find_one(
        {"$or": [{"student_id": payload.studentID}, {"clean_id": payload.studentID}]},
        {"clean_id": 1, "display_name": 1, "_id": 0},
    )
    student_clean_id = (stu_doc or {}).get("clean_id") or payload.studentID

    # 2. Call GAS sendPoints â€” treasury â†’ student (real balance transfer)
    nonce = secrets.token_hex(12)
    gas_payload = {
        "action":     "sendPoints",
        "id":         SL_TREASURY_ID,
        "password":   SL_TREASURY_PASSWORD,
        "receiverId": student_clean_id,
        "amount":     str(payload.points),
        "nonce":      nonce,
    }
    gas_ok = False
    gas_error = "unknown"
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(12.0, connect=6.0),
            follow_redirects=True,
        ) as cli:
            r = await cli.post(
                GAS_POINTS_LOGIN_URL,
                data=gas_payload,
            )
            if r.status_code == 200:
                try:
                    j = r.json()
                    if isinstance(j, dict) and j.get("success") is True:
                        gas_ok = True
                    else:
                        gas_error = str(j.get("message") or j.get("error") or j)[:200]
                except Exception:
                    gas_error = r.text[:200]
            else:
                gas_error = f"HTTP {r.status_code}"
    except Exception as exc:
        gas_error = str(exc)[:200]

    if not gas_ok:
        log.warning("sl.grant: GAS transfer failed: %s", gas_error)
        raise HTTPException(
            status_code=502,
            detail=f"Points transfer failed: {gas_error}",
        )

    # 3. Audit row in MongoDB points_history
    now_str = datetime.now(timezone.utc).isoformat()
    await db.points_history.insert_one({
        "student_id":         student_clean_id,
        "from":               SL_TREASURY_ID,
        "to":                 student_clean_id,
        "delta":              payload.points,
        "source":             "speaking-lab-award",
        "description":        payload.description or "Speaking Lab award",
        "granted_by":         admin.email,
        "created_at":         now_str,
        "senderStudentId":    SL_TREASURY_ID,
        "recipientStudentId": student_clean_id,
        "amount":             payload.points,
        "display_sender":     "Treasury",
    })

    # 4. Push notification to student device.
    #
    # FIX (Phase 3): push subscriptions may have been saved under the raw
    # student_id at signup time (e.g. "STU004") or under the canonical
    # clean_id ("stu004"). Match against BOTH so a paid student always
    # gets a phone notification regardless of how their device first
    # subscribed. Never raises — push is best-effort.
    push_candidates: list[str] = []
    for _c in (
        student_clean_id,
        _norm_student_id(student_clean_id),
        _norm_student_id(payload.studentID),
        payload.studentID,
    ):
        if _c and _c not in push_candidates:
            push_candidates.append(_c)
    asyncio.create_task(
        _fan_out_push(
            {"studentId": {"$in": push_candidates}},
            title=f"🎉 +{payload.points} ពិន្ទុបានបន្ថែម! / Points Credited!",
            body=(
                f"អ្នកទទួលបាន +{payload.points} ពិន្ទុ ✨\n"
                f"+{payload.points} pts from Treasury · {payload.description or 'Speaking Lab award'}"
            ),
            url="/portal",
        )
    )

    log.info(
        "sl.grant: treasury=%s sent %d pts to %s via GAS, by=%s",
        SL_TREASURY_ID, payload.points, student_clean_id, admin.email,
    )
    return {
        "success":    True,
        "studentID":  payload.studentID,
        "clean_id":   student_clean_id,
        "points":     payload.points,
        "via":        "GAS_treasury",
    }


@api.get("/speaking-lab/questions")
async def sl_get_questions(admin: User = Depends(require_admin)):
    doc = await db.speaking_lab_settings.find_one({"_id": "questions"}, {"_id": 0})
    return doc or {"beginner": [], "intermediate": []}

@api.put("/speaking-lab/questions")
async def sl_save_questions(payload: dict, admin: User = Depends(require_admin)):
    data = {k: v for k, v in payload.items() if k != "_id"}
    await db.speaking_lab_settings.replace_one(
        {"_id": "questions"},
        {"_id": "questions", **data},
        upsert=True,
    )
    return {"ok": True, **data}

@api.delete("/speaking-lab/questions")
async def sl_delete_questions(admin: User = Depends(require_admin)):
    await db.speaking_lab_settings.delete_one({"_id": "questions"})
    return {"ok": True, "reset": True}

# â”€â”€ Settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@api.get("/speaking-lab/settings")
async def sl_get_settings(admin: User = Depends(require_admin)):
    doc = await db.speaking_lab_settings.find_one({"_id": "settings"}, {"_id": 0})
    return doc or {}

@api.put("/speaking-lab/settings")
async def sl_save_settings(payload: dict, admin: User = Depends(require_admin)):
    data = {k: v for k, v in payload.items() if k != "_id"}
    await db.speaking_lab_settings.replace_one(
        {"_id": "settings"},
        {"_id": "settings", **data},
        upsert=True,
    )
    return {"ok": True, **data}

# â”€â”€ Attendance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@api.get("/speaking-lab/attendance")
async def sl_get_attendance(
    schedule: str, date: str,
    admin: User = Depends(require_admin),
):
    doc = await db.speaking_lab_attendance.find_one(
        {"schedule": schedule, "date": date}, {"_id": 0}
    )
    if not doc:
        raise HTTPException(status_code=404, detail="No attendance for that day")
    return doc

@api.put("/speaking-lab/attendance")
async def sl_save_attendance(
    payload: SLAttendancePayload,
    admin: User = Depends(require_admin),
):
    await db.speaking_lab_attendance.replace_one(
        {"schedule": payload.schedule, "date": payload.date},
        {
            "schedule":   payload.schedule,
            "date":       payload.date,
            "present":    list(payload.present),
            "saved_by":   admin.email,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
        upsert=True,
    )
    return {"ok": True}

# â”€â”€ Live sessions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@api.post("/speaking-lab/sessions")
async def sl_create_session(
    payload: SLSessionCreate,
    admin: User = Depends(require_admin),
):
    if not 0 <= payload.entry_fee <= 500:
        raise HTTPException(status_code=400, detail="entry_fee out of range")
    session_id = f"sl_{int(datetime.now(timezone.utc).timestamp() * 1000)}"
    await SL_SESSIONS.insert_one({
        "session_id": session_id,
        "schedule":   payload.schedule,
        "entry_fee":  payload.entry_fee,
        "treasury_id":"stu092",
        "status":     "waiting",
        "created_by": admin.email,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    log.info("sl.session.create: %s schedule=%s fee=%s", session_id, payload.schedule, payload.entry_fee)
    return {"session_id": session_id, "schedule": payload.schedule, "entry_fee": payload.entry_fee}

@api.post("/speaking-lab/sessions/{session_id}/enter")
async def sl_enter_session(session_id: str, body: SLEnterRequest):
    sess = await SL_SESSIONS.find_one({"session_id": session_id})
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    display_name = (body.student_name or "").strip()
    if not display_name:
        raise HTTPException(status_code=422, detail="student_name is required")
    display_name_key = display_name.lower()
    existing = await SL_ENTRIES.find_one(
        {"session_id": session_id, "display_name_key": display_name_key},
        {"_id": 0},
    )
    if existing:
        return {"ok": True, "position": existing.get("position", 0),
                "display_name": display_name, "deduplicated": True}
    position   = (await SL_ENTRIES.count_documents({"session_id": session_id})) + 1
    entered_at = datetime.now(timezone.utc).isoformat()
    student_id = f"sl-{uuid.uuid4().hex[:12]}"
    await SL_ENTRIES.insert_one({
        "session_id":       session_id,
        "student_id":       student_id,
        "display_name":     display_name,
        "display_name_key": display_name_key,
        "position":         position,
        "entered_at":       entered_at,
    })
    await _sl_publish(session_id, {
        "type":         "entry",
        "student_id":   student_id,
        "display_name": display_name,
        "position":     position,
        "entered_at":   entered_at,
    })
    log.info("sl.session.enter: %s pos=%s name=%s", session_id, position, display_name)
    return {
        "ok": True, "session_id": session_id, "student_id": student_id,
        "display_name": display_name, "position": position,
        "entered_at": entered_at, "deduplicated": False,
    }

@api.get("/speaking-lab/sessions/{session_id}/stream")
async def sl_stream_session(
    session_id: str,
    admin: User = Depends(require_admin),
):
    sess = await SL_SESSIONS.find_one({"session_id": session_id})
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    queue: asyncio.Queue = asyncio.Queue(maxsize=256)
    async with _sl_lock:
        _sl_subs.setdefault(session_id, set()).add(queue)

    async def gen():
        try:
            async for row in SL_ENTRIES.find(
                {"session_id": session_id}, {"_id": 0}
            ).sort("position", 1):
                yield _sl_sse({"type": "entry", **row})
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=20.0)
                    yield _sl_sse(event)
                except asyncio.TimeoutError:
                    yield b': ping\n\n'
        finally:
            async with _sl_lock:
                subs = _sl_subs.get(session_id)
                if subs:
                    subs.discard(queue)
                    if not subs:
                        _sl_subs.pop(session_id, None)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":     "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection":        "keep-alive",
        },
    )

# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
# END SPEAKING LAB

# ─── Phase 1 Speaking Lab P2P-pool diagnostics + backend-ready confirm ─
#
# Both endpoints are admin-only. They are additive and DO NOT change any
# existing endpoint's request/response shape. The original PWA frontend
# is unchanged in this patch — these are operator/admin tools and a
# backend-ready confirmation endpoint that a future patch can wire up
# from the PWA without further backend work.

class SLP2PPoolConfirmPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    sender_student_id: str = Field(..., min_length=1, max_length=64)
    recipient_student_id: str = Field(..., min_length=1, max_length=64)
    amount: int = Field(..., ge=1, le=100000)
    transfer_id: str | None = None


@api.post("/speaking-lab/p2p-pool/confirm")
async def sl_p2p_pool_confirm(
    payload: SLP2PPoolConfirmPayload,
    admin: User = Depends(require_admin),
):
    """Backend-ready endpoint to register a confirmed P2P transfer to the
    Speaking Lab treasury as a pool entry. ADMIN-ONLY."""
    recip_norm = _norm_student_id(payload.recipient_student_id)
    treasury_norm = _norm_student_id(SL_TREASURY_ID)
    if recip_norm != treasury_norm:
        await _sl_log_pool_event(
            None, payload.sender_student_id, payload.amount, "rejected",
            reason="rejected_wrong_recipient",
            source="manual_confirm",
            extra={"recipient": recip_norm, "treasury": treasury_norm,
                   "by": admin.email,
                   "transfer_id": payload.transfer_id or ""},
        )
        return {"ok": False, "status": "rejected",
                "reason": "rejected_wrong_recipient",
                "recipient": recip_norm,
                "treasury": treasury_norm}

    result = await _sl_try_auto_enter(
        payload.sender_student_id, payload.amount,
        source="manual_confirm",
    )
    return {"ok": result.get("status") in ("accepted", "warned",
                                          "repaired", "duplicate"),
            **result}


@api.get("/speaking-lab/sessions/{session_id}/pool-diagnostics")
async def sl_pool_diagnostics(
    session_id: str,
    admin: User = Depends(require_admin),
    limit: int = 200,
):
    """Return accepted/warned/repaired/rejected/duplicate events for this
    session + roster entries missing a lucky code. ADMIN-ONLY."""
    sess = await SL_SESSIONS.find_one({"session_id": session_id})
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")

    limit = max(1, min(int(limit or 200), 1000))
    events: list[dict] = []
    try:
        cursor = db.speaking_lab_pool_events.find(
            {"session_id": session_id}, {"_id": 0},
        ).sort("created_at", -1).limit(limit)
        async for row in cursor:
            events.append(row)
    except Exception as exc:  # noqa: BLE001
        log.warning("sl.pool.diagnostics events read error: %s", str(exc)[:200])

    missing_lucky_codes: list[dict] = []
    try:
        entry_ids: list[str] = []
        async for r in SL_ENTRIES.find(
            {"session_id": session_id}, {"_id": 0, "student_id": 1,
                                          "display_name": 1},
        ):
            sid = _norm_student_id(r.get("student_id"))
            if sid and not sid.startswith("sl-"):
                entry_ids.append(sid)
        if entry_ids:
            have_codes: set[str] = set()
            async for r in db.speaking_lab_lucky_codes.find(
                {"session_id": session_id,
                 "student_id": {"$in": entry_ids}},
                {"_id": 0, "student_id": 1},
            ):
                sid = _norm_student_id(r.get("student_id"))
                if sid:
                    have_codes.add(sid)
            for sid in entry_ids:
                if sid not in have_codes:
                    missing_lucky_codes.append({"student_id": sid})
    except Exception as exc:  # noqa: BLE001
        log.warning("sl.pool.diagnostics missing-codes error: %s",
                    str(exc)[:200])

    buckets: dict[str, list[dict]] = {
        "accepted": [], "warned": [], "repaired": [],
        "rejected": [], "duplicate": [],
    }
    for ev in events:
        buckets.setdefault(ev.get("status") or "other", []).append(ev)

    return {
        "success":              True,
        "session_id":           session_id,
        "accepted_entries":     buckets.get("accepted", []),
        "warned_events":        buckets.get("warned", []),
        "repaired_events":      buckets.get("repaired", []),
        "rejected_events":      buckets.get("rejected", []),
        "duplicate_events":     buckets.get("duplicate", []),
        "missing_lucky_codes":  missing_lucky_codes,
        "event_count":          len(events),
        "treasury_id":          _norm_student_id(SL_TREASURY_ID),
    }


# ── LUCKY DRAW SURGERY ────────────────────────────────────────────────
async def _lucky_draw_push_notify(student_id: str, amount: int, code: str) -> None:
    """Phase 3: send a Web Push to a Lucky Draw winner regardless of how
    their device originally subscribed (raw id vs clean_id, vs case).
    Never raises — push is best-effort, the GAS transfer is the truth."""
    norm = _norm_student_id(student_id)
    candidates: list[str] = []
    for c in (student_id, norm, norm.upper()):
        if c and c not in candidates:
            candidates.append(c)
    try:
        await _fan_out_push(
            {"studentId": {"$in": candidates}},
            title=f"🎰 +{amount} Lucky Draw Winner!",
            body=(
                f"អ្នកឈ្នះ +{amount} ពិន្ទុពី Speaking Lab Lucky Draw! ✨\n"
                f"You won +{amount} pts from the Speaking Lab pool · ticket {code}"
            ),
            url="/portal",
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("lucky_draw push notify error: %s", str(exc)[:200])


register_lucky_draw_routes(
    api, db, _sl_publish,
    gas_url=GAS_POINTS_LOGIN_URL,
    treasury_id=SL_TREASURY_ID,
    treasury_password=SL_TREASURY_PASSWORD,
    log=log,
    require_admin=require_admin,
    push_notify=_lucky_draw_push_notify,
)
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    # Explicit header list required when allow_credentials=True.
    # Safari iOS (WebKit) rejects allow_headers=["*"] with credentials,
    # causing POST /api/auth/google to fail on iPhone even though it works
    # on desktop Chrome (which is lenient about the wildcard).
    allow_headers=[
        "Content-Type",
        "Authorization",
        "X-Session-ID",
        "X-Cron-Secret",
        "Cookie",
        "Accept",
        "Origin",
        "X-Requested-With",
    ],
)



# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

@app.on_event("startup")
async def startup():
    global audio_bucket
    audio_bucket = AsyncIOMotorGridFSBucket(db, bucket_name="studio_audio")
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
    # Student Auth v10.0 indexes
    await db.students.create_index("clean_id", unique=True)
    await db.students.create_index("student_id", unique=True)
    await db.student_sessions.create_index("session_token", unique=True)
    await db.student_sessions.create_index("expires_at")
        # Speaking Lab indexes
    await db.points_history.create_index([("student_id", 1), ("created_at", -1)])
    await db.speaking_lab_sessions.create_index("session_id", unique=True)
    await db.speaking_lab_entries.create_index([("session_id", 1), ("display_name_key", 1)], unique=True)
    # Phase 1: per-student dedup for P2P pool entries — additive, non-unique.
    await db.speaking_lab_entries.create_index([("session_id", 1), ("student_id", 1)])
    # Phase 1: diagnostic events log for the new pool-diagnostics endpoint.
    await db.speaking_lab_pool_events.create_index([("session_id", 1), ("created_at", -1)])
    await db.speaking_lab_pool_events.create_index([("student_id", 1), ("created_at", -1)])
    await db.speaking_lab_settings.create_index("_id")
    await db.speaking_lab_attendance.create_index([("schedule", 1), ("date", 1)], unique=True)
    # â”€â”€ LUCKY DRAW SURGERY â”€â”€
    await ensure_lucky_draw_indexes(db)
    # â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    # Coupon system indexes
    await db.coupons.create_index("code", unique=True)
    await db.coupons.create_index("enabled")
    await db.coupons.create_index("expires_at")
    await db.payment_intents.create_index([("student_id", 1), ("status", 1), ("created_at", -1)])
    await db.payment_transactions.create_index([("transaction_id", 1), ("apv", 1)], unique=True)
    await db.payment_transactions.create_index([("status", 1), ("created_at", -1)])
    await db.payment_transactions.create_index("matched_student_id")
    await db.payment_settings.create_index([("amount_khr", 1), ("active", 1)])
    await db.payment_audit_log.create_index([("txn_id", 1), ("at", -1)])
    # AI Scene Builder indexes
    await db.ai_scene_jobs.create_index("sceneId", unique=True)
    await db.ai_scene_jobs.create_index([("slug", 1), ("createdAt", -1)])
    await db.ai_scene_jobs.create_index("adminEmail")
    log.info("startup: indexes ready | admin emails=%s",
             "ANY" if not ADMIN_EMAILS else ",".join(ADMIN_EMAILS))



    # ─────────────────────────────────────────────────────────
    # Phase 1 GAS→Mongo migration preflight startup
    # Creates wallet indexes and detects Mongo transaction support.
    # Failure is non-fatal and must not affect live student flows.
    # ─────────────────────────────────────────────────────────
    if _WALLET_SERVICE_AVAILABLE and wallet_service is not None:
        try:
            await wallet_service.ensure_wallet_indexes(db)
            await wallet_service.detect_transaction_support(db)
        except Exception as _wallet_startup_error:
            logging.getLogger(__name__).warning(
                "migration preflight startup skipped/failed: %s",
                _wallet_startup_error,
            )

@app.on_event("shutdown")
async def shutdown():
    client.close()


# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
# COUPON SYSTEM â€” v1.0 (append-only, zero existing routes modified)
# Collections: coupons
# Endpoints: POST/GET/PATCH/DELETE /api/coupons  (admin)
#            POST /api/coupons/validate           (student)
#            POST /api/coupons/redeem             (student)
# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

import secrets as _secrets_coupon
import string  as _string_coupon


def _generate_coupon_code(length: int = 8) -> str:
    """Generate a random uppercase alphanumeric coupon code."""
    alphabet = _string_coupon.ascii_uppercase + _string_coupon.digits
    return "".join(_secrets_coupon.choice(alphabet) for _ in range(length))


def _calc_discount(original_price: int, coupon: dict) -> int:
    """Return the discounted price (never below 0)."""
    if coupon.get("type") == "percent":
        discount = round(original_price * coupon.get("value", 0) / 100)
    else:  # fixed
        discount = int(coupon.get("value", 0))
    return max(0, original_price - discount)


async def _find_valid_coupon(
    code: str,
    student_id: str,
    book_slug: str,
) -> dict | None:
    """
    Look up a coupon by code and verify all constraints.
    Returns the coupon doc on success, raises HTTPException on failure.
    """
    doc = await db.coupons.find_one({"code": code.strip().upper()}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Coupon code not found.")
    if not doc.get("enabled", True):
        raise HTTPException(status_code=400, detail="This coupon has been disabled.")
    now_iso = datetime.now(timezone.utc)
    valid_from = doc.get("valid_from")
    expires_at = doc.get("expires_at")
    if valid_from:
        vf = datetime.fromisoformat(valid_from) if isinstance(valid_from, str) else valid_from
        if vf.tzinfo is None:
            vf = vf.replace(tzinfo=timezone.utc)
        if now_iso < vf:
            raise HTTPException(status_code=400, detail="This coupon is not yet active.")
    if expires_at:
        ex = datetime.fromisoformat(expires_at) if isinstance(expires_at, str) else expires_at
        if ex.tzinfo is None:
            ex = ex.replace(tzinfo=timezone.utc)
        if now_iso > ex:
            raise HTTPException(status_code=400, detail="This coupon has expired.")
    max_uses = doc.get("max_uses")
    if max_uses is not None and doc.get("uses_count", 0) >= max_uses:
        raise HTTPException(status_code=400, detail="This coupon has reached its usage limit.")
    assigned_to = doc.get("assigned_to") or []
    if assigned_to and student_id not in assigned_to:
        raise HTTPException(status_code=403, detail="This coupon is not assigned to your account.")
    book_slugs = doc.get("book_slugs") or []
    if book_slugs and book_slug not in book_slugs:
        raise HTTPException(status_code=400, detail="This coupon cannot be used for this book.")
    # Check if student already redeemed this coupon for this book
    already = any(
        r.get("student_id") == student_id and r.get("book_slug") == book_slug
        for r in (doc.get("redemptions") or [])
    )
    if already:
        raise HTTPException(status_code=400, detail="You have already used this coupon for this book.")
    return doc


# â”€â”€ Admin endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@api.post("/coupons")
async def create_coupon(payload: dict, admin: User = Depends(require_admin)):
    """Create a new coupon. Set code='' to auto-generate."""
    code = (payload.get("code") or "").strip().upper() or _generate_coupon_code()
    if await db.coupons.find_one({"code": code}):
        raise HTTPException(status_code=409, detail=f"Coupon code '{code}' already exists.")
    discount_type = payload.get("type", "percent")
    if discount_type not in ("percent", "fixed"):
        raise HTTPException(status_code=400, detail="type must be 'percent' or 'fixed'.")
    value = float(payload.get("value", 0))
    if value <= 0:
        raise HTTPException(status_code=400, detail="value must be > 0.")
    if discount_type == "percent" and value > 100:
        raise HTTPException(status_code=400, detail="Percent discount cannot exceed 100.")
    now_iso = datetime.now(timezone.utc).isoformat()
    doc = {
        "code":        code,
        "type":        discount_type,
        "value":       value,
        "max_uses":    payload.get("max_uses"),           # None = unlimited
        "uses_count":  0,
        "assigned_to": payload.get("assigned_to") or [],  # [] = public
        "book_slugs":  payload.get("book_slugs") or [],   # [] = all books
        "valid_from":  payload.get("valid_from") or now_iso,
        "expires_at":  payload.get("expires_at"),         # None = never
        "enabled":     True,
        "created_by":  admin.email,
        "created_at":  now_iso,
        "redemptions": [],
    }
    await db.coupons.insert_one(doc)
    doc.pop("_id", None)
    log.info("coupon: created %s by %s", code, admin.email)
    return {"ok": True, "coupon": doc}


@api.get("/coupons")
async def list_coupons(admin: User = Depends(require_admin)):
    """List all coupons (admin only)."""
    cursor = db.coupons.find({}, {"_id": 0}).sort("created_at", -1)
    coupons = await cursor.to_list(length=500)
    return {"ok": True, "coupons": coupons}


@api.get("/coupons/{code}")
async def get_coupon(code: str, admin: User = Depends(require_admin)):
    doc = await db.coupons.find_one({"code": code.upper()}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Coupon not found.")
    return {"ok": True, "coupon": doc}


@api.patch("/coupons/{code}")
async def update_coupon(code: str, payload: dict, admin: User = Depends(require_admin)):
    """Update coupon fields. Supports: enabled, expires_at, max_uses, assigned_to, book_slugs, value."""
    allowed = {"enabled", "expires_at", "max_uses", "assigned_to", "book_slugs", "value", "valid_from"}
    updates = {k: v for k, v in payload.items() if k in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields to update.")
    res = await db.coupons.update_one({"code": code.upper()}, {"$set": updates})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Coupon not found.")
    log.info("coupon: updated %s by %s", code, admin.email)
    return {"ok": True}


@api.delete("/coupons/{code}")
async def delete_coupon(code: str, admin: User = Depends(require_admin)):
    res = await db.coupons.delete_one({"code": code.upper()})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Coupon not found.")
    log.info("coupon: deleted %s by %s", code, admin.email)
    return {"ok": True}


# â”€â”€ Student endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@api.post("/coupons/validate")
async def validate_coupon(payload: dict):
    """
    Preview a coupon's discount without consuming it.
    Accepts student_id from payload (GAS-authenticated students pass their clean_id).
    Returns { ok, original_price, discounted_price, discount_amount, coupon }.
    """
    code       = (payload.get("code") or "").strip()
    book_slug  = (payload.get("book_slug") or "").strip()
    original   = int(payload.get("original_price") or 0)
    student_id = (payload.get("student_id") or "").strip()
    if not code or not book_slug or original <= 0:
        raise HTTPException(status_code=400, detail="code, book_slug, and original_price are required.")
    coupon = await _find_valid_coupon(code, student_id, book_slug)
    discounted = _calc_discount(original, coupon)
    return {
        "ok":               True,
        "original_price":   original,
        "discounted_price": discounted,
        "discount_amount":  original - discounted,
        "coupon_type":      coupon["type"],
        "coupon_value":     coupon["value"],
        "code":             coupon["code"],
    }


@api.post("/coupons/redeem")
async def redeem_coupon(payload: dict):
    """
    Atomically redeem a coupon at purchase time.
    Accepts student_id from payload (GAS-authenticated students pass their clean_id).
    Uses findOneAndUpdate with $lt guard to prevent concurrent over-use.
    Returns { ok, discounted_price }.
    """
    code       = (payload.get("code") or "").strip()
    book_slug  = (payload.get("book_slug") or "").strip()
    original   = int(payload.get("original_price") or 0)
    student_id = (payload.get("student_id") or "").strip()
    if not code or not book_slug or original <= 0:
        raise HTTPException(status_code=400, detail="code, book_slug, and original_price are required.")

    # Validate first (raises HTTPException on any failure)
    coupon = await _find_valid_coupon(code, student_id, book_slug)
    discounted = _calc_discount(original, coupon)
    now_iso = datetime.now(timezone.utc).isoformat()

    # Atomic increment with max_uses guard â€” prevents race conditions
    max_uses = coupon.get("max_uses")
    query: dict = {"code": code.upper()}
    if max_uses is not None:
        query["uses_count"] = {"$lt": max_uses}

    redemption_entry = {
        "student_id":  student_id,
        "book_slug":   book_slug,
        "redeemed_at": now_iso,
        "original":    original,
        "discounted":  discounted,
    }
    result = await db.coupons.find_one_and_update(
        query,
        {
            "$inc":  {"uses_count": 1},
            "$push": {"redemptions": redemption_entry},
        },
        return_document=True,
    )
    if not result:
        raise HTTPException(status_code=400, detail="Coupon is no longer available (usage limit reached).")

    log.info("coupon: redeemed %s by %s for book=%s saved=%dpts",
             code, student_id, book_slug, original - discounted)
    return {
        "ok":               True,
        "code":             code.upper(),
        "original_price":   original,
        "discounted_price": discounted,
        "discount_amount":  original - discounted,
    }


# â”€â”€ END COUPON SYSTEM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# NOTE: app.include_router(api) has been moved to the END of this file
# so that ALL @api.* route decorators (including the conversation route below)
# are registered before the router is attached to the app.
"""
server_conversation_patch.py
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
INTEGRATION INSTRUCTIONS:
  1. Open server.py
  2. Find the line: `async def _elevenlabs_generate(text: str, voice_id: str)`
     (around line 286)
  3. After the closing of that function (around line 340), paste everything
     below the "# â”€â”€â”€ PASTE HERE â”€â”€â”€" marker.
  4. Add the new route alongside the existing /elevenlabs route (around line 690).
  5. Add `pydub>=0.25.1` to requirements.txt

EXISTING FUNCTION NOT MODIFIED â€” only new functions and one new endpoint added.
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
"""

# â”€â”€â”€ PASTE HERE (after _elevenlabs_generate function, before first @api route) â”€â”€â”€

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ #
#  Conversation Voice Studio helpers â€” teacher-side only                       #
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ #

EMOTION_ACTING_NOTES: dict = {
    "neutral":   None,
    "happy":     "enthusiastic and warm",
    "excited":   "very excited and energetic",
    "sad":       "sad and quietly dejected",
    "scared":    "scared, voice trembling slightly",
    "angry":     "frustrated and tense, clipped words",
    "curious":   "curious and questioning, rising intonation",
    "surprised": "surprised and astonished",
    "calm":      "calm, slow, and reassuring",
    "dramatic":  "dramatic and intense, measured pauses",
    "whisper":   "whispering softly and quietly",
}


def _emotion_to_acting_note(emotion, custom_note):
    """Merge emotion preset + teacher custom note into ElevenLabs acting prompt."""
    base = EMOTION_ACTING_NOTES.get(emotion or "neutral")
    if custom_note and custom_note.strip():
        return f"{base}; {custom_note.strip()}" if base else custom_note.strip()
    return base


def _strip_id3_tags(buf: bytes) -> bytes:
    """Remove an ID3v2 header (front) and/or ID3v1 trailer (last 128 bytes)
    from a single MP3 segment, returning only the raw MPEG frame run.

    v10 (2026-05) surgical audio fix:
      ElevenLabs returns each TTS segment as a self-contained .mp3 file
      with its own ID3v2 header and (sometimes) an ID3v1 trailer. Naively
      byte-concatenating those segments produces a file with MULTIPLE
      embedded ID3 headers â€” iOS AVFoundation reads only the first
      header's reported duration (== duration of segment 1) and stops
      playback once currentTime crosses that value. Result: conversation
      audio mysteriously cuts off after 1â€“2 minutes on every iPhone /
      iPad / Mac-Safari client. Chromium-family browsers are lenient and
      keep decoding past the bogus duration, which is why the bug never
      reproduced on desktop QA.

      Stripping ID3 tags from every segment AFTER the first leaves us
      with one header at the very front and an uninterrupted run of
      MPEG-1 Layer III frames, which every decoder handles correctly.

    Header layout reference:
      ID3v2: starts with b"ID3", followed by 3 bytes of version/flags,
             then a 4-byte synchsafe size (each byte uses only 7 LSBs).
             Total tag length = 10 + synchsafe(size).
      ID3v1: fixed 128-byte trailer starting with b"TAG".
    """
    if not buf or len(buf) < 10:
        return buf
    out = buf
    # Strip ID3v2 header at the front, if present.
    if out[:3] == b"ID3":
        # synchsafe size: 4 bytes, top bit of each is zero
        b0, b1, b2, b3 = out[6], out[7], out[8], out[9]
        size = (b0 << 21) | (b1 << 14) | (b2 << 7) | b3
        tag_end = 10 + size
        if 10 < tag_end < len(out):
            out = out[tag_end:]
    # Strip ID3v1 trailer at the back, if present.
    if len(out) >= 128 and out[-128:-125] == b"TAG":
        out = out[:-128]
    return out


def _stitch_mp3_segments(segments):
    """Concatenate MP3 byte segments into one continuous decodable file.

    v10 (2026-05) surgical audio fix â€” see _strip_id3_tags() docstring
    for the full root-cause analysis.

    Strategy:
      â€¢ Keep the FIRST segment intact (its ID3v2 header â€” if any â€” becomes
        the single header for the stitched file).
      â€¢ For every subsequent segment, strip both the ID3v2 header and the
        ID3v1 trailer so we emit only raw MPEG frames.

    Valid when all segments share the same codec parameters â€” guaranteed
    when every clip comes from ElevenLabs mp3_44100_128 CBR output.
    """
    if not segments:
        return b""
    parts = [segments[0]]
    for seg in segments[1:]:
        parts.append(_strip_id3_tags(seg))
    return b"".join(parts)


def _generate_silence_bytes(duration_seconds):
    """Return silent MP3 bytes for the requested duration.

    Tries pydub + ffmpeg first; falls back to a pre-built silent MP3 frame
    repeated to fill the time (works without ffmpeg on Render).
    """
    if duration_seconds <= 0:
        return b""
    try:
        from pydub import AudioSegment  # noqa: PLC0415
        silence = AudioSegment.silent(
            duration=int(duration_seconds * 1000),
            frame_rate=44100,
        )
        buf = io.BytesIO()
        silence.export(buf, format="mp3", bitrate="128k")
        return buf.getvalue()
    except Exception:  # noqa: BLE001
        pass

    # Fallback: repeat a minimal silent 128kbps MPEG-1 L3 frame.
    # Frame holds 1152 samples at 44100 Hz â†’ ~26.1 ms each.
    # Header bytes: FF FB 90 00 (sync + 128kbps + 44100 + stereo + no padding)
    SILENT_FRAME = b"\xff\xfb\x90\x00" + b"\x00" * 413  # 417 bytes total
    FRAME_DURATION = 1152 / 44100  # â‰ˆ 0.02613 s
    n_frames = max(1, int(duration_seconds / FRAME_DURATION) + 1)
    return SILENT_FRAME * n_frames


async def _elevenlabs_generate_line(text, voice_id, voice_settings=None, acting_note=None):
    """Generate audio + word timestamps for one dialogue line.

    Extended variant of _elevenlabs_generate() that supports:
      â€¢ voice_settings  dict  { stability, similarity_boost, style }
      â€¢ acting_note     str   prepended as ElevenLabs emotion directive

    Returns { audio_base64, word_timestamps, duration }.
    """
    if not ELEVENLABS_API_KEY:
        raise HTTPException(status_code=503, detail="ELEVENLABS_API_KEY not configured.")

    # ElevenLabs v3 acting instruction: prefix in square brackets
    # Only add acting note for texts longer than 10 chars to avoid API errors
    use_acting = acting_note and len(text.strip()) > 10
    tts_text = f"[{acting_note}] {text}" if use_acting else text

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps"
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
    }
    body = {
        "text": tts_text,
        "model_id": ELEVENLABS_MODEL,
        "output_format": "mp3_44100_128",
    }
    if voice_settings:
        vs = {}
        for key in ("stability", "similarity_boost", "style"):
            if key in voice_settings:
                try:
                    vs[key] = float(voice_settings[key])
                except (TypeError, ValueError):
                    pass
        vs["use_speaker_boost"] = True
        if vs:
            body["voice_settings"] = vs

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(90.0, connect=10.0),
        follow_redirects=True,
    ) as cli:
        r = await cli.post(url, headers=headers, json=body)
        if r.status_code != 200:
            raise HTTPException(
                status_code=502,
                detail=f"ElevenLabs error {r.status_code}: {r.text[:200]}",
            )
        data = r.json()

    audio_base64 = data.get("audio_base64", "")
    alignment = data.get("alignment", {})
    chars = alignment.get("characters", [])
    char_starts = alignment.get("character_start_times_seconds", [])
    char_ends = alignment.get("character_end_times_seconds", [])

    word_timestamps = []
    current_word = ""
    word_start = 0.0
    word_end = 0.0

    for i, ch in enumerate(chars):
        char_str = ch if isinstance(ch, str) else str(ch)
        t_start = char_starts[i] if i < len(char_starts) else 0.0
        t_end = char_ends[i] if i < len(char_ends) else 0.0

        if char_str in (" ", "\n"):
            if current_word.strip():
                word_timestamps.append({
                    "word": current_word.strip(),
                    "start": round(word_start, 3),
                    "end": round(word_end, 3),
                })
            current_word = ""
        else:
            if not current_word:
                word_start = t_start
            current_word += char_str
            word_end = t_end

    if current_word.strip():
        word_timestamps.append({
            "word": current_word.strip(),
            "start": round(word_start, 3),
            "end": round(word_end, 3),
        })

    duration = word_timestamps[-1]["end"] if word_timestamps else 0.0
    return {
        "audio_base64": audio_base64,
        "word_timestamps": word_timestamps,
        "duration": duration,
    }


# â”€â”€â”€ PASTE NEW ROUTE alongside the existing /elevenlabs route â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ #

@api.post("/studio/books/{slug}/conversation")
async def studio_conversation_generate(
    slug: str,
    payload: dict,
    admin: User = Depends(require_admin),
):
    """Generate multi-character emotional dialogue audio for a chapter.
    Teacher-side only. Never called by students.

    Per-line: calls ElevenLabs with per-speaker voice, emotion, acting notes,
    and voice settings. Stitches all segments into one stable MP3. Stores
    in GridFS. Updates dialog blocks with adjusted timestamps.

    Payload:
        chapterIndex: int
        book: dict   (pre-saved, same pattern as /elevenlabs)
        lines: [
            {
                lineIndex: int,
                speaker: str,
                text: str,
                voiceId: str,
                emotion: str,
                actingNote: str,
                voiceSettings: { stability, similarity_boost, style },
                pauseAfter: float,
            }
        ]
    """
    import asyncio  # noqa: PLC0415

    chapter_index = int(payload.get("chapterIndex", 0))
    lines = payload.get("lines") or []
    if not lines:
        raise HTTPException(status_code=400, detail="No lines provided.")

    # Load book (same pattern as /elevenlabs)
    book = payload.get("book") or None
    if not book:
        book = await db.books.find_one(
            {"slug": slug}, {"_id": 0}, sort=[("revision", -1)]
        )
    if not book:
        await asyncio.sleep(0.5)
        book = await db.books.find_one(
            {"slug": slug}, {"_id": 0}, sort=[("revision", -1)]
        )
    if not book:
        raise HTTPException(
            status_code=404,
            detail=f"Book '{slug}' not found. Save first, then generate.",
        )

    chapters = book.get("chapters", [])
    if chapter_index >= len(chapters):
        raise HTTPException(status_code=400, detail="Chapter index out of range.")

    chapter = chapters[chapter_index]
    blocks = list(chapter.get("blocks", []))
    now = datetime.now(timezone.utc).isoformat()

    # Validate voice IDs
    for li, line in enumerate(lines):
        raw_voice = str(line.get("voiceId") or "").strip()
        if not _VOICE_ID_RE.match(raw_voice):
            line["voiceId"] = ELEVENLABS_DEFAULT_VOICE
            log.warning(
                "conversation: line %d invalid voiceId %r â†’ default", li, raw_voice
            )

    audio_segments = []
    accumulated_time = 0.0
    line_results = []

    for li, line in enumerate(lines):
        voice_id = line["voiceId"]
        emotion = str(line.get("emotion") or "neutral")
        acting_note = _emotion_to_acting_note(emotion, line.get("actingNote") or "")
        voice_settings = line.get("voiceSettings") or None
        pause_after = max(0.0, float(line.get("pauseAfter", 0.35)))

        log.info(
            "conversation: line %d/%d speaker=%s voice=%s emotion=%s",
            li + 1, len(lines), line.get("speaker", "?"), voice_id, emotion,
        )

        try:
            result = await _elevenlabs_generate_line(
                text=line["text"],
                voice_id=voice_id,
                voice_settings=voice_settings,
                acting_note=acting_note,
            )
        except Exception as exc:
            # Log and skip this line rather than aborting the whole generation.
            # This ensures other lines still generate even if one fails.
            log.warning(
                "conversation: line %d (%s) failed: %s â€” skipping",
                li + 1, line.get("speaker", "?"), exc,
            )
            line_results.append({
                "lineIndex": line.get("lineIndex"),
                "speaker": line.get("speaker", ""),
                "start": round(accumulated_time, 3),
                "end": round(accumulated_time + 0.5, 3),
                "wordTimestamps": [],
                "error": str(exc),
            })
            accumulated_time += pause_after
            continue

        raw_audio_b64 = result.get("audio_base64") or ""
        if not raw_audio_b64:
            log.warning("conversation: line %d (%s) returned empty audio â€” skipping",
                        li + 1, line.get("speaker", "?"))
            line_results.append({
                "lineIndex": line.get("lineIndex"),
                "speaker": line.get("speaker", ""),
                "start": round(accumulated_time, 3),
                "end": round(accumulated_time + 0.5, 3),
                "wordTimestamps": [],
                "error": "empty audio",
            })
            accumulated_time += pause_after
            continue

        try:
            audio_bytes = base64.b64decode(raw_audio_b64)
        except Exception as exc:
            log.warning("conversation: line %d b64decode failed: %s â€” skipping", li + 1, exc)
            accumulated_time += pause_after
            continue

        raw_wts = result["word_timestamps"]
        line_duration = result["duration"]

        # Shift timestamps by accumulated offset
        shifted_wts = [
            {
                "word": w["word"],
                "start": round(w["start"] + accumulated_time, 3),
                "end": round(w["end"] + accumulated_time, 3),
            }
            for w in raw_wts
        ]

        line_start = accumulated_time
        line_end = line_start + line_duration

        audio_segments.append(audio_bytes)
        line_results.append({
            "lineIndex": line.get("lineIndex"),
            "speaker": line.get("speaker", ""),
            "start": round(line_start, 3),
            "end": round(line_end, 3),
            "wordTimestamps": shifted_wts,
        })

        # Note: silence between lines removed â€” raw MP3 concatenation
        # is cleaner than injecting synthetic frames. ElevenLabs clips
        # already have natural trailing silence.
        accumulated_time = line_end + pause_after

    # Abort if no lines generated successfully
    if not audio_segments:
        raise HTTPException(
            status_code=502,
            detail="No audio was generated. Check voice IDs and ElevenLabs API key.",
        )

    # Stitch all segments
    stitched_bytes = _stitch_mp3_segments(audio_segments)

    # Upload to GridFS
    audio_id = str(uuid.uuid4())
    try:
        await audio_bucket.upload_from_stream(
            f"{audio_id}.mp3",
            io.BytesIO(stitched_bytes),
            metadata={
                "slug": slug,
                "chapter_index": chapter_index,
                "type": "conversation",
                "speakers": list({lr["speaker"] for lr in line_results}),
                "line_count": len(lines),
                "created_at": now,
                "created_by": admin.email,
            },
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("conversation: GridFS upload failed for slug=%s", slug)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to store conversation audio: {type(exc).__name__}: {exc}",
        ) from exc

    audio_url = f"{PUBLIC_BACKEND_URL}/api/studio/audio/{audio_id}.mp3"

    # Update dialog blocks with adjusted timestamps
    for lr in line_results:
        idx = lr.get("lineIndex")
        if idx is None or not isinstance(idx, int) or idx < 0 or idx >= len(blocks):
            continue
        if blocks[idx].get("type") == "dialog":
            blocks[idx] = {
                **blocks[idx],
                "start": lr["start"],
                "end": lr["end"],
                "wordTimestamps": lr["wordTimestamps"],
            }

    # Remove any existing conversation audio block, inject new one
    blocks = [b for b in blocks if not b.get("_conversation_audio")]
    blocks.append({
        "type": "audio",
        "text": audio_url,
        "heading": f"Conversation â€” {chapter.get('title', 'Chapter')}",
        "_elevenlabs_audio": True,
        "_conversation_audio": True,
        "_audio_id": audio_id,
    })

    # Save new book revision
    chapters[chapter_index] = {**chapter, "blocks": blocks}
    latest = await db.books.find_one(
        {"slug": slug}, {"_id": 0, "revision": 1}, sort=[("revision", -1)]
    )
    next_rev = int((latest or {}).get("revision") or 0) + 1

    updated_doc = {
        **book,
        "chapters": chapters,
        "revision": next_rev,
        "_authoredAt": now,
        "_authoredBy": admin.email,
    }
    updated_doc.pop("_id", None)
    await db.books.insert_one(updated_doc)

    log.info(
        "conversation: done slug=%s chapter=%d lines=%d duration=%.1fs rev=%d",
        slug, chapter_index, len(lines), accumulated_time, next_rev,
    )

    return {
        "ok": True,
        "audioUrl": audio_url,
        "audioId": audio_id,
        "totalDuration": round(accumulated_time, 3),
        "lines": line_results,
        "revision": next_rev,
    }


# â”€â”€ Register all api routes with the app â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# MUST be the last include_router(api) call — v2 so every @api.* route defined
# above (including /studio/books/{slug}/conversation) is attached to the app.
exec(open(__import__("pathlib").Path(__file__).parent / "payment_bridge.py").read())

# ── Premium AI Tools (Phase 1) — register isolated routes onto /api ──────
# Adds POST /api/student/premium/decode-block, POST /api/student/premium/
# executive-upgrade, GET /api/student/premium/ai-config, plus admin routes
# /api/admin/ai-tools-config (GET/PUT) and /api/admin/ai-tools-usage (GET).
# Must run BEFORE app.include_router(api) below.
register_premium_ai_routes(api, db, require_admin, require_student)
register_edutalk_routes(api, db, require_admin, require_student)
# PHASE 3 — tier-aware AI feature config + promotions (isolated, additive).
register_tier_config_routes(api, db, require_admin, require_student)


# ─────────────────────────────────────────────────────────────
# Phase 1 GAS→Mongo migration preflight routes
# Admin-only migration status/audit/import routes.
# Registered before app.include_router(api).
# Failure is non-fatal and does not affect existing routes.
# ─────────────────────────────────────────────────────────────
if _WALLET_SERVICE_AVAILABLE and wallet_service is not None:
    try:
        wallet_service.register_migration_routes(api, db, require_admin)

        # Phase 3 — register student-facing points read routes.
        # Routes return {"mode":"disabled"} when USE_MONGO_POINTS_READ != "true"
        # so the frontend falls back to GAS polling until the flag is flipped.
        wallet_service.register_student_points_routes(api, db, require_student)

        # Phase 2 — register shadow_writer with the live db handle.
        # This ensures shadow writes use the same Motor pool as the app.
        # Non-fatal: if shadow_writer import fails, only shadow writes
        # are disabled — all live student flows continue unchanged.
        try:
            import shadow_writer as _sw_mod
            _sw_mod.register_shadow_db(db)
            log.info("startup: shadow_writer registered with live db")
        except Exception as _sw_err:
            log.warning(
                "startup: shadow_writer registration failed (non-fatal): %s",
                str(_sw_err)[:200],
            )
    except Exception as _wallet_route_error:
        logging.getLogger(__name__).warning(
            "migration preflight route registration skipped/failed: %s",
            _wallet_route_error,
        )


app.include_router(api)
