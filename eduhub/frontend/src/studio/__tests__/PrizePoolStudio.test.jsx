/**
 * PrizePoolStudio.test.jsx — Author Studio's "Prize Pools" screen. Mocks
 * ./api entirely (network layer covered by prize_pool.py's own backend
 * test suite). Asserts the UI CONTRACT:
 *   • lists pools on mount, shows live balance per pool
 *   • creates a new pool (name + owner_type + owner_ref)
 *   • drives the open -> locked -> settled lifecycle, and cancel
 *   • contributes into / distributes from a pool via the wallet-backed routes
 *   • views a pool's ledger
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import PrizePoolStudio from "../PrizePoolStudio";
import * as api from "../api";

jest.mock("../api", () => ({
  listPrizePools: jest.fn(),
  createPrizePool: jest.fn(),
  getPrizePool: jest.fn(),
  getPrizePoolBalance: jest.fn(),
  getPrizePoolLedger: jest.fn(),
  contributeToPrizePool: jest.fn(),
  distributeFromPrizePool: jest.fn(),
  lockPrizePool: jest.fn(),
  unlockPrizePool: jest.fn(),
  settlePrizePool: jest.fn(),
  cancelPrizePool: jest.fn(),
  fundPrizePool: jest.fn(),
  linkPrizePoolToSession: jest.fn(),
}));

const OPEN_POOL = {
  _id: "pool_abc123",
  name: "Speaking Lab — July Tournament",
  owner_type: "event",
  owner_ref: "event_1",
  status: "open",
  pool_wallet_id: "pool_pool_abc123",
};

const LOCKED_POOL = { ...OPEN_POOL, _id: "pool_locked1", status: "locked" };

beforeEach(() => {
  jest.clearAllMocks();
  api.listPrizePools.mockResolvedValue({ pools: [] });
  api.getPrizePoolBalance.mockResolvedValue({ pool_id: "pool_abc123", balance: 0 });
});

test("loads and lists pools on mount, showing live balance", async () => {
  api.listPrizePools.mockResolvedValue({ pools: [OPEN_POOL] });
  api.getPrizePoolBalance.mockResolvedValue({ pool_id: OPEN_POOL._id, balance: 250 });
  render(<PrizePoolStudio />);
  await waitFor(() => expect(api.listPrizePools).toHaveBeenCalled());
  expect(await screen.findByTestId(`prize-pools-row-${OPEN_POOL._id}`)).toHaveTextContent("Speaking Lab — July Tournament");
  await waitFor(() => expect(api.getPrizePoolBalance).toHaveBeenCalledWith(OPEN_POOL._id));
  expect(await screen.findByTestId(`prize-pools-balance-${OPEN_POOL._id}`)).toHaveTextContent("250");
});

test("shows an empty state when no pools exist yet", async () => {
  render(<PrizePoolStudio />);
  expect(await screen.findByTestId("prize-pools-empty")).toBeInTheDocument();
});

test("creates a new pool", async () => {
  api.createPrizePool.mockResolvedValue({ ok: true, pool: OPEN_POOL });
  render(<PrizePoolStudio />);
  fireEvent.change(await screen.findByTestId("prize-pools-new-name-input"), { target: { value: "Speaking Lab — July Tournament" } });
  fireEvent.change(screen.getByTestId("prize-pools-new-owner-type-input"), { target: { value: "event" } });
  fireEvent.change(screen.getByTestId("prize-pools-new-owner-ref-input"), { target: { value: "event_1" } });
  fireEvent.click(screen.getByTestId("prize-pools-create-button"));
  await waitFor(() => expect(api.createPrizePool).toHaveBeenCalledWith({
    name: "Speaking Lab — July Tournament", owner_type: "event", owner_ref: "event_1",
  }));
});

test("locks an open pool", async () => {
  api.listPrizePools.mockResolvedValue({ pools: [OPEN_POOL] });
  api.lockPrizePool.mockResolvedValue({ ok: true, pool: { ...OPEN_POOL, status: "locked" } });
  render(<PrizePoolStudio />);
  fireEvent.click(await screen.findByTestId(`prize-pools-lock-${OPEN_POOL._id}`));
  await waitFor(() => expect(api.lockPrizePool).toHaveBeenCalledWith(OPEN_POOL._id));
});

test("settles a locked pool", async () => {
  api.listPrizePools.mockResolvedValue({ pools: [LOCKED_POOL] });
  api.settlePrizePool.mockResolvedValue({ ok: true, pool: { ...LOCKED_POOL, status: "settled" } });
  render(<PrizePoolStudio />);
  fireEvent.click(await screen.findByTestId(`prize-pools-settle-${LOCKED_POOL._id}`));
  await waitFor(() => expect(api.settlePrizePool).toHaveBeenCalledWith(LOCKED_POOL._id));
});

test("cancels an open pool", async () => {
  api.listPrizePools.mockResolvedValue({ pools: [OPEN_POOL] });
  api.cancelPrizePool.mockResolvedValue({ ok: true, pool: { ...OPEN_POOL, status: "cancelled" } });
  render(<PrizePoolStudio />);
  fireEvent.click(await screen.findByTestId(`prize-pools-cancel-${OPEN_POOL._id}`));
  await waitFor(() => expect(api.cancelPrizePool).toHaveBeenCalledWith(OPEN_POOL._id));
});

test("contributes into an open pool via the wallet-backed route", async () => {
  api.listPrizePools.mockResolvedValue({ pools: [OPEN_POOL] });
  api.contributeToPrizePool.mockResolvedValue({ ok: true, result: {} });
  render(<PrizePoolStudio />);
  fireEvent.click(await screen.findByTestId(`prize-pools-contribute-toggle-${OPEN_POOL._id}`));
  fireEvent.change(screen.getByTestId(`prize-pools-contribute-student-${OPEN_POOL._id}`), { target: { value: "stu001" } });
  fireEvent.change(screen.getByTestId(`prize-pools-contribute-amount-${OPEN_POOL._id}`), { target: { value: "50" } });
  fireEvent.click(screen.getByTestId(`prize-pools-contribute-submit-${OPEN_POOL._id}`));
  await waitFor(() => expect(api.contributeToPrizePool).toHaveBeenCalledWith(
    OPEN_POOL._id,
    expect.objectContaining({ student_id: "stu001", amount: 50, idempotency_key: expect.any(String) }),
  ));
});

test("distributes from a pool with a reason", async () => {
  api.listPrizePools.mockResolvedValue({ pools: [OPEN_POOL] });
  api.distributeFromPrizePool.mockResolvedValue({ ok: true, result: {} });
  render(<PrizePoolStudio />);
  fireEvent.click(await screen.findByTestId(`prize-pools-distribute-toggle-${OPEN_POOL._id}`));
  fireEvent.change(screen.getByTestId(`prize-pools-distribute-student-${OPEN_POOL._id}`), { target: { value: "stu002" } });
  fireEvent.change(screen.getByTestId(`prize-pools-distribute-amount-${OPEN_POOL._id}`), { target: { value: "100" } });
  fireEvent.change(screen.getByTestId(`prize-pools-distribute-reason-${OPEN_POOL._id}`), { target: { value: "1st place" } });
  fireEvent.click(screen.getByTestId(`prize-pools-distribute-submit-${OPEN_POOL._id}`));
  await waitFor(() => expect(api.distributeFromPrizePool).toHaveBeenCalledWith(
    OPEN_POOL._id,
    expect.objectContaining({ student_id: "stu002", amount: 100, reason: "1st place", idempotency_key: expect.any(String) }),
  ));
});

test("unlocks a locked pool", async () => {
  api.listPrizePools.mockResolvedValue({ pools: [LOCKED_POOL] });
  api.unlockPrizePool.mockResolvedValue({ ok: true, pool: { ...LOCKED_POOL, status: "open" } });
  render(<PrizePoolStudio />);
  fireEvent.click(await screen.findByTestId(`prize-pools-unlock-${LOCKED_POOL._id}`));
  await waitFor(() => expect(api.unlockPrizePool).toHaveBeenCalledWith(LOCKED_POOL._id));
});

test("funds an open pool as an administrator credit — no student_id involved", async () => {
  api.listPrizePools.mockResolvedValue({ pools: [OPEN_POOL] });
  api.fundPrizePool.mockResolvedValue({ ok: true, result: {} });
  render(<PrizePoolStudio />);
  fireEvent.click(await screen.findByTestId(`prize-pools-fund-toggle-${OPEN_POOL._id}`));
  fireEvent.change(screen.getByTestId(`prize-pools-fund-amount-${OPEN_POOL._id}`), { target: { value: "500" } });
  fireEvent.change(screen.getByTestId(`prize-pools-fund-note-${OPEN_POOL._id}`), { target: { value: "season budget" } });
  fireEvent.click(screen.getByTestId(`prize-pools-fund-submit-${OPEN_POOL._id}`));
  await waitFor(() => expect(api.fundPrizePool).toHaveBeenCalledWith(
    OPEN_POOL._id,
    expect.objectContaining({ amount: 500, note: "season budget", idempotency_key: expect.any(String) }),
  ));
  expect(api.fundPrizePool.mock.calls[0][1]).not.toHaveProperty("student_id");
});

test("associates a pool with a Speaking Lab session", async () => {
  api.listPrizePools.mockResolvedValue({ pools: [OPEN_POOL] });
  api.linkPrizePoolToSession.mockResolvedValue({ ok: true, result: { pool_id: OPEN_POOL._id, session_id: "sl_123" } });
  render(<PrizePoolStudio />);
  fireEvent.click(await screen.findByTestId(`prize-pools-link-session-toggle-${OPEN_POOL._id}`));
  fireEvent.change(screen.getByTestId(`prize-pools-link-session-input-${OPEN_POOL._id}`), { target: { value: "sl_123" } });
  fireEvent.click(screen.getByTestId(`prize-pools-link-session-submit-${OPEN_POOL._id}`));
  await waitFor(() => expect(api.linkPrizePoolToSession).toHaveBeenCalledWith(OPEN_POOL._id, "sl_123"));
});

test("link session is available even while the pool is locked", async () => {
  api.listPrizePools.mockResolvedValue({ pools: [LOCKED_POOL] });
  render(<PrizePoolStudio />);
  expect(await screen.findByTestId(`prize-pools-link-session-toggle-${LOCKED_POOL._id}`)).toBeInTheDocument();
});

test("shows the linked session when a pool is funding one", async () => {
  const linkedPool = { ...OPEN_POOL, linked_session_id: "sl_42" };
  api.listPrizePools.mockResolvedValue({ pools: [linkedPool] });
  render(<PrizePoolStudio />);
  expect(await screen.findByTestId(`prize-pools-linked-session-${linkedPool._id}`)).toHaveTextContent("sl_42");
});

test("shows an unlinked hint when a pool funds no session yet", async () => {
  api.listPrizePools.mockResolvedValue({ pools: [OPEN_POOL] });
  render(<PrizePoolStudio />);
  expect(await screen.findByTestId(`prize-pools-row-${OPEN_POOL._id}`)).toHaveTextContent("not linked to a session yet");
});

test("views a pool's ledger", async () => {
  api.listPrizePools.mockResolvedValue({ pools: [OPEN_POOL] });
  api.getPrizePoolLedger.mockResolvedValue({
    pool_id: OPEN_POOL._id,
    entries: [{ id: "txn_1", source: "prize_pool_contribution", amount: 50 }],
  });
  render(<PrizePoolStudio />);
  fireEvent.click(await screen.findByTestId(`prize-pools-ledger-toggle-${OPEN_POOL._id}`));
  await waitFor(() => expect(api.getPrizePoolLedger).toHaveBeenCalledWith(OPEN_POOL._id));
  const ledger = await screen.findByTestId(`prize-pools-ledger-${OPEN_POOL._id}`);
  expect(ledger).toHaveTextContent("prize_pool_contribution");
  expect(ledger).toHaveTextContent("50");
});
