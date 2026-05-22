"""
telegram_listener.py — EduHub Payment Alert Listener
=====================================================
Watches the Telegram "Payment Alert" group for PayWay by ABA notifications
and instantly forwards them to the EduHub backend payment webhook.

Deploy as a SECOND Render service (Worker, not Web Service):
  Build command:  pip install -r requirements_listener.txt
  Start command:  python telegram_listener.py

Environment variables to set in Render:
  TG_API_ID               = 38009767
  TG_API_HASH             = 8f1ebbc30ada063b66015b467f64241b
  TG_PHONE                = your Telegram phone number (e.g. +85512345678)
  TG_SESSION_STRING       = (generated on first run — see README below)
  BACKEND_URL             = https://eduhub-backend-td3a.onrender.com
  PAYMENT_WEBHOOK_SECRET  = f6a7f9360b51ec16e991bb9bb327df5d26f8b29092d878f88d8983d9163d043d
  TG_GROUP_NAME           = Payment Alert

Safety guarantees:
  - Never sends any message to Telegram (read-only listener)
  - Deduplication: backend blocks duplicate trx_id+apv
  - Retries with exponential backoff on network failure
  - Logs every forwarded message with timestamp
  - If backend is unreachable, stores message locally and retries

HOW TO GET TG_SESSION_STRING (one-time setup):
  Run this locally once:
    pip install telethon
    python generate_session.py
  It will print a session string — paste that into Render env vars.
  After that, the listener runs headlessly forever with no phone needed.
"""

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from telethon import TelegramClient, events
from telethon.sessions import StringSession

# ── Config ────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("eduhub.tg")

API_ID              = int(os.environ["TG_API_ID"])
API_HASH            = os.environ["TG_API_HASH"]
SESSION_STRING      = os.environ.get("TG_SESSION_STRING", "")
BACKEND_URL         = os.environ.get("BACKEND_URL", "https://eduhub-backend-td3a.onrender.com").rstrip("/")
WEBHOOK_SECRET      = os.environ.get("PAYMENT_WEBHOOK_SECRET", "")
GROUP_NAME          = os.environ.get("TG_GROUP_NAME", "Payment Alert")
PAYWAY_SENDER       = os.environ.get("TG_PAYWAY_SENDER", "PayWay by ABA")

# Local retry queue (in-memory — survives brief backend outages within a session)
_retry_queue: list[dict] = []
_RETRY_MAX = 10          # max retries per message
_RETRY_DELAY = 5         # seconds between retries

# ── PayWay message detector ───────────────────────────────────────────────

def _is_payway_notification(text: str) -> bool:
    """Return True only for real payment notifications, not bot setup messages."""
    if not text:
        return False
    text_lower = text.lower()
    # Must contain payment indicators
    has_payment = ("paid by" in text_lower or "transferred by" in text_lower)
    has_trx     = "trx. id:" in text_lower or "trx id:" in text_lower
    has_apv     = "apv:" in text_lower
    # Must NOT be the setup/welcome messages
    is_setup    = (
        "hello! this is payway bot" in text_lower or
        "please enter the 4 digits" in text_lower or
        "congratulations" in text_lower and "linked" in text_lower
    )
    return has_payment and has_trx and has_apv and not is_setup


# ── Backend forwarder ─────────────────────────────────────────────────────

async def _forward_to_backend(message_text: str, attempt: int = 1) -> bool:
    """POST the PayWay message to the EduHub backend webhook.

    Returns True on success, False on failure (caller should retry).
    """
    url = f"{BACKEND_URL}/api/payments/telegram-webhook"
    headers = {"Content-Type": "application/json"}
    if WEBHOOK_SECRET:
        headers["X-Payment-Secret"] = WEBHOOK_SECRET

    payload = {"message": message_text}

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0)) as client:
            r = await client.post(url, json=payload, headers=headers)
            if r.status_code == 200:
                data = r.json()
                if data.get("duplicate"):
                    log.info("⚠️  Duplicate blocked by backend (trx already recorded)")
                else:
                    log.info("✅ Forwarded to backend — txn_id=%s amount=%s from=%s",
                             data.get("txn_id"), 
                             data.get("parsed", {}).get("amount"),
                             data.get("parsed", {}).get("payer_name"))
                return True
            elif r.status_code == 422:
                # Unparseable message — not a payment notification, skip silently
                log.warning("Backend could not parse message (422) — skipping")
                return True  # Don't retry unparseable messages
            else:
                log.error("Backend returned HTTP %s: %s", r.status_code, r.text[:200])
                return False
    except Exception as exc:
        log.error("Failed to reach backend (attempt %d): %s", attempt, exc)
        return False


