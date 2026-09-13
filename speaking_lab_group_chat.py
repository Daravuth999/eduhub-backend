"""speaking_lab_group_chat.py — group chat for Speaking Lab's group-mode
game (in-app-messaging feature, first release).

WHY THIS IS A NEW, SEPARATE, MINIMAL IDENTITY — NOT A REUSE OF
`speaking_lab_sessions` / `_sl_publish` / the SSE stream
─────────────────────────────────────────────────────────────────────
This feature's own audit (re-verified twice against live code, not
assumed) found:

  * The paid/entry-fee session mechanism (`SL_SESSIONS`,
    `POST /api/speaking-lab/sessions`, `_sl_publish`, the SSE stream at
    `GET /api/speaking-lab/sessions/{id}/stream`) is DEPRECATED — the
    product owner confirmed free sessions are the only live mechanism.
  * `activeSessionId` (Speaking-Lab-Game's `SpeakingLabPage.jsx`) is set
    in exactly ONE place: `LiveRosterGate`'s `onSessionStarted`
    callback, which only fires when `settings.entryFee > 0`. For a free
    game — confirmed the current default and primary path — NO session
    is ever created and NO live connection ever opens, at any point in
    the game, including group formation.
  * Speaking-Lab-Game is teacher-only end-to-end (every route except
    `/login`, `/auth/callback`, and the ALSO-deprecated-paid-flow
    `/join` is gated by `isTeacherRole`). Students never open this app;
    the group chat's UI necessarily lives in eduhub-studio-test, where
    students actually have accounts.

Given that, extending the deprecated session/SSE machinery would mean
building new, real functionality on top of a mechanism nobody uses.
Instead, this module mints a FRESH, dedicated group-chat identity at
the exact moment a teacher forms groups — regardless of entry fee,
independent of `SL_SESSIONS` — and hands each group a real
`messaging_tools` conversation the moment it exists. This also
satisfies the "never re-key a previous session's group chat" rule
(§5.4) by construction: every call to `form_groups_and_create_chats`
mints a brand-new `groupSessionId`, so two different game runs that
happen to produce a "Group 1" can never collide.

IDENTITY
────────
`groupSessionId` = f"slgs_{unix_ms}" — same generation shape as the
(deprecated) `sl_{unix_ms}` session id for consistency of style only;
a DIFFERENT prefix so the two are never confused or accidentally
queried against the wrong collection. Persisted in
`speaking_lab_group_formations` purely as an audit trail (which
teacher, which schedule, which students, when) — messaging_tools' own
`messaging_conversations` documents are the actual source of truth
conversations render from; this collection is not read by the
messaging surface at all.

Composite key for each group's conversation = (groupSessionId,
groupNumber) — carried in the conversation's `speakingLab` field
(messaging_tools.create_group_conversation).
"""
from __future__ import annotations

import logging
import time
import uuid
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import Body, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

import messaging_tools

log = logging.getLogger("eduhub.speaking_lab_group_chat")


class GroupMember(BaseModel):
    model_config = ConfigDict(extra="ignore")
    studentId: str
    name: str = ""


class GroupInput(BaseModel):
    model_config = ConfigDict(extra="ignore")
    groupNumber: int
    members: list[GroupMember]


class FormGroupsPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    schedule: str = ""
    groups: list[GroupInput]


def _session_label(schedule: str, when: Optional[date] = None) -> str:
    d = when or datetime.now(timezone.utc).date()
    sched = f" Schedule {schedule}" if schedule else ""
    # `%-d` (no leading zero) is POSIX-only and not portable to Windows —
    # format the day number separately rather than relying on it, so
    # this behaves identically in production (Linux/Render) and in any
    # Windows dev/test environment.
    return f"{d.strftime('%a %b')} {d.day} Speaking Lab{sched}"


