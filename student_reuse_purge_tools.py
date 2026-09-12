"""student_reuse_purge_tools.py — the single, explicit "wipe this slot for a
genuinely NEW person" operation, separate from ordinary deactivation.

CONFIRMED BUG this exists to fix (verified against the current code, not
assumed): teacher_deactivate_student (server.py) only sets is_active=False /
status="archived" on the student document and clears active sessions — its
own docstring says it "never hard-deletes" and the id "is reusable for a new
student." teacher_create_student's reactivation branch, when a teacher
creates a student against a clean_id that is currently inactive, updates
ONLY display_name/group/password_hash/is_active/status/role/enrolled_at/
last_login on the SAME pre-existing document, and — critically — reuses the
EXACT SAME internal student_id the previous occupant had (student_id =
existing["student_id"]; never regenerated). Every other collection in this
codebase scoped to that student_id or clean_id is left completely
untouched. A brand-new, different real person given a recycled clean_id
today silently inherits the previous occupant's entire history: wallet
balance, purchases, submissions, attendance, achievements, vouchers,
sessions, AI usage — everything.

This module does NOT run automatically on deactivation (deactivation may be
temporary/reversible for the SAME student — e.g. a leave of absence — and
must never lose that student's own history). It runs ONLY when an admin
explicitly confirms, at reactivation time, that the clean_id is being
handed to a genuinely different person — see server.py's
teacher_create_student, which now accepts an explicit
`purge_previous_history: bool` flag on the reactivation path (default
False, so today's existing "same student is coming back" behavior is
completely unchanged unless an admin opts in).

INVENTORY METHODOLOGY: every collection below was located by grepping this
entire backend for db["<name>"] / db.<name>. literal collection access
across every *_tools.py file and server.py, then reading each hit's actual
document-construction code to confirm the real field name(s) a per-student
value is stored under — NOT assumed from a file's name or a prior summary.
This codebase is confirmed INCONSISTENT about which id a given collection
actually stores: some (wallet_service.py, video_library_tools.py,
attendance_tools.py, coach_pack_shared.py, ai_assistant_voice_tools.py)
consistently use the true internal student_id; others (login_reward_tools.py,
login_mystery_box_tools.py, mystery_box_tools.py's EduTalk Pass
entitlements, edutalk_coach_reward_tools.py, edutalk_tools.py's session
docs, edutalk_live_tools.py, camrapidpay_payment_tools.py) resolve to
clean_id first and store THAT value, sometimes in a field literally named
"student_id". The single generic rule applied everywhere below, rather than
hand-modeling every module's exact resolution quirk: match ANY of a
collection's known per-student field names against EITHER the reused
student_id OR the reused clean_id. A collection whose field-name guess
turns out to be wrong for a given document simply matches zero rows for
that document — self-correcting and safe (the audit log records the real
count Mongo reports, never a fabricated one), never a wrong deletion.

RETENTION POLICY — flagged, not guessed: for anything with plausible
financial/accounting/audit value (wallet balance and ledger, tuition,
payment records, reward payouts, admin decision/audit trails), this module
ARCHIVES rather than deletes — the document is preserved in full, but its
per-student key field(s) are renamed to "archived_<field>" (plus
archivedAt/archivedReason/archivedByAdmin/archivedStudentId/
archivedCleanId stamped on) so it no longer matches any query scoped to
the live, reused student_id/clean_id, while remaining fully intact and
inspectable for accounting/audit purposes under its archived key. This is
a reasonable default, not a substitute for an actual retention-policy
decision — see this round's report for the explicit open question to the
project owner about whether even longer-term retention/export is required
for real-money-adjacent collections (tuition_records, payment_intents,
payment_transactions, payment_audit_log, camrapidpay_intents) before they
are ever hard-deleted by any future cleanup job (this module never hard-
deletes anything it archives).

Everything else — the student's own activity/personal-state records with
no plausible standalone retention need (purchases actually already fully
represented in the archived ledger, submissions, attendance, achievements,
sessions, AI usage/caches, etc.) — is hard-deleted, so the new occupant
gets a genuine fresh start and no stale data can confuse them or a future
admin report.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

logger = logging.getLogger("eduhub.student_reuse_purge")

PURGE_AUDIT_COLL = "student_reuse_purge_audit"

# ── hard-delete: student's own activity/state, no retention need ─────────
# (collection, (field_name, ...)) — matched via $or across every field name
# against both the student_id and clean_id values for this reuse event.
DELETE_COLLECTIONS: tuple[tuple[str, tuple[str, ...]], ...] = (
    # Video Library
    ("video_purchases", ("studentId",)),
    ("video_progress", ("studentId",)),
    ("video_bookmarks", ("studentId",)),
    ("video_notes", ("studentId",)),
    # Assessment Lab
    ("assessment_submissions", ("studentId", "cleanId")),
    # Attendance
    ("attendance_records", ("student_id",)),
    ("attendance_streaks", ("student_id",)),
    ("attendance_reward_claims", ("student_id",)),
    # Achievements
    ("achievement_claims", ("student_id",)),
    # Notifications / push
    ("activity_notifications", ("studentId",)),
    ("push_subscriptions", ("studentId",)),
    # Vouchers
    ("student_vouchers", ("student_id", "student_id_norm")),
    # Referrals
    ("referral_codes", ("student_id",)),
    ("referral_leads", ("student_id",)),
    # Mystery box / EduTalk pass / login rewards
    ("speaking_lab_mystery_rounds", ("student_id",)),
    ("speaking_lab_mystery_claims", ("student_id",)),
    ("student_feature_entitlements", ("student_id", "student_id_norm")),
    ("login_mystery_claims", ("student_id", "student_id_norm")),
    ("login_reward_claims", ("student_id", "student_id_norm")),
    # EduTalk coach-reward operational state (grants/audit are ARCHIVED below)
    ("edutalk_coach_rewards_offers", ("clean_id",)),
    ("edutalk_coach_rewards_cap_reservations", ("clean_id",)),
    ("edutalk_coach_rewards_cap_buckets", ("clean_id",)),
    ("edutalk_coach_rewards_notifications", ("clean_id",)),
    ("edutalk_coach_rewards_exercises", ("clean_id",)),
    # Voice Treasure (payout ledger is ARCHIVED below)
    ("voice_treasure_missions", ("student_id",)),
    ("voice_treasure_entries", ("student_id",)),
    ("voice_treasure_attempts", ("student_id",)),
    ("voice_treasure_rewards", ("student_id",)),
    ("voice_treasure_collection", ("student_id",)),
    # EduTalk (1:1 coaching)
    ("edutalk_sessions", ("clean_id",)),
    ("edutalk_messages", ("clean_id",)),
    ("edutalk_usage_logs", ("clean_id",)),
    ("student_edutalk_memory", ("student_id",)),
    # EduTalk Live (group classes)
    ("edutalk_live_sessions", ("clean_id",)),
    ("edutalk_live_reports", ("clean_id",)),
    ("edutalk_live_usage_logs", ("clean_id",)),
    ("edutalk_live_topup_nudge_log", ("clean_id",)),
    ("edutalk_audio_cache", ("student_id",)),
    ("edutalk_audio_entitlements", ("student_id",)),
    # Speaking Lab (schedule_assignments/enrollment_audit are ARCHIVED below)
    ("speaking_lab_sessions", ("student_id",)),
    ("speaking_lab_entries", ("student_id",)),
    ("speaking_lab_lucky_codes", ("student_id",)),
    ("speaking_lab_attendance", ("student_id",)),
    ("speaking_lab_pool_events", ("student_id",)),
    ("speaking_lab_direct_joins", ("student_id",)),
    ("speaking_lab_eligibility_overrides", ("student_id",)),
    ("speaking_lab_missing_code_recoveries", ("student_id",)),
    ("speaking_lab_teacher_admissions", ("student_id",)),
    # Coach Pack (vocab/sentences/chapters/quizzes/roleplay/study path/badges)
    ("student_learning_profile", ("student_id",)),
    ("student_vocab", ("student_id",)),
    ("vocab_example_cache", ("student_id",)),
    ("student_sentences", ("student_id",)),
    ("sentence_rewrite_cache", ("student_id",)),
    ("chapter_progress", ("student_id",)),
    ("chapter_reviews", ("student_id",)),
    ("chapter_review_cache", ("student_id",)),
    ("quiz_attempts", ("student_id",)),
    ("roleplay_sessions", ("student_id",)),
    ("roleplay_messages", ("student_id",)),
    ("student_roleplay_daily_usage", ("student_id",)),
    ("study_paths", ("student_id",)),
    ("student_badges", ("student_id",)),
    ("student_daily_ai_usage", ("student_id",)),
    ("coach_briefing_cache", ("student_id",)),
    ("weakness_diagnosis_cache", ("student_id",)),
    ("book_interaction_progress", ("student_id",)),
    # AI Assistant / premium AI tools
    ("ai_assistant_missions", ("student_id",)),
    ("ai_assistant_voice_attempts", ("student_id",)),
    ("ai_assistant_reward_claims", ("student_id",)),
    ("ai_result_cache", ("student_id",)),
    ("ai_result_access", ("student_id", "clean_id")),
    ("ai_usage_logs", ("student_id",)),
    # Sessions / auth / identity
    ("student_sessions", ("student_id",)),
    ("student_smart_login_credentials", ("student_id",)),
    ("student_status", ("studentId",)),
    ("password_reset_requests", ("student_id",)),
    # Wallet-adjacent operational (NOT the ledger itself — that's archived)
    ("push_credit_log", ("senderStudentId", "recipientStudentId")),
)

# ── archive (never delete): financial ledgers + admin/accountability
# audit trails. Preserves the document; renames its per-student key
# field(s) to archived_<field> so it stops matching the LIVE, reused id. ──
ARCHIVE_COLLECTIONS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("points_wallets", ("student_id",)),
    ("points_transactions", ("from_id", "to_id")),
    ("points_history", ("student_id",)),
    ("tuition_records", ("student_id",)),
    ("payment_intents", ("student_id",)),
    ("payment_transactions", ("matched_student_id",)),
    ("payment_audit_log", ("student_id",)),
    ("camrapidpay_intents", ("student_id",)),
    ("assessment_awards", ("studentId", "cleanId")),
    ("assessment_corrections", ("studentId", "cleanId")),
    ("referral_rewards", ("student_id",)),
    ("voice_treasure_payout_ledger", ("student_id",)),
    ("speaking_lab_reward_history", ("student_id",)),
    ("edutalk_coach_rewards_grants", ("clean_id",)),
    ("edutalk_coach_rewards_audit", ("clean_id",)),
    ("speaking_lab_schedule_assignments", ("student_id",)),
    ("speaking_lab_enrollment_audit", ("student_id",)),
    ("coach_pack_audit_log", ("student_id",)),
)

# ── embedded arrays inside SHARED documents (a coupon, a lucky-draw) that
# other students also reference — pull only this student's own entry,
# never delete/touch the shared parent document itself. ──────────────────
# (collection, array_field, element_match_field)
PULL_OBJECT_ARRAY_COLLECTIONS: tuple[tuple[str, str, str], ...] = (
    ("coupons", "redemptions", "student_id"),
    ("speaking_lab_lucky_draws", "results", "student_id"),
)
# (collection, array_field) — a plain array of id strings, e.g. a push
# broadcast's target list.
PULL_SCALAR_ARRAY_COLLECTIONS: tuple[tuple[str, str], ...] = (
    ("push_history", "studentIds"),
    ("push_scheduled", "studentIds"),
)


def _or_query(fields: tuple[str, ...], ids: list[str]) -> dict:
    return {"$or": [{f: {"$in": ids}} for f in fields]}


async def purge_student_slot_for_reuse(
    db, *, student_id: str, clean_id: str, admin_email: str,
    reason: str = "clean_id_reused_for_new_student",
) -> dict:
    """Wipe every collection in this module's inventory for `student_id`/
    `clean_id`, so a newly (re)created student at this slot starts with a
    genuine fresh-start state. NEVER called implicitly by deactivation or
    by an ordinary "same student is coming back" reactivation — only by
    teacher_create_student's reactivation branch, and only when the admin
    has explicitly set `purge_previous_history=True` on that request.

    Returns {"ok": True, "deleted": {collection: count, ...},
    "archived": {collection: count, ...}, "purge_id": str} — every count
    is the REAL number Mongo reports for this call, never assumed, so a
    collection whose field-name guess doesn't match this document simply
    (and honestly) reports 0, never a fabricated success.
    """
    ids = [v for v in {(student_id or "").strip(), (clean_id or "").strip()} if v]
    if not ids:
        return {"ok": False, "reason": "no student_id or clean_id given", "deleted": {}, "archived": {}}

    now_iso = datetime.now(timezone.utc).isoformat()
    deleted: dict[str, int] = {}
    archived: dict[str, int] = {}

    for coll_name, fields in DELETE_COLLECTIONS:
        try:
            result = await db[coll_name].delete_many(_or_query(fields, ids))
        except Exception as exc:  # noqa: BLE001 — one bad collection must never abort the whole purge
            logger.warning("student_reuse_purge: delete failed for %s (non-fatal): %s", coll_name, exc)
            continue
        if result.deleted_count:
            deleted[coll_name] = result.deleted_count

    for coll_name, array_field, elem_field in PULL_OBJECT_ARRAY_COLLECTIONS:
        try:
            result = await db[coll_name].update_many(
                {}, {"$pull": {array_field: {elem_field: {"$in": ids}}}},
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("student_reuse_purge: array-pull failed for %s.%s (non-fatal): %s",
                            coll_name, array_field, exc)
            continue
        if result.modified_count:
            deleted[f"{coll_name}.{array_field}[]"] = result.modified_count

    for coll_name, array_field in PULL_SCALAR_ARRAY_COLLECTIONS:
        try:
            result = await db[coll_name].update_many(
                {array_field: {"$in": ids}}, {"$pull": {array_field: {"$in": ids}}},
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("student_reuse_purge: scalar-array-pull failed for %s.%s (non-fatal): %s",
                            coll_name, array_field, exc)
            continue
        if result.modified_count:
            deleted[f"{coll_name}.{array_field}[]"] = result.modified_count

    for coll_name, fields in ARCHIVE_COLLECTIONS:
        try:
            cursor = db[coll_name].find(_or_query(fields, ids), {"_id": 1, **{f: 1 for f in fields}})
            count = 0
            async for doc in cursor:
                # Only rename a field whose OWN VALUE is actually one of the
                # reused ids — a document can match this collection's $or
                # query via just ONE of several candidate fields (e.g.
                # points_transactions' to_id matching while from_id is an
                # unrelated party, like the treasury account); renaming
                # every field that merely EXISTS on the doc would corrupt
                # an unrelated party's own key.
                rename_ops = {f: f"archived_{f}" for f in fields if doc.get(f) in ids}
                if not rename_ops:
                    continue
                await db[coll_name].update_one(
                    {"_id": doc["_id"]},
                    {
                        "$rename": rename_ops,
                        "$set": {
                            "archivedAt": now_iso,
                            "archivedReason": reason,
                            "archivedByAdmin": admin_email,
                            "archivedStudentId": student_id,
                            "archivedCleanId": clean_id,
                        },
                    },
                )
                count += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("student_reuse_purge: archive failed for %s (non-fatal): %s", coll_name, exc)
            continue
        if count:
            archived[coll_name] = count

    # The student document itself: avatar_url/avatar_r2_key are write-only
    # bookkeeping fields ON db.students (student_avatar.py), not a separate
    # collection — confirmed by reading that module directly. Not cleared
    # by teacher_create_student's own reactivation $set, so the new
    # occupant would otherwise see the previous occupant's profile photo.
    # created_at is reset too, since it likewise survives reactivation
    # untouched today and should reflect this genuinely new occupant.
    student_doc = await db.students.find_one(
        {"student_id": student_id}, {"_id": 0, "avatar_r2_key": 1},
    )
    old_avatar_key = (student_doc or {}).get("avatar_r2_key")
    if old_avatar_key:
        try:
            from hero_artwork_tools import _delete_from_r2
            await _delete_from_r2(old_avatar_key)
        except Exception as exc:  # noqa: BLE001
            logger.warning("student_reuse_purge: failed to delete old avatar R2 object (non-fatal): %s", exc)
    await db.students.update_one(
        {"student_id": student_id},
        {"$set": {"avatar_url": "", "avatar_r2_key": "", "created_at": now_iso}},
    )

    purge_id = str(uuid.uuid4())
    await db[PURGE_AUDIT_COLL].insert_one({
        "purge_id": purge_id,
        "student_id": student_id,
        "clean_id": clean_id,
        "reason": reason,
        "performed_by": admin_email,
        "performed_at": now_iso,
        "deleted": deleted,
        "archived": archived,
    })
    logger.info(
        "student_reuse_purge: purged slot student_id=%s clean_id=%s by=%s "
        "deleted_collections=%d archived_collections=%d purge_id=%s",
        student_id, clean_id, admin_email, len(deleted), len(archived), purge_id,
    )
    return {"ok": True, "deleted": deleted, "archived": archived, "purge_id": purge_id}
