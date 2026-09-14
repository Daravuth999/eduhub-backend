"""tests/test_attendance_auto_roster.py
==========================================
Automated eligible-student roster assignment (§2).

RESOLVED A/B AMBIGUITY, evidence (not a guess) — see
class_matches_student_schedule's own docstring in attendance_tools.py:
a full-codebase audit found no structured per-student CEFR field
anywhere (CEFR-style labels exist only as free text in ClassIn.title_en
or as unrelated video/book-factory generation parameters). The only
real, structured, matchable per-student attribute is `students.group`
(Schedule A/B). These tests exercise exactly that resolution.

§2.5 — union, not write-on-event. An earlier design wrote matching
students into a class's `roster` array whenever their schedule changed
(sync_rosters_for_student_group). That had a real bug: the very first
write flipped a class's roster resolution from "match everyone by
Schedule A/B" (the pre-existing fallback for an empty `roster` array)
to "match ONLY the explicit ids now in `roster`" — silently dropping
every other auto-matched student. Fixed by making resolution a live
UNION (resolve_class_roster_ids / the closure-local `_class_roster`):
explicit `roster` ids are manual additions/exceptions, ADDITIVE to,
never a replacement for, the live Schedule A/B match. No roster write
happens on a schedule change anymore — there is nothing to keep in
sync, since the match is always computed fresh. These tests exercise
resolve_class_roster_ids directly (the module-level, DB-driven half of
that union) since that's the real behavior teachers/admins depend on.

Same self-contained fake Mongo as the other attendance test files.
"""
from __future__ import annotations

import asyncio
import copy

import attendance_tools as att


def run(c):
    return asyncio.run(c)


def _match(doc, q):
    for k, v in q.items():
        dv = doc.get(k)
        if isinstance(v, dict):
            if "$in" in v and dv not in v["$in"]:
                return False
        elif dv != v:
            return False
    return True


class _Cursor:
    def __init__(s, d):
        s._d = d

    def __aiter__(s):
        async def g():
            for x in s._d:
                yield x
        return g()


class _Coll:
    def __init__(s):
        s.docs = {}

    async def find_one(s, q, p=None):
        for d in s.docs.values():
            if _match(d, q):
                o = copy.deepcopy(d)
                if p and p.get("_id") == 0:
                    o.pop("_id", None)
                return o
        return None

    async def update_one(s, q, up, upsert=False):
        for d in s.docs.values():
            if _match(d, q):
                if "$addToSet" in up:
                    for k, v in up["$addToSet"].items():
                        d.setdefault(k, [])
                        if v not in d[k]:
                            d[k].append(v)
                if "$set" in up:
                    d.update(up["$set"])
                return type("R", (), {"matched_count": 1})()
        return type("R", (), {"matched_count": 0})()

    def find(s, q, p=None):
        out = [copy.deepcopy(d) for d in s.docs.values() if _match(d, q)]
        if p and p.get("_id") == 0:
            for o in out:
                o.pop("_id", None)
        return _Cursor(out)


class _DB:
    def __init__(s):
        s._c = {}

    def __getitem__(s, n):
        return s._c.setdefault(n, _Coll())

    def __getattr__(s, n):
        if n.startswith("_"):
            raise AttributeError(n)
        return s._c.setdefault(n, _Coll())


def _seed_class(db, cid, group, roster=None):
    db[att.COLL_CLASSES].docs[cid] = {
        "_id": cid, "class_id": cid, "title_en": cid, "group": group,
        "roster": list(roster or []),
    }


def _seed_student(db, sid, group):
    db.students.docs[sid] = {"_id": sid, "clean_id": sid, "student_id": sid, "group": group}


# ── class_matches_student_schedule — the resolved eligibility rule ──────────
def test_a_class_labeled_A_matches_only_students_assigned_to_A():
    assert att.class_matches_student_schedule("A", "A") is True
    assert att.class_matches_student_schedule("A", "B") is False
    assert att.class_matches_student_schedule("A", "") is False


def test_a_class_labeled_AB_is_permissive_and_matches_any_assigned_student():
    assert att.class_matches_student_schedule("AB", "A") is True
    assert att.class_matches_student_schedule("AB", "B") is True
    assert att.class_matches_student_schedule("AB", "AB") is True
    assert att.class_matches_student_schedule("AB", "") is False  # unassigned student, nothing to match


def test_a_class_group_tag_that_is_not_a_real_schedule_value_never_participates():
    """The AttendanceStudio.jsx admin form's "Group tag (e.g. A1)"
    placeholder is misleading given this exact resolution — a CEFR-style
    tag like "A1" or a plain description never normalizes to a real
    Schedule value, so it correctly never matches ANY student via this
    mechanism (there being no structured CEFR data to match against
    regardless)."""
    assert att.class_matches_student_schedule("A1", "A") is False
    assert att.class_matches_student_schedule("Beginner", "A") is False
    assert att.class_matches_student_schedule("", "A") is False