async def form_groups_and_create_chats(
    db, *, teacher_id: str, schedule: str, groups: list[GroupInput],
) -> dict:
    """Mints a fresh groupSessionId and creates one messaging
    conversation per group, ALL sharing that same groupSessionId (so
    every group formed together is unambiguously "this run"). Returns
    the mapping the frontend needs to open each group's chat.

    2026-09 — a millisecond timestamp ALONE is not collision-resistant
    enough for this identifier: a test run (and, in principle, two
    fast/concurrent formation requests in production) can produce two
    calls within the same millisecond, which would have silently
    defeated the exact "never re-key a previous session's group chat"
    guarantee this identifier exists to provide (caught by
    test_two_different_sessions_group_1_are_fully_distinct_conversations
    actually colliding before this fix). A short random suffix makes a
    collision cryptographically implausible regardless of timing."""
    group_session_id = f"slgs_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
    when = datetime.now(timezone.utc).date()
    archive_hours = await messaging_tools.speaking_lab_archive_hours(db)

    await db.speaking_lab_group_formations.insert_one({
        "groupSessionId": group_session_id, "teacherId": teacher_id, "schedule": schedule,
        "createdAt": datetime.now(timezone.utc),
        "groups": [{"groupNumber": g.groupNumber, "memberIds": [m.studentId for m in g.members]} for g in groups],
    })

    created = []
    for g in groups:
        member_ids = [m.studentId for m in g.members if (m.studentId or "").strip()]
        if len(member_ids) < 2:
            # A "group" of fewer than 2 real students has no one to chat
            # with — skip silently rather than creating a dead
            # conversation with a single participant. Not an error: a
            # genuinely tiny present-roster edge case (see formGroups'
            # own n<=5 -> one group behavior) can still legitimately
            # produce this.
            continue
        title = f"Group {g.groupNumber} · {_session_label(schedule, when)}"
        conv = await messaging_tools.create_group_conversation(
            db, participant_ids=member_ids, title=title, owner_id=teacher_id,
            speaking_lab={
                "sessionId": group_session_id, "groupNumber": g.groupNumber,
                "sessionLabel": title, "schedule": schedule,
            },
            archive_hours=archive_hours,
        )
        created.append({"groupNumber": g.groupNumber, "conversationId": str(conv["_id"]), "title": title})

    log.info("speaking_lab_group_chat: formed %s group chat(s) for groupSessionId=%s teacher=%s",
              len(created), group_session_id, teacher_id)
    return {"groupSessionId": group_session_id, "conversations": created}


async def update_group_membership(
    db, *, group_session_id: str, group_number: int, member_ids: list[str],
) -> dict:
    """Late-arrival support (rule 5.6) — a student added to the
    smallest current group client-side (SpeakingLabPage.jsx's existing
    `handleAdmittedStudent` logic, untouched) must also be reflected in
    that group's REAL conversation membership. Idempotent: setting the
    full membership list rather than $push, so a retried/duplicate call
    never double-adds anyone."""
    conv = await db.messaging_conversations.find_one({
        "kind": "speaking_lab_group",
        "speakingLab.sessionId": group_session_id,
        "speakingLab.groupNumber": group_number,
    })
    if not conv:
        raise HTTPException(status_code=404, detail="group conversation not found")
    norm_ids = sorted({messaging_tools.norm_id(m) for m in member_ids if messaging_tools.norm_id(m)})
    await db.messaging_conversations.update_one(
        {"_id": conv["_id"]}, {"$set": {"participantIds": norm_ids, "updatedAt": datetime.now(timezone.utc)}},
    )
    return {"ok": True, "conversationId": str(conv["_id"]), "participantIds": norm_ids}


def register_speaking_lab_group_chat_routes(api, db, require_admin) -> None:
    @api.post("/speaking-lab/group-chats/form")
    async def sl_form_group_chats(payload: FormGroupsPayload, admin=Depends(require_admin)):
        result = await form_groups_and_create_chats(
            db, teacher_id=getattr(admin, "email", "") or "", schedule=payload.schedule, groups=payload.groups,
        )
        return result

    @api.post("/speaking-lab/group-chats/{group_session_id}/groups/{group_number}/members")
    async def sl_update_group_members(
        group_session_id: str, group_number: int,
        member_ids: list[str] = Body(embed=True), admin=Depends(require_admin),
    ):
        return await update_group_membership(
            db, group_session_id=group_session_id, group_number=group_number, member_ids=member_ids,
        )

    log.info("speaking_lab_group_chat: routes registered (/api/speaking-lab/group-chats*)")
