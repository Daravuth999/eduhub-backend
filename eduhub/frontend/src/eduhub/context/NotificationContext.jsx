/**
 * NotificationContext.jsx — Activity Center™ global state + realtime bridge.
 *
 * Mounts once (App.js, inside AuthProvider). When a student is authenticated
 * it: (1) loads the notification list + unread count over REST, (2) opens the
 * isolated realtime WebSocket with exponential-backoff reconnect, (3) falls
 * back to a light 60 s unread-count poll ONLY while the socket is down and
 * the tab is visible. Zero traffic when logged out.
 *
 * All items originate from real backend events — nothing is synthesised here.
 *
 * v1.1 — also tracks `unreadByCategory` (fed by the backend's additive
 * `byCategory` field on GET /notifications/unread-count). This is the ONE
 * place the unified badge platform (useUnifiedBadges.js) reads per-module
 * unread counts from — no second fetch, no second WebSocket, no duplicate
 * state. `unreadCount` itself is completely unchanged.
 *
 * v1.2 — Dashboard Bootstrap (stale-while-revalidate): items/unreadCount/
 * unreadByCategory are the Activity Feed + Notification summary resources
 * in the bootstrap set. Cached per-studentId so first paint for a
 * returning student shows the last-known activity/badges immediately
 * instead of an empty flash — see swrCache.js and the studentId-scoping
 * note on CACHE_KEY below (shared-device safety).
 */
import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from "react";
import { useAuth } from "./AuthContext";
import {
  buildNotificationsWsUrl, getUnreadCount, listNotifications,
  markAllNotificationsRead, markNotificationRead,
} from "../lib/notificationApi";
import { readSwrCache, writeSwrCache } from "../lib/swrCache";

const NotificationContext = createContext(null);
export const useNotifications = () => useContext(NotificationContext);

const PAGE_SIZE = 30;

// Dashboard Bootstrap (stale-while-revalidate): Activity Feed + notification
// summary (unreadCount/unreadByCategory badges) are the only personal,
// per-student resources in the bootstrap set. The cache key is namespaced
// by studentId — on a shared device, switching students must never show
// the previous student's activity for even one frame, so a cache
// write/read is only ever valid when the CURRENT authenticated studentId
// matches the cached one.
const CACHE_KEY = (studentId) => `eduhub_notif_cache_v1_${studentId}`;

function readCachedNotifications(studentId) {
  if (!studentId) return null;
  const entry = readSwrCache(CACHE_KEY(studentId));
  return entry ? entry.data : null;
}

function writeCachedNotifications(studentId, { items, hasMore, unreadCount, unreadByCategory }) {
  if (!studentId) return;
  writeSwrCache(CACHE_KEY(studentId), { items, hasMore, unreadCount, unreadByCategory });
}

