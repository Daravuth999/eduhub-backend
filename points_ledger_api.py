# -*- coding: utf-8 -*-
"""
points_ledger_api.py — Phase 5 (Mongo Points Ledger + My Portal SoT v1.0.1)

Corrected patch over v1.0.0:

* v1.0.0 queried ``points_transactions`` by ``student_id`` only. The current
  live records (written by ``shadow_writer.py``) DO NOT have a ``student_id``
  field — they carry ``from_id`` / ``to_id`` plus ``type``. v1.0.0 therefore
  returned an empty timeline for every student in production.
* v1.0.1 supports BOTH shapes:
    - current shadow / future WalletService rows that use ``student_id``
      + ``operation`` + ``delta`` + ``balance_after``
    - current ``shadow_writer`` rows that use ``type`` + ``amount`` +
      ``from_id`` + ``to_id``
* v1.0.1 also adds ``GET /api/student/points/latest`` so the LatestRewardCard
  can rely on a real CONFIRMED credit instead of a guessed localStorage
  balance-diff snapshot.
* Admin endpoint accepts ``include_shadow`` (default True) so the known
  payment_bridge shadow record with ``to_id: stu_88185fad5202`` can be
  verified without opening Mongo Atlas.

CONTRACT
========
Sources of truth (read-only):
  * ``points_wallets``         — current balance (per-student)
  * ``points_transactions``    — append-only ledger (per-student)

Endpoints:
  * GET /api/student/points/transactions
      - Requires student session (Depends(require_student))
      - Returns ONLY the calling student's records
      - Hides ``status == "shadow"`` rows from the timeline by default
      - Newest first; ``limit`` / ``cursor`` pagination
  * GET /api/student/points/latest
      - Same auth + filtering as /transactions
      - Returns the single newest CONFIRMED credit row (or null)
      - Powers LatestRewardCard's "truthful reward" replacement
  * GET /api/admin/points/transactions?student_id=stuXXX&limit=50
      - Requires admin (Depends(require_admin))
      - Accepts both clean IDs (``stu094``) and internal wallet IDs
        (``stu_xxxxxxxxxxxx``)
      - ``include_shadow=true`` by default for verification of current
        live records; pass ``include_shadow=false`` for confirmed-only view

ID RESOLUTION
=============
* Student route: uses ``student.student_id`` (internal wallet id, e.g.
  ``stu_88185fad5202``) AND ``student.clean_id`` (e.g. ``stu094``). The
  query matches BOTH so existing rows in either shape are found.
* Admin route: accepts either clean_id or wallet_id; resolves clean_id →
  wallet_id via ``db.students.clean_id`` lookup. Queries both ids.

QUERY SHAPE
===========
For viewer ids ``{wallet_id, clean_id}`` (deduped):

    {
      "$or": [
        { "student_id": { "$in": viewer_ids } },
        { "from_id":    { "$in": viewer_ids } },
        { "to_id":      { "$in": viewer_ids } }
      ]
    }

This finds:
  * Future WalletService rows  — match ``student_id``
  * Current shadow_writer rows — match ``from_id`` or ``to_id``
  * P2P transfer rows (atomic) — both sides match via from/to_id

NORMALISER
==========
Supports both legacy shadow shape and future WalletService shape. The
output is the documented UI-friendly record shape, with:

  * ``direction`` from operation / type / delta / from-to/viewer matching
  * ``amount`` always positive
  * ``signed_amount`` negative for debits, positive for credits
  * Friendly EN/KM title from a source-code lookup
  * One-line description that NEVER leaks raw wallet ids or
    idempotency keys to students
  * ``related_student_id`` is the counterparty's clean id where possible

PROTECTED SYSTEMS
=================
* NEVER writes to wallets or transactions.
* NEVER calls GAS.
* NEVER touches the WalletService internal helpers.
* Reads ``points_wallets`` / ``points_transactions`` / ``students`` only.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping, Optional
import logging

log = logging.getLogger(__name__)

COLL_WALLETS = "points_wallets"
COLL_TXNS = "points_transactions"
COLL_STUDENTS = "students"

# Phase-2 shadow rows are written by the parallel writer
# (``shadow_writer.py``) to verify the Mongo ledger against GAS. They are
# real economy events but they are NOT yet authoritative — students must
# not see them labelled as confirmed activity, but admins must be able
# to inspect them for ledger verification.
SHADOW_STATUSES = {"shadow"}

# Sources whose source_ref carries a book slug — surfaced as ``book_slug``
# in the normalised record so the UI can deep-link to the Reader.
BOOK_UNLOCK_SOURCES = {
    "book_unlock", "unlock_book", "library_purchase", "library",
    "book_purchase",
}

# Friendly EN labels. Unknown sources fall back to "Points activity".
SOURCE_TITLE_MAP_EN: dict[str, str] = {
    # Top-up
    "payment_bridge":          "Points top-up",
    "payment":                 "Points top-up",
    "topup":                   "Points top-up",
    "khqr":                    "Points top-up",
    "camrapidpay":             "Points top-up",
    # Login reward
    "login_reward":            "Login reward",
    "login_reward_campaign":   "Login reward",
    "login_campaign":          "Login reward",
    "daily_reward":            "Login reward",
    # Referral
    "referral_reward":         "Referral reward",
    "referral_bonus":          "Referral reward",
    "referral":                "Referral reward",
    # Book unlock
    "book_unlock":             "Book unlocked",
    "unlock_book":             "Book unlocked",
    "library_purchase":        "Book unlocked",
    "library":                 "Book unlocked",
    "book_purchase":           "Book unlocked",
    # P2P
    "p2p_send":                "Sent points",
    "p2p_receive":             "Received points",
    "p2p":                     "Points transfer",
    "transfer":                "Points transfer",
    # Premium AI / Reader AI
    "premium_ai":              "Premium AI",
    "executive_upgrade":       "Premium AI",
    "reader_ai":               "Premium AI",
    "ai_reader":               "Premium AI",
    # EduTalk
    "edutalk":                 "EduTalk",
    "edutalk_voice":           "EduTalk",
    "edutalk_support":         "EduTalk",
    # Speech / AI assistant rewards
    "ai_assistant_reward":     "Speech mission reward",
    "speech_mission":          "Speech mission reward",
    "speech_coach":            "Speech mission reward",
    # Admin / teacher adjustments
    "admin_adjustment":        "Teacher / Admin adjustment",
    "teacher_adjustment":      "Teacher / Admin adjustment",
    "admin":                   "Teacher / Admin adjustment",
    "teacher":                 "Teacher / Admin adjustment",
    "reconcile":               "Balance reconciliation",
    "refund":                  "Refund",
}

# Khmer mirror — exposed as title_km on every response row.
SOURCE_TITLE_MAP_KM: dict[str, str] = {
    "payment_bridge":          "បញ្ចូលពិន្ទុ",
    "payment":                 "បញ្ចូលពិន្ទុ",
    "topup":                   "បញ្ចូលពិន្ទុ",
    "khqr":                    "បញ្ចូលពិន្ទុ",
    "camrapidpay":             "បញ្ចូលពិន្ទុ",
    "login_reward":            "រង្វាន់ចូលប្រើ",
    "login_reward_campaign":   "រង្វាន់ចូលប្រើ",
    "login_campaign":          "រង្វាន់ចូលប្រើ",
    "daily_reward":            "រង្វាន់ប្រចាំថ្ងៃ",
    "referral_reward":         "រង្វាន់ណែនាំមិត្ត",
    "referral_bonus":          "រង្វាន់ណែនាំមិត្ត",
    "referral":                "រង្វាន់ណែនាំមិត្ត",
    "book_unlock":             "ដោះសោសៀវភៅ",
    "unlock_book":             "ដោះសោសៀវភៅ",
    "library_purchase":        "ដោះសោសៀវភៅ",
    "library":                 "ដោះសោសៀវភៅ",
    "book_purchase":           "ដោះសោសៀវភៅ",
    "p2p_send":                "បានផ្ញើពិន្ទុ",
    "p2p_receive":             "បានទទួលពិន្ទុ",
    "premium_ai":              "Premium AI",
    "executive_upgrade":       "Premium AI",
    "reader_ai":               "Premium AI",
    "edutalk":                 "EduTalk",
    "edutalk_voice":           "EduTalk",
    "edutalk_support":         "EduTalk",
    "ai_assistant_reward":     "រង្វាន់បេសកកម្មនិយាយ",
    "speech_mission":          "រង្វាន់បេសកកម្មនិយាយ",
    "admin_adjustment":        "ការកែតម្រូវដោយគ្រូ",
    "teacher_adjustment":      "ការកែតម្រូវដោយគ្រូ",
}

DEFAULT_TITLE_EN = "Points activity"
DEFAULT_TITLE_KM = "សកម្មភាពពិន្ទុ"

# Treasury / system pseudo-ids we don't want to leak as raw wallet IDs.
SYSTEM_COUNTERPARTIES = {"treasury", "system", "gas", "payment_bridge"}


# --------------------------------------------------------------------------- #
# Small utilities                                                             #
# --------------------------------------------------------------------------- #
def _stringify_id(value: Any) -> str:
    if value is None:
        return ""
    try:
        return str(value)
    except Exception:  # pragma: no cover — defensive
        return ""


def _coerce_iso(value: Any) -> Optional[str]:
    """Return an ISO-8601 string for a datetime / str / None input."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except Exception:
            return None
    return None


