// PortalPublic.jsx — v14 (Premium Readability Surgery, Feb 2026)
//
// Fixes the "invisible white-on-parchment" bug shown in the v13 audit:
// every text node now adapts to the active [data-theme] via CSS
// variables (--bgfx-ink, --bgfx-ink-mute, --bgfx-card, --bgfx-line,
// --bgfx-accent, --bgfx-accent-warm). No more hardcoded white opacity.
//
// Untouched: Roster fetch (`fetchRosterPoints`), AuthContext, navigation
// targets, leaderboard data shape, all data-testid hooks.
//
// Pulls real roster from existing eduhub roster.js (Google Sheet CSV).
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { GraduationCap, Trophy, Users, ArrowRight, Lock } from "lucide-react";
import { fetchRosterPoints } from "../../lib/roster";
import { useAuth } from "../../context/AuthContext";

export default function PortalPublic() {
  const { isAuthenticated } = useAuth();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchRosterPoints()
      .then((r) => !cancelled && setRows(r))
      .catch((e) => !cancelled && setErr(e?.message || "Could not load roster"));
    return () => { cancelled = true; };
  }, []);

  const total = rows?.length ?? 0;
  const sorted = (rows || []).slice().sort((a, b) => b.points - a.points);
  const top10 = sorted.slice(0, 10);
  const avgPoints = total ? sorted.reduce((s, r) => s + r.points, 0) / total : 0;

  // v14 — palette-aware tokens
  const ink     = "rgb(var(--bgfx-ink))";
  const inkMute = "rgb(var(--bgfx-ink-mute))";
  const cardBg  = "rgb(var(--bgfx-card))";
  const cardBdr = "rgb(var(--bgfx-line) / 0.10)";

  return (
    <div
      className="px-3 sm:px-5 py-4 max-w-[1080px] mx-auto"
      style={{ paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}
      data-testid="portal-public"
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="flex items-center gap-3 mb-3">
          <div
            className="h-12 w-12 rounded-2xl flex items-center justify-center text-white"
            style={{
              background: "linear-gradient(135deg, rgb(var(--bgfx-accent)), rgb(var(--bgfx-accent-warm)))",
              boxShadow: "0 8px 22px rgba(0,0,0,0.16)",
            }}
          >
            <GraduationCap className="h-6 w-6" />
          </div>
          <div>
            <h1
              className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight"
              style={{ color: ink, letterSpacing: "-0.01em" }}
            >
              My Portal
            </h1>
            <p className="text-xs font-semibold" style={{ color: inkMute }}>
              Class overview · Public preview
            </p>
          </div>
        </div>
        <p
          className="text-[15px] leading-relaxed mb-5 max-w-2xl"
          style={{ color: inkMute }}
        >
          Personal evaluation, monthly scores, points, teacher feedback. Sign in to access
          your private dashboard with live polling and bilingual UI (English / ខ្មែរ).
        </p>
      </motion.div>

      {/* Class summary */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5 sm:gap-3 mb-5">
        <SummaryCard label="Total Students"   value={total}                            icon={<Users className="h-4 w-4" />} accent="rgb(var(--bgfx-accent))"      />
        <SummaryCard label="Class Avg Points" value={total ? Math.round(avgPoints) : "—"} icon={<Trophy className="h-4 w-4" />} accent="rgb(var(--bgfx-accent-warm))" />
        <SummaryCard label="Last Updated"     value="Live"                              icon={<span className="h-2 w-2 rounded-full" style={{ background: "rgb(var(--bgfx-accent))", boxShadow: "0 0 0 4px rgb(var(--bgfx-accent) / 0.18)" }} />} accent="rgb(var(--bgfx-accent))" />
      </div>

      {/* Top 10 leaderboard */}
      <div
        className="rounded-2xl p-4 sm:p-5 mb-5"
        style={{
          background: cardBg,
          border: `1px solid ${cardBdr}`,
          boxShadow: "0 4px 14px rgba(0,0,0,0.06)",
        }}
        data-testid="portal-leaderboard"
      >
        <div className="flex items-center gap-2 mb-3">
          <Trophy className="h-4 w-4" style={{ color: "rgb(var(--bgfx-accent-warm))" }} />
          <h2
            className="font-display text-sm font-extrabold uppercase tracking-[0.14em]"
            style={{ color: ink }}
          >
            Top 10 Class Leaderboard
          </h2>
        </div>
        {err && <div className="text-sm" style={{ color: "rgb(var(--bgfx-accent-warm))" }}>{err}</div>}
        {!rows && !err && (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-10 rounded-lg skeleton" />
            ))}
          </div>
        )}
        {top10.length > 0 && (
          <ol className="space-y-1.5">
            {top10.map((r, i) => (
              <motion.li
                key={r.name + i}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.04 }}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5"
                style={{
                  background:
                    i === 0
                      ? "linear-gradient(90deg, rgb(var(--bgfx-accent-warm) / 0.18), transparent 70%)"
                      : "rgb(var(--bgfx-line) / 0.05)",
                  border: `1px solid ${cardBdr}`,
                }}
              >
                <span
                  className="font-mono text-xs font-bold w-6 text-center"
                  style={{ color: i === 0 ? "rgb(var(--bgfx-accent-warm))" : inkMute }}
                >
                  {i + 1}
                </span>
                <span
                  className="flex-1 text-sm font-semibold truncate"
                  style={{ color: ink }}
                >
                  {r.name}
                </span>
                <span
                  className="font-display tnum text-sm font-bold"
                  style={{ color: "rgb(var(--bgfx-accent-warm))" }}
                >
                  {r.points}
                </span>
              </motion.li>
            ))}
          </ol>
        )}
      </div>

      {/* Login nudge */}
      {!isAuthenticated && (
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl p-5 sm:p-6 flex flex-col sm:flex-row items-center gap-4"
          style={{
            background:
              "linear-gradient(135deg, rgb(var(--bgfx-accent) / 0.10), rgb(var(--bgfx-accent-warm) / 0.10))",
            border: `1px solid rgb(var(--bgfx-accent) / 0.35)`,
          }}
          data-testid="portal-login-nudge"
        >
          <div className="flex-1">
            <h3
              className="font-display text-lg font-extrabold mb-1"
              style={{ color: ink }}
            >
              See your personal dashboard
            </h3>
            <p className="text-sm" style={{ color: inkMute }}>
              Sign in with your Student ID to view your scores, points, and teacher feedback.
            </p>
          </div>
          <Link
            to="/login?redirect=/portal/me"
            className="inline-flex items-center gap-1.5 rounded-full px-5 py-2.5 text-xs font-bold uppercase tracking-wider text-white"
            style={{
              background: "linear-gradient(135deg, rgb(var(--bgfx-accent)), rgb(var(--bgfx-accent-warm)))",
              boxShadow: "0 8px 22px -8px rgb(var(--bgfx-accent) / 0.6)",
            }}
            data-testid="portal-login-cta"
          >
            <Lock className="h-3.5 w-3.5" /> Login to access <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </motion.div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, icon, accent }) {
  return (
    <div
      className="rounded-2xl p-4"
      style={{
        background: "rgb(var(--bgfx-card))",
        border: "1px solid rgb(var(--bgfx-line) / 0.10)",
        boxShadow: "0 4px 14px rgba(0,0,0,0.06)",
      }}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span style={{ color: accent }}>{icon}</span>
        <span
          className="text-[10px] uppercase tracking-[0.16em] font-extrabold"
          style={{ color: "rgb(var(--bgfx-ink-mute))" }}
        >
          {label}
        </span>
      </div>
      <div className="font-display text-2xl font-extrabold tnum" style={{ color: accent }}>
        {value}
      </div>
    </div>
  );
}
