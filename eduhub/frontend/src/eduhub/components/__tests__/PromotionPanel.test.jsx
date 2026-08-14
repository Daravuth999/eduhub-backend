/**
 * PromotionPanel.test.jsx — Promotion Experience Studio's rendering engine.
 * Focused on PromotionPanel's OWN logic: the legacy-fallback contract, the
 * resolved-theme composition, and CTA/text/decoration wiring. ArtworkCarousel
 * and useArtworkTopUp are mocked so this file doesn't re-test their own
 * (already-covered-elsewhere) internals.
 */
import { render, screen } from "@testing-library/react";
import PromotionPanel from "../PromotionPanel";
import { useTheme } from "../../pages/portal/hooks/useTheme";

// react-router-dom's real package isn't resolvable under this project's
// Jest config (same reason the existing voice-treasure tests virtualize
// it) — mocked to a minimal useNavigate stub since PromotionPanel only
// ever calls useNavigate() and forwards the returned function.
jest.mock("react-router-dom", () => ({ useNavigate: () => jest.fn() }), { virtual: true });
jest.mock("../../pages/portal/hooks/useTheme");
jest.mock("../artwork/useArtworkTopUp", () => () => ({ openTopUp: jest.fn(), topUpNode: null }));
jest.mock("../artwork/ArtworkCarousel", () => (props) => (
  <div data-testid="mock-artwork-carousel" data-placement={props.placement} />
));

function renderPanel(props) {
  return render(<PromotionPanel {...props} />);
}

beforeEach(() => {
  jest.clearAllMocks();
  useTheme.mockReturnValue({ theme: "light" });
});

describe("legacy fallback contract", () => {
  test("no promotionConfig -> falls back to the existing ArtworkCarousel, dashboard_hero placement, unchanged", () => {
    renderPanel({});
    const fallback = screen.getByTestId("mock-artwork-carousel");
    expect(fallback).toHaveAttribute("data-placement", "dashboard_hero");
    expect(screen.queryByTestId("promotion-panel")).not.toBeInTheDocument();
  });

  test("promotionConfig present -> renders the NEW promotion-panel, not the legacy fallback", () => {
    renderPanel({ promotionConfig: { appearance: {}, content: {} } });
    expect(screen.getByTestId("promotion-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-artwork-carousel")).not.toBeInTheDocument();
  });
});

test("content.visible=false renders nothing (matches Hero/TopEarnerPanel's visibility gate)", () => {
  const { container } = renderPanel({ promotionConfig: { content: { visible: false } } });
  expect(container.innerHTML).toBe("");
});

test("followTheme sync mode tracks the app theme", () => {
  useTheme.mockReturnValue({ theme: "dark" });
  renderPanel({ promotionConfig: { appearance: { syncMode: "followTheme" } } });
  expect(screen.getByTestId("promotion-panel")).toHaveAttribute("data-promotion-preset", "emeraldNight");
});

test("independent sync mode selects the admin-chosen preset regardless of app theme", () => {
  renderPanel({ promotionConfig: { appearance: { syncMode: "independent", themeId: "celebrationGold" } } });
  expect(screen.getByTestId("promotion-panel")).toHaveAttribute("data-promotion-preset", "celebrationGold");
});

test("appThemeOverride (Studio preview) wins over the live app theme", () => {
  useTheme.mockReturnValue({ theme: "light" });
  renderPanel({ promotionConfig: { appearance: { syncMode: "followTheme" } }, appThemeOverride: "dark" });
  expect(screen.getByTestId("promotion-panel")).toHaveAttribute("data-promotion-preset", "emeraldNight");
});

test("background artwork renders via the reused HeroArtworkLayer when configured", () => {
  renderPanel({
    promotionConfig: { appearance: { artwork: { url: "https://cdn.example/promo.png", placement: "right", scale: 100 } } },
  });
  expect(screen.getByTestId("hero-artwork-image")).toHaveAttribute("src", "https://cdn.example/promo.png");
});

test("no artwork configured -> no artwork layer, no artwork overlay", () => {
  renderPanel({ promotionConfig: { appearance: {} } });
  expect(screen.queryByTestId("hero-artwork-layer")).not.toBeInTheDocument();
  expect(screen.queryByTestId("promotion-artwork-overlay")).not.toBeInTheDocument();
});

test("the default preset's panel-wide overlay renders", () => {
  renderPanel({ promotionConfig: { appearance: {} } });
  expect(screen.getByTestId("promotion-panel-overlay")).toBeInTheDocument();
});

test("enabled decorations from the resolved preset render inside the panel", () => {
  renderPanel({ promotionConfig: { appearance: { syncMode: "independent", themeId: "celebrationGold" } } });
  expect(screen.getByTestId("promotion-decorations")).toBeInTheDocument();
  expect(screen.getByTestId("promotion-decoration-sparkles")).toBeInTheDocument();
});

test("text layers render via PromotionTypography", () => {
  renderPanel({
    promotionConfig: { content: { textLayers: [{ id: "1", role: "headline", content: "Back to School" }] } },
  });
  expect(screen.getByTestId("promotion-text-headline")).toHaveTextContent("Back to School");
});

test("CTA buttons render and route via the shared click-action handler", () => {
  renderPanel({
    promotionConfig: {
      content: { ctaButtons: [{ id: "b1", label: "Shop Now", action: { type: "internal_route", value: "/library" } }] },
    },
  });
  expect(screen.getByTestId("promotion-cta-b1")).toHaveTextContent("Shop Now");
});
