"""eduhub_platform/events.py — the Event Platform's pluggable pub/sub bus
(Architecture Reconstruction Phase 4, "event platform").

Package named `eduhub_platform` rather than architecture.md's literal
`platform/` — see eduhub_platform/__init__.py for why. Per that module's
own charter: "identity resolution today [Phase 1]; ledger [Phase 2,
wallet_service.py] / config [Phase 3, config.py] / events / realtime /
notify... in later phases." This is the "events" half of Phase 4.

WHAT ALREADY EXISTS AND IS NOT BEING REPLACED
──────────────────────────────────────────────
An audit of this codebase's notification/push/realtime/scheduling
infrastructure (server.py's ``_fan_out_push``, notification_center.py,
restriction_realtime.py, the push_scheduled Mongo-queue) found a mature,
production event system already in place:

  * ``_fan_out_push`` (server.py) is already the SINGLE chokepoint every
    real platform event funnels through (points credits, lucky draw,
    mystery box, login rewards, attendance, teacher pushes, Speaking Lab
    admission, EduTalk coach rewards, tuition reminders, ...).
  * notification_center.py already wraps that chokepoint with an adapter
    (``wrap_fan_out_push``) that classifies each event (category /
    priority), persists it (TTL'd ``activity_notifications`` docs), and
    delivers it in realtime over an in-process WebSocket manager
    (``_WSManager``), plus a full REST API (list / unread-count /
    mark-read) and WS auth.
  * restriction_realtime.py reuses the SAME ``_fan_out_push`` chokepoint
    for student-status changes — no separate event system there either.
  * Scheduled pushes already have their own working mechanism (a
    ``push_scheduled`` Mongo queue drained by an external cron hitting
    ``POST /push/schedule/run-due``) — not a concern this module touches.

None of that is rebuilt here. The ONE genuine gap this audit found: the
existing WebSocket delivery through ``_WSManager`` is held in a single
process's memory. A WS client connected to app instance/worker A never
receives an event recorded by a request handled on instance/worker B —
fine for a single-instance deployment, a real gap the moment this app
runs with more than one worker/dyno. That is precisely the problem Redis
pub/sub solves, and precisely why "events" and "Redis" are named
together in the approved architecture.

WHAT THIS MODULE ADDS
──────────────────────
A minimal, transport-pluggable ``EventBus``:

  * ``InProcessTransport`` — the safe default. Delivers a published
    message directly to whatever local subscribers this SAME process
    has registered. This is what every deployment gets today (a
    single-instance app doesn't need cross-instance bridging at all),
    and it is what every test in this codebase runs against.
  * ``RedisTransport`` — publishes to / subscribes from a Redis Pub/Sub
    channel via ``redis.asyncio`` (lazily imported — this module and
    every caller of it remain fully importable on a machine that has
    never installed the ``redis`` package or never provisioned a Redis
    server). When multiple app instances share the same Redis, a
    message published on one instance is relayed to every instance's
    local subscribers — the missing piece for notification_center.py's
    realtime layer to work correctly at more than one instance.

Transport selection goes through eduhub_platform.config (Phase 3) —
``EVENT_BUS_TRANSPORT`` resolves to ``"in_process"`` (default) or
``"redis"``. A connection failure on the Redis transport NEVER raises
into the publisher — it logs a warning and the message is simply not
bridged that one time; the app, the WebSocket layer, and every existing
push flow keep working exactly as if Redis were never configured. This
module has no business rules of its own and never imports a business-
domain module (server.py, notification_center.py, wallet_service.py,
etc.) — those import THIS, never the reverse, matching the package's own
one-way dependency contract.

INTEGRATION POINT (not wired by this file — see notification_center.py's
own bridge, which is the one real call site that uses this bus today):
notification_center.py's ``_record_event`` publishes to the bus's
``"activity_notifications"`` channel after recording locally, and its
startup hook subscribes to that same channel to relay incoming bridged
messages into its own local ``_ws_manager`` — additive, and a no-op
difference from today's behaviour whenever the transport is
``"in_process"`` (the default, and the only transport that works without
a Redis server actually being provisioned).
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Awaitable, Callable

log = logging.getLogger("eduhub.event_bus")

Handler = Callable[[dict], Awaitable[None]]
Unsubscribe = Callable[[], Awaitable[None]]


class EventTransport:
    """Base transport interface. Subclasses implement publish/subscribe;
    callers should depend on this type, never a concrete transport."""

    async def publish(self, channel: str, payload: dict[str, Any]) -> None:
        raise NotImplementedError

    async def subscribe(self, channel: str, handler: Handler) -> Unsubscribe:
        raise NotImplementedError

    async def close(self) -> None:
        """Release any held resources (connections, background tasks).
        Safe to call even if nothing was ever opened."""


class InProcessTransport(EventTransport):
    """Pure in-memory pub/sub within THIS process. No cross-instance
    bridging — the correct, sufficient choice for a single-instance
    deployment, and the transport every test in this codebase runs
    against by default."""

    def __init__(self) -> None:
        self._subscribers: dict[str, set[Handler]] = {}
        self._lock = asyncio.Lock()

    async def publish(self, channel: str, payload: dict[str, Any]) -> None:
        async with self._lock:
            handlers = set(self._subscribers.get(channel, set()))
        for handler in handlers:
            try:
                await handler(payload)
            except Exception as exc:  # noqa: BLE001 — one bad subscriber must not break others
                log.warning("event_bus(in_process): subscriber raised for channel %r: %s",
                            channel, str(exc)[:200])

    async def subscribe(self, channel: str, handler: Handler) -> Unsubscribe:
        async with self._lock:
            self._subscribers.setdefault(channel, set()).add(handler)

        async def _unsubscribe() -> None:
            async with self._lock:
                bucket = self._subscribers.get(channel)
                if bucket:
                    bucket.discard(handler)
                    if not bucket:
                        self._subscribers.pop(channel, None)

        return _unsubscribe


class RedisTransport(EventTransport):
    """Redis Pub/Sub-backed transport for multi-instance deployments.

    ``redis.asyncio`` is imported lazily inside ``_client()`` so this
    module (and everything that imports it) stays importable without the
    ``redis`` package installed or a Redis server reachable — exactly the
    same defensive-import posture wallet_service.py already uses for
    ``httpx``. Every public method degrades to a no-op + warning log on
    any connection failure; it NEVER raises into the caller.
    """

    def __init__(self, redis_url: str) -> None:
        self._redis_url = redis_url
        self._client_obj: Any = None
        self._pubsub_tasks: dict[str, asyncio.Task] = {}
        self._local: dict[str, set[Handler]] = {}
        self._lock = asyncio.Lock()

    def _client(self) -> Any:
        if self._client_obj is not None:
            return self._client_obj
        try:
            import redis.asyncio as redis_asyncio  # type: ignore
        except Exception as exc:  # noqa: BLE001
            log.warning("event_bus(redis): 'redis' package not available: %s", exc)
            return None
        try:
            self._client_obj = redis_asyncio.Redis.from_url(
                self._redis_url, decode_responses=True,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("event_bus(redis): failed to construct client: %s", exc)
            self._client_obj = None
        return self._client_obj

    async def publish(self, channel: str, payload: dict[str, Any]) -> None:
        client = self._client()
        if client is None:
            return
        try:
            await client.publish(channel, json.dumps(payload, default=str))
        except Exception as exc:  # noqa: BLE001 — a Redis outage must never break the publisher
            log.warning("event_bus(redis): publish failed for channel %r: %s",
                        channel, str(exc)[:200])

    async def subscribe(self, channel: str, handler: Handler) -> Unsubscribe:
        async with self._lock:
            self._local.setdefault(channel, set()).add(handler)
            already_listening = channel in self._pubsub_tasks

        if not already_listening:
            client = self._client()
            if client is not None:
                try:
                    task = asyncio.create_task(self._listen(channel))
                    async with self._lock:
                        self._pubsub_tasks[channel] = task
                except Exception as exc:  # noqa: BLE001
                    log.warning("event_bus(redis): subscribe failed for channel %r: %s",
                                channel, str(exc)[:200])

        async def _unsubscribe() -> None:
            async with self._lock:
                bucket = self._local.get(channel)
                if bucket:
                    bucket.discard(handler)
                if bucket is not None and not bucket:
                    self._local.pop(channel, None)
                    task = self._pubsub_tasks.pop(channel, None)
                    if task is not None:
                        task.cancel()

        return _unsubscribe

    async def _listen(self, channel: str) -> None:
        client = self._client()
        if client is None:
            return
        try:
            pubsub = client.pubsub()
            await pubsub.subscribe(channel)
        except Exception as exc:  # noqa: BLE001
            log.warning("event_bus(redis): pubsub.subscribe failed for %r: %s", channel, exc)
            return
        try:
            async for message in pubsub.listen():
                if message is None or message.get("type") != "message":
                    continue
                try:
                    payload = json.loads(message["data"])
                except Exception:  # noqa: BLE001 — malformed message, skip it
                    continue
                async with self._lock:
                    handlers = set(self._local.get(channel, set()))
                for handler in handlers:
                    try:
                        await handler(payload)
                    except Exception as exc:  # noqa: BLE001
                        log.warning("event_bus(redis): subscriber raised for channel %r: %s",
                                    channel, str(exc)[:200])
        except asyncio.CancelledError:
            pass
        except Exception as exc:  # noqa: BLE001
            log.warning("event_bus(redis): listener stopped for channel %r: %s", channel, exc)
        finally:
            try:
                await pubsub.unsubscribe(channel)
                await pubsub.close()
            except Exception:  # noqa: BLE001
                pass

    async def close(self) -> None:
        for task in list(self._pubsub_tasks.values()):
            task.cancel()
        self._pubsub_tasks.clear()
        if self._client_obj is not None:
            try:
                await self._client_obj.aclose()
            except Exception:  # noqa: BLE001
                pass


class EventBus:
    """The single object callers hold. Delegates to whichever transport
    was resolved at construction time — callers never branch on
    transport type themselves."""

    def __init__(self, transport: EventTransport) -> None:
        self._transport = transport

    async def publish(self, channel: str, payload: dict[str, Any]) -> None:
        await self._transport.publish(channel, payload)

    async def subscribe(self, channel: str, handler: Handler) -> Unsubscribe:
        return await self._transport.subscribe(channel, handler)

    async def close(self) -> None:
        await self._transport.close()


async def build_event_bus(db) -> EventBus:
    """Resolve the configured transport (published override > env var >
    default "in_process") and construct the matching EventBus. Never
    raises: any resolution or construction problem falls back to
    InProcessTransport, which requires no external resources at all.
    """
    from eduhub_platform.config import resolve_flag

    transport_name = "in_process"
    try:
        value, _source = await resolve_flag(
            db, "EVENT_BUS_TRANSPORT", default="in_process",
        )
        transport_name = str(value or "in_process").strip().lower()
    except Exception as exc:  # noqa: BLE001
        log.warning("event_bus: transport resolution failed, defaulting to in_process: %s", exc)

    if transport_name == "redis":
        import os as _os
        redis_url = _os.environ.get("REDIS_URL", "")
        if redis_url:
            return EventBus(RedisTransport(redis_url))
        log.warning("event_bus: EVENT_BUS_TRANSPORT=redis but REDIS_URL is not set; "
                    "falling back to in_process")

    return EventBus(InProcessTransport())


__all__ = [
    "EventTransport",
    "InProcessTransport",
    "RedisTransport",
    "EventBus",
    "build_event_bus",
]
