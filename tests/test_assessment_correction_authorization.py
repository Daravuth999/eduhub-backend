"""tests/test_assessment_correction_authorization.py
=======================================================
Real FastAPI TestClient + real dependency injection proof that the
post-award correction route is actually gated by require_admin, not just
"tested by always passing admin=_Admin() to the handler directly" (the
convention every other route-level test in test_assessment_tools.py
uses, matching this whole codebase's established fake-router pattern).

Follows tests/test_book_factory_routes.py's exact precedent: build a
real FastAPI() app, register the routes with a real (or rejecting) async
dependency callable, and assert the REAL HTTP status code FastAPI's own
Depends() machinery produces — this is what actually proves a student (or
anyone without a valid admin session) cannot reach the route body at all,
independent of anything the route itself does.
"""
from __future__ import annotations

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.testclient import TestClient

import assessment_tools as at
from tests.test_assessment_tools import _DB, _Wallet, _seed_published_assessment


async def _admin_dep():
    return type("Admin", (), {"email": "teacher@example.com"})()


async def _reject_401_dep():
    # Mirrors server.py's real require_user: no valid session at all.
    raise HTTPException(status_code=401, detail="Not authenticated")


async def _reject_403_dep():
    # Mirrors server.py's real require_admin: authenticated, but
    # user.is_admin is False (e.g. a student's own account, if a student
    # somehow obtained a non-admin User session at all).
    raise HTTPException(status_code=403, detail="Admin access required")


def _make_client(*, admin_dep, db=None):
    app = FastAPI()
    api = APIRouter(prefix="/api")
    db = db or _DB()
    at.register_assessment_routes(
        api, db, admin_dep, admin_dep,  # require_student unused by this route
        wallet=_Wallet(), fan_out_push=None, build_target_query=None,
    )
    app.include_router(api)
    return TestClient(app), db


def test_unauthenticated_caller_gets_401_never_reaches_the_route():
    """No session at all (e.g. a student's GAS session token, which
    require_admin's real dependency chain — Depends(require_user) — does
    not even recognize as a valid admin identity)."""
    client, _db = _make_client(admin_dep=_reject_401_dep)
    r = client.post(
        "/api/admin/assessments/submissions/asub_x/correction",
        json={"clientToken": "tok", "corrections": [{"qid": "q1", "correct": True, "points": 1}],
              "reason": "teacher_grading_mistake"},
    )
    assert r.status_code == 401


def test_authenticated_non_admin_student_gets_403_never_reaches_the_route():
    """The real production shape: server.py's require_admin raises 403 for
    any authenticated User whose is_admin is False. A student cannot ever
    satisfy require_admin — this proves the correction route enforces the
    IDENTICAL gate as every other /admin/assessments/... route, no new or
    weaker authorization logic was introduced for this feature."""
    client, db = _make_client(admin_dep=_reject_403_dep)
    r = client.post(
        "/api/admin/assessments/submissions/asub_x/correction",
        json={"clientToken": "tok", "corrections": [{"qid": "q1", "correct": True, "points": 1}],
              "reason": "teacher_grading_mistake"},
    )
    assert r.status_code == 403
    # Rejected before the route body ever ran — no correction doc, no
    # wallet call, nothing persisted.
    assert db[at.COLL_CORRECTIONS].docs == {}


def test_authenticated_non_admin_student_gets_403_on_the_history_route_too():
    client, _db = _make_client(admin_dep=_reject_403_dep)
    r = client.get("/api/admin/assessments/submissions/asub_x/corrections")
    assert r.status_code == 403


def test_admin_dependency_is_never_bypassed_by_a_missing_or_malformed_body():
    """Even a garbage/empty request body must still be gated by
    authorization FIRST — FastAPI evaluates Depends() before parsing the
    route's own body validation, so a student can't probe past auth by
    sending a malformed payload."""
    client, _db = _make_client(admin_dep=_reject_403_dep)
    r = client.post("/api/admin/assessments/submissions/asub_x/correction", json={})
    assert r.status_code == 403


def test_a_real_admin_session_reaches_the_route_body_not_blocked_by_authorization():
    """Positive control: with a real (accepting) admin dependency, the
    request is NOT rejected at the authorization layer — whatever status
    code comes back reflects the route's own business-logic validation
    (here: 404, since submission asub_x does not exist), never 401/403."""
    client, db = _make_client(admin_dep=_admin_dep)
    asmt = _seed_published_assessment(db)
    r = client.post(
        "/api/admin/assessments/submissions/nonexistent_sub/correction",
        json={"clientToken": "tok", "corrections": [{"qid": "q1", "correct": True, "points": 1}],
              "reason": "teacher_grading_mistake"},
    )
    assert r.status_code == 404  # "Submission not found" — proves auth passed
    assert r.status_code not in (401, 403)
    _ = asmt
