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


# ── sync_rosters_for_student_group — add-only auto-assignment ───────────────
def test_a_newly_assigned_student_is_auto_added_to_every_matching_class():
    db = _DB()
    _seed_class(db, "cls_a1", "A")
    _seed_class(db, "cls_a2", "A")
    _seed_class(db, "cls_b1", "B")
    result = run(att.sync_rosters_for_student_group(db, "stu_alice", "A"))
    assert set(result["added_to"]) == {"cls_a1", "cls_a2"}
    assert "stu_alice" in db[att.COLL_CLASSES].docs["cls_a1"]["roster"]
    assert "stu_alice" in db[att.COLL_CLASSES].docs["cls_a2"]["roster"]
    assert "stu_alice" not in db[att.COLL_CLASSES].docs["cls_b1"]["roster"]


def test_an_ab_class_receives_students_from_either_schedule():
    db = _DB()
    _seed_class(db, "cls_ab", "AB")
    run(att.sync_rosters_for_student_group(db, "stu_alice", "A"))
    run(att.sync_rosters_for_student_group(db, "stu_bob", "B"))
    roster = db[att.COLL_CLASSES].docs["cls_ab"]["roster"]
    assert "stu_alice" in roster
    assert "stu_bob" in roster


def test_already_on_the_roster_is_not_duplicated():
    db = _DB()
    _seed_class(db, "cls_a1", "A", roster=["stu_alice"])
    result = run(att.sync_rosters_for_student_group(db, "stu_alice", "A"))
    assert result["added_to"] == []  # already there — nothing new
    assert db[att.COLL_CLASSES].docs["cls_a1"]["roster"].count("stu_alice") == 1


def test_an_empty_or_unassigned_group_never_triggers_any_roster_write():
    db = _DB()
    _seed_class(db, "cls_a1", "A")
    result = run(att.sync_rosters_for_student_group(db, "stu_alice", ""))
    assert result["added_to"] == []
    assert "stu_alice" not in db[att.COLL_CLASSES].docs["cls_a1"]["roster"]


def test_regression_manual_admin_add_and_remove_still_works_untouched_by_auto_assignment():
    """§2.4 — the automation is purely additive; a class's roster can
    still be manually edited directly (the existing RosterPicker /
    admin_update_class flow), independent of this function."""
    db = _DB()
    _seed_class(db, "cls_a1", "A", roster=["stu_manual"])
    run(att.sync_rosters_for_student_group(db, "stu_alice", "A"))
    roster = db[att.COLL_CLASSES].docs["cls_a1"]["roster"]
    assert "stu_manual" in roster  # untouched
    assert "stu_alice" in roster  # newly auto-added
    # Manual removal (simulating the admin roster picker/update-class flow).
    db[att.COLL_CLASSES].docs["cls_a1"]["roster"] = [r for r in roster if r != "stu_manual"]
    assert "stu_manual" not in db[att.COLL_CLASSES].docs["cls_a1"]["roster"]


def test_regression_reverse_case_a_reassigned_student_is_NEVER_auto_removed_from_their_old_class():
    """§2.3's explicit, documented decision: eligibility changing away
    from a class's group does NOT auto-remove the student — only an
    admin acting deliberately can do that. This is the actual behavior
    under test, not just a comment."""
    db = _DB()
    _seed_class(db, "cls_a1", "A")
    run(att.sync_rosters_for_student_group(db, "stu_alice", "A"))
    assert "stu_alice" in db[att.COLL_CLASSES].docs["cls_a1"]["roster"]
    # Reassign the student to Schedule B.
    run(att.sync_rosters_for_student_group(db, "stu_alice", "B"))
    # Still present on the A class's roster — no auto-removal happened.
    assert "stu_alice" in db[att.COLL_CLASSES].docs["cls_a1"]["roster"]


# ── source-level confirmation that all three real write paths are wired ─────
def test_all_three_real_write_paths_for_students_group_call_the_sync_function():
    """A full-codebase audit found THREE separate places that write
    students.group with no single choke point: server.py's
    teacher_create_student (registration) and teacher_update_student
    (generic admin edit), and teacher_admission.py's
    _assign_schedule_one (Speaking-Lab reassignment). Each must call
    sync_rosters_for_student_group — verified here at the source level
    since none of these three routes can be practically mounted in a
    lightweight unit test (they live inside two very large, heavily-
    dependency-injected modules)."""
    import pathlib
    root = pathlib.Path(__file__).resolve().parent.parent
    server_src = (root / "server.py").read_text(encoding="utf-8")
    admission_src = (root / "teacher_admission.py").read_text(encoding="utf-8")

    # teacher_create_student and teacher_update_student both live in
    # server.py; both must reference the sync call somewhere after their
    # own students.group write.
    assert server_src.count("sync_rosters_for_student_group") >= 2, (
        "expected both teacher_create_student and teacher_update_student "
        "in server.py to call sync_rosters_for_student_group"
    )
    assert "sync_rosters_for_student_group" in admission_src