def _viewer_ids(*candidates: Optional[str]) -> list[str]:
    """De-dupe + lowercase-trim viewer ids for the $or query.

    Preserves wallet-id form (``stu_xxx``) — only strips whitespace and
    drops empties. ``clean_id`` lookups in ``db.students`` are always
    lowercase, so we add a lower-cased pass too for safety.
    """
    out: list[str] = []
    seen: set[str] = set()
    for c in candidates:
        if not isinstance(c, str):
            continue
        s = c.strip()
        if not s:
            continue
        for v in (s, s.lower()):
            if v and v not in seen:
                seen.add(v)
                out.append(v)
    return out


def _resolve_direction(
    doc: Mapping[str, Any], viewer_ids: Iterable[str],
) -> str:
    """Determine credit/debit for the viewing wallet.

    Order of precedence (most reliable first):
      1. ``type`` field set by shadow_writer.py ("credit" / "debit")
      2. ``operation`` field set by WalletService (credit / debit /
         transfer_debit / transfer_credit / refund / refund_debit)
      3. ``from_id`` / ``to_id`` matching the viewer (current row
         direction relative to this student)
      4. Signed ``delta``
      5. Signed ``amount`` (some legacy sources store amount with sign)
      6. Default: credit (safer than mislabeling a credit as a debit)
    """
    raw_type = (doc.get("type") or "").strip().lower()
    if raw_type == "credit":
        return "credit"
    if raw_type == "debit":
        return "debit"

    op = (doc.get("operation") or "").strip().lower()
    if op in ("debit", "transfer_debit", "refund_debit"):
        return "debit"
    if op in ("credit", "transfer_credit", "refund", "refund_credit"):
        return "credit"

    viewer_set = {v for v in viewer_ids if v}
    f_id = (doc.get("from_id") or "").strip().lower()
    t_id = (doc.get("to_id") or "").strip().lower()
    if t_id and t_id in viewer_set and (not f_id or f_id not in viewer_set):
        return "credit"
    if f_id and f_id in viewer_set and (not t_id or t_id not in viewer_set):
        return "debit"

    delta = doc.get("delta")
    if isinstance(delta, (int, float)) and delta < 0:
        return "debit"
    if isinstance(delta, (int, float)) and delta > 0:
        return "credit"

    amt = doc.get("amount")
    if isinstance(amt, (int, float)) and amt < 0:
        return "debit"

    return "credit"


