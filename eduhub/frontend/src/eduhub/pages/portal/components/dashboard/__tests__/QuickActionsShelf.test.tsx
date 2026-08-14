/**
 * QuickActionsShelf.test.tsx — Speaking Lab is no longer a quick-action
 * tile. It's the auto-hiding one-tap live card on My Portal
 * (SpeakingLabLiveCard). The shelf keeps only its four original actions.
 */
import { render, screen } from "@testing-library/react";
import { QuickActionsShelf } from "../QuickActionsShelf";
import { LanguageProvider } from "../../../contexts/LanguageContext";

function renderShelf() {
  return render(
    <LanguageProvider>
      <QuickActionsShelf
        onScoreGuide={() => {}}
        onSendPoints={() => {}}
        onPrint={() => {}}
        onTopUp={() => {}}
      />
    </LanguageProvider>,
  );
}

describe("QuickActionsShelf", () => {
  test("renders the four original quick actions", () => {
    renderShelf();
    expect(screen.getByTestId("portal-quick-action-send-points")).toBeInTheDocument();
    expect(screen.getByTestId("portal-quick-action-top-up")).toBeInTheDocument();
    expect(screen.getByTestId("portal-quick-action-score-guide")).toBeInTheDocument();
    expect(screen.getByTestId("portal-quick-action-print")).toBeInTheDocument();
  });

  test("no longer contains a Speaking Lab tile", () => {
    renderShelf();
    expect(screen.queryByTestId("portal-quick-action-speaking-lab")).not.toBeInTheDocument();
    expect(screen.queryByText(/speaking lab/i)).not.toBeInTheDocument();
  });
});