# ── resolve_class_roster_ids — live, query-time auto-match ──────────────────
def test_a_newly_assigned_student_is_immediately_matched_with_zero_admin_action():
    """No sync/write step exists any more — a student's own `group` value
    is enough. Adding the student to the students collection with a
    matching schedule is the ONLY action; no roster array is touched."""
    db = _DB()
    _seed_class(db, "cls_a1", "A")
    _seed_class(db, "cls_a2", "A")
    _seed_class(db, "cls_b1", "B")
    _seed_student(db, "stu_alice", "A")
    assert run(att.resolve_class_roster_ids(db, db[att.COLL_CLASSES].docs["cls_a1"])) == {"stu_alice"}
    assert run(att.resolve_class_roster_ids(db, db[att.COLL_CLASSES].docs["cls_a2"])) == {"stu_alice"}
    assert run(att.resolve_class_roster_ids(db, db[att.COLL_CLASSES].docs["cls_b1"])) == set()
    # The class's own `roster` array was never written to.
    assert db[att.COLL_CLASSES].docs["cls_a1"]["roster"] == []


def test_an_ab_class_receives_students_from_either_schedule():
    db = _DB()
    _seed_class(db, "cls_ab", "AB")
    _seed_student(db, "stu_alice", "A")
    _seed_student(db, "stu_bob", "B")
    ids = run(att.resolve_class_roster_ids(db, db[att.COLL_CLASSES].docs["cls_ab"]))
    assert ids == {"stu_alice", "stu_bob"}


def test_an_empty_or_unassigned_group_never_matches_anything():
    db = _DB()
    _seed_class(db, "cls_a1", "A")
    _seed_student(db, "stu_alice", "")
    assert run(att.resolve_class_roster_ids(db, db[att.COLL_CLASSES].docs["cls_a1"])) == set()


def test_regression_a_manual_addition_never_drops_the_auto_matched_students():
    """THE bug this fix targets: an earlier write-on-event design flipped
    a class's resolution from "everyone matching Schedule A" to "only
    this one explicit id" the instant any student's schedule changed.
    Here an admin manually adds one extra (non-matching) student to a
    class that ALSO has real Schedule A students — both must be
    present, never either/or."""
    db = _DB()
    _seed_class(db, "cls_a1", "A", roster=["stu_manual"])  # admin-added exception, no Schedule A/B tag
    _seed_student(db, "stu_manual", "")  # doesn't have Schedule A — that's exactly why they were added manually
    _seed_student(db, "stu_alice", "A")
    _seed_student(db, "stu_charlie", "A")
    ids = run(att.resolve_class_roster_ids(db, db[att.COLL_CLASSES].docs["cls_a1"]))
    assert ids == {"stu_manual", "stu_alice", "stu_charlie"}


def test_regression_reverse_case_a_reassigned_student_leaves_the_live_match_immediately():
    """§2.3's explicit, documented decision only concerns explicit manual
    roster entries (an admin-added student stays until removed by hand —
    see test_regression_manual_admin_add_and_remove_still_works_untouched
    below). It was never meant to freeze the LIVE auto-match: a student
    who is reassigned away from a class's Schedule A/B tag stops being
    live-matched by that tag immediately, which is correct — they were
    never explicitly rostered there, only ever included because their
    schedule matched."""
    db = _DB()
    _seed_class(db, "cls_a1", "A")
    _seed_student(db, "stu_alice", "A")
    assert run(att.resolve_class_roster_ids(db, db[att.COLL_CLASSES].docs["cls_a1"])) == {"stu_alice"}
    db.students.docs["stu_alice"]["group"] = "B"
    assert run(att.resolve_class_roster_ids(db, db[att.COLL_CLASSES].docs["cls_a1"])) == set()


def test_regression_manual_admin_add_and_remove_still_works_untouched_by_auto_assignment():
    """§2.4 — the automation is purely additive; a class's explicit
    `roster` array (manual additions/exceptions) can still be edited
    directly via the existing RosterPicker / admin_update_class flow,
    independent of the live Schedule A/B match."""
    db = _DB()
    _seed_class(db, "cls_a1", "A", roster=["stu_manual"])
    _seed_student(db, "stu_manual", "")
    _seed_student(db, "stu_alice", "A")
    ids = run(att.resolve_class_roster_ids(db, db[att.COLL_CLASSES].docs["cls_a1"]))
    assert ids == {"stu_manual", "stu_alice"}
    # Manual removal (simulating the admin roster picker/update-class flow).
    db[att.COLL_CLASSES].docs["cls_a1"]["roster"] = []
    ids = run(att.resolve_class_roster_ids(db, db[att.COLL_CLASSES].docs["cls_a1"]))
    assert ids == {"stu_alice"}  # manual entry gone, live Schedule A match untouched


# ── source-level confirmation the write-on-event mechanism is gone ──────────
def test_no_write_on_event_hook_remains_in_the_three_former_call_sites():
    """The prior design wired an explicit sync call into every real write
    path for students.group (server.py's teacher_create_student /
    teacher_update_student, teacher_admission.py's _assign_schedule_one).
    That mechanism is gone by design (§2.5) — resolve_class_roster_ids /
    _class_roster already match live on every read, so there is nothing
    left to keep in sync and no choke point to enforce."""
    import pathlib
    root = pathlib.Path(__file__).resolve().parent.parent
    server_src = (root / "server.py").read_text(encoding="utf-8")
    admission_src = (root / "teacher_admission.py").read_text(encoding="utf-8")
    assert "sync_rosters_for_student_group" not in server_src
    assert "sync_rosters_for_student_group" not in admission_src