def _resolve_counterparty(
    doc: Mapping[str, Any], viewer_ids: Iterable[str],
) -> Optional[str]:
    """Return the wallet id on the OTHER side of the txn — or None.

    Treasury / system pseudo-ids are NEVER returned so the student UI
    never has to render or hide raw infrastructure tokens.
    """
    viewer_set = {v for v in viewer_ids if v}
    f_id = (doc.get("from_id") or "").strip()
    t_id = (doc.get("to_id") or "").strip()
    if not f_id and not t_id:
        return None
    if f_id and f_id.lower() not in viewer_set:
        if f_id.lower() in SYSTEM_COUNTERPARTIES:
            return None
        return f_id
    if t_id and t_id.lower() not in viewer_set:
        if t_id.lower() in SYSTEM_COUNTERPARTIES:
            return None
        return t_id
    return None


def _resolve_status(doc: Mapping[str, Any]) -> str:
    """Map raw status to the UI-safe enum the response always carries."""
    raw = (doc.get("status") or "").strip().lower()
    if raw in ("confirmed", "pending", "shadow", "failed"):
        return raw
    # Atomic-mode wallet writes don't set ``status`` (the row never exists
    # in a non-confirmed state). Treat those as confirmed.
    return "confirmed"


def _resolve_title(source: str, direction: str) -> tuple[str, str]:
    """Return (title_en, title_km) for a given source + direction."""
    title_en = SOURCE_TITLE_MAP_EN.get(source)
    title_km = SOURCE_TITLE_MAP_KM.get(source)
    # P2P-aware refinement: a generic transfer source becomes
    # Sent / Received based on the row's direction.
    if source in ("transfer", "p2p"):
        if direction == "debit":
            title_en, title_km = "Sent points", "បានផ្ញើពិន្ទុ"
        else:
            title_en, title_km = "Received points", "បានទទួលពិន្ទុ"
    if not title_en:
        title_en = DEFAULT_TITLE_EN
    if not title_km:
        title_km = DEFAULT_TITLE_KM
    return title_en, title_km


