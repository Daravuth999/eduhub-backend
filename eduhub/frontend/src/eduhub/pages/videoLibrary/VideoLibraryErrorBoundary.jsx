import React from "react";

/**
 * VideoLibraryErrorBoundary.jsx — production-readiness audit fix.
 *
 * Neither /video-library nor /video-library/watch/:lessonId had any error
 * boundary above them (confirmed by the production-readiness audit) — a
 * single render-time exception anywhere in the dashboard or player subtree
 * would unmount the whole app with nothing above it to catch it. Mirrors
 * ReaderErrorBoundary.jsx's exact pattern (same reasoning, same non-
 * destructive behavior — never clears session/auth state), pointed at
 * /video-library instead of /library.
 */
export default class VideoLibraryErrorBoundary extends React.Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(err) {
    // eslint-disable-next-line no-console
    console.error("[VideoLibraryErrorBoundary]", err);
  }

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
          background: "#0F0A16",
          color: "#F4E5C1",
        }}
        data-testid="video-library-error-boundary"
      >
        <div
          style={{
            width: "100%",
            maxWidth: 420,
            textAlign: "center",
            borderRadius: 24,
            padding: 28,
            background: "linear-gradient(160deg, #241830 0%, #150F1C 100%)",
            border: "1px solid rgba(212,168,67,0.35)",
            boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
          }}
        >
          <h2 style={{ margin: "0 0 8px", fontSize: 18, fontWeight: 800 }}>
            This page hit a snag
          </h2>
          <p style={{ margin: "0 0 20px", fontSize: 13.5, opacity: 0.8, lineHeight: 1.5 }}>
            Your progress and points are safe. Try reloading this page, or
            head back to the Video Library.
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              data-testid="video-library-error-reload"
              style={{
                padding: "10px 18px",
                borderRadius: 12,
                border: "1px solid rgba(212,168,67,0.55)",
                background: "#D4A843",
                color: "#1a1220",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Reload
            </button>
            <a
              href="/video-library"
              data-testid="video-library-error-back"
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
              Back to Video Library
            </a>
          </div>
        </div>
      </div>
    );
  }
}
