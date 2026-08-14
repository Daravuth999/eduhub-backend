// usePwaInstall.js — single source of truth for PWA install state.
// v9.0 (2026-02) — Replaces the vanilla-JS install pill that used to
// live inside index.html. Exposes:
//   • canInstall        — Chrome/Edge/Android fired beforeinstallprompt
//   • isIos             — user is on iOS (Safari or iOS Chrome/Edge/FF)
//   • isStandalone      — app is already running as an installed PWA
//   • isInstalled       — standalone OR previously-installed signal
//   • promptInstall()   — fires native prompt on Chrome; no-op on iOS
//   • dismissBanner()   — persist "don't show bottom banner again"
//   • bannerDismissed   — reactive flag for the bottom banner
import { useCallback, useEffect, useState } from "react";

const BANNER_DISMISS_KEY = "eduhub_pwa_banner_dismissed_v1";

function detectIos() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  // iPhone / iPod / iPad (including iPad on iOS 13+ which reports MacIntel + touch)
  const iosUA = /iPad|iPhone|iPod/.test(ua);
  const iPadOS =
    navigator.platform === "MacIntel" &&
    typeof navigator.maxTouchPoints === "number" &&
    navigator.maxTouchPoints > 1;
  return iosUA || iPadOS;
}

function detectStandalone() {
  if (typeof window === "undefined") return false;
  const mq =
    window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
  // iOS Safari sets navigator.standalone
  const iosStandalone =
    typeof navigator !== "undefined" && navigator.standalone === true;
  return !!(mq || iosStandalone);
}

export default function usePwaInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [isStandalone, setIsStandalone] = useState(detectStandalone);
  const [isInstalled, setIsInstalled] = useState(detectStandalone);
  const [bannerDismissed, setBannerDismissed] = useState(() => {
    try {
      return localStorage.getItem(BANNER_DISMISS_KEY) === "1";
    } catch (_) {
      return false;
    }
  });

  const isIos = detectIos();

  useEffect(() => {
    const onBeforeInstall = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    const onInstalled = () => {
      setDeferredPrompt(null);
      setIsInstalled(true);
    };
    const mq =
      window.matchMedia && window.matchMedia("(display-mode: standalone)");
    const onDisplayModeChange = (e) => {
      setIsStandalone(e.matches);
      if (e.matches) setIsInstalled(true);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    if (mq && mq.addEventListener) mq.addEventListener("change", onDisplayModeChange);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
      if (mq && mq.removeEventListener)
        mq.removeEventListener("change", onDisplayModeChange);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferredPrompt) return { outcome: "unavailable" };
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice.catch(() => ({
      outcome: "dismissed",
    }));
    setDeferredPrompt(null);
    return choice || { outcome: "dismissed" };
  }, [deferredPrompt]);

  const dismissBanner = useCallback(() => {
    try {
      localStorage.setItem(BANNER_DISMISS_KEY, "1");
    } catch (_) {}
    setBannerDismissed(true);
  }, []);

  const resetDismissed = useCallback(() => {
    try {
      localStorage.removeItem(BANNER_DISMISS_KEY);
    } catch (_) {}
    setBannerDismissed(false);
  }, []);

  const canInstall = !!deferredPrompt;
  // Any signal that the app is installable for the current user.
  const isInstallable = !isInstalled && (canInstall || isIos);

  return {
    canInstall,
    isIos,
    isStandalone,
    isInstalled,
    isInstallable,
    bannerDismissed,
    promptInstall,
    dismissBanner,
    resetDismissed,
  };
}