def _resolve_description(
    doc: Mapping[str, Any], source: str, direction: str,
    counterparty: Optional[str],
) -> str:
    """Lightweight one-liner — never leaks raw wallet ids or idempotency
    keys to students. Only surfaces a small safe set of payload fields.
    """
    payload = doc.get("payload") or {}
    note = ""
    if isinstance(payload, Mapping):
        note = (payload.get("note") or "").strip() if isinstance(payload.get("note"), str) else ""
    if note:
        return note[:160]

    if source in BOOK_UNLOCK_SOURCES:
        slug = doc.get("source_ref")
        if not slug and isinstance(payload, Mapping):
            slug = payload.get("book_slug") or payload.get("slug")
        if slug:
            return f"Unlocked: {slug}"
        return "Library unlock"

    if source in ("p2p_send", "transfer") and direction == "debit":
        if counterparty:
            return f"Sent to {counterparty}"
        return "Transfer sent"
    if source in ("p2p_receive", "transfer") and direction == "credit":
        if counterparty:
            return f"From {counterparty}"
        return "Transfer received"

    if source in ("payment_bridge", "payment", "topup", "khqr", "camrapidpay"):
        # Never expose provider transaction ids to students.
        return "Wallet top-up"

    if source in ("login_reward", "login_reward_campaign",
                  "login_campaign", "daily_reward"):
        return "Daily surprise points"

    if source == "referral_reward":
        return "Friend joined"

    if source in ("premium_ai", "executive_upgrade", "reader_ai",
                  "ai_reader"):
        return "AI session"

    if source in ("edutalk", "edutalk_voice", "edutalk_support"):
        return "EduTalk session"

    if source in ("ai_assistant_reward", "speech_mission", "speech_coach"):
        return "Speech mission completed"

    if source in ("admin_adjustment", "teacher_adjustment",
                  "admin", "teacher"):
        return "Adjustment by teacher"

    return ""


