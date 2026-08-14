// InstallBanner.jsx — subtle bottom-sheet banner shown to users who
// haven't installed the app yet. Respects:
//   • bottom safe-area (iOS notch)
//   • MobileBottomNav (68px) on mobile
//   • localStorage "dismissed" flag
// Pure presentational component; dismissed-state lives in usePwaInstall.
import React from "react";
import { Download, X } from "lucide-react";

export default function InstallBanner({
  open,
  isIos,
  onInstall,
  onIosRequest,
  onDismiss,
}) {
  if (!open) return null;

  const handleClick = () => {
    if (isIos) onIosRequest?.();
    else onInstall?.();
  };

  // Show the correct app name when the user is on the /studio shell.
  const appName =
    typeof window !== "undefined" &&
    (window.location.pathname === "/studio" ||
      window.location.pathname.startsWith("/studio/"))
      ? "Author Studio"
      : "EduHub Studio";

  return (
    <div
      data-testid="pwa-install-banner"
      role="region"
      aria-label={`Install ${appName}`}
      className="fixed inset-x-0 z-[2147483640] flex justify-center px-3 pointer-events-none"
      style={{
        bottom:
          "calc(74px + max(10px, env(safe-area-inset-bottom, 0px)))",
      }}
    >
      <div
        className="pointer-events-auto w-full max-w-[520px] rounded-2xl border border-aurora-violet/30 shadow-[0_14px_40px_rgba(0,0,0,0.55)] backdrop-blur-xl"
        style={{
          background:
            "linear-gradient(135deg, rgba(14,6,32,0.94) 0%, rgba(22,10,50,0.94) 60%, rgba(30,8,48,0.94) 100%)",
          animation: "pwaPillIn 0.45s cubic-bezier(.22,1,.36,1) both",
        }}
      >
        <div className="flex items-center gap-3 p-3.5">
          <div
            aria-hidden
            className="flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center border border-aurora-cyan/40"
            style={{
              background:
                "linear-gradient(135deg, rgba(0,224,255,0.18), rgba(155,92,255,0.18), rgba(255,61,166,0.18))",
            }}
          >
            <Download className="w-5 h-5 text-aurora-cyan" />
          </div>
          <div className="flex-1 min-w-0">
            <div
              className="font-display font-bold text-[0.95rem] text-white tracking-tight"
              data-testid="pwa-banner-title"
            >
              Install {appName}
            </div>
            <div className="text-[0.78rem] text-white/70 leading-snug mt-0.5">
              {isIos
                ? "Add to Home Screen for a full-screen, app-like experience."
                : "One tap to install — faster launch, offline-ready."}
            </div>
          </div>
          <button
            type="button"
            onClick={handleClick}
            data-testid="pwa-banner-install-btn"
            className="flex-shrink-0 inline-flex items-center gap-1.5 px-3.5 py-[8px] rounded-full text-[0.78rem] font-bold transition text-[#0b0518] hover:shadow-[0_0_18px_rgba(0,224,255,0.45)]"
            style={{
              background:
                "linear-gradient(135deg, #00e0ff 0%, #9b5cff 55%, #ff3da6 100%)",
            }}
          >
            Install
          </button>
          <button
            type="button"
            onClick={onDismiss}
            data-testid="pwa-banner-dismiss-btn"
            aria-label="Dismiss"
            className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-white/55 hover:text-white hover:bg-white/5 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
