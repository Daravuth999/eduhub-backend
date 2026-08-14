// PortalPublic.jsx — public preview at /portal: class summary and login nudge.
//   Pulls real roster from existing eduhub roster.js (Google Sheet CSV).
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

  return (
    <div className="px-3 sm:px-5 py-4 max-w-[1080px] mx-auto" data-testid="portal-public">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="flex items-center gap-3 mb-3">
          <div
            className="h-12 w-12 rounded-2xl flex items-center justify-center text-white shadow-[0_0_24px_rgba(0,224,255,0.5)]"
            style={{ background: "linear-gradient(135deg, #00e0ff, #9b5cff)" }}
          >
            <GraduationCap className="h-6 w-6" />
          </div>
          <div>
            <h1 className="font-display text-2xl sm:text-3xl font-bold text-iridescent">My Portal</h1>
            <p className="text-xs text-white/55">Class overview · Public preview</p>
          </div>
        </div>
        <p className="text-sm text-white/70 leading-relaxed mb-5 max-w-2xl">
          Personal evaluation, monthly scores, points, teacher feedback. Sign in to access
          your private dashboard with live polling and bilingual UI (English / ខ្មែរ).
        </p>
      </motion.div>

      {/* Class summary */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5 sm:gap-3 mb-5">
        <SummaryCard label="Total Students" value={total} icon={<Users className="h-4 w-4" />} accent="#00e0ff" />
        <SummaryCard label="Class Avg Points" value={total ? Math.round(avgPoints) : "—"} icon={<Trophy className="h-4 w-4" />} accent="#ffc94d" />
        <SummaryCard label="Last Updated" value="Live" icon={<span className="h-2 w-2 rounded-full bg-aurora-lime animate-pulse-dot" />} accent="#a3ff3a" />
      </div>

      {/* Top 10 leaderboard */}
      <div className="rounded-2xl border border-aurora-violet/30 bg-white/[0.04] backdrop-blur-md p-4 sm:p-5 mb-5" data-testid="portal-leaderboard">
        <div className="flex items-center gap-2 mb-3">
          <Trophy className="h-4 w-4 text-aurora-gold" />
          <h2 className="font-display text-sm font-bold uppercase tracking-wider text-white">Top 10 Class Leaderboard</h2>
        </div>
        {err && <div className="text-aurora-coral text-sm">{err}</div>}
        {!rows && !err && (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-9 rounded-lg skeleton" />
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
                className="flex items-center gap-3 rounded-lg bg-black/25 border border-white/5 px-3 py-2"
              >
                <span className="font-mono text-xs font-bold w-6 text-center text-white/60">{i + 1}</span>
                <span className="flex-1 text-sm font-semibold text-white truncate">{r.name}</span>
                <span className="font-display tnum text-sm font-bold text-aurora-gold">{r.points}</span>
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
          className="rounded-2xl border border-aurora-cyan/40 bg-gradient-to-br from-aurora-cyan/10 to-aurora-violet/10 p-5 sm:p-6 flex flex-col sm:flex-row items-center gap-4"
          data-testid="portal-login-nudge"
        >
          <div className="flex-1">
            <h3 className="font-display text-lg font-bold text-white mb-1">See your personal dashboard</h3>
            <p className="text-sm text-white/65">Sign in with your Student ID to view your scores, points, and teacher feedback.</p>
          </div>
          <Link
            to="/login?redirect=/portal/me"
            className="inline-flex items-center gap-1.5 rounded-full px-5 py-2.5 text-xs font-bold uppercase tracking-wider text-white shadow-[0_8px_22px_-8px_rgba(0,224,255,0.6)]"
            style={{ background: "linear-gradient(135deg, #00e0ff, #9b5cff)" }}
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
      className="rounded-2xl border bg-white/[0.04] backdrop-blur-md p-4"
      style={{ borderColor: `${accent}55` }}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-white/70" style={{ color: accent }}>{icon}</span>
        <span className="text-[10px] uppercase tracking-wider text-white/55 font-bold">{label}</span>
      </div>
      <div className="font-display text-2xl font-bold" style={{ color: accent }}>{value}</div>
    </div>
  );
}
