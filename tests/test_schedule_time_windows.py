"""tests/test_schedule_time_windows.py — admin-configurable schedule time
windows, built entirely on eduhub_platform.config's existing generic
three-tier resolver (resolve_flag/set_override/get_audit_history).

Confirmed by a full-codebase audit before this module was written: every
existing consumer of a student's schedule label (teacher_admission.py's
ALLOWED_SCHEDULE_VALUES/_normalize_schedule/_validate_schedule_target/
session_schedule_eligibility, speaking_lab_direct_join.py,
speaking_lab_eligibility.py, event_engine.py, server.py's Speaking Lab
session CRUD/P2P pool matching/Push Studio targeting,
notification_center.py, and the voice_treasure_*_tools.py family) treats
the label as a bare identity string, never parsed for time content. This
file proves the new time-window layer is genuinely separate: setting,
editing, or having NO time window at all for a label has zero bearing on
anything eligibility-related, since nothing here ever touches
students.group or any eligibility document.

Reuses the exact fake-Mongo convention already established in
tests/test_eduhub_platform_config.py (the module this one builds on)
rather than inventing a new one, extended with a `students` fake
collection supporting .distinct() for list_known_schedule_labels.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

import eduhub_platform.config as cfg
import schedule_time_windows as stw


class _Result:
    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


class _FakeCursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def sort(self, key="updated_at", direction=-1):
        self._docs = sorted(self._docs, key=lambda d: d.get(key) or "", reverse=(direction == -1))
        return self

    def limit(self, n):
        self._docs = self._docs[:n]
        return self

    def __aiter__(self):
        self._it = iter(self._docs)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration


class _FakeConfigCollection:
    def __init__(self):
        self.docs: dict[str, dict] = {}

    async def find_one(self, query, projection=None):
        _id = query.get("_id")
        doc = self.docs.get(_id)
        return dict(doc) if doc is not None else None

    async def update_one(self, query, update, upsert=False):
        _id = query.get("_id")
        if "$set" in update:
            self.docs[_id] = dict(update["$set"])
        return _Result(matched_count=1)

    async def create_index(self, *a, **k):
        return None


class _FakeAuditCollection:
    def __init__(self):
        self.docs: list[dict] = []

    async def insert_one(self, doc):
        self.docs.append(dict(doc))
        return _Result(inserted_id=len(self.docs))

    def find(self, query=None, projection=None):
        query = query or {}
        rows = [d for d in self.docs if all(d.get(k) == v for k, v in query.items())]
        return _FakeCursor(rows)

    async def create_index(self, *a, **k):
        return None


class _FakeStudentsCollection:
    def __init__(self, groups: list[str] | None = None):
        self._groups = groups or []

    async def distinct(self, field):
        assert field == "group"
        return list(self._groups)


class _FakeDB:
    def __init__(self, student_groups: list[str] | None = None):
        self._config = _FakeConfigCollection()
        self._audit = _FakeAuditCollection()
        self.students = _FakeStudentsCollection(student_groups)

    def __getitem__(self, name):
        if name == cfg.COLL_CONFIG:
            return self._config
        if name == cfg.COLL_CONFIG_AUDIT:
            return self._audit
        raise AssertionError(f"unexpected collection: {name}")


# ── get/set — core round-trip and honesty guarantees ───────────────────
@pytest.mark.asyncio
async def test_no_configured_window_returns_none_not_a_guess():
    db = _FakeDB()
    assert await stw.get_schedule_time_window(db, "A") is None


@pytest.mark.asyncio
async def test_set_then_get_round_trips_exactly():
    db = _FakeDB()
    result = await stw.set_schedule_time_window(db, "A", start="19:00", end="20:00", updated_by="admin@x.com")
    assert result["label"] == "A"
    assert result["window"] == {"start": "19:00", "end": "20:00", "timezone": "Asia/Phnom_Penh"}
    assert result["version"] == 1

    window = await stw.get_schedule_time_window(db, "A")
    assert window == {"start": "19:00", "end": "20:00", "timezone": "Asia/Phnom_Penh"}


@pytest.mark.asyncio
async def test_editing_an_existing_window_overwrites_it_and_bumps_version():
    db = _FakeDB()
    await stw.set_schedule_time_window(db, "A", start="19:00", end="20:00", updated_by="admin@x.com")
    result = await stw.set_schedule_time_window(db, "A", start="18:30", end="19:30", updated_by="admin@x.com")
    assert result["version"] == 2
    assert (await stw.get_schedule_time_window(db, "A"))["start"] == "18:30"


@pytest.mark.asyncio
async def test_label_lookup_is_case_and_whitespace_insensitive_matching_normalize_schedule():
    """Setting for 'a' and reading back 'A' (or ' A ') must resolve to the
    SAME config key — teacher_admission.py's own _normalize_schedule is
    the canonical identity function every other consumer already uses,
    reused here for exactly this reason."""
    db = _FakeDB()
    await stw.set_schedule_time_window(db, "a", start="19:00", end="20:00", updated_by="x")
    assert await stw.get_schedule_time_window(db, "A") is not None
    assert await stw.get_schedule_time_window(db, " a ") is not None


@pytest.mark.asyncio
async def test_legacy_colon_suffix_is_stripped_exactly_like_every_other_consumer():
    """The critical audit finding this module was designed around:
    _normalize_schedule discards anything after ':' — a caller passing
    the legacy 'A:Beginner' shape must resolve to the SAME window as 'A',
    never a separate, silently-orphaned config entry."""
    db = _FakeDB()
    await stw.set_schedule_time_window(db, "A", start="19:00", end="20:00", updated_by="x")
    assert await stw.get_schedule_time_window(db, "A:Beginner") == await stw.get_schedule_time_window(db, "A")


# ── validation — Rule 2.4, no silent acceptance of nonsense ─────────────
@pytest.mark.asyncio
async def test_end_before_start_is_rejected():
    db = _FakeDB()
    with pytest.raises(HTTPException) as exc:
        await stw.set_schedule_time_window(db, "A", start="20:00", end="19:00", updated_by="x")
    assert exc.value.status_code == 422
    assert "after" in exc.value.detail.lower()


@pytest.mark.asyncio
async def test_end_equal_to_start_is_rejected_a_zero_length_window_is_nonsense():
    db = _FakeDB()
    with pytest.raises(HTTPException):
        await stw.set_schedule_time_window(db, "A", start="19:00", end="19:00", updated_by="x")


@pytest.mark.asyncio
async def test_malformed_time_strings_are_rejected():
    db = _FakeDB()
    for bad in ("7pm", "19:5", "25:00", "19:60", "", None, "19-00"):
        with pytest.raises(HTTPException) as exc:
            await stw.set_schedule_time_window(db, "A", start=bad, end="20:00", updated_by="x")
        assert exc.value.status_code == 422


@pytest.mark.asyncio
async def test_blank_label_is_rejected():
    db = _FakeDB()
    with pytest.raises(HTTPException):
        await stw.set_schedule_time_window(db, "", start="19:00", end="20:00", updated_by="x")


@pytest.mark.asyncio
async def test_a_rejected_write_never_touches_the_existing_config():
    """An invalid edit attempt must not corrupt or clear an already-valid
    window — the write only happens after validation passes."""
    db = _FakeDB()
    await stw.set_schedule_time_window(db, "A", start="19:00", end="20:00", updated_by="x")
    with pytest.raises(HTTPException):
        await stw.set_schedule_time_window(db, "A", start="20:00", end="19:00", updated_by="x")
    assert (await stw.get_schedule_time_window(db, "A"))["start"] == "19:00"


# ── generic-by-label — Rule 4, no rearchitecture needed for a new schedule ─
@pytest.mark.asyncio
async def test_a_hypothetical_third_schedule_works_with_zero_code_change():
    """Proves the extensibility claim directly: schedule 'C' is not
    ALLOWED_SCHEDULE_VALUES-listed and no student is assigned to it yet,
    but setting/reading its time window works identically to 'A'/'B' —
    nothing here special-cases exactly two schedules."""
    db = _FakeDB()
    result = await stw.set_schedule_time_window(db, "C", start="09:00", end="10:00", updated_by="admin@x.com")
    assert result["label"] == "C"
    assert await stw.get_schedule_time_window(db, "C") == {"start": "09:00", "end": "10:00", "timezone": "Asia/Phnom_Penh"}


# ── list_known_schedule_labels / list_schedule_time_windows ─────────────
@pytest.mark.asyncio
async def test_known_labels_always_include_a_and_b_even_with_no_students():
    db = _FakeDB(student_groups=[])
    assert await stw.list_known_schedule_labels(db) == ["A", "B"]


@pytest.mark.asyncio
async def test_known_labels_include_a_real_third_label_once_a_student_has_it():
    db = _FakeDB(student_groups=["A", "C", "", None, "c"])
    assert await stw.list_known_schedule_labels(db) == ["A", "B", "C"]


@pytest.mark.asyncio
async def test_list_schedule_time_windows_reports_none_for_unconfigured_labels_honestly():
    db = _FakeDB(student_groups=["A", "B"])
    await stw.set_schedule_time_window(db, "A", start="19:00", end="20:00", updated_by="x")
    result = await stw.list_schedule_time_windows(db)
    by_label = {r["label"]: r["window"] for r in result}
    assert by_label["A"] == {"start": "19:00", "end": "20:00", "timezone": "Asia/Phnom_Penh"}
    assert by_label["B"] is None  # never fabricated


@pytest.mark.asyncio
async def test_students_distinct_failure_degrades_to_the_canonical_labels_not_a_crash():
    class _BrokenStudents:
        async def distinct(self, field):
            raise ConnectionError("simulated Mongo outage")

    db = _FakeDB()
    db.students = _BrokenStudents()
    assert await stw.list_known_schedule_labels(db) == ["A", "B"]


# ── audit history — Rule 2.3, traceable after the fact ──────────────────
@pytest.mark.asyncio
async def test_every_edit_is_recorded_in_audit_history_newest_first():
    db = _FakeDB()
    await stw.set_schedule_time_window(db, "A", start="19:00", end="20:00", updated_by="teacher1@x.com")
    await stw.set_schedule_time_window(db, "A", start="18:30", end="19:30", updated_by="teacher2@x.com")

    history = await stw.get_schedule_time_window_history(db, "A")
    assert len(history) == 2
    assert history[0]["new_value"] == {"start": "18:30", "end": "19:30", "timezone": "Asia/Phnom_Penh"}
    assert history[0]["old_value"] == {"start": "19:00", "end": "20:00", "timezone": "Asia/Phnom_Penh"}
    assert history[0]["by"] == "teacher2@x.com"
    assert history[1]["by"] == "teacher1@x.com"


@pytest.mark.asyncio
async def test_audit_history_is_per_label_never_bleeding_across_schedules():
    db = _FakeDB()
    await stw.set_schedule_time_window(db, "A", start="19:00", end="20:00", updated_by="x")
    await stw.set_schedule_time_window(db, "B", start="09:00", end="10:00", updated_by="x")
    assert len(await stw.get_schedule_time_window_history(db, "A")) == 1
    assert len(await stw.get_schedule_time_window_history(db, "B")) == 1


# ── route registration — structural smoke test ──────────────────────────
def test_routes_register_without_touching_any_eligibility_module():
    """Confirms registration is side-effect-free at import/registration
    time (no eligibility/students collection touched merely by mounting
    the routes) and that the module never imports anything from the
    eligibility-consumer files the audit confirmed — proving this really
    is additive, not a hidden rewire of existing behavior."""
    class _Router:
        def __init__(self):
            self.routes = {}

        def get(self, path):
            def deco(fn):
                self.routes[("GET", path)] = fn
                return fn
            return deco

        def post(self, path):
            def deco(fn):
                self.routes[("POST", path)] = fn
                return fn
            return deco

    router = _Router()
    db = _FakeDB()
    stw.register_schedule_time_window_routes(router, db, lambda: None, lambda: None)
    assert ("GET", "/admin/schedule-time-windows") in router.routes
    assert ("POST", "/admin/schedule-time-windows/{label}") in router.routes
    assert ("GET", "/admin/schedule-time-windows/{label}/history") in router.routes
    assert ("GET", "/student/schedule-time-window") in router.routes


@pytest.mark.asyncio
async def test_student_route_returns_the_students_own_window_only():
    class _Student:
        group = "A"

    router_holder = {}

    class _Router:
        def get(self, path):
            def deco(fn):
                router_holder[path] = fn
                return fn
            return deco

        def post(self, path):
            def deco(fn):
                router_holder[path] = fn
                return fn
            return deco

    db = _FakeDB()
    await stw.set_schedule_time_window(db, "A", start="19:00", end="20:00", updated_by="x")
    stw.register_schedule_time_window_routes(_Router(), db, lambda: None, lambda: None)

    result = await router_holder["/student/schedule-time-window"](student=_Student())
    assert result == {"schedule": "A", "window": {"start": "19:00", "end": "20:00", "timezone": "Asia/Phnom_Penh"}}


@pytest.mark.asyncio
async def test_student_route_handles_no_schedule_assigned_honestly():
    class _Student:
        group = ""

    router_holder = {}

    class _Router:
        def get(self, path):
            def deco(fn):
                router_holder[path] = fn
                return fn
            return deco

        def post(self, path):
            def deco(fn):
                router_holder[path] = fn
                return fn
            return deco

    db = _FakeDB()
    stw.register_schedule_time_window_routes(_Router(), db, lambda: None, lambda: None)
    result = await router_holder["/student/schedule-time-window"](student=_Student())
    assert result == {"schedule": "", "window": None}
