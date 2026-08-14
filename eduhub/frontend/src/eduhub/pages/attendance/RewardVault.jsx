/**
 * RewardVault.jsx — the Attendance "Reward Vault" (UI v2.1). NEW file.
 *
 * §3.1/§3.3: reads ONLY the EXISTING `GET /api/student/points/history`
 * endpoint (no new backend route) and filters client-side to attendance-
 * sourced transactions (source === "attendance"). It is kept entirely
 * SEPARATE from the Stamp Ledger. Visual language is a ledger-book /
 * achievement-archive — deliberately NOT a treasure chest (the app already
 * uses a chest visual elsewhere, e.g. Voice Treasure), so there is no
 * collision.
 *
 * The endpoint is flag-gated server-side (USE_MONGO_POINTS_READ). When it
 * returns mode="disabled" we show an honest, calm empty state rather than
 * implying points are missing.
 */
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { BookText, Coins, Sparkle } from "lucide-react";
import { shortDate } from "./attendancePassport";

const BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
const LS_TOKEN_KEY = "student_session_token";

function authHeaders() {
  try {
    const t = localStorage.getItem(LS_TOKEN_KEY);
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}

async function fetchPointsHistory() {
  const res = await fetch(`${BASE}/api/student/points/history?limit=200`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeaders() },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export default function RewardVault() {
  const [rows, setRows] = useState(null);
  const [disabled, setDisabled] = useState(false);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await fetchPointsHistory();
        if (!alive) return;
        if (data && data.mode === "disabled") {
          setDisabled(true);
          setRows([]);
          return;
        }
        const att = (data?.transactions || []).filter((t) => t.source === "attendance");
        setRows(att);
      } catch {
        if (alive) {
          setErrored(true);
          setRows([]);
        }
      }
    })();
    return () => { alive = false; };
  }, []);

  const total = (rows || []).reduce((sum, r) => sum + (Number(r.amount) || 0), 0);

  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      data-testid="reward-vault"
      className="rounded-[26px] p-6 sm:p-7"
      style={{
        background: "#FBF8F1",
        border: "1px solid #E4DAC6",
        boxShadow: "0 18px 44px -28px rgba(27,42,74,0.35)",
      }}
    >
      <div className="flex items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl"
            style={{ background: "#F1E7D2", color: "#9A7A20" }}>
            <BookText className="h-5 w-5" strokeWidth={1.8} />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.22em]" style={{ color: "#9A8B6C" }}>
              Reward Vault
            </div>
            <h2 className="text-[17px] font-semibold" style={{ color: "#1B2A4A", fontFamily: "Georgia, 'Times New Roman', serif" }}>
              Attendance ledger
            </h2>
          </div>
        </div>
        <div className="text-right" data-testid="reward-vault-total">
          <div className="text-[11px] uppercase tracking-wider" style={{ color: "#9A8B6C" }}>Earned</div>
          <div className="flex items-center gap-1.5 justify-end text-[20px] font-semibold" style={{ color: "#9A7A20" }}>
            <Coins className="h-4 w-4" strokeWidth={1.9} /> {total}
          </div>
        </div>
      </div>

      {rows === null ? (
        <div className="space-y-2" data-testid="reward-vault-loading">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-11 rounded-xl animate-pulse" style={{ background: "#F0EADD" }} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div
          className="rounded-2xl px-4 py-6 text-center"
          style={{ background: "#F6F1E6", border: "1px dashed #DDCFB3" }}
          data-testid="reward-vault-empty"
        >
          <Sparkle className="h-5 w-5 mx-auto mb-2" style={{ color: "#C2992E" }} strokeWidth={1.8} />
          <p className="text-[13px]" style={{ color: "#5A5345" }}>
            {disabled
              ? "Your reward ledger will appear here as you attend classes."
              : errored
                ? "We couldn't load your reward ledger just now."
                : "No attendance rewards yet — check in to a live class to earn your first stamp of points."}
          </p>
        </div>
      ) : (
        <ul className="divide-y" style={{ borderColor: "#EBE2CF" }} data-testid="reward-vault-entries">
          {rows.map((r, i) => (
            <li
              key={`${r.created_at}-${i}`}
              className="flex items-center justify-between py-3"
              data-testid={`reward-vault-entry-${i}`}
            >
              <div className="flex items-center gap-3">
                <span className="grid h-8 w-8 place-items-center rounded-lg"
                  style={{ background: "#F1E7D2", color: "#9A7A20" }}>
                  <Coins className="h-4 w-4" strokeWidth={1.8} />
                </span>
                <div>
                  <div className="text-[13.5px] font-medium" style={{ color: "#1B2A4A" }}>
                    Attendance reward
                  </div>
                  <div className="text-[11.5px]" style={{ color: "#9A8B6C" }}>
                    {shortDate(r.created_at)}
                  </div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-[14px] font-semibold" style={{ color: "#2F7D5B" }}>
                  +{Number(r.amount) || 0}
                </div>
                {r.balance_after != null && (
                  <div className="text-[11px]" style={{ color: "#9A8B6C" }}>
                    bal {Number(r.balance_after)}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </motion.section>
  );
}
