import React from "react";

/**
 * ReaderErrorBoundary.jsx — Issue 2 fix.
 *
 * The Reader route (/library/read/:slug) is mounted OUTSIDE AppShell with
 * no error boundary anywhere above it (confirmed by the architecture
 * audit). A single render-time exception anywhere in the Reader subtree
 * (a malformed chapter block, a pagination edge case, etc.) unmounts the
 * whole tree with nothing above it to catch it — the student sees a
 * fully blank page with no way to recover except manually navigating
 * away. This wraps the ROUTE only; ReaderPage/ChapterBlocks/AudioPlayer
 * internals are completely untouched — purely additive, same pattern as
 * the existing game ErrorBoundary (does not clear session/auth state).
 */
export default class ReaderErrorBoundary extends React.Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(err) {
    // eslint-disable-next-line no-console
    console.error("[ReaderErrorBoundary]", err);
  }

  reset = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          background: "#1a1220",
          color: "#F4E5C1",
        }}
        data-testid="reader-error-boundary"
      >
        <div
          style={{
            width: "100%",
            maxWidth: 420,
            textAlign: "center",
            borderRadius: 24,
            padding: 28,
            background: "linear-gradient(160deg, #2A1622 0%, #1A1420 100%)",
            border: "1px solid rgba(212,168,67,0.35)",
            boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
          }}
        >
          <h2 style={{ margin: "0 0 8px", fontSize: 18, fontWeight: 800 }}>
            This page hit a snag
          </h2>
          <p style={{ margin: "0 0 20px", fontSize: 13.5, opacity: 0.8, lineHeight: 1.5 }}>
            Your progress and points are safe. Try reloading this page, or
            head back to the Library.
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              data-testid="reader-error-reload"
              style={{
                padding: "10px 18px",
                borderRadius: 12,
                border: "1px solid rgba(212,168,67,0.55)",
                background: "linear-gradient(135deg, #FF6E91, #E63976)",
                color: "#1a0510",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Reload
            </button>
            <a
              href="/library"
              data-testid="reader-error-back"
              style={{
                padding: "10px 18px",
                borderRadius: 12,
                border: "1px solid rgba(212,168,67,0.35)",
                color: "#F4E5C1",
                textDecoration: "none",
                fontWeight: 700,
                display: "inline-flex",
                alignItems: "center",
              }}
            >
              Back to Library
            </a>
          </div>
        </div>
      </div>
    );
  }
}