def _resolve_book_slug(doc: Mapping[str, Any], source: str) -> Optional[str]:
    if source not in BOOK_UNLOCK_SOURCES:
        return None
    slug = doc.get("source_ref")
    if not slug:
        payload = doc.get("payload") or {}
        if isinstance(payload, Mapping):
            slug = payload.get("book_slug") or payload.get("slug")
    return str(slug) if slug else None


def _normalize_amount(doc: Mapping[str, Any], direction: str) -> tuple[int, int]:
    """Return (amount_abs, signed_amount).

    ``amount`` may be signed (legacy P2P) or unsigned (most rows).
    ``delta`` is always signed in WalletService rows.
    """
    raw = doc.get("amount")
    if raw is None:
        raw = doc.get("delta")
    try:
        amount_abs = int(round(abs(float(raw or 0))))
    except Exception:
        amount_abs = 0
    signed = -amount_abs if direction == "debit" else amount_abs
    return amount_abs, signed


def normalize_transaction(
    doc: Mapping[str, Any], viewer_ids: Iterable[str],
) -> dict[str, Any]:
    """Project a raw ledger row onto the Phase-5 UI-safe shape.

    Supports BOTH ledger schemas (shadow_writer ``type/from_id/to_id``
    and WalletService ``operation/student_id/delta/balance_after``).
    """
    source = (doc.get("source") or "").strip().lower()
    viewer_list = list(viewer_ids)
    direction = _resolve_direction(doc, viewer_list)
    title_en, title_km = _resolve_title(source, direction)
    status = _resolve_status(doc)
    counterparty = _resolve_counterparty(doc, viewer_list)

    amount_abs, signed_amount = _normalize_amount(doc, direction)

    balance_after = doc.get("balance_after")
    try:
        balance_after = (
            float(balance_after) if balance_after is not None else None
        )
    except Exception:
        balance_after = None

    txn_id = _stringify_id(doc.get("_id")) or (
        doc.get("idempotency_key") or ""
    )

    # Raw operation/type — useful for admin debugging only.
    raw_type = (doc.get("operation") or doc.get("type") or "").strip().lower() or None

    return {
        "id":                  txn_id,
        "direction":           direction,
        "amount":              amount_abs,
        "signed_amount":       signed_amount,
        "title":               title_en,
        "title_km":            title_km,
        "description":         _resolve_description(
            doc, source, direction, counterparty,
        ),
        "source":              source or "unknown",
        "status":              status,
        "created_at":          _coerce_iso(doc.get("created_at")),
        "related_student_id":  counterparty,
        "book_slug":           _resolve_book_slug(doc, source),
        "raw_type":            raw_type,
        "balance_after":       balance_after,
    }


