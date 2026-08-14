"""tests/test_push_target_query.py
=====================================
Regression tests for _build_target_query (server.py:1402).

Loads the function directly from server.py source via ast/exec so the
test exercises the live code and fails if the patch is reverted — not a
copy. No server import required (avoids pywebpush / env-var deps).

Critical regression: before the fix, "session_pending_checkin" and
"at_risk_score" fell through to ``return {}`` which broadcasts to ALL
push subscribers instead of only the intended students.
"""
from __future__ import annotations

import ast
import textwrap
import types


def _load_build_target_query():
    """Extract and exec _build_target_query from server.py source."""
    src = open("server.py", encoding="utf-8", errors="replace").read()
    tree = ast.parse(src)
    fn_node = next(
        n for n in ast.walk(tree)
        if isinstance(n, ast.FunctionDef) and n.name == "_build_target_query"
    )
    lines = src.splitlines()
    fn_src = "\n".join(lines[fn_node.lineno - 1 : fn_node.end_lineno])
    fn_src = textwrap.dedent(fn_src)
    ns: dict = {}
    exec(compile(fn_src, "server.py", "exec"), ns)  # noqa: S102
    return ns["_build_target_query"]


_btq = _load_build_target_query()


# ── existing targets — must not regress ──────────────────────────────────────

def test_everyone_returns_empty_dict():
    assert _btq("everyone", [], None) == {}


def test_group_returns_group_query():
    assert _btq("group", [], "A1") == {"group": "A1"}


def test_students_returns_or_query():
    result = _btq("students", ["stu_alice"], None)
    assert "$or" in result
    assert result != {}


def test_students_empty_list_returns_empty_in():
    result = _btq("students", [], None)
    assert result == {"studentId": {"$in": []}}


def test_unknown_target_still_returns_empty_dict():
    # Callers outside attendance that pass an unrecognised target must still
    # get the safe {} fallback (matches nobody when used as a push filter,
    # since push_subscriptions has no documents matching a nonsense key).
    # NOTE: {} actually matches ALL documents in MongoDB — this is the
    # pre-existing "broadcast" behaviour for truly unknown targets and is
    # intentionally left unchanged here. Only the attendance targets are
    # specifically routed.
    result = _btq("completely_unknown_target", ["stu_x"], None)
    assert result == {}


# ── attendance targets — the critical regression fix ─────────────────────────

def test_session_pending_checkin_does_not_return_empty_dict():
    """Closing-soon nudge must reach only pending students, not everyone."""
    result = _btq("session_pending_checkin", ["stu_alice", "stu_bob"], None)
    assert result != {}, (
        "_build_target_query('session_pending_checkin', ...) returned {} "
        "which would broadcast to ALL subscribers — patch missing or reverted"
    )


def test_session_pending_checkin_routes_to_student_ids():
    result = _btq("session_pending_checkin", ["stu_alice"], None)
    assert "$or" in result
    # each entry must reference the studentId field
    for clause in result["$or"]:
        assert "studentId" in clause


def test_at_risk_score_does_not_return_empty_dict():
    """At-risk nudge must reach only flagged students, not everyone."""
    result = _btq("at_risk_score", ["stu_carol"], None)
    assert result != {}, (
        "_build_target_query('at_risk_score', ...) returned {} "
        "which would broadcast to ALL subscribers — patch missing or reverted"
    )


def test_at_risk_score_routes_to_student_ids():
    result = _btq("at_risk_score", ["stu_carol"], None)
    assert "$or" in result
    for clause in result["$or"]:
        assert "studentId" in clause


def test_attendance_targets_empty_ids_return_empty_in():
    """Empty ID list for attendance targets must not match any subscriber."""
    for target in ("session_pending_checkin", "at_risk_score"):
        result = _btq(target, [], None)
        assert result == {"studentId": {"$in": []}}, (
            f"Empty {target!r} returned {result!r} — should match nobody"
        )


def test_attendance_targets_case_insensitive_match():
    """Student IDs are case-insensitive in the push subscription lookup."""
    result = _btq("session_pending_checkin", ["STU_Alice"], None)
    assert "$or" in result
    clause = result["$or"][0]["studentId"]
    assert "$options" in clause and "i" in clause["$options"]
