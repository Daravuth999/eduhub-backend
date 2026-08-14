/**
 * PointsTopUpPopup.tsx — Post-login Points Top-Up Popup
 * ======================================================
 * Shows ONCE per session, 2 seconds after student login.
 * Pulls live packages from Author Studio configuration.
 * Tapping a row goes directly into PointsPurchaseModal flow.
 *
 * Mounting: Add to Dashboard.tsx alongside existing modals.
 * Session guard: sessionStorage key "eduhub_topup_shown_{studentId}"
 * so it never re-shows until next login.
 *
 * PROTECTED: Pure additive new file. Zero existing files modified.
 */

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, Sparkles, Coins, ChevronRight,
  Zap, Crown, Star, Gem
} from "lucide-react";
import PointsPurchaseModal from "./PointsPurchaseModal";

// ── Types ─────────────────────────────────────────────────────────────────

interface Package {
  _id: string;
  label: string;
  amount_khr: number;
  points: number;
  bonus_points: number;
  active: boolean;
  notes?: string;
}

interface Props {
  studentId: string;
  onCredited?: (pts: number) => void;
}

// ── Package tier icons ────────────────────────────────────────────────────

const TIER_ICONS = [Star, Zap, Crown, Gem];
const TIER_COLORS = [
  { accent: "#60a5fa", glow: "rgba(96,165,250,0.25)",  bg: "rgba(96,165,250,0.08)"  },
  { accent: "#a78bfa", glow: "rgba(167,139,250,0.25)", bg: "rgba(167,139,250,0.08)" },
  { accent: "#FFE19A", glow: "rgba(255,225,154,0.3)",  bg: "rgba(255,225,154,0.08)" },
  { accent: "#4ade80", glow: "rgba(74,222,128,0.25)",  bg: "rgba(74,222,128,0.08)"  },
];

// ── Package row ───────────────────────────────────────────────────────────

function PackageRow({
  pkg,
  index,
  onSelect,
}: {
  pkg: Package;
  index: number;
  onSelect: (pkg: Package) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const tier  = TIER_COLORS[index % TIER_COLORS.length];
  const Icon  = TIER_ICONS[index % TIER_ICONS.length];
  const total = (pkg.points || 0) + (pkg.bonus_points || 0);

  return (
    <motion.button
      initial={{ opacity: 0, x: -18 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.15 + index * 0.07, type: "spring", damping: 22 }}
      onHoverStart={() => setHovered(true)}
      onHoverEnd={() => setHovered(false)}
      onClick={() => onSelect(pkg)}
      style={{
        width: "100%",
        background: hovered ? tier.bg : "rgba(255,255,255,0.03)",
        border: `1px solid ${hovered ? tier.accent + "55" : "rgba(255,255,255,0.07)"}`,
        borderRadius: 14,
        padding: "12px 14px",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 12,
        textAlign: "left",
        transition: "all 0.18s ease",
        boxShadow: hovered ? `0 0 20px ${tier.glow}` : "none",
        marginBottom: 8,
      }}
    >
      {/* Tier icon */}
      <div style={{
        width: 36, height: 36, borderRadius: 10, flexShrink: 0,
        background: hovered ? tier.bg : "rgba(255,255,255,0.04)",
        border: `1px solid ${tier.accent}30`,
        display: "flex", alignItems: "center", justifyContent: "center",
        transition: "all 0.18s",
        boxShadow: hovered ? `0 0 14px ${tier.glow}` : "none",
      }}>
        <Icon size={16} color={tier.accent} />
      </div>

      {/* KHR amount */}
      <div style={{ minWidth: 80 }}>
        <div style={{
          fontSize: 16, fontWeight: 800,
          color: hovered ? tier.accent : "#e5e7eb",
          transition: "color 0.18s",
          letterSpacing: "-0.02em",
        }}>
          {(pkg.amount_khr || 0).toLocaleString()}
          <span style={{ fontSize: 12, fontWeight: 600, marginLeft: 2, opacity: 0.7 }}>៛</span>
        </div>
        <div style={{ fontSize: 10, color: "#6b7280", marginTop: 1 }}>
          {pkg.label}
        </div>
      </div>

      {/* Arrow */}
      <ChevronRight size={13} color={hovered ? tier.accent : "#374151"} style={{ transition: "color 0.18s" }} />

      {/* Points */}
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <Coins size={13} color={hovered ? tier.accent : "#a78bfa"} style={{ transition: "color 0.18s" }} />
          <span style={{
            fontSize: 17, fontWeight: 800,
            color: hovered ? tier.accent : "#c4b5fd",
            transition: "color 0.18s",
          }}>
            {total.toLocaleString()}
          </span>
          <span style={{ fontSize: 11, color: "#6b7280" }}>pts</span>
        </div>
        {pkg.bonus_points > 0 && (
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 3,
            background: "rgba(74,222,128,0.12)",
            border: "1px solid rgba(74,222,128,0.25)",
            borderRadius: 5,
            padding: "1px 5px",
            marginTop: 2,
            fontSize: 9,
            fontWeight: 700,
            color: "#4ade80",
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}>
            <Sparkles size={8} />+{pkg.bonus_points} bonus
          </div>
        )}
      </div>

      {/* CTA arrow */}
      <motion.div
        animate={{ x: hovered ? 3 : 0 }}
        transition={{ type: "spring", damping: 20 }}
        style={{
          fontSize: 11, fontWeight: 700,
          color: hovered ? tier.accent : "#374151",
          transition: "color 0.18s",
        }}
      >
        Buy →
      </motion.div>
    </motion.button>
  );
}

