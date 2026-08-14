import React from "react";

interface State {
  hasError: boolean;
  message: string;
}

// Top-level Error Boundary — catches render errors in any subtree and shows
// a recoverable card instead of unmounting the whole app. Critically: it
// does NOT clear the user's session, so the auth state survives a crash.
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { hasError: false, message: "" };

  static getDerivedStateFromError(err: unknown): State {
    return {
      hasError: true,
      message: err instanceof Error ? err.message : "Unexpected error",
    };
  }

  componentDidCatch(err: unknown) {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", err);
  }

  reset = () => {
    this.setState({ hasError: false, message: "" });
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="glass-strong w-full max-w-md rounded-3xl p-7 text-center shadow-[0_15px_40px_rgba(0,0,0,0.4)]">
          <div
            className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl text-2xl"
            style={{
              background: "linear-gradient(135deg, #FFD85C, #FF4081)",
              boxShadow: "0 10px 30px rgba(255,64,129,0.4)",
            }}
          >
            ⚠️
          </div>
          <h2 className="text-xl font-extrabold tracking-wider text-gradient-gold">
            Something glitched
          </h2>
          <p className="mt-2 text-sm text-white/70">
            The game hit a small bump but your login is safe.
          </p>
          {this.state.message && (
            <p className="mt-3 rounded-lg bg-black/30 px-3 py-2 text-[11px] font-mono text-white/55">
              {this.state.message}
            </p>
          )}
          <button
            onClick={this.reset}
            className="mt-5 w-full rounded-xl px-6 py-3 font-bold text-white shadow-[0_6px_20px_rgba(19,194,194,0.4)] transition active:scale-95"
            style={{
              background: "linear-gradient(135deg, #13C2C2, #0D9488)",
            }}
          >
            Resume Game
          </button>
        </div>
      </div>
    );
  }
}
