/**
 * NotificationContext.unreadByCategory.test.jsx — v1.1 additive coverage.
 *
 * Proves the ONE new piece of client state the unified badge platform
 * depends on: `unreadByCategory` stays correctly in sync with the
 * server-sent `byCategory` breakdown across every path that already
 * mutates `unreadCount` (initial refresh, WS arrival, markRead,
 * markAllRead) — never a second, disconnected number.
 */
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import { NotificationProvider, useNotifications } from "../NotificationContext";

jest.mock("../AuthContext", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    student: { studentId: "stu094" },
  }),
}));

const mockListNotifications = jest.fn();
const mockGetUnreadCount = jest.fn();
const mockMarkNotificationRead = jest.fn().mockResolvedValue({ ok: true });
const mockMarkAllNotificationsRead = jest.fn().mockResolvedValue({ ok: true });
let mockWsUrl = "";

jest.mock("../../lib/notificationApi", () => ({
  buildNotificationsWsUrl: () => mockWsUrl,
  listNotifications: (...a) => mockListNotifications(...a),
  getUnreadCount: (...a) => mockGetUnreadCount(...a),
  markNotificationRead: (...a) => mockMarkNotificationRead(...a),
  markAllNotificationsRead: (...a) => mockMarkAllNotificationsRead(...a),
}));

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  close() {}
}
FakeWebSocket.instances = [];

function Probe() {
  const ctx = useNotifications();
  return (
    <div>
      <span data-testid="unreadCount">{ctx.unreadCount}</span>
      <span data-testid="byCategory">{JSON.stringify(ctx.unreadByCategory)}</span>
      <button onClick={() => ctx.markRead("n1")}>markRead</button>
      <button onClick={() => ctx.markAllRead()}>markAllRead</button>
    </div>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  FakeWebSocket.instances = [];
  mockWsUrl = ""; // WS effect no-ops on empty URL -> tests exercise pure REST/state paths
  mockListNotifications.mockResolvedValue({
    items: [
      { id: "n1", title: "Speaking result", body: "", url: "/", category: "speaking_lab", priority: "normal", read: false, createdAt: new Date().toISOString() },
    ],
    hasMore: false,
  });
  mockGetUnreadCount.mockResolvedValue({ count: 3, byCategory: { speaking_lab: 2, points: 1 } });
});

test("refresh() populates unreadByCategory from the server response", async () => {
  render(
    <NotificationProvider>
      <Probe />
    </NotificationProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("unreadCount").textContent).toBe("3"));
  expect(JSON.parse(screen.getByTestId("byCategory").textContent)).toEqual({
    speaking_lab: 2, points: 1,
  });
});

test("markRead decrements only the category of the item that was marked", async () => {
  render(
    <NotificationProvider>
      <Probe />
    </NotificationProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("unreadCount").textContent).toBe("3"));

  await act(async () => {
    screen.getByText("markRead").click();
  });

  expect(screen.getByTestId("unreadCount").textContent).toBe("2");
  const byCat = JSON.parse(screen.getByTestId("byCategory").textContent);
  expect(byCat.speaking_lab).toBe(1); // n1 was speaking_lab -> decremented
  expect(byCat.points).toBe(1); // untouched category unaffected
});

test("markAllRead zeroes both unreadCount and unreadByCategory", async () => {
  render(
    <NotificationProvider>
      <Probe />
    </NotificationProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("unreadCount").textContent).toBe("3"));

  await act(async () => {
    screen.getByText("markAllRead").click();
  });

  expect(screen.getByTestId("unreadCount").textContent).toBe("0");
  expect(JSON.parse(screen.getByTestId("byCategory").textContent)).toEqual({});
});

test("a realtime WS arrival increments both the total and its own category", async () => {
  mockWsUrl = "wss://backend.example.test/api/notifications/ws?token=t";
  const OriginalWebSocket = global.WebSocket;
  global.WebSocket = FakeWebSocket;

  try {
    render(
      <NotificationProvider>
        <Probe />
      </NotificationProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("unreadCount").textContent).toBe("3"));
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));

    const ws = FakeWebSocket.instances[0];
    act(() => {
      ws.onmessage({
        data: JSON.stringify({
          type: "notification",
          item: { id: "n2", category: "attendance", title: "Live", read: false, createdAt: new Date().toISOString() },
        }),
      });
    });

    expect(screen.getByTestId("unreadCount").textContent).toBe("4");
    const byCat = JSON.parse(screen.getByTestId("byCategory").textContent);
    expect(byCat.attendance).toBe(1);
  } finally {
    global.WebSocket = OriginalWebSocket;
  }
});
