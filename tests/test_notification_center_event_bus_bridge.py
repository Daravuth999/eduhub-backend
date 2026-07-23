"""tests/test_notification_center_event_bus_bridge.py
=====================================================
Architecture Reconstruction Phase 4 ("event platform"). notification_center
.py's realtime WebSocket layer (_ws_manager) is in-process only — this
phase's audit found that to be the one genuine gap mapping to "event
platform + Redis": a WS client on one app instance never sees an event
recorded on another. eduhub_platform.events.EventBus is the fix; these
tests prove notification_center.py's bridge (_dispatch_realtime /
_deliver_ws / the register_notification_center startup subscription)
behaves correctly in all three states:

  1. No bus initialized yet (_event_bus is None) — falls back to a direct
     local call, byte-identical to this module's behaviour before the
     bridge existed (this is what every OTHER existing notification_center
     test already exercises, since TestClient(app) without a context
     manager never fires the startup event in this test suite).
  2. A bus IS initialized (simulating register_notification_center's
     startup having run) — publishing reaches the subscribed local
     delivery function.
  3. The bus's publish raises — _dispatch_realtime degrades to the direct
     local call rather than losing the notification.
"""
from __future__ import annotations

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

import notification_center as nc
import eduhub_platform.events as ev


@pytest.fixture(autouse=True)
def _reset_event_bus():
    """notification_center._event_bus is a module-level global (like
    _ws_manager already was before this phase) — reset it around every
    test in this file so no test leaks its bus into another."""
    original = nc._event_bus
    nc._event_bus = None
    yield
    nc._event_bus = original


@pytest.mark.asyncio
async def test_dispatch_realtime_falls_back_to_direct_delivery_when_bus_is_none(monkeypatch):
    nc._event_bus = None
    delivered = []

    async def fake_deliver_ws(payload):
        delivered.append(payload)

    monkeypatch.setattr(nc, "_deliver_ws", fake_deliver_ws)
    await nc._dispatch_realtime({"student_ids": ["stu1"], "item": {"title": "hi"}})
    assert delivered == [{"student_ids": ["stu1"], "item": {"title": "hi"}}]


@pytest.mark.asyncio
async def test_dispatch_realtime_routes_through_bus_when_initialized():
    bus = ev.EventBus(ev.InProcessTransport())
    delivered = []

    async def fake_deliver_ws(payload):
        delivered.append(payload)

    await bus.subscribe(nc._REALTIME_CHANNEL, fake_deliver_ws)
    nc._event_bus = bus

    await nc._dispatch_realtime({"broadcast": True, "item": {"title": "hi"}})
    assert delivered == [{"broadcast": True, "item": {"title": "hi"}}]


@pytest.mark.asyncio
async def test_dispatch_realtime_degrades_to_direct_delivery_on_bus_publish_failure(monkeypatch):
    class _BrokenBus:
        async def publish(self, channel, payload):
            raise ConnectionError("simulated bus outage")

    nc._event_bus = _BrokenBus()
    delivered = []

    async def fake_deliver_ws(payload):
        delivered.append(payload)

    monkeypatch.setattr(nc, "_deliver_ws", fake_deliver_ws)
    await nc._dispatch_realtime({"student_ids": ["stu1"], "item": {"title": "hi"}})
    assert delivered == [{"student_ids": ["stu1"], "item": {"title": "hi"}}]


@pytest.mark.asyncio
async def test_bridge_reaches_ws_manager_via_deliver_ws_broadcast(monkeypatch):
    """End-to-end through the REAL _deliver_ws (not mocked) — proves the
    bus -> _deliver_ws -> _ws_manager wiring, using a fake _ws_manager to
    avoid needing a live WebSocket connection."""
    calls = []

    class _FakeWSManager:
        async def broadcast(self, payload):
            calls.append(("broadcast", payload))

        async def send_to(self, ids, payload):
            calls.append(("send_to", ids, payload))

    monkeypatch.setattr(nc, "_ws_manager", _FakeWSManager())

    bus = ev.EventBus(ev.InProcessTransport())
    await bus.subscribe(nc._REALTIME_CHANNEL, nc._deliver_ws)
    nc._event_bus = bus

    await nc._dispatch_realtime({"broadcast": True, "item": {"title": "broadcast-hi"}})
    assert calls == [("broadcast", {"type": "notification", "item": {"title": "broadcast-hi"}})]


