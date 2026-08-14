import { render, screen, within } from "@testing-library/react";
import MobileBottomNav, { ITEMS } from "../MobileBottomNav";
import { useAuth } from "../../context/AuthContext";
import { useUnifiedBadges } from "../../hooks/useUnifiedBadges";

// react-router-dom v7's package "exports" map isn't resolvable under this
// project's Jest config — every test touching a component that imports it
// must virtually mock it (same convention as GuestAwareGate.test.jsx).
let mockPathname = "/";
jest.mock(
  "react-router-dom",
  () => ({
    useLocation: () => ({ pathname: mockPathname }),
    Link: ({ to, children, ...rest }) => (
      <a href={to} {...rest}>{children}</a>
    ),
  }),
  { virtual: true },
);
jest.mock("../../context/AuthContext", () => ({
  useAuth: jest.fn(),
}));
jest.mock("../../hooks/useUnifiedBadges", () => ({
  useUnifiedBadges: jest.fn(),
}));

function setup({ isAuthenticated = true, byModule = {}, pathname = "/", hidden } = {}) {
  mockPathname = pathname;
  useAuth.mockReturnValue({ isAuthenticated });
  useUnifiedBadges.mockReturnValue({ byModule });
  return render(<MobileBottomNav hidden={hidden} />);
}

test("renders exactly 6 items, in order: Home, Library, Videos, Spin, Portal, AI Assistant", () => {
  expect(ITEMS.map((it) => it.label)).toEqual([
    "Home", "Library", "Videos", "Spin", "Portal", "AI Assistant",
  ]);
  setup();
  const nav = screen.getByTestId("mobile-bottom-nav");
  const labels = ["home", "library", "videos", "spin", "portal", "ai-assistant"];
  labels.forEach((slug) => {
    expect(within(nav).getByTestId(`mobile-tab-${slug}`)).toBeInTheDocument();
  });
});

test("Videos links to /video-library and is not badged", () => {
  setup();
  expect(screen.getByTestId("mobile-tab-videos")).toHaveAttribute("href", "/video-library");
  expect(screen.queryByTestId("mobile-tab-badge-videos")).not.toBeInTheDocument();
});

test("active state highlights Videos on /video-library and its watch sub-route, not Library", () => {
  setup({ pathname: "/video-library/watch/vid_1" });
  expect(screen.getByTestId("mobile-tab-videos")).toHaveAttribute("aria-current", "page");
  expect(screen.getByTestId("mobile-tab-library")).not.toHaveAttribute("aria-current");
});

test("'More' is gone entirely — no testid, no label text", () => {
  setup();
  expect(screen.queryByTestId("mobile-tab-more")).not.toBeInTheDocument();
  expect(screen.queryByText("More")).not.toBeInTheDocument();
});

test("AI Assistant links to /assistant", () => {
  setup();
  expect(screen.getByTestId("mobile-tab-ai-assistant")).toHaveAttribute("href", "/assistant");
});

test("Library badge still renders when unread and authenticated (existing badge preserved)", () => {
  setup({ byModule: { library: 2 } });
  expect(screen.getByTestId("mobile-tab-badge-library")).toHaveTextContent("2");
});

test("no badge module fabricated for AI Assistant", () => {
  setup({ byModule: { library: 2, wallet: 3 } });
  expect(screen.queryByTestId("mobile-tab-badge-ai-assistant")).not.toBeInTheDocument();
});

test("active state highlights AI Assistant on /assistant route", () => {
  setup({ pathname: "/assistant" });
  expect(screen.getByTestId("mobile-tab-ai-assistant")).toHaveAttribute("aria-current", "page");
});

test("hidden prop still slides the nav off-screen (unaffected by nav-item change)", () => {
  setup({ hidden: true });
  expect(screen.getByTestId("mobile-bottom-nav")).toHaveAttribute("aria-hidden", "true");
});
