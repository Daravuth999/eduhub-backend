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

import certifi
import httpx
from dotenv import load_dotenv
from fastapi import (APIRouter, Cookie, Depends, FastAPI, File, Form, Header,
                     HTTPException, Request, Response, UploadFile, status)
from fastapi.responses import JSONResponse
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, ConfigDict, Field
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

client = AsyncIOMotorClient(
    MONGO_URL,
    tls=True,
    tlsCAFile=certifi.where(),
    serverSelectionTimeoutMS=30000,
    connectTimeoutMS=20000,
    socketTimeoutMS=20000,
)
db = client[DB_NAME]

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
    return {
        "user_id": user_id,
        "email": email,
        "name": data.get("name") or "",
        "picture": data.get("picture") or "",
        "is_admin": is_admin,
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
):
    if session_token:
        await db.user_sessions.delete_one({"session_token": session_token})
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
    log.info("startup: indexes ready | admin emails=%s",
             "ANY" if not ADMIN_EMAILS else ",".join(ADMIN_EMAILS))


@app.on_event("shutdown")
async def shutdown():
    client.close()
