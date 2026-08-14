/**
 * LiveCoachRewardPanel.test.jsx — component render tests for the persistent
 * Surprise Reward panel (hotfix v1). Validates the visual-state contract and
 * the locked safety rules at the DOM level.
 *
 * Uses ONLY react + react-dom (already project dependencies) so it runs under
 * the project's configured `craco test` (jsdom) WITHOUT adding any new
 * dependency such as @testing-library/react.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import LiveCoachRewardPanel from "../LiveCoachRewardPanel";

const emptyReward = {
  offer: null,
  claiming: false,
  result: null,
  revealOpen: false,
};

let container;
let root;

function mount(props) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<LiveCoachRewardPanel {...props} />);
  });
}

afterEach(() => {
  if (root) act(() => root.unmount());
  if (container) container.remove();
  root = null;
  container = null;
});

const q = (sel) => container.querySelector(sel);
const testid = (id) => container.querySelector(`[data-testid="${id}"]`);
const clickPanel = () => {
  act(() => {
    testid("live-coach-reward-panel").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
  });
};

describe("LiveCoachRewardPanel", () => {
  test("hidden/unavailable: nothing renders when backend cannot issue rewards", () => {
    mount({
      status: { state: "disabled", inactive_reason: "server_master_gate_off" },
      reward: emptyReward,
    });
    expect(container.firstChild).toBeNull();
    expect(testid("live-coach-reward-panel")).toBeNull();
  });

  test("tracking: persistently visible, locked, non-clickable, no amount", () => {
    mount({ status: { state: "tracking" }, reward: emptyReward });
    const panel = testid("live-coach-reward-panel");
    expect(panel).toBeTruthy();
    expect(panel.getAttribute("data-mode")).toBe("tracking");
    expect(panel.getAttribute("role")).toBe("status");
    expect(panel.getAttribute("aria-disabled")).toBe("true");
    expect(testid("live-coach-reward-panel-claim")).toBeNull();
    expect(container.textContent).not.toMatch(/EduHub Points/i);
  });

  test("eligible WITHOUT offer_id is not clickable (truth-driven)", () => {
    const onClaim = jest.fn();
    mount({ status: { state: "eligible" }, reward: emptyReward, onClaim });
    clickPanel();
    expect(onClaim).not.toHaveBeenCalled();
    expect(testid("live-coach-reward-panel").getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  test("eligible WITH offer_id: clickable, hides amount, one tap -> onClaim(offerId)", () => {
    const onClaim = jest.fn();
    mount({
      status: { state: "eligible", offer_id: "rwd_42" },
      reward: emptyReward,
      onClaim,
    });
    const panel = testid("live-coach-reward-panel");
    expect(panel.getAttribute("role")).toBe("button");
    expect(testid("live-coach-reward-panel-claim")).toBeTruthy();
    expect(container.textContent).not.toMatch(/EduHub Points/i); // hidden pre-claim
    clickPanel();
    expect(onClaim).toHaveBeenCalledTimes(1);
    expect(onClaim).toHaveBeenCalledWith("rwd_42");
  });

  test("claiming: shows 'Opening your surprise…', non-clickable, no amount", () => {
    const onClaim = jest.fn();
    mount({
      status: { state: "claiming", offer_id: "rwd_42" },
      reward: { ...emptyReward, claiming: true },
      onClaim,
    });
    const panel = testid("live-coach-reward-panel");
    expect(panel.getAttribute("data-mode")).toBe("claiming");
    expect(container.textContent).toMatch(/Opening your surprise/i);
    clickPanel();
    expect(onClaim).not.toHaveBeenCalled();
    expect(container.textContent).not.toMatch(/EduHub Points/i);
  });

  test("confirmed: reveals the persisted amount only once it is confirmed", () => {
    mount({
      status: { state: "confirmed", reward_summary: "5 EduHub Points" },
      reward: emptyReward,
    });
    expect(container.textContent).toMatch(/5 EduHub Points/);
  });

  test("reduced-motion: no animated halo element is rendered", () => {
    mount({
      status: { state: "eligible", offer_id: "rwd_1" },
      reward: emptyReward,
      reducedMotion: true,
    });
    expect(q(".etlc-rwp__halo")).toBeNull();
    expect(q(".etlc-rwp--no-motion")).toBeTruthy();
  });

  test("terminal/expired never show a success/amount", () => {
    mount({ status: { state: "terminal" }, reward: emptyReward });
    expect(container.textContent).not.toMatch(/EduHub Points/i);
    expect(testid("live-coach-reward-panel").getAttribute("aria-disabled")).toBe(
      "true",
    );
    act(() => root.unmount());
    container.remove();
    mount({ status: { state: "expired" }, reward: emptyReward });
    expect(container.textContent).not.toMatch(/EduHub Points/i);
  });
});
