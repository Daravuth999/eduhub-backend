"""tests/test_eduhub_platform_events.py
=====================================================
Architecture Reconstruction Phase 4 ("event platform"). An audit of this
codebase's existing notification/push/realtime infrastructure found a
mature system already in place (server.py's `_fan_out_push` chokepoint +
notification_center.py's classify/persist/in-process-WebSocket adapter) —
this module does NOT replace any of that. It adds the one genuinely
missing piece: a pluggable pub/sub bus so notification_center.py's
realtime layer can bridge across multiple app instances once Redis is
actually provisioned, while remaining a no-op difference (in_process
transport) for every deployment that hasn't provisioned Redis yet.

These tests cover eduhub_platform/events.py only — InProcessTransport,
RedisTransport (against a hand-rolled fake pub/sub client, never a real
Redis server), and build_event_bus's resolution/fallback logic.
"""
from __future__ import annotations

import asyncio
import json

import pytest

import eduhub_platform.events as ev


# ═════════════════════════════════════════════════════════════════════════
# InProcessTransport
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_in_process_delivers_to_local_subscriber():
    transport = ev.InProcessTransport()
    received = []

    async def handler(payload):
        received.append(payload)

    await transport.subscribe("chan", handler)
    await transport.publish("chan", {"hello": "world"})
    assert received == [{"hello": "world"}]


@pytest.mark.asyncio
async def test_in_process_publish_with_no_subscribers_is_a_noop():
    transport = ev.InProcessTransport()
    await transport.publish("chan", {"x": 1})  # must not raise


@pytest.mark.asyncio
async def test_in_process_multiple_subscribers_all_receive():
    transport = ev.InProcessTransport()
    a_calls, b_calls = [], []

    async def a(p):
        a_calls.append(p)

    async def b(p):
        b_calls.append(p)

    await transport.subscribe("chan", a)
    await transport.subscribe("chan", b)
    await transport.publish("chan", {"v": 1})
    assert a_calls == [{"v": 1}]
    assert b_calls == [{"v": 1}]


@pytest.mark.asyncio
async def test_in_process_unsubscribe_stops_delivery():
    transport = ev.InProcessTransport()
    received = []

    async def handler(payload):
        received.append(payload)

    unsub = await transport.subscribe("chan", handler)
    await unsub()
    await transport.publish("chan", {"v": 1})
    assert received == []


@pytest.mark.asyncio
async def test_in_process_one_bad_subscriber_does_not_block_others():
    transport = ev.InProcessTransport()
    received = []

    async def bad(payload):
        raise RuntimeError("boom")

    async def good(payload):
        received.append(payload)

    await transport.subscribe("chan", bad)
    await transport.subscribe("chan", good)
    await transport.publish("chan", {"v": 1})  # must not raise
    assert received == [{"v": 1}]


@pytest.mark.asyncio
async def test_in_process_channels_are_isolated():
    transport = ev.InProcessTransport()
    a_calls, b_calls = [], []

    async def a(p):
        a_calls.append(p)

    async def b(p):
        b_calls.append(p)

    await transport.subscribe("chan_a", a)
    await transport.subscribe("chan_b", b)
    await transport.publish("chan_a", {"v": 1})
    assert a_calls == [{"v": 1}]
    assert b_calls == []


# ═════════════════════════════════════════════════════════════════════════
# RedisTransport — against a fake pub/sub client, never a real Redis server
# ═════════════════════════════════════════════════════════════════════════
class _FakePubSub:
    def __init__(self, bus: "_FakeRedis"):
        self._bus = bus
        self._channel = None
        self._queue: asyncio.Queue = asyncio.Queue()

    async def subscribe(self, channel):
        self._channel = channel
        self._bus._pubsubs.setdefault(channel, []).append(self)

    async def listen(self):
        while True:
            msg = await self._queue.get()
            if msg is None:
                return
            yield msg

    async def unsubscribe(self, channel):
        bucket = self._bus._pubsubs.get(channel) or []
        if self in bucket:
            bucket.remove(self)

    async def close(self):
        pass

    async def _deliver(self, data):
        await self._queue.put({"type": "message", "data": data})