export function NotificationProvider({ children }) {
  const { isAuthenticated, student } = useAuth() || {};
  const authed = Boolean(isAuthenticated && student?.studentId);
  const studentId = student?.studentId || null;

  // Seed synchronously from this student's last known-good state so the
  // Activity Feed / notification badges never show an empty/zero flash on
  // a returning launch — the refresh() effect below still fires
  // immediately after and is the source of truth once it resolves.
  const seed = authed ? readCachedNotifications(studentId) : null;

  const [items, setItems] = useState(seed?.items || []);
  const [hasMore, setHasMore] = useState(Boolean(seed?.hasMore));
  const [unreadCount, setUnreadCount] = useState(seed?.unreadCount || 0);
  const [unreadByCategory, setUnreadByCategory] = useState(seed?.unreadByCategory || {});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lastArrival, setLastArrival] = useState(null); // realtime pulse for bell/Cathy

  const wsRef = useRef(null);
  const retryRef = useRef(0);
  const closedRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!authed) return;
    setLoading(true);
    try {
      const [list, count] = await Promise.all([
        listNotifications({ limit: PAGE_SIZE }),
        getUnreadCount(),
      ]);
      const next = {
        items: list.items || [],
        hasMore: Boolean(list.hasMore),
        unreadCount: count.count || 0,
        unreadByCategory: count.byCategory || {},
      };
      setItems(next.items);
      setHasMore(next.hasMore);
      setUnreadCount(next.unreadCount);
      setUnreadByCategory(next.unreadByCategory);
      writeCachedNotifications(studentId, next);
    } catch {
      /* backend unreachable — keep whatever we have, never fabricate */
    } finally {
      setLoading(false);
    }
  }, [authed, studentId]);

  const loadMore = useCallback(async () => {
    if (!authed || !items.length) return;
    try {
      const before = items[items.length - 1].createdAt;
      const list = await listNotifications({ limit: PAGE_SIZE, before });
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...(list.items || []).filter((i) => !seen.has(i.id))];
      });
      setHasMore(Boolean(list.hasMore));
    } catch {
      /* ignore */
    }
  }, [authed, items]);

  const markRead = useCallback(async (id) => {
    // Read the category from `items` synchronously, BEFORE any setState —
    // a value assigned inside a setItems() updater callback is not
    // guaranteed to be readable by the code immediately after the call
    // (React may defer running the updater), so `items` must be a real
    // dependency here (same pattern loadMore already uses above).
    const target = items.find((n) => n.id === id && !n.read);
    const markedCategory = target ? (target.category || "system") : null;

    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    if (markedCategory) {
      setUnreadCount((c) => Math.max(0, c - 1));
      setUnreadByCategory((prev) => {
        const next = { ...prev };
        next[markedCategory] = Math.max(0, (next[markedCategory] || 0) - 1);
        return next;
      });
    }
    try {
      await markNotificationRead(id);
    } catch {
      /* optimistic — resync on next refresh */
    }
  }, [items]);

  const markAllRead = useCallback(async () => {
    setItems((prev) => prev.map((n) => (n.read ? n : { ...n, read: true })));
    setUnreadCount(0);
    setUnreadByCategory({});
    try {
      await markAllNotificationsRead();
    } catch {
      /* optimistic */
    }
  }, []);

  // ── realtime WS with reconnect ──────────────────────────────────────────
  useEffect(() => {
    if (!authed) {
      setItems([]); setUnreadCount(0); setUnreadByCategory({}); setDrawerOpen(false); setLastArrival(null);
      return undefined;
    }
    closedRef.current = false;
    refresh();

    let timer = null;
    const connect = () => {
      if (closedRef.current) return;
      const url = buildNotificationsWsUrl();
      if (!url) return;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch {
        scheduleRetry();
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => {
        retryRef.current = 0;
        setWsConnected(true);
      };
      ws.onmessage = (ev) => {
        let msg = null;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg?.type === "notification" && msg.item) {
          setItems((prev) => [msg.item, ...prev.filter((i) => i.id !== msg.item.id)]);
          setUnreadCount((c) => Math.min(99, c + 1));
          const cat = msg.item.category || "system";
          setUnreadByCategory((prev) => ({ ...prev, [cat]: (prev[cat] || 0) + 1 }));
          setLastArrival(msg.item);
        }
      };
      ws.onclose = () => {
        setWsConnected(false);
        wsRef.current = null;
        scheduleRetry();
      };
      ws.onerror = () => {
        try { ws.close(); } catch { /* ignore */ }
      };
    };
    const scheduleRetry = () => {
      if (closedRef.current) return;
      const delay = Math.min(30000, 2000 * 2 ** Math.min(retryRef.current, 4));
      retryRef.current += 1;
      timer = setTimeout(connect, delay);
    };
    connect();

    return () => {
      closedRef.current = true;
      if (timer) clearTimeout(timer);
      if (wsRef.current) {
        try { wsRef.current.close(); } catch { /* ignore */ }
        wsRef.current = null;
      }
      setWsConnected(false);
    };
  }, [authed, refresh]);

  // ── light fallback poll — ONLY when the socket is down + tab visible ────
  // Refreshes BOTH the unread count AND the item list. A count-only poll
  // left the drawer's timeline permanently stale whenever the socket
  // couldn't connect (e.g. a stale cached Bearer token failing the WS
  // handshake) — the badge could update but "No activity yet" would never
  // resolve to the real, already-persisted event without a full page
  // reload. No setLoading() here — this is a silent background refresh,
  // not a user-initiated one, so it shouldn't flicker a spinner if the
  // drawer happens to be open.
  useEffect(() => {
    if (!authed || wsConnected) return undefined;
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      Promise.all([listNotifications({ limit: PAGE_SIZE }), getUnreadCount()])
        .then(([list, count]) => {
          const next = {
            items: list.items || [],
            hasMore: Boolean(list.hasMore),
            unreadCount: count.count || 0,
            unreadByCategory: count.byCategory || {},
          };
          setItems(next.items);
          setHasMore(next.hasMore);
          setUnreadCount(next.unreadCount);
          setUnreadByCategory(next.unreadByCategory);
          writeCachedNotifications(studentId, next);
        })
        .catch(() => {});
    }, 60000);
    return () => clearInterval(id);
  }, [authed, wsConnected, studentId]);

  const value = useMemo(
    () => ({
      items, hasMore, unreadCount, unreadByCategory, drawerOpen, wsConnected, loading, lastArrival,
      openDrawer: () => setDrawerOpen(true),
      closeDrawer: () => setDrawerOpen(false),
      toggleDrawer: () => setDrawerOpen((v) => !v),
      refresh, loadMore, markRead, markAllRead,
    }),
    [items, hasMore, unreadCount, unreadByCategory, drawerOpen, wsConnected, loading, lastArrival,
     refresh, loadMore, markRead, markAllRead],
  );

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

export default NotificationProvider;
