/**
 * AnnouncementPopup.jsx — v7.9.10 surgical addition
 *
 * Smart, eye-catching, bilingual (Khmer + English) full-screen overlay
 * that surfaces the same `announcementMessages` that drive the Dashboard
 * AnnouncementStrip. Renders ONCE per browser session.
 *
 * Smart auto-duration:
 *   • Khmer chars read at ~9 c/s, English at ~16 c/s.
 *   • Sum across all messages + 2 s comprehension buffer.
 *   • Snap to a tier and cap at 30 s:
 *       ≤ 12 s → 15 s
 *       ≤ 18 s → 20 s
 *       > 18 s → 30 s
 *
 * UX:
 *   • Aurora glass background, animated megaphone, bilingual heading.
 *   • Per-message card with stagger fade-in, shimmer border.
 *   • Circular SVG countdown ring around the close button (live seconds).
 *   • Skip allowed from t = 0 — top-right "Skip" + Esc + click backdrop.
 *   • Auto-dismiss when timer hits 0.
 *   • Khmer rendered via `font-khmer` (Noto Sans Khmer) already wired in
 *     tailwind.config.js; English uses `font-display` for impact and
 *     `font-body` for body.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Megaphone, X, Sparkles } from "lucide-react";
import { useEduHubConfig } from "../hooks/useEduHubConfig";

const SESSION_KEY = "eduhub_announce_popup_seen_v1";
const KHMER_RE = /[\u1780-\u17FF]/;

/** Smart read-time → tier in seconds. */
function computeDurationSec(messages) {
  let raw = 0;
  for (const m of messages) {
    if (!m) continue;
    const text = String(m).trim();
    if (!text) continue;
    const isKhmer = KHMER_RE.test(text);
    const rate = isKhmer ? 9 : 16; // chars/sec
    raw += text.length / rate;
  }
  raw += 2; // comprehension buffer
  if (raw <= 12) return 15;
  if (raw <= 18) return 20;
  return 30; // hard cap
}

