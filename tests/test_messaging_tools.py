"""tests/test_messaging_tools.py — in-app messaging (first release).

The governing priority for this file, per the feature's own build
directive: adversarial private-conversation-access tests are the
single most important category here — every route that touches a
conversation gets a companion test proving a non-participant is
rejected, not just a happy-path test proving a participant succeeds.

Against an in-memory fake Mongo supporting the real query operators
this module's real queries use ($or/$in/$ne/$lte/$gt, dotted-path
fields like "attachment.expiresAt") — none of the simpler fakes
elsewhere in this test suite support those, so this file builds its
own, once, reused by every test below.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from bson import ObjectId
from fastapi import HTTPException

import messaging_tools as mt
import speaking_lab_group_chat as slgc


# ─────────────────────────────────────────────────────────────────────────────
# Fake Mongo — supports the real operators/dotted-paths this module uses.
# ─────────────────────────────────────────────────────────────────────────────
def _get_path(doc, path):
    cur = doc
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def _set_path(doc, path, value):
    parts = path.split(".")
    cur = doc
    for part in parts[:-1]:
        cur = cur.setdefault(part, {})
    cur[parts[-1]] = value


def _unset_path(doc, path):
    parts = path.split(".")
    cur = doc
    for part in parts[:-1]:
        cur = cur.get(part)
        if not isinstance(cur, dict):
            return
    cur.pop(parts[-1], None)


def _match_value(actual, expected):
    if isinstance(expected, dict) and any(k.startswith("$") for k in expected):
        for op, val in expected.items():
            if op == "$in":
                if isinstance(actual, list):
                    if not any(a in val for a in actual):
                        return False
                elif actual not in val:
                    return False
            elif op == "$ne":
                if actual == val:
                    return False
            elif op == "$lte":
                if actual is None or not (actual <= val):
                    return False
            elif op == "$gte":
                if actual is None or not (actual >= val):
                    return False
            elif op == "$lt":
                if actual is None or not (actual < val):
                    return False
            elif op == "$gt":
                if actual is None or not (actual > val):
                    return False
            else:
                raise NotImplementedError(op)
        return True
    if isinstance(actual, list) and not isinstance(expected, list):
        return expected in actual
    return actual == expected


def _matches(doc, query):
    for key, expected in (query or {}).items():
        if key == "$or":
            if not any(_matches(doc, clause) for clause in expected):
                return False
            continue
        actual = _get_path(doc, key)
        if not _match_value(actual, expected):
            return False
    return True


class _Result:
    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


class _Cursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def sort(self, key, direction=-1):
        def keyer(d):
            v = _get_path(d, key)
            return (v is None, v)
        self._docs = sorted(self._docs, key=keyer, reverse=(direction == -1))
        return self

    def limit(self, n):
        self._docs = self._docs[:n]
        return self

    async def to_list(self, length=None):
        return [dict(d) for d in (self._docs[:length] if length else self._docs)]

    def __aiter__(self):
        self._it = iter(self._docs)
        return self

    async def __anext__(self):
        try:
            return dict(next(self._it))
        except StopIteration:
            raise StopAsyncIteration


class _FakeCollection:
    def __init__(self, unique_specs=None):
        self.docs: dict = {}
        self._unique_specs = unique_specs or []  # list of (fields tuple, partial_kind)

    def _check_unique(self, doc, skip_id=None):
        for fields, partial_kind in self._unique_specs:
            if partial_kind and doc.get("kind") != partial_kind:
                continue
            key = tuple(doc.get(f) if not isinstance(doc.get(f), list) else tuple(doc.get(f)) for f in fields)
            for oid, existing in self.docs.items():
                if oid == skip_id:
                    continue
                if partial_kind and existing.get("kind") != partial_kind:
                    continue
                ekey = tuple(existing.get(f) if not isinstance(existing.get(f), list) else tuple(existing.get(f)) for f in fields)
                if ekey == key:
                    from pymongo.errors import DuplicateKeyError
                    raise DuplicateKeyError("duplicate key")

    async def insert_one(self, doc):
        doc = dict(doc)
        oid = doc.get("_id") or ObjectId()
        doc["_id"] = oid
        self._check_unique(doc)
        self.docs[oid] = doc
        return _Result(inserted_id=oid)

    async def find_one(self, query=None, projection=None):
        query = query or {}
        for d in self.docs.values():
            if _matches(d, query):
                return dict(d)
        return None

    def find(self, query=None, projection=None):
        query = query or {}
        return _Cursor([d for d in self.docs.values() if _matches(d, query)])

    async def count_documents(self, query=None):
        query = query or {}
        return sum(1 for d in self.docs.values() if _matches(d, query))

    async def update_one(self, query, update, upsert=False):
        target = None
        for d in self.docs.values():
            if _matches(d, query):
                target = d
                break
        if target is None:
            if upsert:
                new_doc = {}
                for k, v in (query or {}).items():
                    if not k.startswith("$") and not isinstance(v, dict):
                        new_doc[k] = v
                if "$set" in update:
                    for k, v in update["$set"].items():
                        _set_path(new_doc, k, v)
                if "$setOnInsert" in update:
                    for k, v in update["$setOnInsert"].items():
                        _set_path(new_doc, k, v)
                await self.insert_one(new_doc)
                return _Result(matched_count=0, modified_count=0, upserted_id=True)
            return _Result(matched_count=0, modified_count=0)
        pre = dict(target)
        if "$set" in update:
            for k, v in update["$set"].items():
                _set_path(target, k, v)
        if "$unset" in update:
            for k in update["$unset"]:
                _unset_path(target, k)
        if "$addToSet" in update:
            for k, v in update["$addToSet"].items():
                target.setdefault(k, [])
                if v not in target[k]:
                    target[k].append(v)
        try:
            self._check_unique(target, skip_id=target["_id"])
        except Exception:
            self.docs[target["_id"]] = pre
            raise
        return _Result(matched_count=1, modified_count=1)

    async def update_many(self, query, update):
        n = 0
        for d in list(self.docs.values()):
            if _matches(d, query):
                if "$set" in update:
                    for k, v in update["$set"].items():
                        _set_path(d, k, v)
                n += 1
        return _Result(matched_count=n, modified_count=n)

    async def delete_one(self, query):
        for oid, d in list(self.docs.items()):
            if _matches(d, query):
                del self.docs[oid]
                return _Result(deleted_count=1)
        return _Result(deleted_count=0)

    async def create_index(self, *a, **k):
        return None

    async def distinct(self, field, query=None):
        query = query or {}
        out = set()
        for d in self.docs.values():
            if _matches(d, query):
                v = d.get(field)
                if v is not None:
                    out.add(v)
        return list(out)


class _FakeDB:
    def __init__(self):
        self.messaging_conversations = _FakeCollection(unique_specs=[(("kind", "participantIds"), "dm")])
        self.messaging_messages = _FakeCollection()
        self.messaging_read_state = _FakeCollection()
        self.messaging_blocks = _FakeCollection()
        self.messaging_reports = _FakeCollection()
        self.speaking_lab_group_formations = _FakeCollection()
        self.students = _FakeCollection()
        self.platform_config = _FakeCollection()
        self.platform_config_audit = _FakeCollection()
        self.achievement_trophies = _FakeCollection()
        self.achievement_claims = _FakeCollection()

    def __getitem__(self, name):
        return getattr(self, name)


def _student(clean_id, display_name=""):
    return type("S", (), {"clean_id": clean_id, "student_id": clean_id, "display_name": display_name or clean_id})()


class _PushRecorder:
    def __init__(self):
        self.calls = []

    async def __call__(self, subs_query, title, body, url, **kwargs):
        self.calls.append({"subs_query": subs_query, "title": title, "body": body, "url": url, **kwargs})
        return (1, 0)


@pytest.fixture
def db():
    return _FakeDB()


@pytest.fixture
def push():
    return _PushRecorder()


async def _seed_student(db, clean_id, display_name=""):
    await db.students.insert_one({"clean_id": clean_id, "student_id": clean_id, "display_name": display_name or clean_id})


# ═════════════════════════════════════════════════════════════════════════
# §3 — Authorization: adversarial private-conversation-access tests.
# The single most important category in this feature.
# ═════════════════════════════════════════════════════════════════════════
class TestPrivateDMAuthorization:
    @pytest.mark.asyncio
    async def test_a_stranger_cannot_read_a_private_dm_they_are_not_part_of(self, db):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        conv_id = str(conv["_id"])
        await mt.send_message(
            db, conversation=conv, sender_ids=["stu_a"], sender_display="A",
            kind="text", body="private stuff", attachment=None, trophy_id=None,
            client_message_id=None, fan_out_push=_PushRecorder(),
        )
        # Reload with the message applied
        conv = await mt._load_conversation_or_404(db, conv_id)  # noqa: SLF001 — internal, test-only reach
        stranger_ids = ["stu_eve"]
        assert mt.can_read_conversation(conv, stranger_ids) is False
        assert mt.can_write_conversation(conv, stranger_ids) is False

    @pytest.mark.asyncio
    async def test_get_history_route_logic_rejects_a_non_participant(self, db):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        # Simulate exactly what the route does: load + can_read_conversation.
        loaded = await mt._load_conversation_or_404(db, str(conv["_id"]))  # noqa: SLF001
        assert mt.can_read_conversation(loaded, ["stu_eve"]) is False
        assert mt.can_read_conversation(loaded, ["stu_a"]) is True

    @pytest.mark.asyncio
    async def test_a_non_participant_cannot_send_into_someone_elses_dm(self, db, push):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        with pytest.raises(HTTPException) as exc:
            await mt.send_message(
                db, conversation=conv, sender_ids=["stu_eve"], sender_display="Eve",
                kind="text", body="I invited myself", attachment=None, trophy_id=None,
                client_message_id=None, fan_out_push=push,
            )
        assert exc.value.status_code == 403
        assert await db.messaging_messages.count_documents({}) == 0

    @pytest.mark.asyncio
    async def test_a_non_participant_cannot_mark_someone_elses_dm_read(self, db):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        loaded = await mt._load_conversation_or_404(db, str(conv["_id"]))  # noqa: SLF001
        assert mt.is_participant(loaded, ["stu_eve"]) is False

    @pytest.mark.asyncio
    async def test_a_non_participant_cannot_report_a_message_in_someone_elses_dm(self, db, push):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        sent = await mt.send_message(
            db, conversation=conv, sender_ids=["stu_a"], sender_display="A",
            kind="text", body="hello", attachment=None, trophy_id=None,
            client_message_id=None, fan_out_push=push,
        )
        with pytest.raises(HTTPException) as exc:
            await mt.file_report(
                db, reporter_id="stu_eve", conversation_id=str(conv["_id"]),
                message_id=sent["id"], reason="snooping",
            )
        assert exc.value.status_code == 403

    @pytest.mark.asyncio
    async def test_history_of_a_conversation_you_are_not_in_never_leaks_message_bodies(self, db, push):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        await mt.send_message(
            db, conversation=conv, sender_ids=["stu_a"], sender_display="A",
            kind="text", body="TOP SECRET", attachment=None, trophy_id=None,
            client_message_id=None, fan_out_push=push,
        )
        # Directly exercise the same query the history route runs, and
        # confirm the authorization gate — not the query itself — is
        # what would have stopped a stranger (defense-in-depth check:
        # even the raw stored content is exactly what was sent, so the
        # ONLY thing preventing leakage is the auth check on the route).
        stored = [m async for m in db.messaging_messages.find({"conversationId": str(conv["_id"])})]
        assert stored[0]["body"] == "TOP SECRET"
        loaded = await mt._load_conversation_or_404(db, str(conv["_id"]))  # noqa: SLF001
        assert mt.can_read_conversation(loaded, ["stu_eve"]) is False


class TestGroupConversationModeratorVisibility:
    @pytest.mark.asyncio
    async def test_owning_teacher_can_read_but_not_write_a_class_channel(self, db):
        conv = await mt.create_group_conversation(
            db, participant_ids=["stu_a", "stu_b"], title="Class A", owner_id="teacher@school.edu",
        )
        assert mt.can_read_conversation(conv, ["teacher@school.edu"]) is True
        assert mt.can_write_conversation(conv, ["teacher@school.edu"]) is False

    @pytest.mark.asyncio
    async def test_an_unrelated_admin_who_does_not_own_the_channel_cannot_read_it(self, db):
        conv = await mt.create_group_conversation(
            db, participant_ids=["stu_a", "stu_b"], title="Class A", owner_id="teacher@school.edu",
        )
        assert mt.can_read_conversation(conv, ["other_teacher@school.edu"]) is False

    @pytest.mark.asyncio
    async def test_no_admin_backdoor_for_a_private_dm_even_if_the_admin_id_matches_a_participant_field(self, db):
        # A DM's ownerId is ALWAYS None (get_or_create_dm never sets it) —
        # this proves the guarantee is structural (kind != "dm"), not
        # just "nobody happened to set ownerId this time".
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        assert conv["kind"] == "dm"
        assert conv["ownerId"] is None
        # Even a forged conversation dict with ownerId set on a "dm" kind
        # must still be refused — the kind guard itself is what matters.
        forged = dict(conv)
        forged["ownerId"] = "admin@school.edu"
        assert mt.can_read_conversation(forged, ["admin@school.edu"]) is False


# ═════════════════════════════════════════════════════════════════════════
# §4 — Block & report
# ═════════════════════════════════════════════════════════════════════════
class TestBlocking:
    @pytest.mark.asyncio
    async def test_blocking_stops_messages_in_both_directions_from_one_block_action(self, db):
        await mt.block_student(db, "stu_a", "stu_b")
        assert await mt.is_blocked_pair(db, "stu_a", "stu_b") is True
        assert await mt.is_blocked_pair(db, "stu_b", "stu_a") is True  # reverse direction, same single record

    @pytest.mark.asyncio
    async def test_blocked_sender_cannot_send_to_a_dm_even_though_still_a_participant(self, db, push):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        await mt.block_student(db, "stu_b", "stu_a")  # B blocks A
        with pytest.raises(HTTPException) as exc:
            await mt.send_message(
                db, conversation=conv, sender_ids=["stu_a"], sender_display="A",
                kind="text", body="hi", attachment=None, trophy_id=None,
                client_message_id=None, fan_out_push=push,
            )
        assert exc.value.status_code == 403

    @pytest.mark.asyncio
    async def test_blocking_never_hides_existing_message_history_for_the_blocker(self, db, push):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        await mt.send_message(
            db, conversation=conv, sender_ids=["stu_a"], sender_display="A",
            kind="text", body="before the block", attachment=None, trophy_id=None,
            client_message_id=None, fan_out_push=push,
        )
        await mt.block_student(db, "stu_b", "stu_a")
        # History is a pure read against messaging_messages — blocking
        # writes zero rows there, so nothing to delete/hide.
        history = [m async for m in db.messaging_messages.find({"conversationId": str(conv["_id"])})]
        assert len(history) == 1
        assert history[0]["body"] == "before the block"

    @pytest.mark.asyncio
    async def test_unblocking_restores_the_ability_to_message(self, db, push):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        await mt.block_student(db, "stu_b", "stu_a")
        await mt.unblock_student(db, "stu_b", "stu_a")
        # Should not raise now.
        sent = await mt.send_message(
            db, conversation=conv, sender_ids=["stu_a"], sender_display="A",
            kind="text", body="hi again", attachment=None, trophy_id=None,
            client_message_id=None, fan_out_push=push,
        )
        assert sent["body"] == "hi again"

    @pytest.mark.asyncio
    async def test_blocking_yourself_is_rejected(self, db):
        with pytest.raises(HTTPException):
            await mt.block_student(db, "stu_a", "stu_a")


class TestReporting:
    @pytest.mark.asyncio
    async def test_filing_a_report_creates_a_correct_admin_visible_record(self, db, push):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        sent = await mt.send_message(
            db, conversation=conv, sender_ids=["stu_a"], sender_display="A",
            kind="text", body="rude message", attachment=None, trophy_id=None,
            client_message_id=None, fan_out_push=push,
        )
        report = await mt.file_report(
            db, reporter_id="stu_b", conversation_id=str(conv["_id"]),
            message_id=sent["id"], reason="harassment",
        )
        assert report["reporterId"] == "stu_b"
        assert report["conversationId"] == str(conv["_id"])
        assert report["messageId"] == sent["id"]
        assert report["reason"] == "harassment"
        assert report["resolved"] is False

    @pytest.mark.asyncio
    async def test_reported_voice_attachment_survives_its_ttl_until_resolved(self, db, push):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        past = datetime.now(timezone.utc) - timedelta(days=1)  # already "expired" by the clock
        sent = await mt.send_message(
            db, conversation=conv, sender_ids=["stu_a"], sender_display="A",
            kind="voice", body=None,
            attachment={"r2Key": "k1", "mimeType": "audio/webm", "durationSec": 5, "sizeBytes": 10,
                        "url": "https://x/k1", "expiresAt": past, "expired": False},
            trophy_id=None, client_message_id=None, fan_out_push=push,
        )
        await mt.file_report(
            db, reporter_id="stu_b", conversation_id=str(conv["_id"]),
            message_id=sent["id"], reason="inappropriate audio",
        )
        deleted_keys = []

        async def _fake_delete(key):
            deleted_keys.append(key)
            return True

        result = await mt.sweep_expired_attachments(db, delete_object=_fake_delete)
        assert result == {"reaped": 0, "failed": 0}
        assert deleted_keys == []  # never touched — still under report
        msg = await db.messaging_messages.find_one({"_id": ObjectId(sent["id"])})
        assert msg["attachment"]["expired"] is False

    @pytest.mark.asyncio
    async def test_resolving_a_report_gives_the_attachment_a_fresh_ttl_window_not_an_already_elapsed_one(self, db, push):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        past = datetime.now(timezone.utc) - timedelta(days=1)
        sent = await mt.send_message(
            db, conversation=conv, sender_ids=["stu_a"], sender_display="A",
            kind="voice", body=None,
            attachment={"r2Key": "k1", "mimeType": "audio/webm", "durationSec": 5, "sizeBytes": 10,
                        "url": "https://x/k1", "expiresAt": past, "expired": False},
            trophy_id=None, client_message_id=None, fan_out_push=push,
        )
        report = await mt.file_report(
            db, reporter_id="stu_b", conversation_id=str(conv["_id"]),
            message_id=sent["id"], reason="x",
        )
        await mt.resolve_report(db, report_id=str(report["_id"]), resolved_by="admin@x", note="reviewed, ok", ttl_days=30)
        msg = await db.messaging_messages.find_one({"_id": ObjectId(sent["id"])})
        assert msg["reported"] is False
        assert msg["attachment"]["expiresAt"] > datetime.now(timezone.utc) + timedelta(days=29)

        # NOW the sweep is allowed to touch it again, but the fresh
        # window means it correctly does NOT reap it immediately.
        result = await mt.sweep_expired_attachments(db, delete_object=lambda k: asyncio.sleep(0, result=True))
        assert result == {"reaped": 0, "failed": 0}

    @pytest.mark.asyncio
    async def test_text_messages_are_never_touched_by_the_attachment_sweep(self, db, push):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        await mt.send_message(
            db, conversation=conv, sender_ids=["stu_a"], sender_display="A",
            kind="text", body="text lives forever", attachment=None, trophy_id=None,
            client_message_id=None, fan_out_push=push,
        )
        result = await mt.sweep_expired_attachments(db, delete_object=lambda k: asyncio.sleep(0, result=True))
        assert result == {"reaped": 0, "failed": 0}
        msg = await db.messaging_messages.find_one({"kind": "text"})
        assert msg["body"] == "text lives forever"

    @pytest.mark.asyncio
    async def test_a_genuinely_expired_unreported_attachment_is_reaped_and_flagged_expired(self, db, push):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        past = datetime.now(timezone.utc) - timedelta(days=1)
        sent = await mt.send_message(
            db, conversation=conv, sender_ids=["stu_a"], sender_display="A",
            kind="voice", body=None,
            attachment={"r2Key": "k1", "mimeType": "audio/webm", "durationSec": 5, "sizeBytes": 10,
                        "url": "https://x/k1", "expiresAt": past, "expired": False},
            trophy_id=None, client_message_id=None, fan_out_push=push,
        )
        deleted = []

        async def _fake_delete(key):
            deleted.append(key)
            return True

        result = await mt.sweep_expired_attachments(db, delete_object=_fake_delete)
        assert result == {"reaped": 1, "failed": 0}
        assert deleted == ["k1"]
        msg = await db.messaging_messages.find_one({"_id": ObjectId(sent["id"])})
        assert msg["attachment"]["expired"] is True
        assert "r2Key" not in msg["attachment"]
        # The message ROW itself is untouched — still there, still has
        # its real sender/timestamp — only the attachment payload is gone.
        assert msg["senderId"] == "stu_a"


# ═════════════════════════════════════════════════════════════════════════
# §5 — Speaking Lab group chats: session-scoped identity distinctness
# ═════════════════════════════════════════════════════════════════════════
class TestSpeakingLabGroupDistinctness:
    @pytest.mark.asyncio
    async def test_two_different_sessions_group_1_are_fully_distinct_conversations(self, db):
        g1 = slgc.GroupInput(groupNumber=1, members=[
            slgc.GroupMember(studentId="stu_a"), slgc.GroupMember(studentId="stu_b"),
        ])
        run1 = await slgc.form_groups_and_create_chats(db, teacher_id="t@x", schedule="A", groups=[g1])

        g1_again = slgc.GroupInput(groupNumber=1, members=[
            slgc.GroupMember(studentId="stu_a"), slgc.GroupMember(studentId="stu_b"),
        ])
        run2 = await slgc.form_groups_and_create_chats(db, teacher_id="t@x", schedule="A", groups=[g1_again])

        assert run1["groupSessionId"] != run2["groupSessionId"]
        conv1_id = run1["conversations"][0]["conversationId"]
        conv2_id = run2["conversations"][0]["conversationId"]
        assert conv1_id != conv2_id

        # Separate history — a message in run1's group never appears in run2's.
        conv1 = await mt._load_conversation_or_404(db, conv1_id)  # noqa: SLF001
        await mt.send_message(
            db, conversation=conv1, sender_ids=["stu_a"], sender_display="A",
            kind="text", body="only in run 1", attachment=None, trophy_id=None,
            client_message_id=None, fan_out_push=_PushRecorder(),
        )
        run2_messages = [m async for m in db.messaging_messages.find({"conversationId": conv2_id})]
        assert run2_messages == []

    @pytest.mark.asyncio
    async def test_group_display_label_includes_real_session_context_not_a_bare_number(self, db):
        g1 = slgc.GroupInput(groupNumber=2, members=[
            slgc.GroupMember(studentId="stu_a"), slgc.GroupMember(studentId="stu_b"),
        ])
        result = await slgc.form_groups_and_create_chats(db, teacher_id="t@x", schedule="B", groups=[g1])
        title = result["conversations"][0]["title"]
        assert title.startswith("Group 2 ·")
        assert "Speaking Lab" in title
        assert "Schedule B" in title

    @pytest.mark.asyncio
    async def test_a_group_of_fewer_than_two_real_students_creates_no_dead_conversation(self, db):
        lonely = slgc.GroupInput(groupNumber=1, members=[slgc.GroupMember(studentId="stu_a")])
        result = await slgc.form_groups_and_create_chats(db, teacher_id="t@x", schedule="A", groups=[lonely])
        assert result["conversations"] == []

    @pytest.mark.asyncio
    async def test_late_arrival_membership_update_is_idempotent_and_reflected_in_the_real_conversation(self, db):
        g1 = slgc.GroupInput(groupNumber=1, members=[
            slgc.GroupMember(studentId="stu_a"), slgc.GroupMember(studentId="stu_b"),
        ])
        result = await slgc.form_groups_and_create_chats(db, teacher_id="t@x", schedule="A", groups=[g1])
        gsid = result["groupSessionId"]
        await slgc.update_group_membership(db, group_session_id=gsid, group_number=1, member_ids=["stu_a", "stu_b", "stu_c"])
        # Idempotent — calling again with the same set changes nothing extra.
        r = await slgc.update_group_membership(db, group_session_id=gsid, group_number=1, member_ids=["stu_a", "stu_b", "stu_c"])
        assert sorted(r["participantIds"]) == ["stu_a", "stu_b", "stu_c"]
        conv = await db.messaging_conversations.find_one({"_id": ObjectId(r["conversationId"])})
        assert sorted(conv["participantIds"]) == ["stu_a", "stu_b", "stu_c"]

    @pytest.mark.asyncio
    async def test_updating_membership_for_a_nonexistent_group_session_is_a_clean_404_not_a_crash(self, db):
        with pytest.raises(HTTPException) as exc:
            await slgc.update_group_membership(db, group_session_id="slgs_doesnotexist", group_number=1, member_ids=["x"])
        assert exc.value.status_code == 404


class TestConversationArchiving:
    @pytest.mark.asyncio
    async def test_a_conversation_archives_automatically_once_its_archiveat_passes(self, db):
        conv = await mt.create_group_conversation(
            db, participant_ids=["stu_a", "stu_b"], title="Group 1 · test", owner_id="t@x",
            speaking_lab={"sessionId": "slgs_1", "groupNumber": 1, "sessionLabel": "x"}, archive_hours=24,
        )
        # Force it overdue.
        await db.messaging_conversations.update_one({"_id": conv["_id"]}, {"$set": {"archiveAt": datetime.now(timezone.utc) - timedelta(hours=1)}})
        result = await mt.archive_due_conversations(db)
        assert result == {"archived": 1}
        updated = await db.messaging_conversations.find_one({"_id": conv["_id"]})
        assert updated["archived"] is True

    @pytest.mark.asyncio
    async def test_an_archived_conversation_is_read_only_and_hidden_from_the_active_list(self, db, push):
        conv = await mt.create_group_conversation(
            db, participant_ids=["stu_a", "stu_b"], title="Group 1 · test", owner_id="t@x",
        )
        await db.messaging_conversations.update_one({"_id": conv["_id"]}, {"$set": {"archived": True}})
        reloaded = await mt._load_conversation_or_404(db, str(conv["_id"]))  # noqa: SLF001
        with pytest.raises(HTTPException) as exc:
            await mt.send_message(
                db, conversation=reloaded, sender_ids=["stu_a"], sender_display="A",
                kind="text", body="too late", attachment=None, trophy_id=None,
                client_message_id=None, fan_out_push=push,
            )
        assert exc.value.status_code == 403
        active = await mt.list_conversations(db, ["stu_a"])
        assert active == []

    @pytest.mark.asyncio
    async def test_a_non_speaking_lab_class_channel_never_gets_an_archiveat_and_never_auto_archives(self, db):
        conv = await mt.create_group_conversation(db, participant_ids=["stu_a", "stu_b"], title="Class A", owner_id="t@x")
        assert conv["archiveAt"] is None
        result = await mt.archive_due_conversations(db)
        assert result == {"archived": 0}


# ═════════════════════════════════════════════════════════════════════════
# §7 — Achievement share card: real data only, never fabricated
# ═════════════════════════════════════════════════════════════════════════
class TestAchievementShareCard:
    @pytest.mark.asyncio
    async def test_a_student_cannot_share_a_trophy_they_have_not_actually_unlocked(self, db, push):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        await db.achievement_trophies.insert_one({
            "trophy_id": "tier1", "name": "Trophy Tier 1", "artwork": "/x.png",
            "enabled": True, "requirements": {"min_lifetime_points": 1000}, "reward": {},
        })
        with pytest.raises(HTTPException) as exc:
            await mt.send_message(
                db, conversation=conv, sender_ids=["stu_a"], sender_display="A",
                kind="card_achievement", body=None, attachment=None, trophy_id="tier1",
                client_message_id=None, fan_out_push=push,
            )
        assert exc.value.status_code == 403
        assert await db.messaging_messages.count_documents({}) == 0

    @pytest.mark.asyncio
    async def test_a_genuinely_unlocked_achievement_is_embedded_as_a_real_snapshot(self, db, push):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        await db.achievement_trophies.insert_one({
            "trophy_id": "tier1", "name": "Trophy Tier 1", "artwork": "/tier1.png",
            "enabled": True, "requirements": {}, "reward": {},
        })
        await db.achievement_claims.insert_one({
            "trophy_id": "tier1", "student_id": "stu_a", "status": "credited", "claimed_at": "2026-01-01T00:00:00+00:00",
        })
        sent = await mt.send_message(
            db, conversation=conv, sender_ids=["stu_a"], sender_display="A",
            kind="card_achievement", body=None, attachment=None, trophy_id="tier1",
            client_message_id=None, fan_out_push=push,
        )
        assert sent["card"]["type"] == "achievement"
        assert sent["card"]["name"] == "Trophy Tier 1"
        assert sent["card"]["artwork"] == "/tier1.png"
        assert sent["card"]["claimedAt"] == "2026-01-01T00:00:00+00:00"

    @pytest.mark.asyncio
    async def test_sharing_a_nonexistent_trophy_id_is_rejected_not_fabricated(self, db, push):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        with pytest.raises(HTTPException) as exc:
            await mt.send_message(
                db, conversation=conv, sender_ids=["stu_a"], sender_display="A",
                kind="card_achievement", body=None, attachment=None, trophy_id="does-not-exist",
                client_message_id=None, fan_out_push=push,
            )
        assert exc.value.status_code == 403  # get_unlocked_trophy_for_student returns None -> "not unlocked"


# ═════════════════════════════════════════════════════════════════════════
# Optimistic send / reconciliation, unread counts, DM identity
# ═════════════════════════════════════════════════════════════════════════
class TestCoreMessagingBehavior:
    @pytest.mark.asyncio
    async def test_client_message_id_is_echoed_back_for_optimistic_reconciliation(self, db, push):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        sent = await mt.send_message(
            db, conversation=conv, sender_ids=["stu_a"], sender_display="A",
            kind="text", body="hi", attachment=None, trophy_id=None,
            client_message_id="local-123", fan_out_push=push,
        )
        assert sent["clientMessageId"] == "local-123"

    @pytest.mark.asyncio
    async def test_the_sender_never_sees_their_own_just_sent_message_as_unread(self, db, push):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        await mt.send_message(
            db, conversation=conv, sender_ids=["stu_a"], sender_display="A",
            kind="text", body="hi", attachment=None, trophy_id=None,
            client_message_id=None, fan_out_push=push,
        )
        convs = await mt.list_conversations(db, ["stu_a"])
        assert convs[0]["unreadCount"] == 0

    @pytest.mark.asyncio
    async def test_the_recipient_sees_the_new_message_as_unread_until_they_read_it(self, db, push):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        await mt.send_message(
            db, conversation=conv, sender_ids=["stu_a"], sender_display="A",
            kind="text", body="hi", attachment=None, trophy_id=None,
            client_message_id=None, fan_out_push=push,
        )
        convs = await mt.list_conversations(db, ["stu_b"])
        assert convs[0]["unreadCount"] == 1
        await mt.mark_read(db, conversation_id=str(conv["_id"]), student_id="stu_b")
        convs = await mt.list_conversations(db, ["stu_b"])
        assert convs[0]["unreadCount"] == 0

    @pytest.mark.asyncio
    async def test_starting_a_dm_with_yourself_is_rejected(self, db):
        with pytest.raises(HTTPException):
            await mt.get_or_create_dm(db, "stu_a", "stu_a")

    @pytest.mark.asyncio
    async def test_repeated_dm_requests_between_the_same_pair_return_the_same_conversation(self, db):
        c1 = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        c2 = await mt.get_or_create_dm(db, "stu_b", "stu_a")  # order reversed
        assert c1["_id"] == c2["_id"]

    @pytest.mark.asyncio
    async def test_dm_list_shows_the_real_other_participants_display_name(self, db, push):
        await _seed_student(db, "stu_b", "Sophea")
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        await mt.send_message(
            db, conversation=conv, sender_ids=["stu_a"], sender_display="A",
            kind="text", body="hi", attachment=None, trophy_id=None,
            client_message_id=None, fan_out_push=push,
        )
        convs = await mt.list_conversations(db, ["stu_a"])
        assert convs[0]["otherDisplayName"] == "Sophea"

    @pytest.mark.asyncio
    async def test_offline_recipient_gets_a_real_push_fallback(self, db):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        recorder = _PushRecorder()
        await mt.send_message(
            db, conversation=conv, sender_ids=["stu_a"], sender_display="Alice",
            kind="text", body="hi there", attachment=None, trophy_id=None,
            client_message_id=None, fan_out_push=recorder,
        )
        assert len(recorder.calls) == 1
        assert recorder.calls[0]["subs_query"] == {"studentId": "stu_b"}
        assert recorder.calls[0]["category"] == "system"
        # Category is passed explicitly — classify_event never scans the
        # private message body for keywords when a valid category is given.

    @pytest.mark.asyncio
    async def test_empty_text_message_is_rejected_not_stored_as_a_blank_row(self, db, push):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        with pytest.raises(HTTPException):
            await mt.send_message(
                db, conversation=conv, sender_ids=["stu_a"], sender_display="A",
                kind="text", body="   ", attachment=None, trophy_id=None,
                client_message_id=None, fan_out_push=push,
            )
        assert await db.messaging_messages.count_documents({}) == 0

    @pytest.mark.asyncio
    async def test_a_voice_message_with_no_attachment_payload_is_rejected(self, db, push):
        conv = await mt.get_or_create_dm(db, "stu_a", "stu_b")
        with pytest.raises(HTTPException):
            await mt.send_message(
                db, conversation=conv, sender_ids=["stu_a"], sender_display="A",
                kind="voice", body=None, attachment=None, trophy_id=None,
                client_message_id=None, fan_out_push=push,
            )


# ═════════════════════════════════════════════════════════════════════════
# §8 — Admin config toggle
# ═════════════════════════════════════════════════════════════════════════
class TestConfigToggle:
    @pytest.mark.asyncio
    async def test_messaging_defaults_to_disabled_for_a_first_release(self, db):
        assert await mt.messaging_enabled(db) is False

    @pytest.mark.asyncio
    async def test_enabling_via_the_generic_config_system_flips_the_flag(self, db):
        from eduhub_platform.config import set_override
        await set_override(db, "MESSAGING_ENABLED", True, updated_by="admin@x")
        assert await mt.messaging_enabled(db) is True

    @pytest.mark.asyncio
    async def test_a_string_false_override_actually_disables_it(self, db):
        """Regression test — messaging_enabled() previously did a raw
        bool(value) instead of the shared resolve_bool_flag helper, so a
        published override of the STRING "false" (exactly what Author
        Studio's generic Platform Config text input saves) evaluated as
        truthy in Python and silently left messaging turned on."""
        from eduhub_platform.config import set_override
        await set_override(db, "MESSAGING_ENABLED", "true", updated_by="admin@x")
        assert await mt.messaging_enabled(db) is True
        await set_override(db, "MESSAGING_ENABLED", "false", updated_by="admin@x")
        assert await mt.messaging_enabled(db) is False

    @pytest.mark.asyncio
    async def test_attachment_ttl_and_archive_hours_default_sensibly_and_are_overridable(self, db):
        assert await mt.attachment_ttl_days(db) == 30
        assert await mt.speaking_lab_archive_hours(db) == 24
        from eduhub_platform.config import set_override
        await set_override(db, "MESSAGING_ATTACHMENT_TTL_DAYS", 7, updated_by="admin@x")
        assert await mt.attachment_ttl_days(db) == 7

    @pytest.mark.asyncio
    async def test_require_enabled_blocks_when_the_flag_is_off(self, db):
        with pytest.raises(HTTPException) as exc:
            await mt._require_enabled(db)  # noqa: SLF001 — the exact function every route calls
        assert exc.value.status_code == 403


# ═════════════════════════════════════════════════════════════════════════
# r2_object_store — content-hash key stability (pure, no network)
# ═════════════════════════════════════════════════════════════════════════
def test_content_hash_key_is_stable_for_identical_bytes():
    import r2_object_store as store
    raw = b"hello world"
    k1 = store.content_hash_key(raw, prefix="messaging/voice", ext="webm")
    k2 = store.content_hash_key(raw, prefix="messaging/voice", ext="webm")
    assert k1 == k2
    assert k1.startswith("messaging/voice/")
    assert k1.endswith(".webm")


def test_content_hash_key_differs_for_different_bytes():
    import r2_object_store as store
    k1 = store.content_hash_key(b"aaa", prefix="messaging/voice", ext="webm")
    k2 = store.content_hash_key(b"bbb", prefix="messaging/voice", ext="webm")
    assert k1 != k2


def test_r2_config_returns_none_when_unconfigured(monkeypatch):
    import r2_object_store as store
    for var in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL"):
        monkeypatch.delenv(var, raising=False)
    assert store.r2_config() is None


# ═════════════════════════════════════════════════════════════════════════
# Route-level (real FastAPI TestClient) adversarial tests — proves the
# ACTUAL registered HTTP routes enforce authorization end-to-end, not
# just the underlying functions unit-tested above. Catches a class of
# bug pure function tests cannot (a route forgetting to call the check
# it's supposed to, wiring the wrong variable, etc.).
# ═════════════════════════════════════════════════════════════════════════
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

from eduhub_platform.config import set_override


class _CurrentIdentity:
    """Mutable holder so ONE TestClient can act as different students
    across requests within a single test — mirrors exactly what
    switching the logged-in user across two browser tabs would do."""

    def __init__(self, student):
        self.student = student


def _make_messaging_client(db, identity: "_CurrentIdentity", admin=None):
    app = FastAPI()
    api = APIRouter(prefix="/api")

    async def _require_student():
        return identity.student

    async def _require_admin():
        if admin is None:
            raise HTTPException(status_code=401, detail="not admin")
        return admin

    push = _PushRecorder()
    mt.register_messaging_routes(api, app, db, _require_student, _require_admin, push)
    app.include_router(api)
    return TestClient(app), push


class TestMessagingRoutesAdversarial:
    def _enable(self, db):
        asyncio.run(set_override(db, "MESSAGING_ENABLED", True, updated_by="admin@x"))

    def test_history_route_returns_200_for_a_participant_and_403_for_a_stranger(self, db):
        self._enable(db)
        conv = asyncio.run(mt.get_or_create_dm(db, "stu_a", "stu_b"))
        identity = _CurrentIdentity(_student("stu_a"))
        client, _ = _make_messaging_client(db, identity)

        ok = client.get(f"/api/messaging/conversations/{conv['_id']}/messages")
        assert ok.status_code == 200

        identity.student = _student("stu_eve")
        forbidden = client.get(f"/api/messaging/conversations/{conv['_id']}/messages")
        assert forbidden.status_code == 403

    def test_send_message_route_returns_200_for_a_participant_and_403_for_a_stranger(self, db):
        self._enable(db)
        conv = asyncio.run(mt.get_or_create_dm(db, "stu_a", "stu_b"))
        identity = _CurrentIdentity(_student("stu_eve"))
        client, _ = _make_messaging_client(db, identity)

        forbidden = client.post(
            f"/api/messaging/conversations/{conv['_id']}/messages",
            data={"kind": "text", "body": "I was never invited"},
        )
        assert forbidden.status_code == 403

        identity.student = _student("stu_a")
        ok = client.post(
            f"/api/messaging/conversations/{conv['_id']}/messages",
            data={"kind": "text", "body": "legit message"},
        )
        assert ok.status_code == 200
        assert ok.json()["body"] == "legit message"

    def test_mark_read_route_rejects_a_non_participant(self, db):
        self._enable(db)
        conv = asyncio.run(mt.get_or_create_dm(db, "stu_a", "stu_b"))
        identity = _CurrentIdentity(_student("stu_eve"))
        client, _ = _make_messaging_client(db, identity)
        resp = client.post(f"/api/messaging/conversations/{conv['_id']}/read")
        assert resp.status_code == 403

    def test_report_route_rejects_a_non_participant(self, db):
        self._enable(db)
        conv = asyncio.run(mt.get_or_create_dm(db, "stu_a", "stu_b"))
        identity = _CurrentIdentity(_student("stu_a"))
        client, _ = _make_messaging_client(db, identity)
        sent = client.post(
            f"/api/messaging/conversations/{conv['_id']}/messages",
            data={"kind": "text", "body": "hello"},
        ).json()

        identity.student = _student("stu_eve")
        resp = client.post(
            f"/api/messaging/conversations/{conv['_id']}/messages/{sent['id']}/report",
            json={"reason": "spying"},
        )
        assert resp.status_code == 403

    def test_a_stranger_cannot_enumerate_someone_elses_conversation_by_guessing_a_second_conversation_id(self, db):
        """Two separate DMs exist; a participant in one must not be able
        to read the OTHER via the same route just by knowing its id."""
        self._enable(db)
        conv_ab = asyncio.run(mt.get_or_create_dm(db, "stu_a", "stu_b"))
        conv_cd = asyncio.run(mt.get_or_create_dm(db, "stu_c", "stu_d"))
        identity = _CurrentIdentity(_student("stu_a"))
        client, _ = _make_messaging_client(db, identity)

        own = client.get(f"/api/messaging/conversations/{conv_ab['_id']}/messages")
        assert own.status_code == 200
        others = client.get(f"/api/messaging/conversations/{conv_cd['_id']}/messages")
        assert others.status_code == 403

    def test_list_conversations_route_never_returns_a_conversation_the_caller_is_not_in(self, db):
        self._enable(db)
        asyncio.run(mt.get_or_create_dm(db, "stu_a", "stu_b"))
        asyncio.run(mt.get_or_create_dm(db, "stu_c", "stu_d"))
        identity = _CurrentIdentity(_student("stu_a"))
        client, _ = _make_messaging_client(db, identity)
        items = client.get("/api/messaging/conversations").json()["items"]
        all_participant_ids = {p for c in items for p in c["participantIds"]}
        assert "stu_c" not in all_participant_ids
        assert "stu_d" not in all_participant_ids

    def test_every_messaging_route_is_rejected_when_the_feature_is_disabled(self, db):
        # Deliberately NOT calling self._enable(db) — default is off.
        conv = asyncio.run(mt.get_or_create_dm(db, "stu_a", "stu_b"))
        identity = _CurrentIdentity(_student("stu_a"))
        client, _ = _make_messaging_client(db, identity)
        assert client.get("/api/messaging/conversations").status_code == 403
        assert client.get(f"/api/messaging/conversations/{conv['_id']}/messages").status_code == 403
        assert client.post(
            f"/api/messaging/conversations/{conv['_id']}/messages", data={"kind": "text", "body": "x"},
        ).status_code == 403

    def test_cron_endpoint_accepts_the_shared_secret_without_any_user_session(self, db):
        app = FastAPI()
        api = APIRouter(prefix="/api")

        async def _require_student():
            raise HTTPException(status_code=401)

        async def _require_admin():
            raise HTTPException(status_code=401)

        async def _current_user_dep():
            return None  # no session at all — the cron caller has none

        mt.register_messaging_routes(
            api, app, db, _require_student, _require_admin, _PushRecorder(),
            current_user_dep=_current_user_dep, is_super_admin_fn=lambda u: False, cron_secret="s3cr3t",
        )
        app.include_router(api)
        client = TestClient(app)

        no_secret = client.post("/api/admin/messaging/attachments/reap-expired")
        assert no_secret.status_code == 403

        with_secret = client.post(
            "/api/admin/messaging/attachments/reap-expired", headers={"x-cron-secret": "s3cr3t"},
        )
        assert with_secret.status_code == 200

    def test_cron_endpoint_rejects_a_wrong_secret(self, db):
        app = FastAPI()
        api = APIRouter(prefix="/api")

        async def _require_student():
            raise HTTPException(status_code=401)

        async def _require_admin():
            raise HTTPException(status_code=401)

        async def _current_user_dep():
            return None

        mt.register_messaging_routes(
            api, app, db, _require_student, _require_admin, _PushRecorder(),
            current_user_dep=_current_user_dep, is_super_admin_fn=lambda u: False, cron_secret="s3cr3t",
        )
        app.include_router(api)
        client = TestClient(app)
        resp = client.post(
            "/api/admin/messaging/attachments/reap-expired", headers={"x-cron-secret": "wrong-guess"},
        )
        assert resp.status_code == 403

    def test_get_single_conversation_route_returns_viewer_id_so_the_client_can_render_own_vs_other_bubbles(self, db):
        self._enable(db)
        conv = asyncio.run(mt.get_or_create_dm(db, "stu_a", "stu_b"))
        identity = _CurrentIdentity(_student("stu_a"))
        client, _ = _make_messaging_client(db, identity)
        resp = client.get(f"/api/messaging/conversations/{conv['_id']}")
        assert resp.status_code == 200
        assert resp.json()["viewerId"] == "stu_a"

    def test_get_single_conversation_route_still_works_for_an_archived_conversation(self, db):
        """The archived conversation is excluded from the list route, but
        must remain directly openable — otherwise a student could never
        read their own archived Speaking Lab group's history again."""
        self._enable(db)
        conv = asyncio.run(mt.create_group_conversation(
            db, participant_ids=["stu_a", "stu_b"], title="Group 1 · old", owner_id="t@x",
        ))
        asyncio.run(db.messaging_conversations.update_one({"_id": conv["_id"]}, {"$set": {"archived": True}}))
        identity = _CurrentIdentity(_student("stu_a"))
        client, _ = _make_messaging_client(db, identity)

        # Confirmed excluded from the active list.
        listed = client.get("/api/messaging/conversations").json()["items"]
        assert conv["_id"] not in [c["id"] for c in listed]

        # But still directly reachable.
        resp = client.get(f"/api/messaging/conversations/{conv['_id']}")
        assert resp.status_code == 200
        assert resp.json()["archived"] is True

    def test_get_single_conversation_route_rejects_a_non_participant_non_owner(self, db):
        self._enable(db)
        conv = asyncio.run(mt.get_or_create_dm(db, "stu_a", "stu_b"))
        identity = _CurrentIdentity(_student("stu_eve"))
        client, _ = _make_messaging_client(db, identity)
        resp = client.get(f"/api/messaging/conversations/{conv['_id']}")
        assert resp.status_code == 403
