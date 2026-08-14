/**
 * Hero.test.jsx — Hero is pure presentation: given a resolved
 * ExperienceConfig, it renders content correctly and applies the
 * referenced palette. It must never crash on a partial/empty config
 * (every domain read with a fallback), and must honor content.visible.
 *
 * Tier is mocked to "static" so assertions don't depend on real
 * requestAnimationFrame/CSS transition timing (jsdom doesn't run a real
 * compositor, and even real browsers throttle rAF in a backgrounded tab —
 * see the architecture notes for why this component is imperative-motion
 * driven in the first place).
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import Hero from "../Hero";

jest.mock("../../hooks/usePlaybackMode", () => ({
  __esModule: true,
  default: () => "static",
  usePlaybackMode: () => "static",
}));

const fullConfig = {
  content: {
    badge: "Academic Learning Portal",
    title: "Welcome to Our Classroom",
    khmerSubtitle: "ស្វាគមន៍",
    description: "Interactive Learning Portal",
    instructorLine: "Daravuth.Y",
    visible: true,
  },
  appearance: { paletteId: "morningEmerald", radiusId: "lg" },
  motion: { presetId: "cinematicRise", lightingId: "sunrise", particlesId: "sparseStars" },
  playback: { firstLaunchOfDay: true, firstLaunchPerSession: true, replayIntervalHours: 6 },
};

describe("Hero", () => {
  it("renders every content field from the resolved config", () => {
    render(<Hero config={fullConfig} />);
    expect(screen.getByTestId("hero-title").textContent).toBe("Welcome to Our Classroom");
    expect(screen.getByTestId("hero-khmer").textContent).toBe("ស្វាគមន៍");
    expect(screen.getByText("Academic Learning Portal")).toBeInTheDocument();
    expect(screen.getByText("Interactive Learning Portal")).toBeInTheDocument();
    expect(screen.getByText("Daravuth.Y")).toBeInTheDocument();
  });

  it("applies the referenced palette's onBase color to rendered text, not a hardcoded color", () => {
    render(<Hero config={fullConfig} />);
    // morningEmerald.onBase === "#FFFFFF"; jsdom's CSSOM can't parse the
    // gradient background (no linear-gradient support in its grammar), so
    // this checks a plain-color token application instead — the part that
    // actually round-trips through jsdom and proves the palette is wired.
    expect(screen.getByTestId("hero-title")).toHaveStyle({ color: "#FFFFFF" });
  });

  it("renders nothing when content.visible is false", () => {
    const hidden = { ...fullConfig, content: { ...fullConfig.content, visible: false } };
    const { container } = render(<Hero config={hidden} />);
    expect(container.innerHTML).toBe("");
  });

  it("never crashes on a completely empty config", () => {
    expect(() => render(<Hero config={{}} />)).not.toThrow();
  });

  it("never crashes when config is null/undefined", () => {
    expect(() => render(<Hero config={null} />)).not.toThrow();
    expect(() => render(<Hero config={undefined} />)).not.toThrow();
  });

  it("omits a content group entirely when its field is absent, rather than rendering an empty element", () => {
    const noInstructor = { ...fullConfig, content: { ...fullConfig.content, instructorLine: "" } };
    render(<Hero config={noInstructor} />);
    expect(screen.queryByText(/Instructor:/)).not.toBeInTheDocument();
  });

  it("renders an optional CTA when the config provides one", () => {
    const withCta = { ...fullConfig, content: { ...fullConfig.content, cta: { label: "Explore Books", href: "/library" } } };
    render(<Hero config={withCta} />);
    const link = screen.getByText("Explore Books");
    expect(link.closest("a")).toHaveAttribute("href", "/library");
  });

  describe("Hero Artwork", () => {
    it("renders nothing when appearance.heroArtwork is absent", () => {
      render(<Hero config={fullConfig} />);
      expect(screen.queryByTestId("hero-artwork-layer")).not.toBeInTheDocument();
    });

    it("renders nothing when heroArtwork has no url (e.g. cleared/removed)", () => {
      const noUrl = { ...fullConfig, appearance: { ...fullConfig.appearance, heroArtwork: { placement: "right" } } };
      render(<Hero config={noUrl} />);
      expect(screen.queryByTestId("hero-artwork-layer")).not.toBeInTheDocument();
    });

    it("renders the artwork image when a url is present", () => {
      const withArt = { ...fullConfig, appearance: { ...fullConfig.appearance, heroArtwork: { url: "https://cdn.example/art.png", placement: "right", scale: 100, layerOrder: "behindText" } } };
      render(<Hero config={withArt} />);
      expect(screen.getByTestId("hero-artwork-image")).toHaveAttribute("src", "https://cdn.example/art.png");
    });

    it("defaults to the behindText slot when layerOrder is unspecified", () => {
      const withArt = { ...fullConfig, appearance: { ...fullConfig.appearance, heroArtwork: { url: "https://cdn.example/art.png" } } };
      const { container } = render(<Hero config={withArt} />);
      const hero = screen.getByTestId("hero");
      const artwork = screen.getByTestId("hero-artwork-layer");
      const typography = container.querySelector('[data-testid="hero-title"]').closest(".relative");
      const children = Array.from(hero.children);
      // Artwork must appear before the typography block in DOM order (behind it).
      expect(children.indexOf(artwork)).toBeLessThan(children.indexOf(typography));
    });

    it("aboveDecorative places the artwork after the typography block in DOM order (topmost)", () => {
      const withArt = {
        ...fullConfig,
        appearance: { ...fullConfig.appearance, heroArtwork: { url: "https://cdn.example/art.png", layerOrder: "aboveDecorative" } },
      };
      const { container } = render(<Hero config={withArt} />);
      const hero = screen.getByTestId("hero");
      const artwork = screen.getByTestId("hero-artwork-layer");
      const typography = container.querySelector('[data-testid="hero-title"]').closest(".relative");
      const children = Array.from(hero.children);
      expect(children.indexOf(artwork)).toBeGreaterThan(children.indexOf(typography));
    });

    it("the artwork layer is never interactive (pointer-events: none) so it can't block clicks on Hero content", () => {
      const withArt = { ...fullConfig, appearance: { ...fullConfig.appearance, heroArtwork: { url: "https://cdn.example/art.png" } } };
      render(<Hero config={withArt} />);
      expect(screen.getByTestId("hero-artwork-layer")).toHaveStyle({ pointerEvents: "none" });
    });
  });
});