class _FakeRedis:
    def __init__(self):
        self._pubsubs: dict[str, list[_FakePubSub]] = {}
        self.published: list[tuple[str, str]] = []
        self.fail_publish = False

    @classmethod
    def from_url(cls, url, decode_responses=True):
        instance = cls()
        _FakeRedis._last_instance = instance
        return instance

    def pubsub(self):
        return _FakePubSub(self)

    async def publish(self, channel, data):
        if self.fail_publish:
            raise ConnectionError("simulated redis outage")
        self.published.append((channel, data))
        for ps in list(self._pubsubs.get(channel, [])):
            await ps._deliver(data)

    async def aclose(self):
        pass


def _wire_fake_client(transport: "ev.RedisTransport") -> _FakeRedis:
    """Bypass RedisTransport._client()'s real `import redis.asyncio` entirely
    by pre-seeding the cached client object it would otherwise construct —
    avoids fighting the real installed `redis` package's own import
    machinery in a test environment that legitimately has it installed."""
    fake = _FakeRedis()
    transport._client_obj = fake
    return fake


@pytest.mark.asyncio
async def test_redis_transport_publish_reaches_local_subscriber():
    transport = ev.RedisTransport("redis://fake")
    _wire_fake_client(transport)
    received = []

    async def handler(payload):
        received.append(payload)

    await transport.subscribe("chan", handler)
    await asyncio.sleep(0)  # let the listener task start
    await transport.publish("chan", {"hello": "redis"})
    await asyncio.sleep(0.05)  # let the listener task process the message
    assert received == [{"hello": "redis"}]
    await transport.close()


@pytest.mark.asyncio
async def test_redis_transport_publish_failure_never_raises():
    transport = ev.RedisTransport("redis://fake")
    client = _wire_fake_client(transport)
    client.fail_publish = True
    await transport.publish("chan", {"v": 1})  # must not raise
    await transport.close()


@pytest.mark.asyncio
async def test_redis_transport_missing_package_degrades_silently(monkeypatch):
    import sys
    monkeypatch.delitem(sys.modules, "redis.asyncio", raising=False)
    monkeypatch.delitem(sys.modules, "redis", raising=False)

    import builtins
    real_import = builtins.__import__

    def _blocked_import(name, *a, **k):
        if name == "redis.asyncio" or name.startswith("redis"):
            raise ImportError("simulated: redis package not installed")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", _blocked_import)
    transport = ev.RedisTransport("redis://fake")
    await transport.publish("chan", {"v": 1})  # must not raise
    unsub = await transport.subscribe("chan", lambda p: None)
    await unsub()  # must not raise
    await transport.close()


# ═════════════════════════════════════════════════════════════════════════
# build_event_bus — transport resolution + fallback
# ═════════════════════════════════════════════════════════════════════════
class _FakeConfigDB:
    """Minimal fake matching eduhub_platform.config's expected db shape."""
    def __init__(self, override=None):
        self._override = override

    def __getitem__(self, name):
        return self

    async def find_one(self, query, projection=None):
        if self._override is None:
            return None
        return {"value": self._override}


@pytest.mark.asyncio
async def test_build_event_bus_defaults_to_in_process():
    db = _FakeConfigDB()
    bus = await ev.build_event_bus(db)
    assert isinstance(bus._transport, ev.InProcessTransport)


@pytest.mark.asyncio
async def test_build_event_bus_redis_without_url_falls_back_to_in_process(monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)
    db = _FakeConfigDB(override="redis")
    bus = await ev.build_event_bus(db)
    assert isinstance(bus._transport, ev.InProcessTransport)


@pytest.mark.asyncio
async def test_build_event_bus_redis_with_url_uses_redis_transport(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "redis://fake:6379")
    db = _FakeConfigDB(override="redis")
    bus = await ev.build_event_bus(db)
    assert isinstance(bus._transport, ev.RedisTransport)


@pytest.mark.asyncio
async def test_build_event_bus_resolution_failure_falls_back_to_in_process():
    class _BrokenDB:
        def __getitem__(self, name):
            raise ConnectionError("simulated outage")
    bus = await ev.build_event_bus(_BrokenDB())
    assert isinstance(bus._transport, ev.InProcessTransport)


# ═════════════════════════════════════════════════════════════════════════
# EventBus — thin delegation wrapper
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_event_bus_delegates_publish_and_subscribe():
    transport = ev.InProcessTransport()
    bus = ev.EventBus(transport)
    received = []

    async def handler(p):
        received.append(p)

    await bus.subscribe("chan", handler)
    await bus.publish("chan", {"v": 1})
    assert received == [{"v": 1}]
    await bus.close()