function CountdownRing({ remaining, total, size = 56 }) {
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = total > 0 ? remaining / total : 0;
  const offset = c * (1 - pct);
  return (
    <svg width={size} height={size} className="absolute inset-0 -rotate-90 pointer-events-none">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke="rgba(255,255,255,0.10)"
        strokeWidth={stroke}
        fill="none"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke="url(#ringGrad)"
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        style={{ transition: "stroke-dashoffset 0.95s linear" }}
      />
      <defs>
        <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"  stopColor="#00e0ff" />
          <stop offset="50%" stopColor="#9b5cff" />
          <stop offset="100%" stopColor="#ff3da6" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export default function AnnouncementPopup() {
  const { config, status, source } = useEduHubConfig();
  const messages = useMemo(
    () => (config?.announcementMessages || []).filter((m) => String(m || "").trim()),
    [config]
  );

  // One-shot per session gate
  const [open, setOpen] = useState(false);
  const armed = useRef(false);

  // Open as soon as we have a non-empty message list AND we haven't shown yet this session.
  useEffect(() => {
    if (armed.current) return;
    if (!messages.length) return;
    // Wait until we have either live or cached config (avoid flashing default copy).
    if (status === "loading" && source === "default") return;
    // v8 — skip popup on focused work routes (Author Studio, in-book reader)
    // where a full-screen announcement would block productive flow.
    try {
      const path = typeof window !== "undefined" ? window.location.pathname : "";
      if (/^\/studio(\/|$)/.test(path) || /^\/library\/read\//.test(path)) return;
    } catch { /* ignore */ }
    try {
      if (sessionStorage.getItem(SESSION_KEY)) return;
    } catch { /* ignore */ }
    armed.current = true;
    setOpen(true);
  }, [messages, status, source]);

  const totalSec = useMemo(() => computeDurationSec(messages), [messages]);
  const [remaining, setRemaining] = useState(totalSec);

  // Reset remaining whenever the popup opens (or duration changes).
  useEffect(() => {
    if (!open) return;
    setRemaining(totalSec);
  }, [open, totalSec]);

  // Tick every second while open.
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          window.clearInterval(id);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [open]);

  // Auto-close when timer hits 0
  useEffect(() => {
    if (open && remaining === 0) close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining, open]);

  // Esc to dismiss
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close() {
    setOpen(false);
    try { sessionStorage.setItem(SESSION_KEY, "1"); } catch { /* ignore */ }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="ann-popup"
          className="fixed inset-0 z-[200] flex items-center justify-center p-4 sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35 }}
          data-testid="announcement-popup-overlay"
          onClick={(e) => { if (e.target === e.currentTarget) close(); }}
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(120% 90% at 50% 0%, rgba(155,92,255,0.28) 0%, rgba(0,224,255,0.12) 35%, rgba(8,4,24,0.85) 75%)",
              backdropFilter: "blur(18px) saturate(140%)",
              WebkitBackdropFilter: "blur(18px) saturate(140%)",
            }}
          />

          {/* Card */}
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            className="relative w-full max-w-[560px] rounded-3xl overflow-hidden border border-white/[0.10]"
            style={{
              background:
                "linear-gradient(160deg, rgba(20,8,48,0.95) 0%, rgba(8,4,24,0.96) 100%)",
              boxShadow:
                "0 30px 80px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,224,255,0.08), 0 0 60px rgba(155,92,255,0.18)",
            }}
            data-testid="announcement-popup-card"
          >
            {/* Animated aurora ribbon at top */}
            <div
              aria-hidden
              className="absolute inset-x-0 top-0 h-[3px]"
              style={{
                background:
                  "linear-gradient(90deg, #00e0ff, #9b5cff, #ff3da6, #ffc94d, #00e0ff)",
                backgroundSize: "200% 100%",
                animation: "ann-pop-shimmer 4.5s linear infinite",
              }}
            />

            {/* Skip — top-right */}
            <button
              type="button"
              onClick={close}
              data-testid="announcement-popup-skip"
              className="absolute right-3 top-3 inline-flex items-center gap-1 px-3 py-1.5 text-[0.72rem] font-semibold rounded-full text-white/85 hover:text-white bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.10] transition"
              aria-label="Skip announcement"
            >
              <X className="w-3.5 h-3.5" />
              Skip
            </button>

            <div className="px-6 sm:px-8 pt-8 pb-6">
              {/* Header */}
              <div className="flex items-center gap-3 mb-5">
                <motion.div
                  initial={{ rotate: -10, scale: 0.9 }}
                  animate={{ rotate: [0, -6, 6, -3, 3, 0], scale: 1 }}
                  transition={{ duration: 1.6, repeat: Infinity, repeatDelay: 1.4, ease: "easeInOut" }}
                  className="w-11 h-11 rounded-2xl flex items-center justify-center"
                  style={{
                    background:
                      "linear-gradient(135deg, rgba(0,224,255,0.25), rgba(155,92,255,0.25))",
                    boxShadow: "0 0 24px rgba(155,92,255,0.35)",
                  }}
                >
                  <Megaphone className="w-5 h-5 text-aurora-cyan" />
                </motion.div>
                <div className="min-w-0">
                  <div
                    className="font-display text-[0.7rem] tracking-[0.18em] uppercase font-bold"
                    style={{
                      backgroundImage:
                        "linear-gradient(90deg, #00e0ff, #9b5cff, #ff3da6)",
                      WebkitBackgroundClip: "text",
                      backgroundClip: "text",
                      color: "transparent",
                    }}
                  >
                    {config.announcementTitle || "Important Announcement"}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0">
                    <span className="font-khmer text-[1.05rem] sm:text-[1.18rem] font-bold text-white">
                      សូមកត់ចំណាំ
                    </span>
                    <span className="font-display text-[0.95rem] sm:text-[1.05rem] font-extrabold text-white/85">
                      Please Read
                    </span>
                  </div>
                </div>
              </div>

              {/* Messages */}
              <div className="space-y-2.5 max-h-[58vh] overflow-y-auto pr-1 ann-pop-scroll">
                {messages.map((msg, idx) => {
                  const isKhmer = KHMER_RE.test(msg);
                  return (
                    <motion.div
                      key={idx}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.45, delay: 0.25 + idx * 0.12, ease: [0.2, 0.8, 0.2, 1] }}
                      className="relative rounded-2xl px-4 py-3 border border-white/[0.07]"
                      style={{
                        background:
                          "linear-gradient(140deg, rgba(255,255,255,0.04) 0%, rgba(155,92,255,0.06) 100%)",
                      }}
                      data-testid={`announcement-popup-msg-${idx}`}
                    >
                      {/* Shimmer rim */}
                      <div
                        aria-hidden
                        className="absolute inset-0 rounded-2xl pointer-events-none opacity-40"
                        style={{
                          background:
                            "linear-gradient(120deg, transparent 30%, rgba(0,224,255,0.18) 50%, transparent 70%)",
                          backgroundSize: "220% 100%",
                          animation: "ann-pop-shimmer 6s linear infinite",
                          mask:
                            "linear-gradient(#000,#000) content-box, linear-gradient(#000,#000)",
                          WebkitMask:
                            "linear-gradient(#000,#000) content-box, linear-gradient(#000,#000)",
                          WebkitMaskComposite: "xor",
                          maskComposite: "exclude",
                          padding: "1px",
                          borderRadius: "1rem",
                        }}
                      />
                      <p
                        className={
                          isKhmer
                            ? "font-khmer text-[1.0rem] sm:text-[1.05rem] leading-[1.85] text-aurora-cyan"
                            : "font-body text-[0.95rem] sm:text-[1rem] leading-[1.7] text-white/[0.92]"
                        }
                      >
                        {msg.trim()}
                      </p>
                    </motion.div>
                  );
                })}
              </div>

              {/* Footer — countdown */}
              <div className="mt-6 flex items-center justify-between">
                <div className="flex items-center gap-2 text-white/60">
                  <Sparkles className="w-3.5 h-3.5 text-aurora-cyan" />
                  <span className="text-[0.72rem] font-medium">
                    Auto-closes — press <kbd className="px-1.5 py-0.5 mx-0.5 rounded bg-white/[0.08] border border-white/[0.10] text-[0.66rem]">Esc</kbd> to skip
                  </span>
                </div>

                <button
                  type="button"
                  onClick={close}
                  data-testid="announcement-popup-gotit"
                  className="relative inline-flex items-center justify-center w-14 h-14 rounded-full text-white font-bold text-[0.85rem]"
                  style={{
                    background:
                      "linear-gradient(135deg, rgba(0,224,255,0.18), rgba(155,92,255,0.22))",
                    border: "1px solid rgba(255,255,255,0.10)",
                  }}
                  aria-label={remaining > 0 ? `Closes in ${remaining} seconds` : "Close"}
                >
                  <CountdownRing remaining={remaining} total={totalSec} />
                  <span className="relative z-10">{remaining > 0 ? remaining : "OK"}</span>
                </button>
              </div>
            </div>
          </motion.div>

          {/* Local keyframes */}
          <style>{`
            @keyframes ann-pop-shimmer {
              0% { background-position: 0% 50%; }
              100% { background-position: 200% 50%; }
            }
            .ann-pop-scroll::-webkit-scrollbar { width: 6px; }
            .ann-pop-scroll::-webkit-scrollbar-thumb {
              background: rgba(255,255,255,0.12); border-radius: 4px;
            }
          `}</style>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
