import { render, screen, fireEvent } from "@testing-library/react";
import PromotionCtaBar from "../PromotionCtaBar";

const THEME = { accent: "#D9B872", onSurface: "#111", cta: { cornerRadius: "999px", style: "filled", animation: "rise" } };

test("renders nothing when there are no buttons", () => {
  const { container } = render(<PromotionCtaBar buttons={[]} theme={THEME} />);
  expect(container.innerHTML).toBe("");
});

test("buttons without a label are filtered out", () => {
  const { container } = render(<PromotionCtaBar buttons={[{ id: "a" }]} theme={THEME} />);
  expect(container.innerHTML).toBe("");
});

test("renders each button with its own testid and label", () => {
  render(
    <PromotionCtaBar
      theme={THEME}
      buttons={[
        { id: "b1", label: "Shop Now", action: { type: "internal_route", value: "/library" } },
        { id: "b2", label: "Learn More", action: { type: "internal_route", value: "/assistant" } },
      ]}
    />,
  );
  expect(screen.getByTestId("promotion-cta-b1")).toHaveTextContent("Shop Now");
  expect(screen.getByTestId("promotion-cta-b2")).toHaveTextContent("Learn More");
});

test("clicking an internal_route button calls navigate with the configured value — reuses artworkClickAction.js unchanged", () => {
  const navigate = jest.fn();
  render(
    <PromotionCtaBar
      theme={THEME}
      navigate={navigate}
      buttons={[{ id: "b1", label: "Shop Now", action: { type: "internal_route", value: "/library" } }]}
    />,
  );
  fireEvent.click(screen.getByTestId("promotion-cta-b1"));
  expect(navigate).toHaveBeenCalledWith("/library");
});

test("clicking a topup button calls the existing openTopUp callback, not a new payment path", () => {
  const openTopUp = jest.fn();
  render(
    <PromotionCtaBar
      theme={THEME}
      openTopUp={openTopUp}
      buttons={[{ id: "b1", label: "Top Up", action: { type: "topup" } }]}
    />,
  );
  fireEvent.click(screen.getByTestId("promotion-cta-b1"));
  expect(openTopUp).toHaveBeenCalled();
});

test("a disabled button never fires its click handler", () => {
  const navigate = jest.fn();
  render(
    <PromotionCtaBar
      theme={THEME}
      navigate={navigate}
      buttons={[{ id: "b1", label: "Shop", disabled: true, action: { type: "internal_route", value: "/library" } }]}
    />,
  );
  const btn = screen.getByTestId("promotion-cta-b1");
  expect(btn).toBeDisabled();
  fireEvent.click(btn);
  expect(navigate).not.toHaveBeenCalled();
});

test("placement='free' positions each button absolutely from its x/y percentages", () => {
  render(
    <PromotionCtaBar
      theme={THEME}
      placement="free"
      buttons={[{ id: "b1", label: "Go", x: 30, y: 60, action: { type: "internal_route", value: "/library" } }]}
    />,
  );
  expect(screen.getByTestId("promotion-cta-b1")).toHaveStyle({ position: "absolute", left: "30%", top: "60%" });
});

test.each(["filled", "outline", "glass", "pill", "floating"])("style=%s renders without throwing", (style) => {
  render(
    <PromotionCtaBar
      theme={THEME}
      buttons={[{ id: "b1", label: "Go", style, action: { type: "internal_route", value: "/x" } }]}
    />,
  );
  expect(screen.getByTestId("promotion-cta-b1")).toBeInTheDocument();
});
