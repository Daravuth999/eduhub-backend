import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Trophy, Copy, Check, Users, Coins, Sparkles } from "lucide-react";
import { Surface } from "./primitives/Surface";
import { Pill } from "./primitives/Pill";
import { useReducedMotion } from "../hooks/useReducedMotion";
import {
  speakingLabApi,
  SpeakingLabApiError,
  type ActiveSessionResponse,
  type DirectJoinResponse,
} from "../lib/speakingLabApi";
import { beginCriticalOperation } from "../../../lib/criticalOperationRegistry";

/**
 * SpeakingLabLiveCard — the one-tap Speaking Lab entry on My Portal.
 *
 * Design principle that fixes the whole class of "couldn't reach the
 * Prize Pool service" failures: this card makes its network call on
 * mount but DEGRADES TO INVISIBLE on any failure — it never renders an
 * error onto the student's main dashboard. It only appears when there
 * is genuinely a live session the student can join right now.
 *
 * No session code is ever typed. `activeSession()` asks the server "is
 * there a live session for me?"; if yes and joining is open, the student
 * taps ONE button and the server resolves the session + runs the atomic
 * enrollment (`joinActive()`), returning their Lucky Ticket immediately.
 *
 * The server is the ONLY source of truth for whether a session is live
 * and whether this student already holds a ticket — so besides the
 * mount check, this card re-checks every POLL_INTERVAL_MS while the tab
 * is visible (paused in the background, no polling storm). That catches
 * both a teacher starting a session after Portal was already open, and
 * this student being enrolled server-side by "Enroll All" / Auto Enroll
 * without ever tapping Join Now themselves.
 */

const POLL_INTERVAL_MS = 8_000;

type CardState =
  | { kind: "hidden" }
  | { kind: "offer"; entry_fee: number; player_count: number }
  | { kind: "joining" }
  | { kind: "joined"; entry: JoinedTicket }
  | { kind: "join_error"; message: string };

interface JoinedTicket {
  lucky_code: string;
  entry_fee?: number;
  pool_total?: number;
  player_count?: number;
  position?: number;
}

const JOIN_ERROR_MESSAGES: Record<string, string> = {
  insufficient_points: "You don't have enough points to join this Prize Pool.",
  wallet_not_ready: "Your wallet isn't ready yet — ask your teacher for help.",
  schedule_assignment_required: "Ask your teacher to assign you to Schedule A or B first.",
  wrong_schedule: "This session is for a different schedule group than yours.",
  no_active_session: "That session just closed. Check back with your teacher.",
  draw_locked: "The draw for this session has already started.",
  direct_join_disabled: "The Prize Pool isn't open yet — check back at class time.",
  ambiguous_timeout: "That took a little long — checking your entry…",
  ambiguous_network_error: "Connection trouble — checking your entry…",
  default: "We couldn't complete that just now. Please try again.",
};

function joinErrorMessage(code: string): string {
  return JOIN_ERROR_MESSAGES[code] || JOIN_ERROR_MESSAGES.default;
}