// ── Main popup ────────────────────────────────────────────────────────────

export function PointsTopUpPopup({ studentId, onCredited }: Props) {
  const [visible, setVisible]           = useState(false);
  const [packages, setPackages]         = useState<Package[]>([]);
  const [loading, setLoading]           = useState(true);
  const [selectedPkg, setSelectedPkg]   = useState<Package | null>(null);
  // v1.1: KHQR return-flow state
  // khqrReturnIntentId: set from URL ?khqr_intent= on mount; triggers return modal
  const [khqrReturnIntentId, setKhqrReturnIntentId] = useState<string | null>(null);
  // khqrEnabled: null=loading, true/false from /config probe (no invoice created)
  const [khqrEnabled, setKhqrEnabled] = useState<boolean | null>(null);

  const sessionKey = `eduhub_topup_shown_${studentId}`;

  // -- v1.1 KHQR return-flow: detect ?khqr_intent= on mount ------------------
  // PointsTopUpPopup is ALWAYS mounted in Dashboard.tsx, making this the
  // reliable entry point. PointsPurchaseModal only renders when selectedPkg is
  // set, so putting the URL detection here guarantees it runs on page load.
  useEffect(() => {
    if (!studentId) return;
    try {
      const params = new URLSearchParams(
        typeof window !== 'undefined' ? window.location.search : ''
      );
      const intentId = params.get('khqr_intent');
      if (!intentId) return;
      // Open the return-flow modal and clean the URL immediately
      setKhqrReturnIntentId(intentId);
      if (typeof window !== 'undefined' && window.history) {
        window.history.replaceState(
          null, '',
          window.location.pathname + window.location.hash
        );
      }
    } catch { /* URL read failed */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId]);

  // -- v1.1 /config probe: show/hide KHQR button without creating invoice -----
  // Surgery v2 fix: send the Bearer token (matching the rest of the app), and
  // since the backend now treats /config as public, even unauthenticated
  // requests succeed. Both paths are belt-and-suspenders.
  // We do NOT block this on the result: if it fails, PointsPurchaseModal
  // will probe /config itself once it mounts. So the KHQR button never
  // depends solely on this fetch succeeding.
  useEffect(() => {
    if (!studentId) return;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    try {
      const t = typeof localStorage !== "undefined"
        ? localStorage.getItem("student_session_token")
        : "";
      if (t) headers.Authorization = `Bearer ${t}`;
    } catch { /* locked-down storage — ignore */ }
    fetch(
      `${process.env.REACT_APP_BACKEND_URL || ''}/api/payments/camrapidpay/config`,
      { credentials: 'include', headers }
    )
      .then(async r => {
        if (r.ok) return r.json();
        // Non-sensitive debug breadcrumb. No secrets, no PII.
        if (typeof console !== "undefined") {
          // eslint-disable-next-line no-console
          console.debug("[EduHub] KHQR /config HTTP", r.status);
        }
        return { enabled: false, reason: `http_${r.status}` };
      })
      .then(d => {
        setKhqrEnabled(Boolean(d?.enabled));
        if (typeof console !== "undefined") {
          // eslint-disable-next-line no-console
          console.debug("[EduHub] KHQR /config:", {
            enabled: Boolean(d?.enabled),
            reason: d?.reason || "unknown",
          });
        }
      })
      .catch(e => {
        setKhqrEnabled(false);
        if (typeof console !== "undefined") {
          // eslint-disable-next-line no-console
          console.debug("[EduHub] KHQR /config network error:", String(e?.message || e));
        }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId]);

  // Load packages + apply 2-second delay
  useEffect(() => {
    if (!studentId) return;

    // Already shown this session → bail
    if (sessionStorage.getItem(sessionKey)) return;

    fetch(`${process.env.REACT_APP_BACKEND_URL || ""}/api/payments/packages/public`, { credentials: "include" })
      .then(r => r.json())
      .then(d => {
        const active = (d.packages || []).filter((p: Package) => p.active);
        setPackages(active);
        setLoading(false);
        if (active.length > 0) {
          // 2-second delay for premium feel
          const t = setTimeout(() => setVisible(true), 2000);
          return () => clearTimeout(t);
        }
      })
      .catch(() => setLoading(false));
  }, [studentId, sessionKey]);

  const handleClose = useCallback(() => {
    sessionStorage.setItem(sessionKey, "1");
    setVisible(false);
  }, [sessionKey]);

  const handleSelect = useCallback((pkg: Package) => {
    setSelectedPkg(pkg);
    setVisible(false); // close popup, open purchase modal
  }, []);

  const handlePurchaseClose = useCallback(() => {
    sessionStorage.setItem(sessionKey, "1");
    setSelectedPkg(null);
  }, [sessionKey]);

  const handleCredited = useCallback((pts: number) => {
    onCredited?.(pts);
  }, [onCredited]);

  return (
    <>
      {/* ── Popup ── */}
      <AnimatePresence>
        {visible && packages.length > 0 && (
          <motion.div
            key="topup-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{
              position: "fixed", inset: 0, zIndex: 9998,
              background: "rgba(0,0,0,0.65)",
              backdropFilter: "blur(8px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
            }}
            onClick={e => { if (e.target === e.currentTarget) handleClose(); }}
          >
            <motion.div
              key="topup-card"
              initial={{ opacity: 0, y: 40, scale: 0.93 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 40, scale: 0.93 }}
              transition={{ type: "spring", damping: 24, stiffness: 340 }}
              style={{
                width: "100%",
                maxWidth: 400,
                background: "radial-gradient(ellipse at 30% -10%, #2D1F3E 0%, #0d0a16 65%)",
                border: "1px solid rgba(212,168,67,0.22)",
                borderRadius: 28,
                overflow: "hidden",
                boxShadow: [
                  "0 32px 80px rgba(0,0,0,0.7)",
                  "0 0 0 1px rgba(255,255,255,0.04) inset",
                  "0 1px 0 rgba(212,168,67,0.15) inset",
                ].join(", "),
              }}
            >
              {/* Decorative shimmer bar */}
              <div style={{
                height: 3,
                background: "linear-gradient(90deg, transparent, #FFE19A, #D4A843, #a78bfa, transparent)",
                backgroundSize: "200% 100%",
                animation: "shimmer 2.5s ease infinite",
              }} />

              {/* Header */}
              <div style={{
                padding: "20px 22px 16px",
                display: "flex",
                alignItems: "flex-start",
                gap: 14,
              }}>
                <motion.div
                  animate={{
                    boxShadow: [
                      "0 0 0 0 rgba(212,168,67,0)",
                      "0 0 0 10px rgba(212,168,67,0.15)",
                      "0 0 0 0 rgba(212,168,67,0)",
                    ],
                  }}
                  transition={{ duration: 2.4, repeat: Infinity }}
                  style={{
                    width: 46, height: 46, borderRadius: 14, flexShrink: 0,
                    background: "linear-gradient(135deg, rgba(212,168,67,0.3), rgba(212,168,67,0.1))",
                    border: "1px solid rgba(212,168,67,0.4)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  <Coins size={22} color="#FFE19A" />
                </motion.div>

                <div style={{ flex: 1 }}>
                  <div style={{
                    fontSize: 18, fontWeight: 800,
                    color: "#FFE19A",
                    letterSpacing: "-0.02em",
                    lineHeight: 1.2,
                  }}>
                    Top Up Your Points
                  </div>
                  <div style={{ fontSize: 12, color: "#6b7280", marginTop: 3 }}>
                    Power up your learning · Unlock more books
                  </div>
                </div>

                <button
                  onClick={handleClose}
                  style={{
                    background: "rgba(255,255,255,0.05)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 8, padding: 6,
                    cursor: "pointer", color: "#4b5563",
                    display: "flex", alignItems: "center",
                    transition: "all 0.15s",
                    flexShrink: 0,
                  }}
                >
                  <X size={14} />
                </button>
              </div>

              {/* Package table */}
              <div style={{ padding: "0 16px 6px" }}>
                {packages.map((pkg, i) => (
                  <PackageRow key={pkg._id} pkg={pkg} index={i} onSelect={handleSelect} />
                ))}
              </div>

              {/* Footer */}
              <div style={{
                padding: "12px 22px 20px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                borderTop: "1px solid rgba(255,255,255,0.05)",
              }}>
                <div style={{ fontSize: 10, color: "#374151", lineHeight: 1.5 }}>
                  Paid via ABA KHQR · Instant credit
                  <br />Points never expire
                </div>
                <button
                  onClick={handleClose}
                  style={{
                    background: "none",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 10,
                    padding: "6px 14px",
                    color: "#4b5563",
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Maybe later
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

            {/* v1.1 KHQR return-flow modal ----------------------------------------
           Auto-opens when student returns from CamRapidPay with
           ?khqr_intent= in URL. Entry point is reliable because THIS
           component is always mounted; PointsPurchaseModal is not.
           NEVER credits from redirect: modal polls backend status API.
           ----------------------------------------------------------------- */}
      <AnimatePresence>
        {khqrReturnIntentId != null && !selectedPkg && (
          <PointsPurchaseModal
            studentId={studentId}
            khqrReturnIntentId={khqrReturnIntentId}
            khqrEnabled={khqrEnabled === true}
            onClose={() => {
              setKhqrReturnIntentId(null);
              try { sessionStorage.removeItem('khqr_pending'); } catch {}
            }}
            onCredited={(pts: number) => {
              setKhqrReturnIntentId(null);
              try { sessionStorage.removeItem('khqr_pending'); } catch {}
              onCredited?.(pts);
            }}
          />
        )}
      </AnimatePresence>

{/* ── Purchase modal (opens when package selected) ── */}
      <AnimatePresence>
        {selectedPkg && (
          <PointsPurchaseModal
            studentId={studentId}
            preselectedPackage={selectedPkg}
            khqrEnabled={khqrEnabled === true}
            triggerReason="manual_topup"
            contextHeadlineKm="បញ្ចូលពិន្ទុ"
            contextBodyKm="ជ្រើសរើសកញ្ចប់ដែលអ្នកចង់បញ្ចូល ដើម្បីបើកសៀវភៅ និងមុខងារបន្ថែមក្នុង App។"
            currentBalance={0}
            recommendedPackageId={selectedPkg?._id || ""}
            onClose={handlePurchaseClose}
            onCredited={handleCredited}
          />
        )}
      </AnimatePresence>

      {/* Shimmer keyframe */}
      <style>{`
        @keyframes shimmer {
          0%   { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
      `}</style>

    </>
  );
}


