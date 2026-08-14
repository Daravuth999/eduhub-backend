// InstallButton.jsx — compact install button for the header (and anywhere
// else we need it). Hidden automatically when the app is already installed.
// On click:
//   • Chrome / Edge / Android → fires the captured beforeinstallprompt.
//   • iOS Safari              → opens the iOS install guide modal via
//                               the provider-supplied `onIosRequest`.
import React from "react";
import { Download } from "lucide-react";

export default function InstallButton({
  canInstall,
  isIos,
  isInstalled,
  onInstall,
  onIosRequest,
  compact = false,
  className = "",
}) {
  if (isInstalled) return null;
  if (!canInstall && !isIos) return null;

  const handleClick = () => {
    if (canInstall) onInstall?.();
    else if (isIos) onIosRequest?.();
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      data-testid="pwa-install-header-btn"
      aria-label="Install EduHub Studio"
      className={
        "inline-flex items-center gap-1.5 rounded-full font-semibold transition " +
        (compact
          ? "px-2.5 py-[6px] text-[0.72rem] "
          : "px-3.5 py-[7px] text-[0.78rem] ") +
        "bg-gradient-to-r from-aurora-cyan/15 via-aurora-violet/15 to-aurora-magenta/15 " +
        "border border-aurora-cyan/40 text-aurora-cyan " +
        "hover:from-aurora-cyan/25 hover:via-aurora-violet/25 hover:to-aurora-magenta/25 " +
        "hover:shadow-[0_0_14px_rgba(0,224,255,0.45)] " +
        className
      }
    >
      <Download className="w-3.5 h-3.5" />
      <span className="hidden sm:inline">Install</span>
      <span className="sm:hidden">Get app</span>
    </button>
  );
}
