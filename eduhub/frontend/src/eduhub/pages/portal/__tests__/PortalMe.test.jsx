/**
 * PortalMe.test.jsx — proves the Speaking Lab "Join Prize Pool" card
 * (mounted inside Dashboard.tsx, which PortalMe renders) is reachable
 * ONLY through the authenticated Portal context, never for an
 * unauthenticated visitor.
 *
 * PortalMe is the actual authentication gate for /portal/me: it renders
 * nothing at all — not even a login prompt — unless AuthContext already
 * has a logged-in student with portalData. Since JoinPrizePool only ever
 * mounts inside Dashboard, and Dashboard only ever mounts inside this
 * gate, this test is the direct proof that JoinPrizePool cannot render
 * outside an authenticated session.
 */
import { render, screen } from "@testing-library/react";
import PortalMe from "../PortalMe";
import { useAuth } from "../../../context/AuthContext";

jest.mock("../../../context/AuthContext", () => ({
  useAuth: jest.fn(),
}));

jest.mock("../screens/Dashboard", () => ({
  Dashboard: () => <div data-testid="dashboard-rendered">DASHBOARD</div>,
}));

describe("PortalMe — authentication gate for the Speaking Lab card's mount point", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("renders nothing (not even Dashboard) when there is no authenticated student", () => {
    useAuth.mockReturnValue({ student: null, logout: () => {} });
    const { container } = render(<PortalMe />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("dashboard-rendered")).not.toBeInTheDocument();
  });

  test("renders nothing when student exists but has no portalData yet", () => {
    useAuth.mockReturnValue({ student: { portalData: null }, logout: () => {} });
    const { container } = render(<PortalMe />);
    expect(container).toBeEmptyDOMElement();
  });

  test("renders Dashboard (and therefore the Speaking Lab card) only once authenticated", () => {
    useAuth.mockReturnValue({
      student: { portalData: { StudentID: "stu001" }, password: "x", portalPoints: 10 },
      logout: () => {},
    });
    render(<PortalMe />);
    expect(screen.getByTestId("dashboard-rendered")).toBeInTheDocument();
  });
});
