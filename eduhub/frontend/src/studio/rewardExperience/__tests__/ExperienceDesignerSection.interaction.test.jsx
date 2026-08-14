/**
 * ExperienceDesignerSection.interaction.test.jsx — real pointer-event
 * verification of the canvas drag/resize/rotate math (the one surface the
 * independent audit could not click-test live, since it lives behind
 * Studio admin auth). Drives the ACTUAL production components
 * (ExperienceDesignerSection -> RewardExperiencePreview) through jsdom
 * pointer events, not a mock — this exercises the real onPointerDown/
 * onPointerMove handlers exactly as a browser would dispatch them.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import ExperienceDesignerSection from "../ExperienceDesignerSection";

// jsdom 16.x implements neither pointer capture nor the PointerEvent
// constructor itself (confirmed: `"PointerEvent" in window` is false in
// this project's jsdom version) — every real browser has both. Standard
// test-environment polyfills; production code only calls/dispatches these,
// never inspects jsdom-specific internals.
beforeAll(() => {
  Element.prototype.setPointerCapture = jest.fn();
  Element.prototype.releasePointerCapture = jest.fn();
  if (typeof window.PointerEvent === "undefined") {
    window.PointerEvent = class PointerEvent extends MouseEvent {
      constructor(type, params = {}) {
        super(type, params);
        this.pointerId = params.pointerId ?? 1;
      }
    };
  }
});

function firePointer(el, type, { clientX, clientY, pointerId = 1, shiftKey = false } = {}) {
  fireEvent(
    el,
    new window.PointerEvent(type, { bubbles: true, cancelable: true, clientX, clientY, pointerId, shiftKey }),
  );
}

function baseForm(decorations) {
  return {
    accent_color: "#D4A843",
    reward_points: 20,
    reward_kind: "points",
    title: "Welcome back!",
    subtitle: "Claim your surprise learning points today.",
    cta_text: "Claim Reward",
    experience: {
      version: 2,
      environment: "classic",
      glass: "auto",
      lighting: "auto",
      reveal: "cinematic",
      particles: "auto",
      particle_intensity: "premium",
      backdrop_blur: 10,
      env_intensity: 1,
      ambient_color: "",
      popup_size: "standard",
      glass_config: { frost: -1, opacity: -1, radius: -1, border: "auto", reflection: true, depth: 0.6 },
      lighting_config: { intensity: 0.6, direction: "top", color: "", blur: 20, opacity: 0.7 },
      typography: { title_font: "default", title_weight: 900, title_spacing: 0, title_color: "", title_shadow: 0, align: "center" },
      cta: { style: "solid", radius: 40, glow: 0.4, shadow: 0.5, animation: "shimmer" },
      decorations,
    },
  };
}

function makeDecoration(overrides = {}) {
  return {
    id: "dec_test1", kind: "builtin", asset: "trophy",
    x: 50, y: 50, size: 72, rotation: 0, opacity: 1, glow: 0, blur: 0,
    flip: false, locked: false, visible: true, name: "", group: "",
    shadow: 0, anim: "none", anim_speed: 1, layer: "front",
    ...overrides,
  };
}

function renderDesigner(decoration) {
  const calls = [];
  const set = jest.fn((key, value) => calls.push([key, value]));
  const form = baseForm([decoration]);
  const utils = render(<ExperienceDesignerSection form={form} set={set} />);
  return { ...utils, set, calls };
}

// jsdom's getBoundingClientRect returns all-zero by default; the drag math
// divides by rect.width/height, so give the stage a real size like a
// browser would.
function stubStageRect() {
  Element.prototype.getBoundingClientRect = jest.fn(() => ({
    left: 0, top: 0, right: 300, bottom: 620, width: 300, height: 620, x: 0, y: 0, toJSON() {},
  }));
}

describe("Experience Designer canvas — real pointer interaction", () => {
  beforeEach(stubStageRect);

  test("drag moves the decoration's x/y in the direction of the pointer", () => {
    const { set, calls } = renderDesigner(makeDecoration({ x: 50, y: 50 }));
    const handle = screen.getByTestId("rxp-handle-dec_test1");

    firePointer(handle, "pointerdown", { clientX: 150, clientY: 310, pointerId: 1 });
    // move 30px right, 62px down relative to a 300x620 stage -> +10% x, +10% y
    firePointer(handle, "pointermove", { clientX: 180, clientY: 372, pointerId: 1 });
    firePointer(handle, "pointerup", { pointerId: 1 });

    expect(set).toHaveBeenCalled();
    const lastPatch = calls[calls.length - 1][1];
    const moved = lastPatch.decorations.find((d) => d.id === "dec_test1");
    expect(moved.x).toBeGreaterThan(50);
    expect(moved.y).toBeGreaterThan(50);
    // clamped to [0,100] — never escapes the stage
    expect(moved.x).toBeLessThanOrEqual(100);
    expect(moved.y).toBeLessThanOrEqual(100);
  });

  test("drag never moves a locked decoration", () => {
    const { set, calls } = renderDesigner(makeDecoration({ x: 50, y: 50, locked: true }));
    const handle = screen.getByTestId("rxp-handle-dec_test1");

    firePointer(handle, "pointerdown", { clientX: 150, clientY: 310, pointerId: 1 });
    firePointer(handle, "pointermove", { clientX: 200, clientY: 400, pointerId: 1 });
    firePointer(handle, "pointerup", { pointerId: 1 });

    // selecting a locked item is fine (selectItem runs), but no position patch
    const positionPatch = calls.find(([, v]) => v?.decorations);
    if (positionPatch) {
      const d = positionPatch[1].decorations.find((x) => x.id === "dec_test1");
      expect(d.x).toBe(50);
      expect(d.y).toBe(50);
    }
  });

  test("resize handle increases size when dragged outward, clamped to 400", () => {
    const { set, calls } = renderDesigner(makeDecoration({ size: 72 }));
    firePointer(screen.getByTestId("rxp-handle-dec_test1"), "pointerdown", { clientX: 150, clientY: 310, pointerId: 1 });
    const resizeKnob = screen.getByTestId("rxp-resize-dec_test1");

    firePointer(resizeKnob, "pointerdown", { clientX: 160, clientY: 320, pointerId: 2 });
    firePointer(resizeKnob, "pointermove", { clientX: 460, clientY: 620, pointerId: 2 }); // huge delta
    firePointer(resizeKnob, "pointerup", { pointerId: 2 });

    const sizeCall = calls.find(([, v]) => typeof v?.size === "undefined" && v?.decorations)
      || calls[calls.length - 1];
    const d = sizeCall[1].decorations.find((x) => x.id === "dec_test1");
    expect(d.size).toBeGreaterThan(72);
    expect(d.size).toBeLessThanOrEqual(400); // backend sanitizer's own upper bound
  });

  test("rotate handle produces a rotation within the valid -180..180 range", () => {
    const { calls } = renderDesigner(makeDecoration({ rotation: 0 }));
    firePointer(screen.getByTestId("rxp-handle-dec_test1"), "pointerdown", { clientX: 150, clientY: 310, pointerId: 1 });
    const rotateKnob = screen.getByTestId("rxp-rotate-dec_test1");

    firePointer(rotateKnob, "pointerdown", { clientX: 150, clientY: 292, pointerId: 3 });
    firePointer(rotateKnob, "pointermove", { clientX: 220, clientY: 310, pointerId: 3 });
    firePointer(rotateKnob, "pointerup", { pointerId: 3 });

    const rotCall = calls.find(([, v]) => v?.decorations?.some((d) => d.id === "dec_test1" && d.rotation !== 0));
    expect(rotCall).toBeTruthy();
    const d = rotCall[1].decorations.find((x) => x.id === "dec_test1");
    expect(d.rotation).toBeGreaterThanOrEqual(-180);
    expect(d.rotation).toBeLessThanOrEqual(180);
  });
});

// ── Mobile layout regression (bug report: designer overflows the viewport
// on iPhone portrait) ────────────────────────────────────────────────────
//
// Root cause: the Templates row is `flex overflow-x-auto` with `shrink-0`
// cards. Without an explicit `min-width: 0`, that row's rendered width
// resolves to its MIN-CONTENT (the full unscrolled width of every card)
// instead of shrinking to the available space — and because <fieldset>
// elements have a browser-default `min-width: min-content`, that width
// propagates up and forces the entire designer wider than the viewport on
// mobile instead of clipping + scrolling internally. Verified live in a
// real browser at a 390px viewport: the fieldset measured 874px before this
// fix and 318px after it, with the Templates row correctly reporting
// offsetWidth 318 / scrollWidth 874 (properly clipped and scrollable).
//
// jsdom has no real layout engine, so this can't re-measure pixel widths —
// it locks in the actual CSS classes that make the fix take effect, so a
// future edit that drops them regresses this exact bug loudly rather than
// silently.
test("fieldset and the Templates scroll row both opt out of content-based min-width (prevents mobile overflow)", () => {
  const { container } = renderDesigner(makeDecoration());

  const fieldset = container.querySelector('[data-testid="lrc-experience-designer"]');
  expect(fieldset.className).toMatch(/\bmin-w-0\b/);

  const templatesRow = fieldset.querySelector(".overflow-x-auto");
  expect(templatesRow).toBeTruthy();
  expect(templatesRow.className).toMatch(/\bmin-w-0\b/);
});
