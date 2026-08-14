// IosInstallModal.jsx — guided install modal for iOS Safari users.
// iOS Safari does NOT support beforeinstallprompt, so we walk the user
// through the native "Add to Home Screen" flow with visuals.
import React, { useEffect } from "react";
import { X, Share, PlusSquare, Check } from "lucide-react";

export default function IosInstallModal({ open, onClose }) {
  // Lock body scroll while open; restore on close.
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const isIpadOS =
    typeof navigator !== "undefined" &&
    navigator.platform === "MacIntel" &&
    typeof navigator.maxTouchPoints === "number" &&
    navigator.maxTouchPoints > 1;

  // Show the correct app name when the user is on the /studio shell.
  const appName =
    typeof window !== "undefined" &&
    (window.location.pathname === "/studio" ||
      window.location.pathname.startsWith("/studio/"))
      ? "Author Studio"
      : "EduHub Studio";

  return (
    <div
      data-testid="pwa-ios-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pwa-ios-modal-title"
      className="fixed inset-0 z-[2147483647] flex items-end sm:items-center justify-center px-3 sm:px-4"
      style={{
        background: "rgba(2, 0, 12, 0.78)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        animation: "pwaFadeIn 0.24s ease-out both",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-[440px] rounded-t-3xl sm:rounded-3xl border border-aurora-violet/30 shadow-[0_24px_60px_rgba(0,0,0,0.7)] overflow-hidden"
        style={{
          background:
            "linear-gradient(160deg, #0c0422 0%, #150835 55%, #1d0744 100%)",
          animation: "pwaSheetIn 0.4s cubic-bezier(.22,1,.36,1) both",
          paddingBottom: "max(0px, env(safe-area-inset-bottom))",
        }}
      >
        {/* top glow strip */}
        <div
          aria-hidden
          className="absolute top-0 left-0 right-0 h-px opacity-70"
          style={{
            background:
              "linear-gradient(90deg, transparent, #00e0ff 25%, #9b5cff 55%, #ff3da6 80%, transparent)",
          }}
        />
        {/* close */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          data-testid="pwa-ios-modal-close"
          className="absolute top-3 right-3 w-9 h-9 rounded-full flex items-center justify-center text-white/65 hover:text-white hover:bg-white/5 transition"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="px-5 sm:px-6 pt-6 sm:pt-7 pb-5">
          {/* header */}
          <div className="flex items-center gap-3 mb-5">
            <div
              aria-hidden
              className="w-12 h-12 rounded-2xl overflow-hidden flex-shrink-0 border border-aurora-cyan/40"
              style={{
                background:
                  "linear-gradient(135deg, rgba(0,224,255,0.25), rgba(155,92,255,0.25), rgba(255,61,166,0.25))",
              }}
            >
              <img
                src="/icons/icon-192.png"
                alt=""
                className="w-full h-full object-cover"
              />
            </div>
            <div>
              <div
                id="pwa-ios-modal-title"
                className="font-display font-extrabold text-[1.05rem] text-white tracking-tight leading-tight"
              >
                Install {appName}
              </div>
              <div className="text-[0.78rem] text-white/65 mt-0.5">
                Add to Home Screen on your iPhone
                {isIpadOS ? " or iPad" : ""}
              </div>
            </div>
          </div>

          {/* Steps */}
          <ol className="space-y-3">
            <Step
              n={1}
              title="Tap the Share button"
              body={
                <>
                  In Safari’s toolbar
                  {isIpadOS ? " at the top-right" : " at the bottom"}, tap the{" "}
                  <span className="inline-flex items-center gap-1 font-semibold text-aurora-cyan">
                    <Share className="w-3.5 h-3.5" />
                    Share
                  </span>{" "}
                  icon.
                </>
              }
              icon={<Share className="w-4 h-4" />}
            />
            <Step
              n={2}
              title='Choose "Add to Home Screen"'
              body={
                <>
                  Scroll through the share sheet and tap{" "}
                  <span className="inline-flex items-center gap-1 font-semibold text-aurora-violet">
                    <PlusSquare className="w-3.5 h-3.5" />
                    Add to Home Screen
                  </span>
                  .
                </>
              }
              icon={<PlusSquare className="w-4 h-4" />}
            />
            <Step
              n={3}
              title="Confirm and launch"
              body={
                <>
                  Tap{" "}
                  <span className="font-semibold text-aurora-magenta">Add</span>{" "}
                  in the top-right corner, then open {appName} from your
                  Home Screen for a full-screen, app-like experience.
                </>
              }
              icon={<Check className="w-4 h-4" />}
            />
          </ol>

          {/* Note */}
          <div
            className="mt-5 rounded-xl border border-aurora-cyan/25 px-3.5 py-3 text-[0.76rem] text-white/70"
            style={{ background: "rgba(0,224,255,0.05)" }}
          >
            <strong className="text-aurora-cyan font-semibold">Tip:</strong>{" "}
            Make sure you’re opening this page in <strong>Safari</strong> — the
            “Add to Home Screen” option isn’t available in Chrome or Firefox on
            iOS.
          </div>

          {/* footer */}
          <button
            type="button"
            onClick={onClose}
            data-testid="pwa-ios-modal-got-it"
            className="mt-5 w-full inline-flex items-center justify-center gap-2 rounded-full py-3 font-bold text-[0.88rem] text-[#0b0518] transition hover:shadow-[0_0_22px_rgba(0,224,255,0.45)]"
            style={{
              background:
                "linear-gradient(135deg, #00e0ff 0%, #9b5cff 55%, #ff3da6 100%)",
            }}
          >
            Got it
          </button>
        </div>
      </div>

      {/* local keyframes */}
      <style>{`
        @keyframes pwaFadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes pwaSheetIn {
          from { transform: translateY(28px) scale(0.98); opacity: 0; }
          to   { transform: translateY(0) scale(1);      opacity: 1; }
        }
      `}</style>
    </div>
  );
}

function Step({ n, title, body, icon }) {
  return (
    <li
      className="flex gap-3 rounded-xl border border-white/[0.07] px-3.5 py-3"
      style={{ background: "rgba(255,255,255,0.02)" }}
    >
      <div
        aria-hidden
        className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center font-bold text-[0.8rem] text-aurora-cyan border border-aurora-cyan/40"
        style={{ background: "rgba(0,224,255,0.08)" }}
      >
        {n}
      </div>
      <div className="min-w-0">
        <div className="font-semibold text-white text-[0.88rem] flex items-center gap-1.5">
          <span className="text-white/45">{icon}</span>
          <span>{title}</span>
        </div>
        <div className="text-[0.78rem] text-white/65 mt-0.5 leading-snug">
          {body}
        </div>
      </div>
    </li>
  );
}
