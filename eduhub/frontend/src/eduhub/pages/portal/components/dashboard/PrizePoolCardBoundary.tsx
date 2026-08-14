import { Component, type ReactNode } from "react";

/**
 * PrizePoolCardBoundary — isolates JoinPrizePool from the rest of My
 * Portal. If anything inside throws during render (not just a rejected
 * API call — JoinPrizePool already catches those internally), this
 * boundary contains the crash and shows a small, visible fallback
 * instead of blanking the entire Dashboard. Scoped to this one card
 * only; no other Portal section is wrapped or affected.
 *
 * The fallback is deliberately visible (not `null`) — a silently empty
 * boundary is indistinguishable from "the card was never mounted at
 * all", which makes a real crash impossible to tell apart from a
 * deployment/caching problem when someone reports "I don't see the
 * card". A visible, labeled fallback always proves the boundary itself
 * rendered, narrowing any future report immediately.
 */
interface State {
  hasError: boolean;
}

export class PrizePoolCardBoundary extends Component<{ children: ReactNode }, State> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    // eslint-disable-next-line no-console
    console.error("[PrizePoolCardBoundary] JoinPrizePool crashed:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="join-prize-pool join-prize-pool--boundary-fallback"
          role="alert"
          data-testid="join-prize-pool-boundary-fallback"
        >
          Speaking Lab is temporarily unavailable. The rest of My Portal is
          unaffected.
        </div>
      );
    }
    return this.props.children;
  }
}

export default PrizePoolCardBoundary;