async def _forward_with_retry(message_text: str):
    """Forward with exponential backoff retry."""
    for attempt in range(1, _RETRY_MAX + 1):
        success = await _forward_to_backend(message_text, attempt)
        if success:
            return
        if attempt < _RETRY_MAX:
            delay = min(_RETRY_DELAY * (2 ** (attempt - 1)), 120)  # max 2 min wait
            log.info("Retrying in %ds (attempt %d/%d)…", delay, attempt + 1, _RETRY_MAX)
            await asyncio.sleep(delay)
    # All retries failed — add to in-memory queue for background retry
    log.error("All %d retries failed — adding to retry queue", _RETRY_MAX)
    _retry_queue.append({
        "text":       message_text,
        "added_at":   datetime.now(timezone.utc).isoformat(),
        "attempts":   _RETRY_MAX,
    })


async def _background_retry_worker():
    """Background task that retries failed messages every 60 seconds."""
    while True:
        await asyncio.sleep(60)
        if not _retry_queue:
            continue
        log.info("Background retry: %d messages in queue", len(_retry_queue))
        still_failing = []
        for item in _retry_queue:
            success = await _forward_to_backend(item["text"])
            if not success:
                item["attempts"] += 1
                if item["attempts"] < 50:  # give up after 50 total attempts (~50 min)
                    still_failing.append(item)
                else:
                    log.error("PERMANENTLY FAILED after 50 attempts: %s…", item["text"][:80])
        _retry_queue.clear()
        _retry_queue.extend(still_failing)


# ── Main listener ─────────────────────────────────────────────────────────

async def main():
    log.info("EduHub Payment Listener starting…")
    log.info("Watching group: '%s' | Backend: %s", GROUP_NAME, BACKEND_URL)

    if not SESSION_STRING:
        log.error(
            "TG_SESSION_STRING is not set. "
            "Run generate_session.py locally to get it, then set it in Render env vars."
        )
        raise SystemExit(1)

    client = TelegramClient(StringSession(SESSION_STRING), API_ID, API_HASH)

    await client.start()
    log.info("✅ Telegram client connected as: %s", await client.get_me())

    # Resolve the target group once at startup
    target_group = None
    async for dialog in client.iter_dialogs():
        if dialog.name == GROUP_NAME:
            target_group = dialog.entity
            log.info("✅ Found group '%s' (id=%s)", GROUP_NAME, dialog.id)
            break

    if not target_group:
        log.error(
            "Could not find group '%s'. "
            "Make sure TG_GROUP_NAME matches exactly and your account is a member.",
            GROUP_NAME,
        )
        raise SystemExit(1)

    # Start background retry worker
    asyncio.create_task(_background_retry_worker())

    @client.on(events.NewMessage(chats=target_group))
    async def handle_message(event):
        text = event.message.message or ""
        sender = ""
        try:
            sender_entity = await event.get_sender()
            sender = getattr(sender_entity, "first_name", "") or getattr(sender_entity, "title", "") or ""
        except Exception:
            pass

        log.debug("Message from '%s': %s…", sender, text[:60])

        # Only process PayWay notification messages
        if not _is_payway_notification(text):
            return

        log.info("💳 PayWay notification detected from '%s'", sender)
        log.info("   Message: %s", text[:120])

        # Forward to backend (with retry)
        asyncio.create_task(_forward_with_retry(text))

    log.info("👂 Listening for PayWay notifications… (Ctrl+C to stop)")
    await client.run_until_disconnected()


if __name__ == "__main__":
    asyncio.run(main())
