// SystemTest.jsx — Native React port of the IELTS Speaking Test "Secure
//   Portal". Re-uses AuthContext (no re-login). Preserves the original Apps
//   Script API (login / fetchQuestions / submitTest / getTimerConfig). The
//   anti-cheat heuristics (visibility loss, copy/paste, focus blur) and the
//   one-question-per-screen flow are preserved verbatim, but presented in the
//   EduHub aurora theme.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ShieldCheck,
  ShieldAlert,
  Shield,
  Clock,
  ArrowRight,
  Check,
  X,
  PlayCircle,
  PauseCircle,
  Loader2,
  Send,
  AlertTriangle,
  Lock,
  Sparkles,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { getSessionToken, makeNonce } from "../../lib/secureClient";

const SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwQknsM0MJwRmoTGPai-_E2OSMb9FPxK7UsexqmpXZAqelyw99guEhjhNQn9hCL0m5uTg/exec";

const QUESTION_TIME = 30;

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}
function fmtMs(ms) {
  if (!ms) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function fixDropbox(url) {
  if (!url) return url;
  return String(url)
    .replace("?dl=0", "?raw=1")
    .replace("www.dropbox.com", "dl.dropboxusercontent.com");
}

/* ───────── Stage 1: Integrity briefing ───────── */
function IntegrityScreen({ onAgree, onCancel, lang, setLang }) {
  const [count, setCount] = useState(5);
  useEffect(() => {
    if (count <= 0) return;
    const t = setTimeout(() => setCount((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [count]);

  const items = [
    { t: "No tab/window switching", d: "Stay focused on this page. 3 strikes = blocked." },
    { t: "No copy / paste", d: "Selecting answer text is disabled while testing." },
    { t: "Per-question timer", d: `${QUESTION_TIME}s per question — auto-skip on expiry.` },
    { t: "Behavior is logged", d: "Tab switches & copy/paste attempts are recorded." },
  ];

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-3xl border border-aurora-coral/40 backdrop-blur-xl overflow-hidden"
      style={{
        background:
          "radial-gradient(ellipse at top, rgba(255,122,58,0.12), transparent 60%), rgba(8,3,22,0.7)",
        boxShadow: "0 24px 80px -24px rgba(255,61,166,0.4)",
      }}
      data-testid="integrity-screen"
    >
      <div className="px-5 sm:px-7 py-5 border-b border-white/[0.08] text-center relative">
        <div
          className="mx-auto w-14 h-14 rounded-full grid place-items-center mb-2.5"
          style={{
            background: "rgba(245,69,92,0.12)",
            border: "2px solid rgba(245,69,92,0.7)",
            boxShadow: "0 0 26px rgba(245,69,92,0.45)",
          }}
        >
          <Lock className="w-6 h-6 text-aurora-coral" />
        </div>
        <h2 className="font-display text-xl sm:text-2xl font-extrabold text-iridescent">
          Test Integrity Required
        </h2>
        <p className="text-white/55 text-[12.5px] mt-1">
          Read the rules below before starting. Your behaviour will be monitored.
        </p>
        <button
          onClick={() => setLang(lang === "en" ? "km" : "en")}
          className="absolute top-3 right-3 text-[11px] uppercase tracking-wider px-2.5 py-1 rounded-full border border-white/15 bg-white/[0.05] text-white/75 hover:text-white"
          data-testid="systemtest-lang-toggle"
        >
          {lang === "en" ? "ខ្មែរ" : "EN"}
        </button>
      </div>

      <div className="px-5 sm:px-7 py-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mb-5">
          {items.map((it) => (
            <div
              key={it.t}
              className="flex items-start gap-3 p-3 rounded-xl border border-white/[0.08]"
              style={{ background: "rgba(255,255,255,0.025)" }}
            >
              <div className="w-8 h-8 rounded-lg grid place-items-center bg-aurora-coral/15 border border-aurora-coral/40 text-aurora-coral flex-none">
                <ShieldAlert className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-white">
                  {it.t}
                </div>
                <div className="text-[11.5px] text-white/55">{it.d}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] px-3.5 py-3 mb-4 text-[12.5px] text-white/65 leading-relaxed">
          By continuing you confirm that you alone will take this test, you
          will not switch tabs, and you understand that <strong className="text-aurora-coral">three violations will block the test</strong>.
        </div>

        <div className="flex gap-2.5 flex-wrap">
          <button
            onClick={onCancel}
            data-testid="integrity-cancel-btn"
            className="px-4 py-2.5 rounded-full text-[13px] font-semibold border border-white/15 bg-white/[0.04] text-white/75 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={onAgree}
            disabled={count > 0}
            data-testid="integrity-start-btn"
            className="ml-auto inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-extrabold text-white disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: "linear-gradient(135deg,#ff3da6,#9b5cff)",
              boxShadow: "0 6px 22px -4px rgba(255,61,166,0.55)",
            }}
          >
            {count > 0 ? `I agree · start in ${count}s` : "I agree — start test"}
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </motion.section>
  );
}

/* ───────── Score modal ───────── */
function ScoreModal({ data, onClose }) {
  if (!data) return null;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-[1500] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(8px)" }}
      data-testid="score-modal"
    >
      <motion.div
        initial={{ scale: 0.94, y: 14 }}
        animate={{ scale: 1, y: 0 }}
        className="relative w-full max-w-[760px] max-h-[90vh] overflow-y-auto rounded-3xl border border-aurora-cyan/40 backdrop-blur-xl"
        style={{
          background:
            "radial-gradient(ellipse at top, rgba(0,224,255,0.12), transparent 60%), rgba(8,3,22,0.92)",
          boxShadow: "0 30px 100px -30px rgba(0,224,255,0.45)",
        }}
      >
        <div className="px-5 sm:px-7 py-5 border-b border-white/[0.08] flex items-center gap-3">
          <div className="grid place-items-center w-12 h-12 rounded-2xl text-white shadow-[0_0_22px_rgba(0,224,255,0.55)]"
               style={{ background: "linear-gradient(135deg,#00e0ff,#9b5cff)" }}>
            <Sparkles className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="font-display text-lg font-extrabold text-iridescent">
              Test Complete
            </div>
            <div className="text-[12px] text-white/55">
              Score: {data.score ?? "—"} · Correct {data.correct}/{data.total} · Accuracy {data.accuracy}%
            </div>
          </div>
          <button
            onClick={onClose}
            data-testid="score-close-btn"
            className="ml-auto inline-flex items-center justify-center w-9 h-9 rounded-full border border-white/15 bg-white/[0.04] text-white/70 hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 sm:px-7 py-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-5">
            <SummaryCard label="Score" value={data.score ?? "—"} accent="cyan" />
            <SummaryCard label="Correct" value={data.correct} accent="lime" />
            <SummaryCard label="Wrong" value={data.wrong} accent="coral" />
            <SummaryCard label="Accuracy" value={`${data.accuracy}%`} accent="violet" />
          </div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-white/45 font-bold mb-2">
            Per-question breakdown
          </div>
          <ul className="space-y-1.5">
            {data.rows.map((r, i) => (
              <li
                key={i}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-xl border-l-[3px] ${
                  r.skipped
                    ? "border-aurora-coral/60 bg-aurora-coral/[0.06]"
                    : r.correct
                    ? "border-aurora-lime/70 bg-aurora-lime/[0.06]"
                    : "border-aurora-coral/70 bg-aurora-coral/[0.06]"
                }`}
              >
                <span className="font-mono text-[11px] text-white/50 w-8 flex-none">
                  Q{i + 1}
                </span>
                <span className="text-[12.5px] text-white/85 truncate flex-1">
                  Your: <strong>{r.user || "—"}</strong> → Correct:{" "}
                  <strong className="text-aurora-cyan">{r.correctAnswer || "—"}</strong>
                </span>
                <span
                  className={`text-[12px] font-extrabold ${
                    r.skipped
                      ? "text-aurora-coral"
                      : r.correct
                      ? "text-aurora-lime"
                      : "text-aurora-coral"
                  }`}
                >
                  {r.skipped ? "Skipped" : r.correct ? "✓" : "✗"}
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-center">
            <Stat label="Tabs" value={data.tabs} />
            <Stat label="Copy/Paste" value={data.copies} />
            <Stat label="Avg time" value={fmtMs(data.avgMs)} />
            <Stat label="Duration" value={fmtMs(data.totalMs)} />
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
function SummaryCard({ label, value, accent }) {
  const map = {
    cyan: "border-aurora-cyan/45 bg-aurora-cyan/10 text-aurora-cyan",
    lime: "border-aurora-lime/45 bg-aurora-lime/10 text-aurora-lime",
    coral: "border-aurora-coral/45 bg-aurora-coral/10 text-aurora-coral",
    violet: "border-aurora-violet/45 bg-aurora-violet/10 text-aurora-violet",
  };
  return (
    <div className={`rounded-xl border ${map[accent]} px-3 py-2.5 text-center`}>
      <div className="font-display text-2xl font-black leading-none">{value}</div>
      <div className="text-[10px] uppercase tracking-[0.18em] mt-1 text-white/55 font-bold">
        {label}
      </div>
    </div>
  );
}
function Stat({ label, value }) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.18em] text-white/45 font-bold">
        {label}
      </div>
      <div className="font-mono text-[13px] text-white/90">{value}</div>
    </div>
  );
}

/* ───────── Audio chip ───────── */
function AudioChip({ url, idx }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    return () => audioRef.current?.pause();
  }, []);

  const toggle = () => {
    if (!audioRef.current) {
      audioRef.current = new Audio(fixDropbox(url));
      audioRef.current.addEventListener("timeupdate", () => {
        const a = audioRef.current;
        if (a?.duration) setProgress((a.currentTime / a.duration) * 100);
      });
      audioRef.current.addEventListener("ended", () => setPlaying(false));
    }
    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
    } else {
      audioRef.current.play().catch(() => setPlaying(false));
      setPlaying(true);
    }
  };

  return (
    <div
      className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 mb-3"
      data-testid={`audio-chip-${idx}`}
    >
      <button
        onClick={toggle}
        className="grid place-items-center w-10 h-10 rounded-full text-[#0a0220] shadow-[0_4px_14px_rgba(0,224,255,0.45)]"
        style={{ background: "linear-gradient(135deg,#00e0ff,#9b5cff)" }}
        type="button"
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? <PauseCircle className="w-5 h-5" /> : <PlayCircle className="w-5 h-5" />}
      </button>
      <div className="flex-1">
        <div className="text-[10px] uppercase tracking-[0.18em] text-white/45 font-bold">
          Audio recording
        </div>
        <div className="h-[3px] bg-white/10 rounded-full mt-1 overflow-hidden">
          <div
            className="h-full transition-all"
            style={{
              width: `${progress}%`,
              background:
                "linear-gradient(90deg,#00e0ff,#9b5cff,#ff3da6)",
            }}
          />
        </div>
      </div>
    </div>
  );
}

/* ───────── Main page ───────── */
export default function SystemTest() {
  const { student } = useAuth();
  const sid = student?.studentId || "";
  const pwd = student?.password || student?.portalData?.Password || "";

  const [stage, setStage] = useState("intro"); // intro → loading → testing → submitting → done
  const [lang, setLang] = useState("en");
  const [questions, setQuestions] = useState([]);
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState([]);
  const [qDurations, setQDurations] = useState([]);
  const startedAtRef = useRef(0);
  const qStartRef = useRef(0);

  // Global timer
  const [timeLeft, setTimeLeft] = useState(60 * 60);
  const [duration, setDuration] = useState(60 * 60);
  const timerRef = useRef(null);

  // Per-question timer
  const [qLeft, setQLeft] = useState(QUESTION_TIME);
  const qTimerRef = useRef(null);

  // Anti-cheat
  const [tabs, setTabs] = useState(0);
  const [copies, setCopies] = useState(0);
  const [violations, setViolations] = useState(0);
  const [overlay, setOverlay] = useState(null); // null | 1 | 2 | 3
  const [blocked, setBlocked] = useState(false);

  // Final
  const [scoreData, setScoreData] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  /* ─── Start / fetch questions ─── */
  const startTest = useCallback(async () => {
    setStage("loading");
    startedAtRef.current = Date.now();
    setErrorMsg(null);

    // Fetch timer config
    let mins = 60;
    try {
      const r = await fetch(`${SCRIPT_URL}?action=getTimerConfig`);
      const d = await r.json();
      if (d?.success && d.timerMinutes) mins = parseInt(d.timerMinutes, 10) || 60;
    } catch {
      /* default 60 */
    }
    setDuration(mins * 60);
    setTimeLeft(mins * 60);

    // Fetch questions
    try {
      const body = new URLSearchParams({
        action: "fetchQuestions",
        id: sid,
        password: pwd,
      });
      const tok = getSessionToken();
      if (tok) body.append("sessionToken", tok);
      const res = await fetch(SCRIPT_URL, {
        method: "POST",
        body,
        redirect: "follow",
      });
      const data = await res.json();
      if (data?.success && Array.isArray(data.questions)) {
        const valid = data.questions
          .filter((q) => q.question && q.options && q.options.length > 0)
          .map((q) => {
            const opts = q.options.map((o, i) => ({ text: o, originalIndex: i }));
            const sh = shuffle(opts);
            return { ...q, options: sh.map((o) => o.text) };
          });
        const shuffled = shuffle(valid);
        setQuestions(shuffled);
        setAnswers(new Array(shuffled.length).fill(""));
        setQDurations(new Array(shuffled.length).fill(0));
        setIdx(0);
        qStartRef.current = Date.now();
        setStage("testing");
      } else {
        setErrorMsg(data?.message || "No questions found.");
        setStage("intro");
      }
    } catch {
      setErrorMsg("Couldn't reach the test server. Try again.");
      setStage("intro");
    }
  }, [sid, pwd]);

  /* ─── Global timer ─── */
  useEffect(() => {
    if (stage !== "testing" || blocked) return;
    timerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
      const left = Math.max(0, duration - elapsed);
      setTimeLeft(left);
      if (left <= 0) {
        clearInterval(timerRef.current);
        submit();
      }
    }, 1000);
    return () => clearInterval(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, duration, blocked]);

  /* ─── Per-question timer ─── */
  useEffect(() => {
    if (stage !== "testing" || blocked) return;
    setQLeft(QUESTION_TIME);
    clearInterval(qTimerRef.current);
    qTimerRef.current = setInterval(() => {
      setQLeft((q) => {
        if (q <= 1) {
          clearInterval(qTimerRef.current);
          advance();
          return 0;
        }
        return q - 1;
      });
    }, 1000);
    return () => clearInterval(qTimerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, stage, blocked]);

  /* ─── Anti-cheat: visibility + blur + copy/paste ─── */
  useEffect(() => {
    if (stage !== "testing" || blocked) return;

    const onHidden = () => {
      if (document.hidden) {
        setTabs((t) => t + 1);
        bumpViolation();
      }
    };
    const onBlur = () => {
      setTabs((t) => t + 1);
      bumpViolation();
    };
    const onCopy = (e) => {
      e.preventDefault();
      setCopies((c) => c + 1);
    };
    const onContext = (e) => e.preventDefault();
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("blur", onBlur);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    document.addEventListener("paste", onCopy);
    document.addEventListener("contextmenu", onContext);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
      document.removeEventListener("paste", onCopy);
      document.removeEventListener("contextmenu", onContext);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, blocked]);

  function bumpViolation() {
    setViolations((v) => {
      const nv = v + 1;
      setOverlay(Math.min(nv, 3));
      if (nv >= 3) {
        setBlocked(true);
        setTimeout(() => submit(true), 2500);
      }
      return nv;
    });
  }

  const dismissOverlay = () => setOverlay(null);

  /* ─── Answer & navigation ─── */
  const choose = (val) => {
    setAnswers((a) => {
      const c = [...a];
      c[idx] = val;
      return c;
    });
  };

  const advance = () => {
    setQDurations((d) => {
      const c = [...d];
      c[idx] = Date.now() - qStartRef.current;
      return c;
    });
    qStartRef.current = Date.now();
    if (idx >= questions.length - 1) submit();
    else setIdx((i) => i + 1);
  };

  /* ─── Submit ─── */
  async function submit(forced = false) {
    if (stage === "submitting" || stage === "done") return;
    setStage("submitting");
    clearInterval(timerRef.current);
    clearInterval(qTimerRef.current);

    const finalAnswers = questions.map((_, i) => answers[i] || "");
    try {
      const submitBody = new URLSearchParams({
        action: "submitTest",
        id: sid,
        password: pwd,
        answers: JSON.stringify(finalAnswers),
        behaviorLog: JSON.stringify({
          tabSwitches: tabs,
          copyPasteAttempts: copies,
          violationCount: violations,
          blocked: forced || blocked,
          questionDurations: qDurations,
          startTime: new Date(startedAtRef.current).toISOString(),
          endTime: new Date().toISOString(),
        }),
        nonce: makeNonce(),
      });
      const tok2 = getSessionToken();
      if (tok2) submitBody.append("sessionToken", tok2);
      const res = await fetch(SCRIPT_URL, {
        method: "POST",
        body: submitBody,
        redirect: "follow",
      });
      const data = await res.json();
      const total = questions.length;
      const rows = (data?.results || []).map((r, i) => ({
        user: finalAnswers[i],
        correctAnswer: r?.correctAnswer || "—",
        correct: !!r?.isCorrect,
        skipped: !finalAnswers[i],
      }));
      const correct = rows.filter((r) => r.correct).length;
      const wrong = total - correct;
      const acc = total ? Math.round((correct / total) * 100) : 0;
      const totalMs = Date.now() - startedAtRef.current;
      const avgMs =
        qDurations.filter(Boolean).reduce((a, b) => a + b, 0) /
        Math.max(1, qDurations.filter(Boolean).length);

      setScoreData({
        score: data?.score ?? correct,
        correct,
        wrong,
        total,
        accuracy: acc,
        rows,
        tabs,
        copies,
        avgMs: Math.round(avgMs),
        totalMs,
      });
      setStage("done");
    } catch {
      setErrorMsg("Submission failed. Please try again.");
      setStage("testing");
    }
  }

  /* ─── Render ─── */
  if (!sid) {
    return (
      <div className="rounded-2xl border border-aurora-violet/30 p-6 text-white/80">
        Please <strong>sign in</strong> to take the system test.
      </div>
    );
  }

  if (stage === "intro") {
    return (
      <>
        {errorMsg && (
          <div className="mb-3 rounded-xl border border-aurora-coral/40 bg-aurora-coral/10 text-aurora-coral px-3.5 py-2 text-[12.5px]">
            {errorMsg}
          </div>
        )}
        <IntegrityScreen
          onAgree={startTest}
          onCancel={() => window.history.back()}
          lang={lang}
          setLang={setLang}
        />
      </>
    );
  }

  if (stage === "loading") {
    return (
      <div className="grid place-items-center py-20 text-white/70">
        <Loader2 className="w-7 h-7 animate-spin text-aurora-cyan mb-2" />
        Loading test questions…
      </div>
    );
  }

  const q = questions[idx];
  const total = questions.length;
  const stepPct = total ? ((idx + 1) / total) * 100 : 0;
  const qPct = (qLeft / QUESTION_TIME) * 100;
  const qCls = qLeft <= 5 ? "crit" : qLeft <= 10 ? "warn" : "ok";

  const isLast = idx === total - 1;
  const picked = answers[idx];

  return (
    <section className="relative" data-testid="systemtest-page">
      {/* Top status row */}
      <div className="rounded-2xl border border-white/[0.08] backdrop-blur-xl px-3.5 sm:px-5 py-3 mb-3 flex items-center gap-3 flex-wrap"
           style={{ background: "rgba(8,3,22,0.55)" }}>
        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border ${
            violations === 0
              ? "border-aurora-lime/40 bg-aurora-lime/10 text-aurora-lime"
              : violations < 3
              ? "border-aurora-gold/40 bg-aurora-gold/10 text-aurora-gold"
              : "border-aurora-coral/40 bg-aurora-coral/10 text-aurora-coral"
          }`}
        >
          {violations === 0 ? (
            <ShieldCheck className="w-3.5 h-3.5" />
          ) : violations < 3 ? (
            <ShieldAlert className="w-3.5 h-3.5" />
          ) : (
            <Shield className="w-3.5 h-3.5" />
          )}
          {violations === 0
            ? "Monitoring"
            : violations < 3
            ? `Warning ${violations}/3`
            : "Blocked"}
        </span>

        <span className="font-mono text-[11px] text-white/55 hidden sm:inline">
          T:{tabs} · CP:{copies}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <Clock className="w-3.5 h-3.5 text-aurora-cyan" />
          <span
            className={`font-mono text-[13px] tracking-wider ${
              timeLeft <= 60
                ? "text-aurora-coral animate-pulse"
                : timeLeft <= 300
                ? "text-aurora-gold"
                : "text-white"
            }`}
            data-testid="systemtest-timer"
          >
            {fmtTime(timeLeft)}
          </span>
        </div>
      </div>

      {/* Question progress */}
      <div className="flex items-center gap-3 mb-3">
        <span className="font-mono text-[11px] text-white/55 whitespace-nowrap">
          {idx + 1} / {total}
        </span>
        <div className="flex-1 h-[3px] bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full transition-all"
            style={{
              width: `${stepPct}%`,
              background: "linear-gradient(90deg,#00e0ff,#9b5cff,#ff3da6)",
            }}
          />
        </div>
      </div>

      {/* Per-question countdown */}
      <div className="flex items-center gap-3 mb-4">
        <span className="font-mono text-[11px] text-white/55">Question time</span>
        <div className="flex-1 h-[5px] bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full transition-all"
            style={{
              width: `${qPct}%`,
              background:
                qCls === "crit"
                  ? "#ff3da6"
                  : qCls === "warn"
                  ? "#ffc94d"
                  : "linear-gradient(90deg,#00e0ff,#9b5cff)",
            }}
          />
        </div>
        <span
          className={`font-mono text-[12px] min-w-[36px] text-right ${
            qCls === "crit"
              ? "text-aurora-coral"
              : qCls === "warn"
              ? "text-aurora-gold"
              : "text-white/85"
          }`}
        >
          {qLeft}s
        </span>
      </div>

      {/* Question card */}
      <AnimatePresence mode="wait">
        <motion.article
          key={idx}
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.32 }}
          className="rounded-3xl border border-aurora-violet/30 backdrop-blur-xl px-4 sm:px-6 py-5"
          style={{
            background:
              "radial-gradient(ellipse at top, rgba(155,92,255,0.10), transparent 60%), rgba(8,3,22,0.58)",
            boxShadow: "0 18px 50px -20px rgba(155,92,255,0.4)",
          }}
          data-testid={`question-card-${idx + 1}`}
        >
          <div className="text-[10px] uppercase tracking-[0.18em] text-aurora-cyan font-bold mb-2 inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-aurora-cyan shadow-[0_0_8px_#00e0ff]" />
            Question {idx + 1}
          </div>
          <h2 className="text-[15px] sm:text-[17px] leading-relaxed text-white/95 mb-4 allow-select">
            {q?.question}
          </h2>

          {q?.audio && <AudioChip url={q.audio} idx={idx} />}

          <div className="flex flex-col gap-2.5">
            {(q?.options || []).map((opt, i) => {
              const letter = String.fromCharCode(65 + i);
              const sel = picked === letter;
              return (
                <button
                  type="button"
                  key={i}
                  onClick={() => !picked && choose(letter)}
                  disabled={!!picked}
                  data-testid={`option-${i}`}
                  className={`group flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all ${
                    sel
                      ? "border-aurora-cyan/70 bg-aurora-cyan/[0.10] shadow-[0_0_18px_-4px_rgba(0,224,255,0.55)]"
                      : "border-white/[0.10] bg-white/[0.02] hover:border-aurora-cyan/40 hover:bg-aurora-cyan/[0.05]"
                  } ${picked && !sel ? "opacity-60" : ""}`}
                >
                  <span
                    className="grid place-items-center w-7 h-7 rounded-lg font-display text-[13px] font-extrabold text-aurora-cyan border border-aurora-cyan/40 bg-aurora-cyan/10"
                  >
                    {letter}
                  </span>
                  <span className="text-[13.5px] text-white/85 flex-1">{opt}</span>
                  {sel && <Check className="w-4 h-4 text-aurora-cyan flex-none" />}
                </button>
              );
            })}
          </div>

          <div className="mt-5 flex items-center justify-between gap-3 flex-wrap">
            <span className="text-[11.5px] font-mono text-white/45">
              {picked ? "Locked. Click next." : "Pick one answer to continue."}
            </span>
            <button
              type="button"
              onClick={advance}
              disabled={!picked}
              data-testid="next-btn"
              className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-extrabold text-white disabled:opacity-50 disabled:cursor-not-allowed transition ${
                isLast
                  ? "shadow-[0_6px_22px_-4px_rgba(155,92,255,0.55)]"
                  : "shadow-[0_6px_22px_-4px_rgba(0,224,255,0.55)]"
              }`}
              style={{
                background: isLast
                  ? "linear-gradient(135deg,#9b5cff,#ff3da6)"
                  : "linear-gradient(135deg,#00e0ff,#9b5cff)",
              }}
            >
              {isLast ? (
                <>
                  Submit <Send className="w-4 h-4" />
                </>
              ) : (
                <>
                  Next <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </div>
        </motion.article>
      </AnimatePresence>

      {/* Submit overlay */}
      {stage === "submitting" && (
        <div className="fixed inset-0 z-[1400] flex items-center justify-center"
             style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(6px)" }}>
          <div className="rounded-2xl border border-aurora-cyan/40 px-6 py-5 backdrop-blur-xl text-center"
               style={{ background: "rgba(8,3,22,0.85)" }}>
            <Loader2 className="w-7 h-7 animate-spin text-aurora-cyan mx-auto mb-2" />
            <div className="text-white/80 text-sm">Submitting your test…</div>
          </div>
        </div>
      )}

      {/* Violation overlay */}
      <AnimatePresence>
        {overlay && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[1300] flex items-center justify-center p-4"
            style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(8px)" }}
            data-testid="violation-overlay"
          >
            <div
              className={`rounded-3xl border-2 px-6 py-7 max-w-[460px] w-full text-center backdrop-blur-xl ${
                overlay >= 3
                  ? "border-aurora-coral shadow-[0_0_60px_rgba(255,61,166,0.45)]"
                  : "border-aurora-gold shadow-[0_0_60px_rgba(255,201,77,0.4)]"
              }`}
              style={{ background: "rgba(8,3,22,0.92)" }}
            >
              <AlertTriangle
                className={`w-12 h-12 mx-auto mb-3 ${
                  overlay >= 3 ? "text-aurora-coral" : "text-aurora-gold"
                }`}
              />
              <div className="font-display text-lg font-extrabold text-white mb-1.5">
                {overlay === 1 && "Stay focused on the test"}
                {overlay === 2 && "Second warning — last chance"}
                {overlay === 3 && "Test blocked"}
              </div>
              <div className="text-white/70 text-[13px] mb-4">
                {overlay === 1 &&
                  "Tab switching and window blur are not allowed during a test."}
                {overlay === 2 &&
                  "One more violation will block this test."}
                {overlay === 3 &&
                  "Three violations recorded. Test will be auto-submitted."}
              </div>
              <div className="flex items-center justify-center gap-2 mb-4">
                {[1, 2, 3].map((n) => (
                  <span
                    key={n}
                    className={`w-3 h-3 rounded-full border-2 ${
                      n <= overlay
                        ? "bg-aurora-coral border-aurora-coral shadow-[0_0_8px_#ff3da6]"
                        : "border-white/30"
                    }`}
                  />
                ))}
              </div>
              {overlay < 3 && (
                <button
                  type="button"
                  onClick={dismissOverlay}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-extrabold text-white"
                  style={{
                    background: "linear-gradient(135deg,#ffc94d,#ff7a3a)",
                    boxShadow: "0 6px 22px -4px rgba(255,122,58,0.55)",
                  }}
                >
                  Resume test
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Score modal */}
      <AnimatePresence>
        {scoreData && (
          <ScoreModal data={scoreData} onClose={() => setScoreData(null)} />
        )}
      </AnimatePresence>
    </section>
  );
}
