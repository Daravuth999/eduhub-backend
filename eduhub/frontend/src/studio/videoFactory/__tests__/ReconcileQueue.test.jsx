import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ReconcileQueue from "../ReconcileQueue";

jest.mock("../videoLibraryApi", () => ({
  listReconcilePurchases: jest.fn(),
  resolveReconcile: jest.fn(),
}));

import { listReconcilePurchases, resolveReconcile } from "../videoLibraryApi";

const ITEM = { studentId: "stu1", lessonId: "vid_1", lessonTitle: "Ordering Coffee", price: 50, reason: "network_error" };

beforeEach(() => {
  jest.clearAllMocks();
});

test("shows an honest empty state when nothing is pending", async () => {
  listReconcilePurchases.mockResolvedValue([]);
  render(<ReconcileQueue />);
  expect(await screen.findByTestId("reconcile-empty")).toBeInTheDocument();
});

test("renders each pending purchase with the lesson title, student, price, and reason", async () => {
  listReconcilePurchases.mockResolvedValue([ITEM]);
  render(<ReconcileQueue />);
  const row = await screen.findByTestId("reconcile-row-stu1::vid_1");
  expect(row).toHaveTextContent("Ordering Coffee");
  expect(row).toHaveTextContent("stu1");
  expect(row).toHaveTextContent("50 pts");
  expect(row).toHaveTextContent("network_error");
});

test("falls back to the lessonId when no lessonTitle was returned", async () => {
  listReconcilePurchases.mockResolvedValue([{ ...ITEM, lessonTitle: "" }]);
  render(<ReconcileQueue />);
  const row = await screen.findByTestId("reconcile-row-stu1::vid_1");
  expect(row).toHaveTextContent("vid_1");
});

test("Grant ownership calls resolveReconcile with 'succeeded' and refreshes the queue", async () => {
  listReconcilePurchases.mockResolvedValueOnce([ITEM]).mockResolvedValueOnce([]);
  resolveReconcile.mockResolvedValue({ state: "succeeded" });
  render(<ReconcileQueue />);
  await screen.findByTestId("reconcile-row-stu1::vid_1");
  fireEvent.click(screen.getByTestId("reconcile-grant-stu1::vid_1"));
  await waitFor(() => expect(resolveReconcile).toHaveBeenCalledWith("stu1", "vid_1", "succeeded"));
  await waitFor(() => expect(screen.getByTestId("reconcile-empty")).toBeInTheDocument());
});

test("Deny calls resolveReconcile with 'failed'", async () => {
  listReconcilePurchases.mockResolvedValue([ITEM]);
  resolveReconcile.mockResolvedValue({ state: "failed" });
  render(<ReconcileQueue />);
  fireEvent.click(await screen.findByTestId("reconcile-deny-stu1::vid_1"));
  await waitFor(() => expect(resolveReconcile).toHaveBeenCalledWith("stu1", "vid_1", "failed"));
});

test("a resolution failure shows an inline error instead of crashing", async () => {
  listReconcilePurchases.mockResolvedValue([ITEM]);
  resolveReconcile.mockRejectedValue(new Error("not_reconcilable"));
  render(<ReconcileQueue />);
  fireEvent.click(await screen.findByTestId("reconcile-grant-stu1::vid_1"));
  expect(await screen.findByTestId("reconcile-error")).toHaveTextContent(/not_reconcilable/i);
});

test("a load failure shows an inline error instead of crashing", async () => {
  listReconcilePurchases.mockRejectedValue(new Error("network down"));
  render(<ReconcileQueue />);
  expect(await screen.findByTestId("reconcile-error")).toHaveTextContent(/network down/i);
});

test("Refresh button re-fetches the queue", async () => {
  listReconcilePurchases.mockResolvedValue([]);
  render(<ReconcileQueue />);
  await screen.findByTestId("reconcile-empty");
  fireEvent.click(screen.getByTestId("reconcile-refresh-button"));
  await waitFor(() => expect(listReconcilePurchases).toHaveBeenCalledTimes(2));
});
