/**
 * PurchaseLessonModal.jsx — the Video Library's premium lesson-unlock
 * experience. Pure presentation + local phase state machine; the backend
 * purchase state machine (video_library_tools.py) remains the ONLY
 * authority: the lesson unlocks exclusively after a confirmed
 * `ok: true / state: "succeeded"` response from the existing
 * POST /api/video/lessons/{id}/purchase endpoint. No parallel purchase
 * mechanism, no optimistic unlock, no client-side entitlement.
 *
 * v2 (2026-08) UX redesign — root cause of the reported "two unrelated
 * dialogs" feeling: this was ALREADY a single component/phase-machine
 * (confirm -> processing -> success/error), not two separate modals. The
 * defect was that phase changes swapped content with a hard cut (no
 * shared motion), the lesson's thumbnail/title disappeared after the
 * confirm phase (visual context lost), and the card had no
 * env(safe-area-inset-bottom) handling — unlike this file's sibling
 * video-control-bar in VideoLessonPlayer.jsx, which already does. Fixed
 * by: a persistent identity strip carried through every non-confirm
 * phase, a shared vl-phase-in cross-fade on the phase content, a
 * staggered "ledger" reveal for the points arithmetic, and real
 * safe-area padding on the card itself (plus a maxHeight/overflow
 * fallback for short viewports). The purchase call path itself
 * (handleUnlock -> purchaseLesson -> ok/state branching) is unchanged.
 *
 * Balances shown use the platform's canonical formatPoints convention
 * (up to 2 decimals, trailing zeros dropped — never float noise). The
 * post-purchase balance prefers the backend's authoritative
 * `purchase.pointsAfter` (fresh GAS read) and falls back to a local
 * computation only for display; refreshPoints() reconciles afterwards.
 *
 * Haptics are strictly optional (guarded navigator.vibrate) — success is
 * never blocked on them. Reduced-motion users get the final states
 * without any decorative animation (CSS media query in videoLibrary.css)
 * — state transitions themselves are never gated on motion.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { X, Lock, Loader2, Check, Play, Coins } from "lucide-react";
import { purchaseLesson } from "./videoLibraryApi";
import { useAuth } from "../../context/AuthContext";
import formatPoints from "../../lib/formatPoints";
import "./videoLibrary.css";

const GOLD = "#D4A843";

function Artwork({ lesson, size = "h-36" }) {
  return (
    <div className={`relative w-full ${size} rounded-xl overflow-hidden flex-shrink-0`} data-testid="video-purchase-artwork">
      {lesson.thumbnailUrl ? (
        <img src={lesson.thumbnailUrl} alt="" className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full flex items-center justify-center"
             style={{ background: "linear-gradient(140deg, rgba(212,168,67,0.18), rgba(0,0,0,0.35) 75%)" }}>
          <Play size={26} className="text-white/30" />
        </div>
      )}
      <div className="absolute inset-0" style={{ background: "linear-gradient(to top, rgba(0,0,0,0.55), transparent 55%)" }} />
    </div>
  );
}

/** Persistent lesson-identity strip — carried through processing/success/
 * error/insufficient phases so the student never loses the "I'm unlocking
 * THIS lesson" context once the big hero artwork (confirm phase only)
 * scrolls out of view. Deliberately tiny/quiet — it's continuity, not a
 * second headline. */
