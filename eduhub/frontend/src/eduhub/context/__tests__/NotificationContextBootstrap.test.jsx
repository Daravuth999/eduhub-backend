/**
 * NotificationContextBootstrap.test.jsx — Dashboard Bootstrap caching
 * added to NotificationContext (Activity Feed + notification summary).
 *
 * The critical property under test: cached activity/unread-count is
 * ALWAYS scoped to the currently authenticated studentId. On a shared
 * device, a different student logging in must never see a frame of the
 * previous student's cached activity feed or badge count.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { NotificationProvider, useNotifications } from "../NotificationContext";
import * as notificationApi from "../../lib/notificationApi";

jest.mock("../../lib/notificationApi", () => ({
  buildNotificationsWsUrl: () => "", // skip real WebSocket entirely in tests
  getUnreadCount: jest.fn(),
  listNotifications: jest.fn(),
  markAllNotificationsRead: jest.fn(),
  markNotificationRead: jest.fn(),
}));

let mockAuth = { isAuthenticated: false, student: null };
jest.mock("../AuthContext", () => ({
  useAuth: () => mockAuth,
}));

function Probe() {
  const ctx = useNotifications();
  return (
    <div>
      <div data-testid="unread">{ctx.unreadCount}</div>
      <div data-testid="items">{ctx.items.map((i) => i.title).join(",")}</div>
      <div data-testid="byCategory">{JSON.stringify(ctx.unreadByCategory)}</div>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
  notificationApi.listNotifications.mockResolvedValue({ items: [], hasMore: false });
  notificationApi.getUnreadCount.mockResolvedValue({ count: 0 });
});

test("a logged-out visitor sees zero/empty state, never a cache from a previous session", () => {
  mockAuth = { isAuthenticated: false, student: null };
  render(<NotificationProvider><Probe /></NotificationProvider>);
  expect(screen.getByTestId("unread").textContent).toBe("0");
  expect(screen.getByTestId("items").textContent).toBe("");
});

test("first paint for a returning authenticated student shows cached items/unreadCount synchronously, before the refresh() fetch resolves", async () => {
  localStorage.setItem(
    "eduhub_notif_cache_v1_stu001",
    JSON.stringify({ ts: Date.now(), data: { items: [{ id: "n1", title: "Cached Event" }], hasMore: false, unreadCount: 3 } }),
  );
  mockAuth = { isAuthenticated: true, student: { studentId: "stu001" } };
  // Never resolves in this test — proves the FIRST render already has the cached value.
  notificationApi.listNotifications.mockReturnValue(new Promise(() => {}));
  notificationApi.getUnreadCount.mockReturnValue(new Promise(() => {}));

  render(<NotificationProvider><Probe /></NotificationProvider>);

  expect(screen.getByTestId("unread").textContent).toBe("3");
  expect(screen.getByTestId("items").textContent).toBe("Cached Event");
});

test("a DIFFERENT student's cache is never shown — cache is strictly scoped by studentId", () => {
  localStorage.setItem(
    "eduhub_notif_cache_v1_stu001",
    JSON.stringify({ ts: Date.now(), data: { items: [{ id: "n1", title: "Student A's Activity" }], hasMore: false, unreadCount: 5 } }),
  );
  // stu002 is now the authenticated student on this device — must not see stu001's cache.
  mockAuth = { isAuthenticated: true, student: { studentId: "stu002" } };
  notificationApi.listNotifications.mockReturnValue(new Promise(() => {}));
  notificationApi.getUnreadCount.mockReturnValue(new Promise(() => {}));

  render(<NotificationProvider><Probe /></NotificationProvider>);

  expect(screen.getByTestId("unread").textContent).toBe("0");
  expect(screen.getByTestId("items").textContent).toBe("");
});

test("refresh() writes the freshly fetched items/unreadCount to this student's cache", async () => {
  mockAuth = { isAuthenticated: true, student: { studentId: "stu003" } };
  notificationApi.listNotifications.mockResolvedValue({ items: [{ id: "n2", title: "Fresh Event" }], hasMore: false });
  notificationApi.getUnreadCount.mockResolvedValue({ count: 7 });

  render(<NotificationProvider><Probe /></NotificationProvider>);

  await waitFor(() => expect(screen.getByTestId("unread").textContent).toBe("7"));

  const raw = localStorage.getItem("eduhub_notif_cache_v1_stu003");
  expect(raw).toBeTruthy();
  const parsed = JSON.parse(raw);
  expect(parsed.data.unreadCount).toBe(7);
  expect(parsed.data.items[0].title).toBe("Fresh Event");
});

test("unreadByCategory (the per-module badge breakdown) is seeded on first paint and updated on refresh, alongside unreadCount", async () => {
  localStorage.setItem(
    "eduhub_notif_cache_v1_stu004",
    JSON.stringify({ ts: Date.now(), data: { items: [], hasMore: false, unreadCount: 2, unreadByCategory: { rewards: 2 } } }),
  );
  mockAuth = { isAuthenticated: true, student: { studentId: "stu004" } };
  notificationApi.listNotifications.mockResolvedValue({ items: [], hasMore: false });
  notificationApi.getUnreadCount.mockResolvedValue({ count: 5, byCategory: { rewards: 2, payments: 3 } });

  render(<NotificationProvider><Probe /></NotificationProvider>);

  // Seeded synchronously from cache before the mocked fetch resolves.
  expect(screen.getByTestId("byCategory").textContent).toBe(JSON.stringify({ rewards: 2 }));

  await waitFor(() => expect(screen.getByTestId("unread").textContent).toBe("5"));
  expect(screen.getByTestId("byCategory").textContent).toBe(JSON.stringify({ rewards: 2, payments: 3 }));

  const parsed = JSON.parse(localStorage.getItem("eduhub_notif_cache_v1_stu004"));
  expect(parsed.data.unreadByCategory).toEqual({ rewards: 2, payments: 3 });
});