# --------------------------------------------------------------------------- #
# Route registration                                                          #
# --------------------------------------------------------------------------- #
def register_points_ledger_routes(api, db, require_student, require_admin) -> None:
    """Mount the v1.0.1 ledger endpoints onto the existing /api router.

    Called once from server.py startup. Mirrors the
    ``wallet_service.register_student_points_routes`` pattern so this
    module never imports server.py directly — no circular import risk.
    """
    from fastapi import Depends, HTTPException, Query  # noqa: WPS433

    def _clamp_int(value, default, low, high):
        try:
            v = int(value)
        except Exception:
            v = default
        return max(low, min(high, v))

    async def _resolve_admin_lookup(raw: str) -> tuple[list[str], Optional[str]]:
        """Return (viewer_ids, wallet_id) for an admin-supplied lookup.

        Accepts either ``stu094`` (clean_id) or ``stu_xxxxxxxx``
        (wallet_id). Resolves clean_id → wallet_id via db.students.
        """
        wallet_id: Optional[str] = None
        if not raw:
            return [], None
        candidate = raw.strip()
        if candidate.startswith("stu_"):
            wallet_id = candidate
        else:
            try:
                stu = await db[COLL_STUDENTS].find_one(
                    {
                        "$or": [
                            {"clean_id": candidate.lower()},
                            {"student_id": candidate},
                            {"clean_id": candidate},
                        ]
                    },
                    {"_id": 0, "student_id": 1, "clean_id": 1},
                )
                if stu and stu.get("student_id"):
                    wallet_id = stu["student_id"]
            except Exception as e:  # pragma: no cover — defensive
                log.warning("admin lookup students read failed: %s", e)
        ids = _viewer_ids(wallet_id, candidate)
        return ids, wallet_id or candidate

    def _build_query(
        viewer_ids: list[str],
        cursor: Optional[str],
        include_shadow: bool,
    ) -> dict[str, Any]:
        """Build the points_transactions query for a given viewer."""
        if not viewer_ids:
            # Defensive guard — never return another student's data.
            return {"_id": {"$exists": False}}
        q: dict[str, Any] = {
            "$or": [
                {"student_id": {"$in": viewer_ids}},
                {"from_id":    {"$in": viewer_ids}},
                {"to_id":      {"$in": viewer_ids}},
            ],
        }
        if not include_shadow:
            q["status"] = {"$nin": list(SHADOW_STATUSES)}
        if cursor:
            q["created_at"] = {"$lt": cursor}
        return q

    async def _wallet_doc_for(viewer_ids: list[str]) -> Optional[dict]:
        if not viewer_ids:
            return None
        try:
            doc = await db[COLL_WALLETS].find_one(
                {
                    "$or": [
                        {"student_id": {"$in": viewer_ids}},
                        {"clean_id":   {"$in": viewer_ids}},
                    ]
                },
                {
                    "_id": 0, "balance": 1, "student_id": 1,
                    "clean_id": 1, "status": 1, "updated_at": 1,
                },
            )
            return doc
        except Exception as e:  # pragma: no cover — defensive
            log.warning("wallet read failed for viewers=%s: %s", viewer_ids, e)
            return None

    # ---------------------------------------------------------------- #
    # Student transaction timeline                                     #
    # ---------------------------------------------------------------- #
    @api.get("/student/points/transactions")
    async def _student_points_transactions(   # noqa: D401
        limit: int = 50,
        cursor: Optional[str] = None,
        student=Depends(require_student),
    ):
        wallet_id = getattr(student, "student_id", None)
        clean_id = getattr(student, "clean_id", None)
        viewer_ids = _viewer_ids(wallet_id, clean_id)
        page_size = _clamp_int(limit, 50, 1, 200)

        # Student timeline hides Phase-2 shadow rows by default — they
        # are real ledger events but the source-of-truth flip has not
        # happened yet (see AUDIT_REPORT.md).
        query = _build_query(viewer_ids, cursor, include_shadow=False)
        try:
            cur = (
                db[COLL_TXNS]
                .find(query)
                .sort("created_at", -1)
                .limit(page_size)
            )
            raw_rows = await cur.to_list(length=page_size)
        except Exception as e:  # pragma: no cover — defensive
            log.warning("student timeline read failed: %s", e)
            raw_rows = []

        rows = [normalize_transaction(r, viewer_ids) for r in raw_rows]

        wallet_doc = await _wallet_doc_for(viewer_ids)
        balance = float(wallet_doc.get("balance") or 0) if wallet_doc else None
        resolved_wallet_id = (
            (wallet_doc or {}).get("student_id") or wallet_id or ""
        )

        next_cursor = (
            rows[-1].get("created_at")
            if rows and len(rows) == page_size
            else None
        )

        return {
            "success":        True,
            "student_id":     clean_id or wallet_id or "",
            "wallet_id":      resolved_wallet_id,
            "balance":        balance,
            "transactions":  rows,
            "next_cursor":    next_cursor,
            "count":          len(rows),
            "includes_shadow": False,
        }

    # ---------------------------------------------------------------- #
    # Latest confirmed credit (powers LatestRewardCard)                #
    # ---------------------------------------------------------------- #
    @api.get("/student/points/latest")
    async def _student_points_latest(   # noqa: D401
        student=Depends(require_student),
    ):
        """Return the calling student's newest CONFIRMED credit row, or
        ``{transaction: null}``. Used by the LatestRewardCard so it can
        stop guessing rewards from local balance differences.

        Defensive: never includes shadow rows. If only shadow rows
        exist, this endpoint returns ``transaction: null`` and the UI
        shows an honest empty state.
        """
        wallet_id = getattr(student, "student_id", None)
        clean_id = getattr(student, "clean_id", None)
        viewer_ids = _viewer_ids(wallet_id, clean_id)
        query = _build_query(viewer_ids, cursor=None, include_shadow=False)
        # Only show CREDITS in the reward card (never a debit as a "reward").
        # We match on either type or operation or direction-by-to_id —
        # but the simplest robust filter is: limit a few rows and pick
        # the first credit after normalisation.
        try:
            cur = (
                db[COLL_TXNS]
                .find(query)
                .sort("created_at", -1)
                .limit(20)
            )
            raw_rows = await cur.to_list(length=20)
        except Exception as e:  # pragma: no cover — defensive
            log.warning("latest reward read failed: %s", e)
            raw_rows = []

        latest = None
        for r in raw_rows:
            n = normalize_transaction(r, viewer_ids)
            if (
                n.get("direction") == "credit"
                and n.get("status") == "confirmed"
                and (n.get("amount") or 0) > 0
            ):
                latest = n
                break

        return {
            "success":     True,
            "student_id":  clean_id or wallet_id or "",
            "transaction": latest,
        }

    # ---------------------------------------------------------------- #
    # Admin ledger lookup                                              #
    # ---------------------------------------------------------------- #
    @api.get("/admin/points/transactions")
    async def _admin_points_transactions(   # noqa: D401
        student_id: str = Query(
            ..., description="clean_id (stu094) or wallet_id (stu_xxx)",
        ),
        limit: int = 50,
        cursor: Optional[str] = None,
        include_shadow: bool = True,
        _admin=Depends(require_admin),
    ):
        """Admin-only ledger lookup. READ ONLY — never mutates wallets.

        ``include_shadow`` defaults to True so admins can verify the
        known live shadow records (e.g. payment_bridge shadow rows
        with ``to_id: stu_88185fad5202``) without opening Mongo Atlas.
        """
        raw = (student_id or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="student_id required")

        viewer_ids, resolved_wallet_id = await _resolve_admin_lookup(raw)
        page_size = _clamp_int(limit, 50, 1, 200)

        query = _build_query(viewer_ids, cursor, include_shadow=include_shadow)
        try:
            cur = (
                db[COLL_TXNS]
                .find(query)
                .sort("created_at", -1)
                .limit(page_size)
            )
            raw_rows = await cur.to_list(length=page_size)
        except Exception as e:  # pragma: no cover — defensive
            log.warning("admin timeline read failed: %s", e)
            raw_rows = []

        rows = [normalize_transaction(r, viewer_ids) for r in raw_rows]

        wallet_doc = await _wallet_doc_for(viewer_ids)
        balance = (
            float(wallet_doc.get("balance") or 0) if wallet_doc else None
        )
        wallet_status = (
            wallet_doc.get("status") if wallet_doc else None
        )
        wallet_updated = (
            _coerce_iso(wallet_doc.get("updated_at"))
            if wallet_doc else None
        )

        next_cursor = (
            rows[-1].get("created_at")
            if rows and len(rows) == page_size
            else None
        )

        return {
            "success":           True,
            "lookup":            raw,
            "wallet_id":         resolved_wallet_id,
            "viewer_ids":        viewer_ids,
            "balance":           balance,
            "wallet_status":     wallet_status,
            "wallet_updated_at": wallet_updated,
            "transactions":      rows,
            "next_cursor":       next_cursor,
            "count":             len(rows),
            "includes_shadow":   include_shadow,
        }

    log.info(
        "points_ledger_api v1.0.1: routes registered "
        "(/api/student/points/transactions, "
        "/api/student/points/latest, "
        "/api/admin/points/transactions)"
    )
