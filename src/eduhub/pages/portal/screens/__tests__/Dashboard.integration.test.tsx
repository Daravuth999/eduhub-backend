/**
 * Dashboard.integration.test.tsx — route-level proof that My Portal's
 * Speaking Lab entry is the auto-hiding one-tap live card, and that it
 * can NEVER surface a Speaking Lab connectivity error onto the main
 * dashboard.
 *
 * The card (SpeakingLabLiveCard) asks the server "is there a live
 * session for me?" on mount. It renders NOTHING when there's no session
 * or when the check fails — the dashboard degrades to invisible, never
 * to an error. These tests pin that behavior against the real
 * Dashboard.tsx tree.
 *
 * Every Dashboard child component and hook is stubbed to a trivial
 * canary so the real Dashboard.tsx JSX tree is exercised fast and
 * deterministically.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { Dashboard } from "../Dashboard";
import { LanguageProvider } from "../../contexts/LanguageContext";
import { speakingLabApi, SpeakingLabApiError } from "../../lib/speakingLabApi";

jest.mock("../../lib/speakingLabApi", () => {
  const actual = jest.requireActual("../../lib/speakingLabApi");
  return {
    ...actual,
    speakingLabApi: {
      activeSession: jest.fn(),
      joinActive: jest.fn(),
      joinPreview: jest.fn(),
      directJoin: jest.fn(),
    },
  };
});
const mockedApi = speakingLabApi as jest.Mocked<typeof speakingLabApi>;

function activeSession(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ok: true, active: true, session_id: "sl_1", schedule: "AB", entry_fee: 4,
    pool_total: 0, player_count: 0, direct_join_enabled: true, existing_entry: null,
    ...overrides,
  };
}

jest.mock("../../hooks/useStudentData", () => ({
  useStudentData: (initial: any) => ({ data: initial }),
}));
jest.mock("../../hooks/useComments", () => ({
  useComments: () => ({ data: [], loading: false }),
}));
jest.mock("../../hooks/useHistory", () => ({
  useHistory: () => ({ data: [], loading: false }),
}));
jest.mock("../../hooks/usePoints", () => ({
  usePoints: () => ({
    points: 0,
    receiveEvent: null,
    consumeReceiveEvent: jest.fn(),
    spendEvent: null,
    consumeSpendEvent: jest.fn(),
    previousPoints: 0,
    refresh: jest.fn(),
    debug: {},
    triggerTestEvent: jest.fn(),
    loading: false,
    rewardVersion: 0,
  }),
}));
jest.mock("../../hooks/useConnectionStatus", () => ({
  useConnectionStatus: () => ({ online: true }),
}));
jest.mock("../../hooks/useTopPerformerCelebration", () => ({
  useTopPerformerCelebration: () => ({
    showToast: false,
    dismiss: jest.fn(),
    improvedByCriterion: {},
    excellentStreak: 0,
  }),
}));
jest.mock("../../hooks/useIdleLogout", () => ({ useIdleLogout: () => {} }));
jest.mock("../../../../context/AuthContext", () => ({
  useAuth: () => ({ student: { role: "student" } }),
}));

// Trivial canary stubs for every other real Dashboard section — each
// renders a unique marker so we can assert it survives a crash in the
// Speaking Lab card elsewhere in the same tree.
jest.mock("../../components/layout/PortalAppBar", () => ({
  PortalAppBar: () => <div data-testid="canary-appbar" />,
}));
jest.mock("../../components/layout/AuroraBackdrop", () => ({
  AuroraBackdrop: () => null,
}));
jest.mock("../../components/layout/PageShell", () => ({
  PageShell: ({ children }: any) => <div>{children}</div>,
}));
jest.mock("../../components/layout/ConnectionBanner", () => ({
  ConnectionBanner: () => null,
}));
jest.mock("../../components/dashboard/StudentHero", () => ({
  StudentHero: () => <div data-testid="canary-student-hero">STUDENT HERO</div>,
}));
jest.mock("../../components/dashboard/MonthlyPerformance", () => ({
  MonthlyPerformance: () => null,
}));
jest.mock("../../components/dashboard/TransactionTimeline", () => ({
  TransactionTimeline: () => (
    <div data-testid="canary-transaction-timeline">TRANSACTIONS</div>
  ),
}));
jest.mock("../../components/dashboard/CriteriaShelf", () => ({ CriteriaShelf: () => null }));
jest.mock("../../components/dashboard/OverallScore", () => ({ OverallScore: () => null }));
jest.mock("../../components/dashboard/FeedbackTriad", () => ({ FeedbackTriad: () => null }));
jest.mock("../../components/dashboard/CommentsSection", () => ({ CommentsSection: () => null }));
jest.mock("../../components/dashboard/PerformanceChart", () => ({ PerformanceChart: () => null }));
jest.mock("../../components/dashboard/TopPerformerToast", () => ({ TopPerformerToast: () => null }));
jest.mock("../../components/dashboard/CriterionDetailDrawer", () => ({
  CriterionDetailDrawer: () => null,
}));
jest.mock("../../components/dashboard/DebugDrawer", () => ({ DebugDrawer: () => null }));
jest.mock("../../components/modals/ScoreGuideModal", () => ({ ScoreGuideModal: () => null }));
jest.mock("../../components/modals/SendPointsModal", () => ({ SendPointsModal: () => null }));
jest.mock("../../components/modals/RestrictionModal", () => ({ RestrictionModal: () => null }));
jest.mock("../../components/dashboard/PointsTopUpPopup", () => ({ PointsTopUpPopup: () => null }));
jest.mock("../../components/dashboard/TuitionStrip", () => ({
  TuitionStrip: () => <div data-testid="canary-tuition-strip">TUITION</div>,
}));
jest.mock("../../components/dashboard/QuickActionsShelf", () => ({
  QuickActionsShelf: () => <div data-testid="canary-quick-actions">QUICK ACTIONS</div>,
}));
jest.mock("../../components/dashboard/PointsPurchaseModal", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../../components/dashboard/MonthlyReviewExpander", () => ({
  MonthlyReviewExpander: () => null,
}));
jest.mock("../../components/dashboard/PerformanceGlance", () => ({
  PerformanceGlance: () => <div data-testid="canary-performance-glance">PERFORMANCE</div>,
}));
jest.mock("../../components/dashboard/RewardsHub", () => ({
  RewardsHub: () => <div data-testid="canary-rewards-hub">REWARDS</div>,
}));

const baseStudent: any = {
  StudentID: "stu001",
  Name: "Test Student",
  Password: "x",
};

function renderDashboard() {
  return render(
    <LanguageProvider>
      <Dashboard
        student={baseStudent}
        password="x"
        initialPoints={0}
        onLogout={() => {}}
      />
    </LanguageProvider>,
  );
}

describe("Dashboard — Speaking Lab live card", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  test("when no session is live, the live card is hidden and the rest of My Portal renders normally", async () => {
    mockedApi.activeSession.mockResolvedValueOnce(activeSession({ active: false }));

    renderDashboard();

    await waitFor(() => expect(mockedApi.activeSession).toHaveBeenCalled());
    expect(screen.getByTestId("canary-student-hero")).toBeInTheDocument();
    expect(screen.getByTestId("canary-quick-actions")).toBeInTheDocument();
    expect(screen.getByTestId("canary-tuition-strip")).toBeInTheDocument();
    expect(screen.getByTestId("canary-rewards-hub")).toBeInTheDocument();
    expect(screen.getByTestId("canary-transaction-timeline")).toBeInTheDocument();
    expect(screen.queryByTestId("speaking-lab-live-card")).not.toBeInTheDocument();
  });

  test("a failed active-session check NEVER surfaces an error on the dashboard — the card just hides", async () => {
    mockedApi.activeSession.mockRejectedValueOnce(
      new SpeakingLabApiError("backend_unreachable", "REACT_APP_BACKEND_URL is not set", 0),
    );

    renderDashboard();

    await waitFor(() => expect(mockedApi.activeSession).toHaveBeenCalled());
    // No Speaking Lab error text of any kind reaches the main screen.
    expect(screen.queryByText(/couldn't reach the prize pool/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/REACT_APP_BACKEND_URL/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("speaking-lab-live-card")).not.toBeInTheDocument();
    // The rest of My Portal is completely unaffected.
    expect(screen.getByTestId("canary-student-hero")).toBeInTheDocument();
    expect(screen.getByTestId("canary-rewards-hub")).toBeInTheDocument();
  });

  test("when a session is live and joinable, the one-tap card appears near the top of My Portal", async () => {
    mockedApi.activeSession.mockResolvedValueOnce(activeSession());

    renderDashboard();

    await waitFor(() =>
      expect(screen.getByTestId("speaking-lab-live-card")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("speaking-lab-join-now")).toBeInTheDocument();
    // Positioned right after the points-balance hero, before quick actions.
    const portal = screen.getByTestId("my-portal");
    const children = Array.from(portal.children);
    const heroIndex = children.findIndex((el) => el.getAttribute("data-testid") === "canary-student-hero");
    const cardIndex = children.findIndex((el) => el.contains(screen.getByTestId("speaking-lab-live-card")));
    const quickIndex = children.findIndex((el) => el.getAttribute("data-testid") === "canary-quick-actions");
    expect(cardIndex).toBeGreaterThan(heroIndex);
    expect(quickIndex).toBeGreaterThan(cardIndex);
  });
});