@pytest.mark.asyncio
async def test_bridge_reaches_ws_manager_via_deliver_ws_send_to(monkeypatch):
    calls = []

    class _FakeWSManager:
        async def broadcast(self, payload):
            calls.append(("broadcast", payload))

        async def send_to(self, ids, payload):
            calls.append(("send_to", ids, payload))

    monkeypatch.setattr(nc, "_ws_manager", _FakeWSManager())

    bus = ev.EventBus(ev.InProcessTransport())
    await bus.subscribe(nc._REALTIME_CHANNEL, nc._deliver_ws)
    nc._event_bus = bus

    await nc._dispatch_realtime({"student_ids": ["stu1"], "item": {"title": "direct-hi"}})
    assert calls == [("send_to", ["stu1"], {"type": "notification", "item": {"title": "direct-hi"}})]


@pytest.mark.asyncio
async def test_two_bus_instances_sharing_in_process_transport_simulates_cross_instance():
    """A single InProcessTransport shared by two EventBus wrappers stands
    in for "two app instances sharing one Redis" — publishing from one
    reaches the OTHER's subscriber, proving the cross-instance relay shape
    this bridge is designed for (RedisTransport's real network behaviour
    is covered separately in tests/test_eduhub_platform_events.py)."""
    shared_transport = ev.InProcessTransport()
    instance_a_bus = ev.EventBus(shared_transport)
    instance_b_bus = ev.EventBus(shared_transport)

    instance_b_received = []

    async def instance_b_handler(payload):
        instance_b_received.append(payload)

    await instance_b_bus.subscribe("activity_notifications", instance_b_handler)
    await instance_a_bus.publish("activity_notifications", {"item": {"title": "cross-instance"}})

    assert instance_b_received == [{"item": {"title": "cross-instance"}}]


# ═════════════════════════════════════════════════════════════════════════
# GET /admin/event-bus/status — verification tooling (Phase 4)
# ═════════════════════════════════════════════════════════════════════════
class _FakeDB:
    def __getitem__(self, name):
        return self

    async def find_one(self, *a, **k):
        return None

    async def create_index(self, *a, **k):
        return "idx"


async def _fake_admin():
    return {"email": "admin@test"}


def test_event_bus_status_route_reports_not_initialized_before_startup():
    db = _FakeDB()
    app = FastAPI()
    api = APIRouter(prefix="/api")
    nc.register_notification_center(api, app, db, None, _fake_admin)
    app.include_router(api)
    client = TestClient(app)

    resp = client.get("/api/admin/event-bus/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["channel"] == "activity_notifications"
    assert "redis_url_configured" in body
    # TestClient(app) without a context manager never fires the startup
    # event in this test suite (see the module docstring above), so the
    # bus genuinely has not been initialized yet at this point.
    assert body["transport"] == "not_initialized"


def test_event_bus_status_route_not_mounted_without_require_admin():
    db = _FakeDB()
    app = FastAPI()
    api = APIRouter(prefix="/api")
    nc.register_notification_center(api, app, db, None)  # require_admin omitted
    app.include_router(api)
    client = TestClient(app)

    resp = client.get("/api/admin/event-bus/status")
    assert resp.status_code == 404


def test_event_bus_status_route_reports_transport_once_bus_is_set():
    db = _FakeDB()
    app = FastAPI()
    api = APIRouter(prefix="/api")
    nc.register_notification_center(api, app, db, None, _fake_admin)
    app.include_router(api)
    client = TestClient(app)

    nc._event_bus = ev.EventBus(ev.InProcessTransport())
    try:
        resp = client.get("/api/admin/event-bus/status")
        assert resp.json()["transport"] == "InProcessTransport"
    finally:
        nc._event_bus = None