export default function SpeakingLabLiveCard() {
  const reduced = useReducedMotion();
  const [state, setState] = useState<CardState>({ kind: "hidden" });
  const [copied, setCopied] = useState(false);
  const aliveRef = useRef(true);
  const stateKindRef = useRef<CardState["kind"]>("hidden");
  stateKindRef.current = state.kind;

  const checkActiveSession = useCallback(async () => {
    let res: ActiveSessionResponse;
    try {
      res = await speakingLabApi.activeSession();
    } catch {
      return; // hidden — never an error on the main screen
    }
    if (!aliveRef.current) return;
    if (!res.active) {
      if (stateKindRef.current === "offer" || stateKindRef.current === "hidden") {
        setState({ kind: "hidden" });
      }
      return; // nothing live -> stay/return hidden
    }
    if (res.existing_entry) {
      setState({
        kind: "joined",
        entry: {
          lucky_code: res.existing_entry.lucky_code,
          entry_fee: res.entry_fee,
          pool_total: res.pool_total,
          player_count: res.player_count,
        },
      });
      return;
    }
    // A live session with no ticket yet — only offer Join if the
    // backend says joining is actually open; otherwise stay hidden.
    if (!res.direct_join_enabled) return;
    setState({ kind: "offer", entry_fee: res.entry_fee, player_count: res.player_count });
  }, []);

  // Mount check, then re-check every POLL_INTERVAL_MS while the tab is
  // visible — paused entirely in the background (no polling storm from
  // backgrounded tabs). Skipped while a join is actively in flight or a
  // just-shown error is on screen, so a background tick can never race
  // handleJoin's own state transition.
  useEffect(() => {
    aliveRef.current = true;
    checkActiveSession();

    let intervalId: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      if (stateKindRef.current === "hidden" || stateKindRef.current === "offer") {
        checkActiveSession();
      }
    };
    const startPolling = () => {
      if (intervalId) return;
      intervalId = setInterval(tick, POLL_INTERVAL_MS);
    };
    const stopPolling = () => {
      if (intervalId) clearInterval(intervalId);
      intervalId = null;
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        tick();
        startPolling();
      } else {
        stopPolling();
      }
    };
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      startPolling();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      aliveRef.current = false;
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [checkActiveSession]);

  const handleJoin = useCallback(async () => {
    setState({ kind: "joining" });
    // A PWA update must never land mid-join (it's a real, atomic ticket
    // charge on the backend) — see pwaUpdateController.js.
    const endCriticalOp = beginCriticalOperation("speaking-lab-join");
    try {
      let result: DirectJoinResponse;
      try {
        result = await speakingLabApi.joinActive();
      } catch (err) {
        if (!aliveRef.current) return;
        const code = err instanceof SpeakingLabApiError ? err.code : "default";
        // On an ambiguous outcome, resolve against authoritative state
        // rather than re-offering a (possibly-charging) Join button.
        if (code === "ambiguous_timeout" || code === "ambiguous_network_error") {
          try {
            const res = await speakingLabApi.activeSession();
            if (!aliveRef.current) return;
            if (res.existing_entry) {
              setState({
                kind: "joined",
                entry: {
                  lucky_code: res.existing_entry.lucky_code,
                  entry_fee: res.entry_fee,
                  pool_total: res.pool_total,
                  player_count: res.player_count,
                },
              });
              return;
            }
            setState({ kind: "offer", entry_fee: res.entry_fee, player_count: res.player_count });
            return;
          } catch {
            setState({ kind: "join_error", message: joinErrorMessage("default") });
            return;
          }
        }
        setState({ kind: "join_error", message: joinErrorMessage(code) });
        return;
      }
      if (!aliveRef.current) return;
      setState({
        kind: "joined",
        entry: {
          lucky_code: result.lucky_code,
          entry_fee: result.entry_fee,
          pool_total: result.pool_total,
          player_count: result.player_count,
          position: result.position,
        },
      });
    } finally {
      endCriticalOp();
    }
  }, []);

  const handleCopy = useCallback((code: string) => {
    navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      },
      () => {
        /* clipboard unavailable — the code is on screen anyway */
      },
    );
  }, []);

  if (state.kind === "hidden") return null;

  const enter = reduced
    ? {}
    : { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35 } };

  return (
    <motion.div data-testid="speaking-lab-live-card" {...enter}>
      <Surface
        variant="aurora"
        accent="violet"
        className="join-prize-pool p-5 sm:p-6 relative overflow-hidden"
      >
        <div className="relative z-[1] flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <div aria-hidden data-accent="violet" className="aurora-icon-badge h-11 w-11 shrink-0">
              <Trophy className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <Pill tone="accent" filled className="!rounded-full mb-1">
                <Sparkles className="h-3 w-3" /> Speaking Lab is Live
              </Pill>
            </div>
          </div>

          {(state.kind === "offer" || state.kind === "joining") && (
            <div className="flex flex-col gap-3">
              <div>
                <h3 className="display text-lg sm:text-xl font-bold text-[color:var(--color-ink)]">
                  Join the Prize Pool
                </h3>
                <p className="text-sm text-[color:var(--color-ink-soft)] mt-1">
                  One tap to enter — you'll get your lucky ticket instantly.
                </p>
              </div>
              <div className="flex flex-wrap gap-3 text-xs text-[color:var(--color-ink-soft)]">
                {state.kind === "offer" && state.entry_fee > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <Coins className="h-3.5 w-3.5" /> Entry: {state.entry_fee} pts
                  </span>
                )}
                {state.kind === "offer" && typeof state.player_count === "number" && (
                  <span className="inline-flex items-center gap-1">
                    <Users className="h-3.5 w-3.5" /> {state.player_count} joined
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={handleJoin}
                disabled={state.kind === "joining"}
                data-accent="violet"
                data-testid="speaking-lab-join-now"
                className="aurora-glow-btn"
              >
                {state.kind === "joining" ? "Joining…" : "Join Now"}
              </button>
            </div>
          )}

          {state.kind === "joined" && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <div aria-hidden data-accent="green" className="aurora-icon-badge h-7 w-7">
                  <Check className="h-3.5 w-3.5" />
                </div>
                <h3 className="display text-lg font-bold text-[color:var(--color-ink)]">
                  You're In!
                </h3>
              </div>
              <div
                className="rounded-xl px-4 py-3 flex items-center justify-between gap-3"
                style={{ background: "var(--color-surface)", border: "1px solid var(--color-line)" }}
              >
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-ink-mute)]">
                    Your Lucky Code
                  </div>
                  <div
                    className="mono text-lg sm:text-xl font-bold text-[color:var(--color-ink)] truncate"
                    data-testid="speaking-lab-live-code"
                  >
                    {state.entry.lucky_code}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleCopy(state.entry.lucky_code)}
                  className="shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold min-h-[40px]"
                  style={{ background: "var(--color-surface-2)", color: "var(--color-ink)" }}
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
              <div className="flex flex-wrap gap-3 text-xs text-[color:var(--color-ink-soft)]">
                {typeof state.entry.pool_total === "number" && (
                  <span className="inline-flex items-center gap-1">
                    <Trophy className="h-3.5 w-3.5" /> Pool: {state.entry.pool_total} pts
                  </span>
                )}
                {typeof state.entry.player_count === "number" && (
                  <span className="inline-flex items-center gap-1">
                    <Users className="h-3.5 w-3.5" /> {state.entry.player_count} players
                  </span>
                )}
                {typeof state.entry.position === "number" && state.entry.position > 0 && (
                  <span>Position #{state.entry.position}</span>
                )}
              </div>
            </div>
          )}

          {state.kind === "join_error" && (
            <div className="flex flex-col gap-3" role="alert">
              <p className="text-sm text-[color:var(--color-ink)]">{state.message}</p>
              <button
                type="button"
                onClick={handleJoin}
                data-accent="violet"
                data-testid="speaking-lab-try-again"
                className="aurora-glow-btn self-start"
              >
                Try again
              </button>
            </div>
          )}
        </div>
      </Surface>
    </motion.div>
  );
}