function IdentityStrip({ lesson }) {
  return (
    <div className="flex items-center gap-2.5" data-testid="video-purchase-identity-strip">
      <div className="w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 bg-white/5 border border-white/10">
        {lesson.thumbnailUrl ? (
          <img src={lesson.thumbnailUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Play size={13} className="text-white/30" />
          </div>
        )}
      </div>
      <div className="text-[12.5px] font-semibold text-white/70 truncate">{lesson.title}</div>
    </div>
  );
}

function LedgerRow({ label, value, prefix, strong, color, testId, delay, divider }) {
  if (divider) {
    return <div className="h-px bg-white/10 vl-ledger-row" style={{ animationDelay: `${delay}ms` }} />;
  }
  return (
    <div className="flex items-center justify-between text-[13px] vl-ledger-row" style={{ animationDelay: `${delay}ms` }}>
      <span className="text-white/50">{label}</span>
      <span className={`tabular-nums ${strong ? "font-bold text-white text-[13.5px]" : "font-semibold text-white/80"}`}
            style={color ? { color } : undefined} data-testid={testId}>
        {prefix}{formatPoints(value)} pts
      </span>
    </div>
  );
}

/** Deterministic, restrained gold particle burst (12 dots). */
function Burst() {
  return (
    <div aria-hidden className="absolute inset-0 pointer-events-none overflow-visible">
      {Array.from({ length: 12 }).map((_, i) => {
        const angle = (i / 12) * Math.PI * 2;
        const radius = 58 + (i % 3) * 20;
        return (
          <span key={i} className="vl-burst-particle"
                style={{
                  "--dx": `${Math.cos(angle) * radius}px`,
                  "--dy": `${Math.sin(angle) * radius}px`,
                  animationDelay: `${(i % 4) * 40}ms`,
                  width: i % 3 === 0 ? 7 : 5,
                  height: i % 3 === 0 ? 7 : 5,
                }} />
        );
      })}
    </div>
  );
}

export default function PurchaseLessonModal({ lesson, open, onClose, onUnlocked }) {
  const navigate = useNavigate();
  // Optional auth context — graceful when mounted without a provider (tests).
  let auth = null;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  try { auth = useAuth(); } catch { /* no provider */ }
  const student = auth?.student;

  const price = Number(lesson?.price) || 0;
  const rawBalance = student?.points ?? student?.portalPoints ?? student?.portalData?.Points;
  const balance = rawBalance !== null && rawBalance !== undefined && rawBalance !== "" && Number.isFinite(Number(rawBalance))
    ? Number(rawBalance) : null;

  const [phase, setPhase] = useState("confirm"); // confirm | processing | success | error
  const [error, setError] = useState(null);
  const [newBalance, setNewBalance] = useState(null);
  const submittingRef = useRef(false);
  const cardRef = useRef(null);

  useEffect(() => {
    if (open) {
      setPhase("confirm"); setError(null); setNewBalance(null);
      submittingRef.current = false;
    }
  }, [open]);

  // Focus the sheet on open so keyboard/screen-reader users land inside the
  // dialog immediately, and let Escape close it (matches the overlay-click
  // dismissal already below) whenever the sheet is closable.
  useEffect(() => {
    if (!open) return undefined;
    cardRef.current?.focus?.();
    const onKeyDown = (e) => {
      if (e.key === "Escape" && phase !== "processing") onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, phase, onClose]);

  if (!open || !lesson) return null;

  const insufficient = balance !== null && balance < price;

  const handleUnlock = async () => {
    if (submittingRef.current) return; // guards a fast double-tap/double-invoke
    submittingRef.current = true;
    setError(null);
    setPhase("processing");
    try {
      const result = await purchaseLesson(lesson.lessonId, { password: student?.password });
      if (result?.ok) {
        const after = Number.isFinite(Number(result?.purchase?.pointsAfter))
          ? Number(result.purchase.pointsAfter)
          : balance !== null ? balance - price : null;
        setNewBalance(after);
        if (after !== null) auth?.setBalance?.(after);
        Promise.resolve(auth?.refreshPoints?.()).catch(() => {});
        try { if (navigator.vibrate) navigator.vibrate([16, 30, 22]); } catch { /* unsupported */ }
        setPhase("success");
      } else {
        const state = result?.purchase?.state;
        setError(state === "reconcile"
          ? {
            title: "Purchase pending review",
            message: "Your payment could not be confirmed and is pending review. The lesson stays locked and no new attempt is possible until it is resolved — please contact support if this persists.",
            retry: false,
          }
          : {
            title: "Purchase could not be completed",
            message: "No points were deducted. Please try again.",
            retry: true,
          });
        setPhase("error");
      }
    } catch (e) {
      // The backend's own already_owned guard (video_library_tools.py,
      // HTTP 409 "you already own this lesson") — surfaced honestly as its
      // own state rather than a generic retryable failure, since retrying
      // would just 409 again. No points were touched either way.
      const alreadyOwned = e?.status === 409 && /already own/i.test(e?.message || "");
      setError(alreadyOwned
        ? {
          title: "You already own this lesson",
          message: "No new purchase was made — you can start watching right away.",
          retry: false,
          alreadyOwned: true,
        }
        : {
          title: "Purchase could not be completed",
          message: e?.message || "Something went wrong. Please try again.",
          retry: true,
        });
      setPhase("error");
    } finally {
      submittingRef.current = false;
    }
  };

  const closable = phase !== "processing";

  return (
    <div className="vl-modal-overlay fixed inset-0 z-50 flex items-end sm:items-center justify-center px-0 sm:px-6"
         style={{ background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" }}
         data-testid="video-purchase-modal"
         onClick={() => { if (closable) onClose?.(); }}>
      <div ref={cardRef} tabIndex={-1}
           role="dialog" aria-modal="true" aria-labelledby="video-purchase-heading"
           className="vl-modal-card relative w-full sm:max-w-sm bg-[#141414] border border-white/10 rounded-t-2xl sm:rounded-2xl space-y-4 outline-none"
           style={{
             paddingTop: "1.25rem",
             paddingLeft: "max(1.25rem, env(safe-area-inset-left))",
             paddingRight: "max(1.25rem, env(safe-area-inset-right))",
             // The one place this sheet actually collided with device chrome
             // (home indicator) or, on other screens, a fixed bottom nav —
             // the video-control-bar elsewhere in this feature already uses
             // this exact max(...) pattern; this card never did.
             paddingBottom: "max(1.25rem, calc(env(safe-area-inset-bottom) + 0.75rem))",
             maxHeight: "min(680px, calc(100dvh - 24px))",
             overflowY: "auto",
           }}
           onClick={(e) => e.stopPropagation()}>
        {closable && phase !== "success" && (
          <button onClick={onClose} aria-label="Close" data-testid="video-purchase-close-button"
                  className="absolute top-3.5 right-3.5 z-10 p-1.5 text-white/45 hover:text-white">
            <X size={16} />
          </button>
        )}

        {/* key={phase} replays a single, shared cross-fade+rise on every
            phase change (vl-phase-in, defined in videoLibrary.css) instead
            of the previous hard content swap — the thing that actually
            read as "a second dialog appeared". No component state lives on
            this wrapper, so remounting it is purely a motion device. */}
        <div key={phase} className="vl-phase-in space-y-4">
          {phase === "confirm" && !insufficient && (
            <>
              <Artwork lesson={lesson} />
              <div className="text-center space-y-1">
                <div className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: GOLD }}>
                  Unlock this lesson
                </div>
                <h2 id="video-purchase-heading" className="text-[16px] font-bold text-white leading-snug" data-testid="video-purchase-lesson-title">
                  {lesson.title}
                </h2>
                <div className="inline-flex items-center gap-1.5 text-[13px] font-bold mt-1 px-3 py-1 rounded-full"
                     style={{ background: "rgba(212,168,67,0.12)", color: GOLD, border: "1px solid rgba(212,168,67,0.3)" }}
                     data-testid="video-purchase-price">
                  <Coins size={13} /> {formatPoints(price)} EduHub Points
                </div>
              </div>
              {balance !== null && (
                <div className="rounded-xl bg-white/[0.04] border border-white/10 p-3.5 space-y-2">
                  <LedgerRow label="Your balance" value={balance} testId="video-purchase-balance-before" delay={40} />
                  <LedgerRow label="This lesson" value={price} prefix="−" color="#f0a8a8" testId="video-purchase-debit-preview" delay={110} />
                  <LedgerRow divider delay={170} />
                  <LedgerRow label="You'll have" value={balance - price} strong testId="video-purchase-balance-after" delay={210} />
                </div>
              )}
              <div className="space-y-2">
                <button onClick={handleUnlock}
                        data-testid="video-purchase-confirm-button"
                        className="w-full py-3.5 min-h-[48px] rounded-xl text-[14px] font-bold text-black transition-transform active:scale-[0.98]"
                        style={{ background: GOLD }}>
                  Unlock Lesson — {formatPoints(price)} pts
                </button>
                <button onClick={onClose} data-testid="video-purchase-cancel-button"
                        className="w-full py-2.5 min-h-[44px] rounded-xl text-[13px] font-semibold text-white/55 hover:text-white">
                  Not now
                </button>
              </div>
            </>
          )}

          {phase === "confirm" && insufficient && (
            <div className="text-center space-y-4 pt-2" data-testid="video-purchase-insufficient">
              <IdentityStrip lesson={lesson} />
              <div className="w-12 h-12 mx-auto rounded-full flex items-center justify-center"
                   style={{ background: "rgba(240,120,80,0.14)" }}>
                <Lock size={20} className="text-orange-400" />
              </div>
              <div className="space-y-1">
                <h2 id="video-purchase-heading" className="text-[16px] font-bold text-white">Not enough EduHub Points</h2>
                <p className="text-[13px] text-white/55">
                  You need <b className="text-white">{formatPoints(price)} pts</b> — you currently have{" "}
                  <b className="text-white" data-testid="video-purchase-insufficient-balance">{formatPoints(balance)} pts</b>.
                </p>
              </div>
              <div className="space-y-2">
                <button onClick={() => navigate("/")}
                        data-testid="video-purchase-get-points-button"
                        className="w-full py-3.5 min-h-[48px] rounded-xl text-[14px] font-bold text-black"
                        style={{ background: GOLD }}>
                  Get Points
                </button>
                <button onClick={onClose} data-testid="video-purchase-cancel-button"
                        className="w-full py-2.5 min-h-[44px] rounded-xl text-[13px] font-semibold text-white/55 hover:text-white">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {phase === "processing" && (
            <>
              <IdentityStrip lesson={lesson} />
              <div className="flex flex-col items-center justify-center py-10 gap-3 text-center" data-testid="video-purchase-processing">
                <Loader2 className="animate-spin" size={26} style={{ color: GOLD }} />
                <div className="text-[13.5px] font-semibold text-white">Confirming with your wallet…</div>
                <div className="text-[11.5px] text-white/40">Please keep this window open.</div>
              </div>
            </>
          )}

          {phase === "success" && (
            <div className="text-center space-y-4 pt-1 pb-1" data-testid="video-purchase-success">
              <IdentityStrip lesson={lesson} />
              <div className="relative w-16 h-16 mx-auto">
                <Burst />
                <div className="vl-check relative w-16 h-16 rounded-full flex items-center justify-center"
                     style={{ background: "rgba(212,168,67,0.16)", border: "1.5px solid rgba(212,168,67,0.55)" }}>
                  <Check size={28} style={{ color: GOLD }} strokeWidth={3} />
                </div>
              </div>
              <div className="space-y-1">
                <h2 id="video-purchase-heading" className="text-[17px] font-bold text-white">Lesson Unlocked</h2>
                <div className="text-[13px] font-bold mt-1" style={{ color: "#f0a8a8" }} data-testid="video-purchase-debit">
                  −{formatPoints(price)} pts
                </div>
              </div>
              {newBalance !== null && (
                <div className="rounded-xl bg-white/[0.04] border border-white/10 p-3">
                  <LedgerRow label="New balance" value={newBalance} strong testId="video-purchase-new-balance" delay={80} />
                </div>
              )}
              <button onClick={() => onUnlocked?.()}
                      data-testid="video-purchase-start-learning-button"
                      className="w-full py-3.5 min-h-[48px] rounded-xl text-[14px] font-bold text-black inline-flex items-center justify-center gap-2"
                      style={{ background: GOLD }}>
                <Play size={15} fill="currentColor" /> Start Learning
              </button>
            </div>
          )}

          {phase === "error" && (
            <div className="text-center space-y-4 pt-2" data-testid="video-purchase-error">
              <IdentityStrip lesson={lesson} />
              <div className="w-12 h-12 mx-auto rounded-full flex items-center justify-center"
                   style={{ background: "rgba(240,80,80,0.13)" }}>
                <X size={20} className="text-red-400" />
              </div>
              <div className="space-y-1">
                <h2 id="video-purchase-heading" className="text-[15.5px] font-bold text-white">{error?.title}</h2>
                <p className="text-[12.5px] text-white/55 leading-relaxed">{error?.message}</p>
                {balance !== null && !error?.alreadyOwned && (
                  <p className="text-[11.5px] text-white/40 mt-1">Your balance: {formatPoints(balance)} pts</p>
                )}
              </div>
              <div className="space-y-2">
                {error?.alreadyOwned ? (
                  <button onClick={() => onUnlocked?.()} data-testid="video-purchase-already-owned-continue-button"
                          className="w-full py-3.5 min-h-[48px] rounded-xl text-[14px] font-bold text-black inline-flex items-center justify-center gap-2"
                          style={{ background: GOLD }}>
                    <Play size={15} fill="currentColor" /> Continue to Lesson
                  </button>
                ) : error?.retry && (
                  <button onClick={handleUnlock} data-testid="video-purchase-retry-button"
                          className="w-full py-3.5 min-h-[48px] rounded-xl text-[14px] font-bold text-black"
                          style={{ background: GOLD }}>
                    Try again
                  </button>
                )}
                <button onClick={onClose} data-testid="video-purchase-cancel-button"
                        className="w-full py-2.5 min-h-[44px] rounded-xl text-[13px] font-semibold text-white/55 hover:text-white">
                  {error?.alreadyOwned ? "Close" : error?.retry ? "Cancel" : "Close"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
