/**
 * LibraryTopUpButton.jsx — Premium Khmer-first Top-Up Button (v3)
 * =================================================================
 * Always-visible "បញ្ចូលពិន្ទុ" (Top-Up) action button placed in the
 * Library header area, next to the wallet pill.
 *
 * v3 (UI/Khmer surgery — 2026-05-23):
 *   • Khmer-first label "បញ្ចូលពិន្ទុ" + small English subtext.
 *   • Bigger, premium pill — no longer overlaps the wallet pill on
 *     mobile (mobile = 11 px subtext drops out, label shrinks slightly).
 *   • Strong gold/cyan glow that signals "important action" without
 *     fighting other CTAs on the page.
 *   • Real Khmer-capable font stack so the label never renders as
 *     broken tofu glyphs on iPhone Safari.
 *
 * No change to mounting, props, or modal contract.
 *
 * Props:
 *   studentId  — from student?.studentId (already in LibraryPage scope)
 *   onCredited — calls refreshPoints() after successful top-up
 */

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Coins, Sparkles } from "lucide-react";
import PointsPurchaseModal from "../pages/portal/components/dashboard/PointsPurchaseModal";
import { prefetchPackages } from "../utils/topUpPackagesCache";

const KHMER_FONT_STACK =
  `'Noto Sans Khmer', 'Kantumruy Pro', 'Battambang', 'Khmer OS', ` +
  `'Khmer OS Battambang', 'Hanuman', 'Bayon', system-ui, ` +
  `-apple-system, sans-serif`;

export default function LibraryTopUpButton({ studentId, onCredited }) {
  const [showModal, setShowModal] = useState(false);
  const [justCredited, setJustCredited] = useState(false);
  // Guard against accidental double-mount of the modal from a fast
  // double-tap. The cache module already dedupes network requests, but
  // this also prevents two modal instances racing on identical state.
  const openLockRef = useRef(false);

  // Prefetch v1.0.1 — kick off ONE real background refresh as soon as the
  // Top-Up button mounts (Library is now visible). The shared in-flight
  // promise in topUpPackagesCache guarantees this never produces a
  // duplicate request even if React StrictMode double-invokes the effect.
  useEffect(() => {
    prefetchPackages();
  }, []);

  function handleCredited(pts) {
    setJustCredited(true);
    setTimeout(() => setJustCredited(false), 3000);
    onCredited?.(pts);
  }

  function openModal() {
    if (openLockRef.current || showModal) return;
    openLockRef.current = true;
    // Best-effort forced refresh on intent-to-open. The modal also forces
    // a refresh on mount; both go through the same in-flight promise so
    // there is at most one network request.
    prefetchPackages();
    setShowModal(true);
    setTimeout(() => { openLockRef.current = false; }, 600);
  }

  return (
    <>
      {/* ── Premium pill ── */}
      <motion.button
        onClick={openModal}
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.96 }}
        data-testid="library-topup-btn"
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "9px 16px",
          minHeight: 38,
          borderRadius: 999,
          border: "1px solid rgba(212,168,67,0.55)",
          background: justCredited
            ? "linear-gradient(135deg, rgba(74,222,128,0.32), rgba(74,222,128,0.12))"
            : "linear-gradient(135deg, rgba(212,168,67,0.30), rgba(167,139,250,0.18))",
          color: justCredited ? "#4ade80" : "#FFE19A",
          fontSize: 13,
          fontWeight: 800,
          cursor: "pointer",
          letterSpacing: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          transition:
            "background 0.4s, color 0.4s, border-color 0.4s, box-shadow 0.4s",
          borderColor: justCredited
            ? "rgba(74,222,128,0.55)"
            : "rgba(212,168,67,0.6)",
          boxShadow:
            "0 6px 18px rgba(212,168,67,0.22), inset 0 1px 0 rgba(255,225,154,0.12)",
          fontFamily: KHMER_FONT_STACK,
          maxWidth: "100%",
        }}
      >
        {/* Animated glow ring — GPU only */}
        <motion.span
          aria-hidden
          animate={{
            boxShadow: justCredited
              ? [
                  "0 0 0 0 rgba(74,222,128,0)",
                  "0 0 0 9px rgba(74,222,128,0.30)",
                  "0 0 0 0 rgba(74,222,128,0)",
                ]
              : [
                  "0 0 0 0 rgba(212,168,67,0)",
                  "0 0 0 9px rgba(212,168,67,0.32)",
                  "0 0 0 0 rgba(212,168,67,0)",
                ],
          }}
          transition={{ duration: 3.4, repeat: Infinity, ease: "easeInOut" }}
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 999,
            pointerEvents: "none",
          }}
        />

        {/* Sweep shimmer */}
        <span
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 999,
            background:
              "linear-gradient(105deg, transparent 35%, rgba(255,225,154,0.22) 50%, transparent 65%)",
            backgroundSize: "200% 100%",
            animation: "lib-topup-sweep 3s ease infinite",
            pointerEvents: "none",
          }}
        />

        {/* Icon */}
        <AnimatePresence mode="wait">
          {justCredited ? (
            <motion.span
              key="credited"
              initial={{ scale: 0, rotate: -20 }}
              animate={{ scale: 1, rotate: 0 }}
              exit={{ scale: 0 }}
              style={{ display: "flex", position: "relative", zIndex: 1 }}
            >
              <Sparkles size={15} />
            </motion.span>
          ) : (
            <motion.span
              key="coins"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              style={{ display: "flex", position: "relative", zIndex: 1 }}
            >
              <Coins size={15} />
            </motion.span>
          )}
        </AnimatePresence>

        {/* Khmer-primary label */}
        <span
          style={{
            position: "relative",
            zIndex: 1,
            display: "inline-flex",
            alignItems: "baseline",
            gap: 6,
            fontFamily: KHMER_FONT_STACK,
            letterSpacing: 0,
            textTransform: "none",
            lineHeight: 1.4,
          }}
        >
          {justCredited ? (
            <span style={{ fontFamily: KHMER_FONT_STACK }}>បានបញ្ចូលរួចរាល់!</span>
          ) : (
            <>
              <span style={{ fontFamily: KHMER_FONT_STACK }}>បញ្ចូលពិន្ទុ</span>
              {/* English subtext only on screens >= 360 px wide */}
              <span
                className="lib-topup-en"
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: "rgba(196,181,253,0.85)",
                  fontFamily: "system-ui, -apple-system, sans-serif",
                  letterSpacing: "0.04em",
                }}
              >
                Top Up
              </span>
            </>
          )}
        </span>
      </motion.button>

      {/* ── Purchase modal ── */}
      <AnimatePresence>
        {showModal && (
          <PointsPurchaseModal
  studentId={studentId}
  onClose={() => setShowModal(false)}
  onCredited={handleCredited}
  triggerReason="library_topup_button"
  contextHeadlineKm="បញ្ចូលពិន្ទុ"
  contextBodyKm="ជ្រើសរើសកញ្ចប់ដែលអ្នកចង់បញ្ចូល ដើម្បីបើកសៀវភៅ និងមុខងារបន្ថែមក្នុង App។"
  currentBalance={0}
  recommendedPackageId=""
/>
        )}
      </AnimatePresence>

      {/* Scoped keyframes + tiny mobile fix */}
      <style>{`
        @keyframes lib-topup-sweep {
          0%   { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        /* Hide English subtext on narrow iPhone widths so the button
           never overlaps the wallet pill / status icons. */
        @media (max-width: 360px) {
          .lib-topup-en { display: none !important; }
        }
      `}</style>
    </>
  );
}
