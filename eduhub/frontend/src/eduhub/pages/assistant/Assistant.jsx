// Assistant.jsx — v1.1 Premium UI + Response Quality Completion Hotfix.
//
// Personal English Coach powered by Gemini 2.5 Flash (backend integration
// already deployed in v1.0).
//
// What this rewrite fixes vs v1.0:
//
//   • Eliminates the giant empty black chat panel before the first
//     message. Pre-chat shows a real "landing" experience with hero,
//     coach orb, smart starter cards, and a contextual greeting.
//
//   • Chat surface only appears AFTER the student sends their first
//     question. Smooth crossfade between landing and chat modes.
//
//   • Sticky native input dock with safe-area bottom padding, large
//     glass input, animated mic with listening glow, and clear
//     active/disabled send button.
//
//   • The "Please sign in again so your wallet can be checked." error
//     is gone from the chat history. Root cause: after a page reload,
//     AuthContext restores the cached profile WITHOUT the student
//     password (stripSensitive), and re-hydrates the password from
//     GAS in the background. During that race window, the backend
//     receives password="" and returns reason="missing_password". We
//     now:
//
//       — gate Send on `isBootstrapping && !student.password` and
//         show a calm "Refreshing your wallet…" pill instead.
//       — surface any wallet-check failure as a small Retry banner
//         under the input, NOT as a scary in-chat bubble.
//
//   • Voice input keeps the v1 Web Speech API approach (no Whisper, no
//     audio upload, no new npm dependency), with a friendlier
//     listening glow, transcript editing, and richer fallbacks.
//
//   • Desktop-only "Press Enter / Shift+Enter" hint is hidden on
//     mobile and reduced-motion is respected throughout.

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import Markdown from "markdown-to-jsx";
import {
  Bot,
  Sparkles,
  RefreshCw,
  Coins,
  Square,
  Square as SquareIcon,
  GraduationCap,
  MessageSquare,
  BookOpen,
  PenLine,
  Mic2,
  Mic2 as Mic2Icon,
  Languages,
  ScrollText,
  AlertCircle,
  Trophy,
  Wand2,
  Gift,
  Loader2,
  CheckCircle2,
  Award,
  Crown,
  ShieldCheck,
  Lightbulb,
  ArrowRight,
  Activity,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import CoachHero from "./components/CoachHero";
import ModeSegmented from "./components/ModeSegmented";
import StickyComposer from "./components/StickyComposer";
import PausedStateCard from "./components/PausedStateCard";
import ChatLanding from "./components/ChatLanding";
import { CoachOrbSvg } from "./components/illustrations";
import { EASE, DURATION, bubbleEnter } from "./motion";
import useKeyboardBodyLock from "../../hooks/useKeyboardBodyLock";
import "./assistant-premium.css"; /* v2 — premium adaptive tokens (day/night) */
import { useAuth } from "../../context/AuthContext";
import { getAssistantConfig, postAssistantChat } from "../../lib/aiAssistantApi";
import {
  getVoiceConfig,
  startMission as apiStartMission,
  uploadAttempt as apiUploadAttempt,
  analyzeAttempt as apiAnalyzeAttempt,
  getRewardStatus as apiGetRewardStatus,
  claimReward as apiClaimReward,
  pickSafeMimeType,
} from "../../lib/aiAssistantVoiceApi";

/* ──────────────────  CONSTANTS  ────────────────────────────────────────── */
const DEFAULT_MODES = [
  "General",
  "Grammar",
  "Speaking",
  "Writing",
  "Vocabulary",
  "Pronunciation",
  "IELTS",
];

const DEFAULT_SUGGESTIONS = [
  "Correct my sentence",
  "Give me a 5-minute speaking exercise",
  "Explain present perfect",
  "Help me improve pronunciation",
  "Give me useful daily conversation vocabulary",
  "Check my writing",
];

/** Smart starter cards shown on the empty landing state. Each card has
 *  a tone, a real prompt the coach will receive, and an icon. */
const STARTER_CARDS = [
  {
    key: "grammar",
    mode: "Grammar",
    label: "Explain grammar",
    sub: "“Explain present perfect with two examples.”",
    prompt: "Explain present perfect with two clear examples.",
    Icon: BookOpen,
    accent: "rgba(0,224,255,0.16)",
    ring: "rgba(0,224,255,0.45)",
  },
  {
    key: "writing",
    mode: "Writing",
    label: "Check my writing",
    sub: "Paste a sentence and I'll polish it.",
    prompt: "Please check this sentence and suggest a more natural version: ",
    Icon: PenLine,
    accent: "rgba(155,92,255,0.16)",
    ring: "rgba(155,92,255,0.45)",
  },
  {
    key: "speaking",
    mode: "Speaking",
    label: "Speaking practice",
    sub: "Try a 5-minute speaking warm-up.",
    prompt: "Give me a 5-minute speaking warm-up I can do right now.",
    Icon: Mic2,
    accent: "rgba(255,61,166,0.16)",
    ring: "rgba(255,61,166,0.45)",
  },
  {
    key: "vocab",
    mode: "Vocabulary",
    label: "Daily vocabulary",
    sub: "Useful words for everyday talk.",
    prompt: "Give me 6 useful English words for daily conversation, with examples.",
    Icon: Languages,
    accent: "rgba(255,196,0,0.16)",
    ring: "rgba(255,196,0,0.45)",
  },
  {
    key: "ielts",
    mode: "IELTS",
    label: "IELTS coaching",
    sub: "Quick tip + one practice task.",
    prompt: "Give me one IELTS Speaking Part 2 tip and a short practice task.",
    Icon: GraduationCap,
    accent: "rgba(80,220,160,0.16)",
    ring: "rgba(80,220,160,0.45)",
  },
  {
    key: "pronounce",
    mode: "Pronunciation",
    label: "Pronunciation help",
    sub: "Tricky sounds for Khmer speakers.",
    prompt:
      "Give me 3 English sounds that are tricky for Khmer speakers, with a tip for each.",
    Icon: ScrollText,
    accent: "rgba(120,180,255,0.16)",
    ring: "rgba(120,180,255,0.45)",
  },
];

const VOICE_UNSUPPORTED_MSG =
  "Voice input is not available on this device. Please type your question.";

const WALLET_RETRY_MSG =
  "We could not check your points yet. Please retry, or sign in again if this continues.";

/* ──────────────────  HELPERS  ─────────────────────────────────────────── */
function prepareBotText(text = "") {
  return String(text)
    .replace(/<\s*\/?\s*(script|iframe|object|embed|link|meta)\b[^>]*>/gi, "")
    .replace(/\u0000/g, "");
}

function initials(name = "") {
  const p = String(name).trim().split(/\s+/);
  if (!p.length) return "ME";
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

function pickGreeting(firstName) {
  const safe = String(firstName || "friend").replace(/[*_`<>]/g, "");
  const h = new Date().getHours();
  let when = "Hi";
  if (h < 5) when = "You're up late";
  else if (h < 12) when = "Good morning";
  else if (h < 17) when = "Good afternoon";
  else if (h < 21) when = "Good evening";
  else when = "Hi";
  return `${when}, ${safe}`;
}

/* ──────────────────  BUBBLES  ─────────────────────────────────────────── */
const BotBubble = memo(function BotBubble({ text, animate, redirect, reduced }) {
  const prepared = useMemo(() => prepareBotText(text || ""), [text]);
  const enter = bubbleEnter(reduced || !animate);
  return (
    <motion.div
      initial={enter.initial}
      animate={enter.animate}
      transition={enter.transition}
      className={`ai-msg-bot ${redirect ? "ai-msg-bot--redirect" : ""} self-start max-w-[92%] sm:max-w-[60ch] rounded-2xl rounded-bl-sm px-4 py-3 text-[0.93rem] leading-relaxed border`}
      data-testid={redirect ? "ai-coach-redirect-bubble" : "ai-coach-bubble"}
    >
      <div className="ai-msg-bot__label flex items-center gap-2 mb-1.5 text-[10px] uppercase tracking-[0.18em] font-bold">
        {redirect ? <GraduationCap className="w-3 h-3" /> : <Bot className="w-3 h-3" />}
        {redirect ? "EduTalk redirect" : "Coach"}
      </div>
      <div className="ai-coach-bubble">
        <Markdown
          options={{
            disableParsingRawHTML: true,
            forceBlock: true,
            overrides: {
              script: { component: () => null },
              iframe: { component: () => null },
              object: { component: () => null },
              embed: { component: () => null },
              link: { component: () => null },
              pre: { props: { className: "ai-coach-pre" } },
            },
          }}
        >
          {prepared}
        </Markdown>
      </div>
    </motion.div>
  );
});

const UserBubble = memo(function UserBubble({ text, name, reduced }) {
  const enter = bubbleEnter(reduced);
  return (
    <motion.div
      initial={enter.initial}
      animate={enter.animate}
      transition={enter.transition}
      className="ai-msg-user self-end max-w-[92%] sm:max-w-[46ch] rounded-2xl rounded-br-sm px-4 py-3 text-[0.93rem] leading-relaxed"
      data-testid="ai-coach-user-bubble"
    >
      <div className="ai-msg-user__label text-[10px] uppercase tracking-[0.18em] font-bold mb-1.5">
        {name || "You"}
      </div>
      <div className="whitespace-pre-wrap break-words">{text}</div>
    </motion.div>
  );
});

function TypingDots({ reduced }) {
  const enter = bubbleEnter(reduced);
  return (
    <motion.div
      initial={enter.initial}
      animate={enter.animate}
      transition={enter.transition}
      className="ai-msg-typing self-start inline-flex items-center gap-1.5 rounded-2xl rounded-bl-sm px-4 py-3 border"
      data-testid="ai-coach-typing"
    >
      <Bot className="ai-msg-typing__icon w-3.5 h-3.5" />
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="ai-msg-typing__dot w-1.5 h-1.5 rounded-full"
            style={{
              animation: "aiCoachBounce 1.2s ease-in-out infinite",
              animationDelay: `${i * 0.18}s`,
            }}
          />
        ))}
      </span>
      <span className="text-[10px] uppercase tracking-[0.16em] font-semibold ml-1 opacity-70">
        coaching
      </span>
    </motion.div>
  );
}

/* ──────────────────  VOICE INPUT (Web Speech API)  ────────────────────── */
function useSpeechRecognition({ onTranscript }) {
  const recogRef = useRef(null);
  // Synchronous initial detection (no effect needed for SR support check).
  const [supported] = useState(() => {
    if (typeof window === "undefined") return false;
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  });
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");

  const start = useCallback(() => {
    if (typeof window === "undefined") return;
    const SR =
      window.SpeechRecognition || window.webkitSpeechRecognition || null;
    if (!SR) {
      setError(VOICE_UNSUPPORTED_MSG);
      return;
    }
    try {
      const r = new SR();
      r.lang = "en-US";
      r.interimResults = true;
      r.continuous = false;
      r.maxAlternatives = 1;
      r.onstart = () => {
        setListening(true);
        setError("");
      };
      r.onerror = (e) => {
        const code = (e && e.error) || "";
        if (code === "not-allowed" || code === "service-not-allowed") {
          setError(
            "Microphone permission is blocked. Please allow microphone access and try again.",
          );
        } else if (code === "no-speech") {
          setError("I didn't hear anything. Please try again.");
        } else if (code === "network") {
          setError("Voice service is offline. Please type instead.");
        } else if (code) {
          setError("Voice input could not start. Please type instead.");
        }
        setListening(false);
      };
      r.onend = () => setListening(false);
      r.onresult = (event) => {
        let finalText = "";
        for (let i = 0; i < event.results.length; i++) {
          finalText += event.results[i][0].transcript;
        }
        if (typeof onTranscript === "function") onTranscript(finalText);
      };
      recogRef.current = r;
      r.start();
    } catch {
      setError("Voice input could not start. Please type instead.");
      setListening(false);
    }
  }, [onTranscript]);

  const stop = useCallback(() => {
    try {
      if (recogRef.current) recogRef.current.stop();
    } catch {
      /* ignore */
    }
    setListening(false);
  }, []);

  return { supported, listening, error, start, stop };
}

/* ──────────────────  MAIN PAGE  ───────────────────────────────────────── */
function FreeChatPanel({ onActiveChange }) {
  const { student, isAuthenticated, isBootstrapping } = useAuth();
  const reducedMotion = useReducedMotion();

  const sid = student?.studentId || "";
  const pwd = student?.password || student?.portalData?.Password || "";
  const firstName =
    (student?.name || sid || "friend").split(/\s+/)[0] || "friend";

  // ── Config (real backend) ─────────────────────────────────────────
  const [config, setConfig] = useState({
    enabled: true,
    cost_points: 5,
    voice_input_enabled: true,
    modes: DEFAULT_MODES,
    suggestions: DEFAULT_SUGGESTIONS,
    provider_ready: true,
  });
  const [configLoaded, setConfigLoaded] = useState(false);
  const [configError, setConfigError] = useState("");

  const reloadConfig = useCallback(async () => {
    setConfigError("");
    try {
      const r = await getAssistantConfig();
      if (r && r.config) setConfig((prev) => ({ ...prev, ...r.config }));
      setConfigLoaded(true);
      return true;
    } catch (e) {
      // Don't show this as a scary chat error — degrade to defaults.
      setConfigError(
        e?.data?.detail ||
          e?.message ||
          "Could not load coach settings right now.",
      );
      setConfigLoaded(true);
      return false;
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line 
    if (!isBootstrapping) reloadConfig();
  }, [isBootstrapping, reloadConfig]);

  // ── Chat state ────────────────────────────────────────────────────
  const [mode, setMode] = useState("General");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [walletNotice, setWalletNotice] = useState(""); // shown UNDER input

  const taRef = useRef(null);
  const scrollRef = useRef(null);
  const abortRef = useRef(null);
  const historyRef = useRef([]);
  const lastQueryRef = useRef("");

  // ── Keyboard-open root-cause fix ──────────────────────────────────
  // Prevents iOS Safari's native "scroll the document to reveal the
  // focused input" behavior while the composer textarea has focus —
  // that auto-scroll (not this page's own dvh-based sizing) is what
  // was dragging the fixed Header and MobileBottomNav upward along
  // with the rest of the page. See useKeyboardBodyLock.js.
  useKeyboardBodyLock(taRef);

  // ── Intelligent auto-scroll ──────────────────────────────────────
  // Tracks whether the user is already near the bottom of the scroll
  // region, read by the auto-scroll effect below. Pure DOM/scroll-
  // position bookkeeping — no chat state, no business logic. A ref
  // (not state) because scroll position changes far more often than
  // React should re-render for.
  const isNearBottomRef = useRef(true);

  const hasChat = messages.length > 0;

  // ── Report "a real conversation is under way" to the shell ─────────
  // Purely a UI signal (whether to keep showing the header's meta line)
  // — no chat/business state is lifted or duplicated, the parent just
  // gets told when to stop mounting <AssistantPersonalHero/>.
  useEffect(() => {
    onActiveChange?.(hasChat);
  }, [hasChat, onActiveChange]);

  // ── Track scroll position so auto-scroll never fights the reader ──
  // "Near bottom" uses a generous threshold (120px) so it still counts
  // as "following along" even mid-momentum-scroll on mobile.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const NEAR_BOTTOM_PX = 120;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      isNearBottomRef.current = distance < NEAR_BOTTOM_PX;
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // ── Auto-scroll — intelligent: only follows the conversation while
  // the reader is already at (or returns to) the bottom. If they've
  // scrolled up to reread something, new messages / the typing
  // indicator arriving never yanks them back down. ─────────────────
  useEffect(() => {
    if (!hasChat) return;
    const el = scrollRef.current;
    if (!el) return;
    if (!isNearBottomRef.current) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [messages, busy, hasChat, reducedMotion]);

  // ── Auto-grow textarea ────────────────────────────────────────────
  const onInput = useCallback((e) => {
    setInput(e.target.value);
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
  }, []);

  // ── Voice input ───────────────────────────────────────────────────
  const speech = useSpeechRecognition({
    onTranscript: (t) => {
      setInput(t);
      const ta = taRef.current;
      if (ta) {
        ta.style.height = "auto";
        ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
      }
    },
  });

  // ── Wallet hydration helper ───────────────────────────────────────
  // Cost > 0 + missing password = race window after page reload.
  // We show a calm pill, never a scary chat bubble.
  const cost = Number(config.cost_points || 0);
  const needsWalletPw = cost > 0 && isAuthenticated && !pwd;

  // ── Send a message ────────────────────────────────────────────────
  const send = useCallback(
    async (raw, opts = {}) => {
      const msg = (raw ?? input).trim();
      if (!msg || busy) return;
      if (!isAuthenticated) {
        setError("Please sign in to chat with the coach.");
        return;
      }
      if (needsWalletPw && !opts.allowMissingPw) {
        setWalletNotice(
          "Refreshing your wallet… please try again in a moment.",
        );
        return;
      }

      lastQueryRef.current = msg;
      setError("");
      setWalletNotice("");
      setInput("");
      if (taRef.current) taRef.current.style.height = "auto";

      setMessages((m) => [
        ...m,
        { role: "user", text: msg, mode: opts.mode || mode },
      ]);
      historyRef.current.push({ role: "user", content: msg });

      setBusy(true);
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const data = await postAssistantChat(
          {
            message: msg,
            mode: opts.mode || mode,
            history: historyRef.current.slice(-10),
            password: pwd,
          },
          { signal: controller.signal },
        );

        if (controller.signal.aborted) return;

        if (data && data.success && data.reply) {
          historyRef.current.push({
            role: "assistant",
            content: data.reply,
          });
          setMessages((m) => [
            ...m,
            {
              role: "bot",
              text: data.reply,
              animate: true,
              redirect: !!data.redirect_to_edutalk,
            },
          ]);
        } else {
          // Backend-level soft failures — keep them out of the chat history.
          const reason = data?.reason || "";
          if (reason === "missing_password" || reason === "wallet_unavailable") {
            setWalletNotice(WALLET_RETRY_MSG);
          } else if (reason === "insufficient_points") {
            setError(
              data?.message ||
                "You need more points to ask the coach. Please top up.",
            );
          } else {
            setError(
              data?.message ||
                "The coach couldn't respond. Please try again.",
            );
          }
        }
      } catch (e) {
        if (e && e.name === "AbortError") return;
        const apiMsg = e?.data?.message || e?.data?.detail;
        const reason = e?.data?.reason;
        if (reason === "missing_password" || reason === "wallet_unavailable") {
          setWalletNotice(WALLET_RETRY_MSG);
        } else {
          setError(apiMsg || "Network hiccup — tap retry to try again.");
        }
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, input, isAuthenticated, mode, needsWalletPw, pwd],
  );

  const onKeyDown = useCallback(
    (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
    [send],
  );

  const stop = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = null;
    setBusy(false);
  }, []);

  const retry = useCallback(() => {
    setError("");
    if (lastQueryRef.current) send(lastQueryRef.current);
  }, [send]);

  const retryWallet = useCallback(() => {
    setWalletNotice("");
    if (lastQueryRef.current) send(lastQueryRef.current);
  }, [send]);

  const runStarter = useCallback(
    (card) => {
      setMode(card.mode);
      send(card.prompt, { mode: card.mode });
    },
    [send],
  );

  // ── Derived flags ─────────────────────────────────────────────────
  const featureDisabled = configLoaded && config.enabled === false;
  const voiceAvailable =
    speech.supported && (config.voice_input_enabled ?? true);
  const providerReady = configLoaded ? !!config.provider_ready : true;
  const visibleModes =
    config.modes && config.modes.length ? config.modes : DEFAULT_MODES;

  /* ─────────────────────────  RENDER  ──────────────────────────────── */
  // v4 — Layout Architecture rebuild. Two regions only, both normal flex
  // children of this panel (which itself fills 100% of the shell's
  // .ai-shell-body slot): a scrollable conversation region (banners,
  // mode chips, landing/messages — everything that isn't the composer)
  // and the composer, now a plain flex child instead of position:fixed.
  // `scrollRef` moves to the actual scrolling element so the existing
  // auto-scroll-to-bottom effect keeps working unmodified.
  return (
    <div className="h-full flex flex-col max-w-[680px] mx-auto w-full" data-testid="ai-assistant-page">
      <div ref={scrollRef} className="ai-shell-scroll flex-1 min-h-0">
        {/* Bootstrapping calm state */}
        {isBootstrapping && (
          <div
            className="ai-banner ai-banner--muted px-3 py-2 text-[12px] mb-3 flex items-center gap-2"
            data-testid="ai-coach-bootstrapping"
          >
            <span
              className="ai-spinner-dot w-3 h-3 rounded-full border-2 inline-block"
              style={{ animation: "aiCoachSpin 0.9s linear infinite" }}
            />
            Getting your coach ready…
          </div>
        )}

        {/* AI Assistant paused — premium disabled card */}
        {featureDisabled && <PausedStateCard variant="ai" />}

        {/* Provider not ready */}
        {!isBootstrapping && configLoaded && !providerReady && (
          <div
            className="ai-banner ai-banner--warning px-3.5 py-2.5 text-[12.5px] mb-3 flex items-start gap-2"
            data-testid="ai-coach-provider-warn"
          >
            <AlertCircle className="w-3.5 h-3.5 mt-0.5" />
            <span>
              The AI is being set up by your teacher. Please check back in a few
              minutes.
            </span>
          </div>
        )}

        {/* Config error (non-fatal) */}
        {configError && (
          <div
            className="ai-banner ai-banner--warning px-3.5 py-2 text-[12px] mb-3 flex items-center gap-2"
            data-testid="ai-coach-config-error"
          >
            <span>{configError}</span>
            <button
              onClick={reloadConfig}
              data-testid="ai-coach-config-retry"
              className="ai-banner__action ml-auto"
            >
              <RefreshCw className="w-3 h-3" /> Retry
            </button>
          </div>
        )}

        {/* ── LANDING (no chat yet) — the ONLY place mode chips and the
            starter-prompt tiles appear. Once a real message is sent,
            both disappear forever (this whole block is conditional on
            !hasChat) — the conversation begins almost immediately under
            the header with nothing left above it to scroll past.
            Vertically centered in whatever space is left, never a
            top-aligned block with dead space below it. ─────────────── */}
        <AnimatePresence initial={false}>
          {!hasChat && !busy && (
            <motion.div
              key="landing"
              initial={false}
              exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
              transition={{ duration: reducedMotion ? 0 : DURATION, ease: EASE }}
              className="ai-shell-landing"
            >
              <div
                className="flex gap-1.5 overflow-x-auto pb-1.5 mb-2 no-scrollbar"
                data-testid="ai-coach-modes"
              >
                {visibleModes.map((m) => {
                  const active = mode === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      data-testid={`ai-coach-mode-${m.toLowerCase()}`}
                      aria-pressed={active}
                      className={`shrink-0 text-[11.5px] font-bold uppercase tracking-wider px-3 py-1.5 rounded-full transition-all border ${active ? "ai-chip-active" : ""}`}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>

              {/* Three suggested prompts only — this used to be six
                  illustrated tiles PLUS a separate row of up to four more
                  suggestion chips, two overlapping ways to offer the same
                  kind of canned prompt. One calm set of three is enough. */}
              <ChatLanding
                firstName={firstName}
                cards={STARTER_CARDS.slice(0, 3)}
                disabled={featureDisabled || !providerReady}
                onPick={runStarter}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── CHAT (one or more messages) — bubbles render directly in
            this scroll region; no separate floating card wrapper. The
            typing indicator is the last item in the same message list,
            so it appears exactly where the next reply will land. ──── */}
        <AnimatePresence initial={false}>
          {(hasChat || busy) && (
            <motion.div
              key="chat"
              initial={reducedMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reducedMotion ? 0 : DURATION, ease: EASE }}
              className="ai-convo"
              data-testid="ai-coach-chat-box"
            >
              <div
                className="flex flex-col gap-2.5"
                role="log"
                aria-live="polite"
                aria-relevant="additions"
                aria-label="Conversation with your English coach"
              >
                {messages.map((m, i) =>
                  m.role === "bot" ? (
                    <BotBubble
                      key={i}
                      text={m.text}
                      animate={m.animate}
                      redirect={m.redirect}
                      reduced={reducedMotion}
                    />
                  ) : (
                    <UserBubble
                      key={i}
                      text={m.text}
                      name={firstName}
                      reduced={reducedMotion}
                    />
                  ),
                )}
                {busy && <TypingDots reduced={reducedMotion} />}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Inline error (NOT in chat history) */}
        {error && (
          <motion.div
            initial={reducedMotion ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reducedMotion ? 0 : DURATION, ease: EASE }}
            className="ai-banner ai-banner--danger mt-2 px-3 py-2 text-[12.5px] flex items-center gap-2"
            data-testid="ai-coach-error"
          >
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button
              onClick={retry}
              data-testid="ai-coach-retry-btn"
              className="ai-banner__action text-[11px]"
            >
              <RefreshCw className="w-3 h-3" /> Retry
            </button>
          </motion.div>
        )}

        {/* Wallet notice — calm, NEVER appears as a chat bubble */}
        {walletNotice && (
          <motion.div
            initial={reducedMotion ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reducedMotion ? 0 : DURATION, ease: EASE }}
            className="ai-banner ai-banner--warning mt-2 px-3 py-2 text-[12.5px] flex items-center gap-2"
            data-testid="ai-coach-wallet-notice"
          >
            <Coins className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1">{walletNotice}</span>
            <button
              onClick={retryWallet}
              data-testid="ai-coach-wallet-retry"
              className="ai-banner__action text-[11px]"
            >
              <RefreshCw className="w-3 h-3" /> Retry
            </button>
          </motion.div>
        )}

        {/* Voice unsupported fallback */}
        {configLoaded && !voiceAvailable && (
          <p
            className="mt-2 text-[11px] text-center opacity-60"
            data-testid="ai-coach-voice-fallback"
          >
            {speech.supported
              ? "Voice input has been disabled by your teacher. Please type your question."
              : VOICE_UNSUPPORTED_MSG}
          </p>
        )}
      </div>

      {/* ── COMPOSER — a normal flex child now, not position:fixed.
          Naturally attached to the bottom of the shell, which itself
          tracks the dynamic viewport (see .ai-shell-v2 in the CSS). ── */}
      <div className="ai-shell-composer">
        <StickyComposer
          taRef={taRef}
          value={input}
          onInput={onInput}
          onKeyDown={onKeyDown}
          placeholder={
            featureDisabled
              ? "Coach is paused…"
              : busy
                ? "Coach is thinking…"
                : speech.listening
                  ? "Listening… speak now"
                  : isBootstrapping
                    ? "Getting ready…"
                    : "Ask the English coach…"
          }
          disabled={busy}
          studentName={student?.name || sid}
          voiceAvailable={voiceAvailable}
          listening={speech.listening}
          onMicStart={speech.start}
          onMicStop={speech.stop}
          busy={busy}
          onSend={() => send()}
          onStop={stop}
          sendDisabled={
            !input.trim() ||
            featureDisabled ||
            !providerReady ||
            isBootstrapping
          }
          needsWalletPw={needsWalletPw}
          featureDisabled={featureDisabled}
        />

        {/* Voice error hint */}
        {speech.error && (
          <p
            className="ai-badge-danger mt-1.5 text-[11px] text-center rounded-lg py-1 px-2"
            data-testid="ai-coach-voice-error"
          >
            {speech.error}
          </p>
        )}

        {/* Desktop-only keyboard hint */}
        <p
          className="hidden sm:block mt-2 text-[10.5px] text-center font-mono opacity-45"
          data-testid="ai-coach-kbd-hint"
        >
          Press{" "}
          <kbd className="px-1.5 py-px rounded border" style={{ borderColor: "var(--ai-border)", background: "var(--ai-surface-2)" }}>
            Enter
          </kbd>{" "}
          to send ·{" "}
          <kbd className="px-1.5 py-px rounded border" style={{ borderColor: "var(--ai-border)", background: "var(--ai-surface-2)" }}>
            Shift+Enter
          </kbd>{" "}
          for newline · points charged only after a successful answer
        </p>
      </div>

      <style>{`
        @keyframes aiCoachBounce {
          0%, 80%, 100% { transform: translateY(0); opacity: .5 }
          40%           { transform: translateY(-6px); opacity: 1 }
        }
        @keyframes aiCoachSpin {
          to { transform: rotate(360deg); }
        }
        @keyframes aiCoachOrb {
          0%, 100% { transform: scale(1); }
          50%      { transform: scale(1.03); }
        }
        @media (prefers-reduced-motion: reduce) {
          .ai-coach-orb-anim { animation: none !important; }
        }
        .ai-coach-bubble li { margin-left: 1.2rem; list-style: disc; padding-left: 0.15rem; }
        .ai-coach-bubble li + li { margin-top: 0.2rem; }
        .ai-coach-bubble p { margin: 0 0 0.6rem; }
        .ai-coach-bubble p:last-child { margin-bottom: 0; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>
    </div>
  );
}

/* ──────────────────  COACH ORB  ───────────────────────────────────────── */
function CoachOrb({ reduced }) {
  return (
    <div
      className="w-11 h-11 grid place-items-center shrink-0 ai-coach-orb-anim"
      style={{ animation: reduced ? "none" : "aiCoachOrb 5s ease-in-out infinite" }}
      aria-hidden="true"
    >
      <CoachOrbSvg size={44} />
    </div>
  );
}


/* ============================================================================
 * EduHub Speech Coach — Voice Missions + Coach Rewards (v1.0.1)
 * ----------------------------------------------------------------------------
 * Real voice recording (MediaRecorder), R2-backed audio storage on the server,
 * transcript-based Gemini speech feedback, retry-required mission flow, and
 * backend-verified Coach Rewards credited via the existing MongoDB wallet path
 * (wallet_service.WalletService.credit). NO GAS / sendPoints path is used.
 * NO unsupported ESLint rule comments are present in this file.
 *
 * The default export (`Assistant`) wraps two tabs:
 *   • "Speech Missions" (default) — the Speech Coach experience below
 *   • "Free Chat"                 — the existing FreeChatPanel preserved
 * ========================================================================== */

const MISSION_MODES = [
  {
    key: "speaking_challenge",
    label: "Speaking Challenge",
    blurb: "Speak openly. Practice ideas, opinions, and natural delivery.",
    Icon: Mic2Icon,
  },
  {
    key: "pronunciation_drill",
    label: "Pronunciation Drill",
    blurb: "Read aloud target sentences. Sharpen your spoken clarity.",
    Icon: Wand2,
  },
  {
    key: "friday_class_prep",
    label: "Friday Class Prep",
    blurb: "Warm up before Friday class. Speak your intro and updates.",
    Icon: Crown,
  },
  {
    key: "sentence_delivery",
    label: "Sentence Delivery Coach",
    blurb: "Deliver one sentence with rhythm, pause, and confidence.",
    Icon: Trophy,
  },
];

// Voice UI state machine values (string literals, no enum) — every state in
// the spec is reachable: idle, recording, stopping, uploading, analyzing,
// feedback_ready, retry_required, reward_eligible, claiming, reward_claimed,
// upload_failed, permission_denied, unsupported.
// v1.1.0 — Filler Word Counter (transcript-text only; no audio analysis).
//
// Mirrors the backend FILLER_WORDS_EN / FILLER_WORDS_KM lists in
// ai_assistant_voice_tools.py. The two lists are kept in sync manually
// since they are tiny and human-curated. The backend remains the source
// of truth for the persisted filler_count on each attempt; this hook is
// only for the LIVE pill the student sees while recording.
const FILLER_WORDS_EN_FE = [
  "um", "uh", "uhm", "umm", "uhh", "erm", "er",
  "ah", "ahh", "hmm", "mhm", "mm",
  "like", "you know", "i mean", "sort of", "kind of",
  "actually", "basically", "literally", "honestly",
  "so", "well", "right", "okay", "ok",
];
const FILLER_WORDS_KM_FE = ["អឺ", "អា", "ចឹង", "ហើយ", "នឹង"];

// Pre-build a word-boundary regex once; longest first so multi-word
// fillers like "you know" / "i mean" are matched before their parts.
const FILLER_RE_EN_FE = new RegExp(
  "\\b(?:" +
    [...FILLER_WORDS_EN_FE]
      .sort((a, b) => b.length - a.length)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|") +
    ")\\b",
  "gi",
);

function countFillersClient(text) {
  if (!text) return 0;
  let total = 0;
  // Reset lastIndex before each call (regex has the `g` flag).
  FILLER_RE_EN_FE.lastIndex = 0;
  total += (text.match(FILLER_RE_EN_FE) || []).length;
  for (const w of FILLER_WORDS_KM_FE) {
    if (!w) continue;
    // Khmer substring count (regex word-boundary is not Khmer-aware).
    let idx = 0;
    while ((idx = text.indexOf(w, idx)) !== -1) {
      total += 1;
      idx += w.length;
    }
  }
  return total;
}

function useFillerCounter(transcript, active) {
  // v1.1.0 — Derive filler count synchronously from the transcript via
  // useMemo. We deliberately AVOID the React 19 lint pattern that broke
  // the v1.0.0 Vercel build (calling setState inside useEffect for a
  // value that can be derived synchronously). When `active` is false
  // (idle / after stop), the count freezes at zero unless the caller
  // renders the last snapshot from the analysis response.
  const count = useMemo(
    () => (active ? countFillersClient(transcript) : 0),
    [transcript, active],
  );
  // `pulse` is just `count` itself — using it as a React key on the
  // animated icon re-triggers the CSS pulse on every new filler word.
  const pulse = count;
  // `reset` is a stable no-op (kept for API compatibility with callers
  // that previously expected an imperative reset). Synchronous derivation
  // means there is no internal state to clear.
  const reset = useCallback(() => {}, []);
  return { count, pulse, reset };
}

function FillerPill({ count, pulse, hint }) {
  const high = count >= 5;
  return (
    <div
      data-testid="speech-filler-pill"
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10.5px] font-bold transition ${
        high ? "ai-badge-danger" : count > 0 ? "ai-badge-gold" : "ai-badge-neutral"
      }`}
      // Re-mount the inner text on each new pulse to retrigger the
      // CSS animation without using transition: all (which can break
      // transform-driven animations elsewhere).
    >
      <Activity className={`w-3 h-3 ${count > 0 ? "ai-coach-pulse" : ""}`} key={`a-${pulse}`} />
      <span data-testid="speech-filler-count">Filler words: {count}</span>
      {hint ? <span className="font-normal opacity-70">· {hint}</span> : null}
    </div>
  );
}

// v1.1.0 — Speech Delivery / Confidence Score header rendered on top of
// the FeedbackCard. Big animated number, score label, delta vs previous
// attempt, breakdown chips, improvement tip. The 0-100 delivery score is
// one continuous signal, so it now reads from a single calm accent
// (--ai-accent-cyan) rather than five distinct rainbow "grade" colours.
function SpeechScoreHeader({
  score,
  scoreLabel,
  scoreDelta,
  breakdown,
  improvementTip,
  wpm,
  fillerCount,
  fillerPct,
  retryBonus,
  prevScore,
  scoreMethod,
}) {
  const animatedScore = useAnimatedNumber(Number(score || 0), 600);
  const hasDelta = scoreDelta !== null && scoreDelta !== undefined && Number.isFinite(Number(scoreDelta));
  const deltaUp = hasDelta && Number(scoreDelta) > 0;
  const deltaDown = hasDelta && Number(scoreDelta) < 0;
  const b = breakdown || {};
  const chips = [
    { k: "pace",       label: "Pace",       val: b.pace },
    { k: "clarity",    label: "Clarity",    val: b.clarity },
    { k: "structure",  label: "Structure",  val: b.structure },
    { k: "confidence", label: "Confidence", val: b.confidence },
  ];
  return (
    <div
      className="ai-speech-card px-3.5 py-3.5 space-y-3"
      data-testid="speech-score-header"
    >
      <div className="flex items-start gap-3.5">
        <div
          className="ai-score-ring relative w-[64px] h-[64px] rounded-2xl grid place-items-center shrink-0"
          aria-label={`Speech Delivery Score ${score} out of 100`}
        >
          <div
            className="ai-score-value text-[26px] font-extrabold tabular-nums leading-none"
            data-testid="speech-score-value"
          >
            {animatedScore}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-[10.5px] uppercase tracking-wider font-bold opacity-60">
              Speech Delivery Score
            </div>
            {hasDelta ? (
              <span
                data-testid="speech-score-delta"
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10.5px] font-bold ${
                  deltaUp ? "ai-badge-success" : deltaDown ? "ai-badge-danger" : "ai-badge-neutral"
                }`}
              >
                {deltaUp ? <TrendingUp className="w-2.5 h-2.5" /> : null}
                {deltaDown ? <TrendingDown className="w-2.5 h-2.5" /> : null}
                {Number(scoreDelta) > 0 ? "+" : ""}
                {Number(scoreDelta)}
                {prevScore !== null && prevScore !== undefined
                  ? ` vs ${prevScore}`
                  : ""}
              </span>
            ) : null}
            {Number(retryBonus) > 0 ? (
              <span
                data-testid="speech-retry-bonus"
                className="ai-badge-accent inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10.5px] font-bold"
              >
                <Sparkles className="w-2.5 h-2.5" /> +{retryBonus} retry bonus
              </span>
            ) : null}
          </div>
          <div className="text-[15px] font-extrabold leading-tight mt-0.5" data-testid="speech-score-label">
            {scoreLabel || "Warming Up"}
          </div>
          <div className="text-[11px] opacity-65 leading-snug mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5">
            <span>
              Pace <span className="font-bold tabular-nums opacity-90">{Number(wpm || 0).toFixed(0)}</span> wpm
            </span>
            <span>
              Filler words <span className="font-bold tabular-nums opacity-90">{fillerCount ?? 0}</span>
              {Number(fillerPct) > 0 ? (
                <span className="opacity-55"> ({Number(fillerPct).toFixed(0)}%)</span>
              ) : null}
            </span>
          </div>
        </div>
      </div>

      {/* Subscore chips — 4 chips, each 0..25 */}
      <div className="grid grid-cols-4 gap-1.5" data-testid="speech-score-breakdown">
        {chips.map((c) => (
          <div
            key={c.k}
            data-testid={`speech-score-chip-${c.k}`}
            className="ai-score-chip rounded-xl px-1.5 py-1.5 text-center"
          >
            <div className="text-[9px] uppercase tracking-wider font-bold opacity-55 leading-none">
              {c.label}
            </div>
            <div className="ai-score-value text-[15px] font-extrabold tabular-nums leading-tight mt-0.5">
              {Number(c.val ?? 0)}
              <span className="opacity-40 text-[10px] font-bold">/25</span>
            </div>
          </div>
        ))}
      </div>

      {/* Improvement tip — Daravuth-style coaching line */}
      {improvementTip ? (
        <div
          className="rounded-xl px-2.5 py-2 text-[11.5px] leading-snug flex items-start gap-2"
          style={{ background: "var(--ai-surface-2)", border: "1px solid var(--ai-border)" }}
          data-testid="speech-improvement-tip"
        >
          <Lightbulb className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--ai-accent-gold)" }} />
          <span>
            <span className="font-bold">Try this:</span> {improvementTip}
          </span>
        </div>
      ) : null}

      <div className="text-[9.5px] opacity-45 leading-snug pt-0.5 border-t" style={{ borderColor: "var(--ai-border)" }}>
        {scoreMethod === "transcript_timing_v1_1_0" || !scoreMethod
          ? "Computed from transcript, pace, structure and filler words. v1.1 does not score phoneme-level pronunciation."
          : `Scoring method: ${scoreMethod}.`}
      </div>
    </div>
  );
}

// Tiny tween-on-mount for the score number (no extra dependency).
function useAnimatedNumber(target, duration) {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    const from = fromRef.current;
    const to = Number(target || 0);
    const start = performance.now();
    let raf = 0;
    const step = (now) => {
      const t = Math.min(1, (now - start) / Math.max(50, duration || 600));
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(from + (to - from) * eased));
      if (t < 1) raf = requestAnimationFrame(step);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

function MissionCard({ mode, onStart, busy }) {
  const Icon = mode.Icon;
  return (
    <button
      type="button"
      onClick={() => onStart(mode.key)}
      disabled={busy}
      data-testid={`speech-mission-card-${mode.key}`}
      className="ai-mission-tile group relative rounded-2xl px-3.5 py-3 text-left transition disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <div className="flex items-start gap-3">
        <div className="ai-mission-tile__icon w-9 h-9 rounded-xl grid place-items-center shrink-0">
          <Icon className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <div className="text-[13.5px] font-bold leading-tight">
            {mode.label}
          </div>
          <div className="text-[11px] opacity-70 leading-snug mt-0.5">
            {mode.blurb}
          </div>
        </div>
        <ArrowRight className="ai-tile__arrow w-4 h-4 transition shrink-0 mt-1" />
      </div>
    </button>
  );
}

function StateBadge({ state }) {
  const map = {
    idle: { label: "Ready", cls: "ai-badge-neutral" },
    recording: { label: "Recording…", cls: "ai-badge-danger ai-coach-pulse" },
    stopping: { label: "Stopping…", cls: "ai-badge-neutral" },
    uploading: { label: "Saving your voice practice…", cls: "ai-badge-accent" },
    analyzing: { label: "Analyzing your speech…", cls: "ai-badge-accent" },
    feedback_ready: { label: "Feedback ready", cls: "ai-badge-success" },
    retry_required: { label: "Retry to improve", cls: "ai-badge-gold" },
    reward_eligible: { label: "Reward unlocked", cls: "ai-badge-success" },
    claiming: { label: "Preparing Coach Reward…", cls: "ai-badge-accent" },
    reward_claimed: { label: "Reward claimed", cls: "ai-badge-success" },
    upload_failed: { label: "Upload failed", cls: "ai-badge-danger" },
    permission_denied: { label: "Microphone blocked", cls: "ai-badge-danger" },
    unsupported: { label: "Recording unsupported", cls: "ai-badge-neutral" },
  };
  const m = map[state] || map.idle;
  return (
    <span
      data-testid={`speech-state-${state}`}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10.5px] font-bold ${m.cls}`}
    >
      {m.label}
    </span>
  );
}

function FeedbackCard({ analysis, scoringEnabled = true }) {
  if (!analysis) return null;
  const feedback = analysis.feedback || null;
  const score = Number(analysis.speech_score || 0);
  const showScore = !!scoringEnabled && (score > 0 || Number.isFinite(score));
  const fillerCount = Number(analysis.filler_count || 0);
  const rows = [
    { k: "what_was_clear", title: "What was clear", icon: <CheckCircle2 className="w-3.5 h-3.5" style={{ color: "var(--ai-accent-lime)" }} /> },
    { k: "corrected_version", title: "Better version", icon: <Wand2 className="w-3.5 h-3.5" style={{ color: "var(--ai-accent-cyan)" }} /> },
    { k: "grammar_tip", title: "Sentence structure fix", icon: <Lightbulb className="w-3.5 h-3.5" style={{ color: "var(--ai-accent-gold)" }} /> },
    { k: "delivery_tip", title: "Delivery / rhythm tip", icon: <Mic2Icon className="w-3.5 h-3.5" style={{ color: "var(--ai-accent-cyan)" }} /> },
    { k: "retry_instruction", title: "Retry challenge", icon: <ArrowRight className="w-3.5 h-3.5" style={{ color: "var(--ai-accent-cyan)" }} /> },
    { k: "confidence_message", title: "Coach's note", icon: <Sparkles className="w-3.5 h-3.5" style={{ color: "var(--ai-accent-lime)" }} /> },
  ];
  return (
    <div className="space-y-3" data-testid="speech-feedback-block">
      {showScore ? (
        <SpeechScoreHeader
          score={score}
          scoreLabel={analysis.score_label}
          scoreDelta={analysis.score_delta}
          breakdown={analysis.score_breakdown}
          improvementTip={analysis.improvement_tip}
          wpm={analysis.wpm}
          fillerCount={fillerCount}
          fillerPct={analysis.filler_pct}
          retryBonus={analysis.retry_bonus_applied}
          prevScore={analysis.prev_score}
          scoreMethod={analysis.score_method}
        />
      ) : null}

      {feedback ? (
        <div
          className="ai-speech-card p-3.5 space-y-2.5"
          data-testid="speech-feedback-card"
        >
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-4 h-4" style={{ color: "var(--ai-accent-cyan)" }} />
            <div className="text-[12.5px] font-bold">
              EduHub Mini-Coach feedback
            </div>
            {fillerCount > 0 ? (
              <span
                className="ai-badge-gold ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold"
                data-testid="speech-feedback-filler-tag"
              >
                <Activity className="w-2.5 h-2.5" />
                {fillerCount} filler{fillerCount === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
          {rows.map((r) =>
            feedback[r.k] ? (
              <div key={r.k} className="flex items-start gap-2">
                <div className="mt-0.5 shrink-0">{r.icon}</div>
                <div className="min-w-0">
                  <div className="text-[10.5px] uppercase tracking-wider opacity-55 font-semibold">
                    {r.title}
                  </div>
                  <div className="text-[12.5px] opacity-85 leading-snug">
                    {feedback[r.k]}
                  </div>
                </div>
              </div>
            ) : null,
          )}
          <div className="text-[10px] opacity-45 leading-snug pt-1 border-t" style={{ borderColor: "var(--ai-border)" }}>
            By EduHub Speech Coach standard. Feedback is from your spoken
            transcript (Web Speech API). v1.1 does not include phoneme-level
            pronunciation scoring or certified pronunciation grading.
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BonusBox({ rewardPoints, modeLabel, onClaim, claiming, claimed, error }) {
  if (claimed) {
    return (
      <div
        className="ai-reward-box ai-reward-box--claimed px-3.5 py-3 flex items-center gap-3"
        data-testid="speech-reward-claimed"
      >
        <Award className="w-6 h-6 shrink-0" style={{ color: "var(--ai-accent-lime)" }} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-bold leading-tight" style={{ color: "var(--ai-accent-lime)" }}>
            +{rewardPoints} points credited!
          </div>
          <div className="text-[11px] opacity-70 leading-snug">
            Great work on {modeLabel}. Keep practicing.
          </div>
        </div>
      </div>
    );
  }
  return (
    <div
      className="ai-reward-box px-3.5 py-3 flex items-center gap-3"
      data-testid="speech-bonus-box"
    >
      <Gift className="w-6 h-6 shrink-0" style={{ color: "var(--ai-accent-gold)" }} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-bold leading-tight" style={{ color: "var(--ai-accent-gold)" }}>
          Coach Reward unlocked: +{rewardPoints} pts
        </div>
        <div className="text-[11px] opacity-70 leading-snug">
          Verified by your coach. Tap claim to add it to your wallet.
        </div>
        {error ? (
          <div className="text-[10.5px] mt-1" style={{ color: "var(--ai-accent-coral)" }} data-testid="speech-claim-error">
            {error}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onClaim}
        disabled={claiming}
        data-testid="speech-claim-reward-btn"
        className="ai-reward-claim-btn px-3 py-2 rounded-xl font-bold text-[12px] inline-flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed shrink-0"
      >
        {claiming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trophy className="w-3.5 h-3.5" />}
        {claiming ? "Claiming…" : "Claim"}
      </button>
    </div>
  );
}

function ProgressDots({ done, total }) {
  const dots = [];
  for (let i = 0; i < Math.max(1, total); i += 1) {
    const filled = i < done;
    dots.push(
      <span
        key={i}
        className={`w-2 h-2 rounded-full ${filled ? "ai-dot-filled" : "ai-dot-empty"}`}
      />,
    );
  }
  return (
    <div className="inline-flex items-center gap-1.5" data-testid="speech-progress-dots">
      {dots}
    </div>
  );
}

function useMediaRecorderState() {
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const startedAtRef = useRef(0);
  const stop = useCallback(() => {
    try {
      const rec = recorderRef.current;
      if (rec && rec.state === "recording") rec.stop();
    } catch {
      /* ignore */
    }
    try {
      const s = streamRef.current;
      if (s) s.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    streamRef.current = null;
  }, []);
  useEffect(() => () => stop(), [stop]);
  return { recorderRef, streamRef, chunksRef, startedAtRef, stop };
}

function useBrowserTranscript() {
  // Light wrapper around the Web Speech API focused on the Speech Coach.
  const recRef = useRef(null);
  const finalRef = useRef("");
  const interimRef = useRef("");
  const [transcript, setTranscript] = useState("");
  const [active, setActive] = useState(false);
  const supported = useMemo(() => {
    if (typeof window === "undefined") return false;
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }, []);
  const start = useCallback(() => {
    if (!supported) return;
    try {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      const r = new SR();
      r.continuous = true;
      r.interimResults = true;
      r.lang = "en-US";
      finalRef.current = "";
      interimRef.current = "";
      r.onresult = (ev) => {
        let finalT = "";
        let interimT = "";
        for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
          const seg = ev.results[i];
          if (seg.isFinal) finalT += seg[0].transcript;
          else interimT += seg[0].transcript;
        }
        finalRef.current = (finalRef.current + " " + finalT).replace(/\s+/g, " ").trim();
        interimRef.current = interimT;
        setTranscript((finalRef.current + " " + interimT).trim());
      };
      r.onerror = () => { /* swallow — recording still continues */ };
      r.onend = () => { setActive(false); };
      r.start();
      recRef.current = r;
      setActive(true);
    } catch {
      /* ignore */
    }
  }, [supported]);
  const stop = useCallback(() => {
    try { if (recRef.current) recRef.current.stop(); } catch { /* ignore */ }
    recRef.current = null;
    setActive(false);
  }, []);
  const reset = useCallback(() => {
    finalRef.current = "";
    interimRef.current = "";
    setTranscript("");
  }, []);
  return { transcript, active, supported, start, stop, reset };
}

function SpeechCoachPanel({ onSwitchToChat }) {
  const { isAuthenticated, isBootstrapping } = useAuth();
  const reducedMotion = useReducedMotion();

  // ── public config ─────────────────────────────────────────────────
  const [cfg, setCfg] = useState(null);
  const [cfgLoaded, setCfgLoaded] = useState(false);
  const [cfgError, setCfgError] = useState("");
  const loadCfg = useCallback(async () => {
    setCfgError("");
    try {
      const r = await getVoiceConfig();
      setCfg(r?.config || null);
    } catch (e) {
      setCfgError(e?.message || "Could not load Speech Coach config.");
    } finally {
      setCfgLoaded(true);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line
    if (!isBootstrapping) loadCfg();
  }, [isBootstrapping, loadCfg]);

  const missionsEnabled = !!cfg?.missions_enabled;
  const rewardsCfg = cfg?.rewards || {};
  const points = rewardsCfg.points || {};
  const dailyCap = Number(rewardsCfg.daily_cap_pts || 0);
  const weeklyCap = Number(rewardsCfg.weekly_cap_pts || 0);
  const vp = cfg?.voice_practice || {};
  const maxDuration = Math.max(5, Number(vp.max_duration_seconds || 30));
  const r2Available = !!vp.r2_available;
  const recordingEnabled = !!vp.real_recording_enabled;

  // ── mission state ─────────────────────────────────────────────────
  const [activeMode, setActiveMode] = useState(null);
  const [mission, setMission] = useState(null);
  const [missionError, setMissionError] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [rewardStatus, setRewardStatus] = useState(null);
  const [voiceState, setVoiceState] = useState("idle");
  const [permissionError, setPermissionError] = useState("");
  const [recordTimer, setRecordTimer] = useState(0);
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [claimError, setClaimError] = useState("");

  const visibleModes = useMemo(() => {
    if (!cfg) return MISSION_MODES;
    const enabledByMode = cfg?.mode_enabled || {};
    return MISSION_MODES.filter((m) => enabledByMode[m.key] !== false);
  }, [cfg]);

  // ── recording machinery ───────────────────────────────────────────
  const { recorderRef, streamRef, chunksRef, startedAtRef, stop: forceStop } = useMediaRecorderState();
  const safeMime = useMemo(() => pickSafeMimeType(), []);
  const speech = useBrowserTranscript();
  // v1.1.0 — live filler counter driven by the same Web Speech transcript.
  const fillerLive = useFillerCounter(speech.transcript, voiceState === "recording");
  const timerRef = useRef(null);
  const scoringEnabled = !!(cfg?.scoring?.enabled !== false && cfg?.scoring?.show_to_student !== false);

  const recordingSupported = !!safeMime && recordingEnabled;

  useEffect(() => {
    if (voiceState !== "recording") {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return undefined;
    }
    timerRef.current = window.setInterval(() => {
      const ms = Date.now() - startedAtRef.current;
      const secs = Math.floor(ms / 1000);
      setRecordTimer(secs);
      if (secs >= maxDuration) {
        // Auto-stop on max duration
        try {
          if (recorderRef.current && recorderRef.current.state === "recording") {
            recorderRef.current.stop();
          }
        } catch { /* ignore */ }
      }
    }, 200);
    return () => {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [voiceState, maxDuration, recorderRef, startedAtRef]);

  const resetMission = useCallback(() => {
    forceStop();
    speech.stop();
    speech.reset();
    fillerLive.reset();
    setMission(null);
    setMissionError("");
    setAnalysis(null);
    setRewardStatus(null);
    setVoiceState("idle");
    setPermissionError("");
    setRecordTimer(0);
    setClaiming(false);
    setClaimed(false);
    setClaimError("");
    setActiveMode(null);
  }, [forceStop, speech, fillerLive]);

  const startMission = useCallback(async (modeKey) => {
    setMissionError("");
    setPermissionError("");
    setAnalysis(null);
    setRewardStatus(null);
    setClaimed(false);
    setClaimError("");
    setActiveMode(modeKey);
    try {
      const r = await apiStartMission({ mode: modeKey });
      setMission(r);
      setVoiceState("idle");
    } catch (e) {
      setMissionError(e?.data?.detail || e?.message || "Could not start mission.");
      setActiveMode(null);
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (!recordingSupported || !mission) return;
    setPermissionError("");
    speech.reset();
    fillerLive.reset();
    chunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new window.MediaRecorder(stream, { mimeType: safeMime.mimeType });
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      rec.onstop = async () => {
        const durationSeconds = Math.max(0, (Date.now() - startedAtRef.current) / 1000);
        try { if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop()); }
        catch { /* ignore */ }
        streamRef.current = null;
        speech.stop();
        const blob = new Blob(chunksRef.current, { type: safeMime.mimeType });
        setVoiceState("uploading");
        try {
          await apiUploadAttempt({
            missionId: mission.mission_id,
            audioBlob: blob,
            transcript: speech.transcript || "",
            durationSeconds,
            filename: `attempt.${safeMime.extension}`,
          });
        } catch (e) {
          setVoiceState("upload_failed");
          setMissionError(e?.data?.detail || e?.message || "Upload failed. Please try again.");
          return;
        }
        setVoiceState("analyzing");
        try {
          const r = await apiAnalyzeAttempt({ missionId: mission.mission_id });
          setAnalysis(r);
          if (r?.reward_eligible) {
            setVoiceState("reward_eligible");
            try {
              const s = await apiGetRewardStatus(mission.mission_id);
              setRewardStatus(s);
            } catch { /* ignore */ }
          } else if (r?.retry_required) {
            setVoiceState("retry_required");
          } else {
            setVoiceState("feedback_ready");
          }
        } catch (e) {
          setVoiceState("feedback_ready");
          setMissionError(e?.data?.detail || e?.message || "Analysis failed.");
        }
      };
      startedAtRef.current = Date.now();
      setRecordTimer(0);
      recorderRef.current = rec;
      rec.start();
      speech.start();
      setVoiceState("recording");
    } catch (e) {
      const name = e?.name || "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setVoiceState("permission_denied");
        setPermissionError("Microphone access was denied. Please allow it and try again.");
      } else {
        setVoiceState("idle");
        setPermissionError(e?.message || "Could not start recording.");
      }
    }
  }, [recordingSupported, mission, safeMime, speech, fillerLive, recorderRef, streamRef, chunksRef, startedAtRef]);

  const stopRecording = useCallback(() => {
    if (voiceState !== "recording") return;
    setVoiceState("stopping");
    try {
      if (recorderRef.current && recorderRef.current.state === "recording") {
        recorderRef.current.stop();
      }
    } catch { /* ignore */ }
  }, [voiceState, recorderRef]);

  const claim = useCallback(async () => {
    if (!mission || claiming || claimed) return;
    setClaiming(true);
    setVoiceState("claiming");
    setClaimError("");
    try {
      const r = await apiClaimReward({ missionId: mission.mission_id });
      if (r?.credited) {
        setClaimed(true);
        setVoiceState("reward_claimed");
      } else {
        setClaimError("Reward could not be credited. Please try again.");
        setVoiceState("reward_eligible");
      }
    } catch (e) {
      const detail = e?.data?.detail || e?.code;
      if (detail === "reward_credit_unavailable") {
        setClaimError("Reward credit is temporarily unavailable. Please try again later.");
      } else {
        setClaimError(detail || e?.message || "Reward claim failed.");
      }
      setVoiceState("reward_eligible");
    } finally {
      setClaiming(false);
    }
  }, [mission, claiming, claimed]);

  const modeLabel = useMemo(() => {
    if (!activeMode) return "";
    const m = MISSION_MODES.find((x) => x.key === activeMode);
    return m ? m.label : "";
  }, [activeMode]);

  const attemptsDone = Number(analysis?.attempts_completed || mission?.attempts_required ? analysis?.attempts_completed || 0 : 0);
  const attemptsReq = Number(mission?.attempts_required || analysis?.attempts_required || 2);

  if (isBootstrapping || !cfgLoaded) {
    return (
      <div
        className="ai-speech-card px-3 py-4 text-[12.5px] opacity-80 flex items-center gap-2"
        data-testid="speech-coach-bootstrapping"
      >
        <Loader2 className="w-4 h-4 animate-spin" style={{ color: "var(--ai-accent-cyan)" }} />
        Getting your Speech Coach ready…
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div
        className="ai-banner ai-banner--danger px-3.5 py-3 text-[12.5px]"
        data-testid="speech-coach-signed-out"
      >
        Please sign in to start your Speech Missions.
      </div>
    );
  }

  if (cfgError) {
    return (
      <div
        className="ai-banner ai-banner--danger px-3.5 py-3 text-[12.5px]"
        data-testid="speech-coach-cfg-error"
      >
        {cfgError}
      </div>
    );
  }

  if (!missionsEnabled) {
    return (
      <PausedStateCard variant="missions" onSwitchToChat={onSwitchToChat} />
    );
  }

  return (
    <div className="space-y-3" data-testid="speech-coach-panel">
      {/* Privacy notice */}
      <div
        className="ai-speech-card px-3 py-2 text-[10.5px] opacity-70 flex items-start gap-1.5"
        data-testid="speech-privacy-notice"
      >
        <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--ai-accent-cyan)" }} />
        Your voice recording is saved only for AI feedback, learning progress, and teacher review.
      </div>

      {/* Practice Passport — compact rewards stats */}
      <div
        className="ai-speech-card px-3 py-2 flex items-center gap-3 text-[10.5px] opacity-80"
        data-testid="speech-practice-passport"
      >
        <Crown className="w-4 h-4" style={{ color: "var(--ai-accent-gold)" }} />
        <div className="flex-1 min-w-0">
          <div className="font-bold opacity-90">Practice Passport</div>
          <div className="leading-snug">
            Daily cap: <span className="font-bold" style={{ color: "var(--ai-accent-gold)" }}>{dailyCap}</span> pts ·
            Weekly cap: <span className="font-bold" style={{ color: "var(--ai-accent-gold)" }}>{weeklyCap}</span> pts ·
            Retry-required mission
          </div>
        </div>
      </div>

      {/* No active mission → show mission picker */}
      {!mission && (
        <div className="space-y-2.5">
          <div className="text-[11px] uppercase tracking-wider font-bold opacity-55">
            Today’s Speech Missions
          </div>
          {visibleModes.length === 0 ? (
            <div className="ai-speech-card px-3 py-3 text-[12px] opacity-70" data-testid="speech-no-missions">
              No missions available right now.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5" data-testid="speech-mission-grid">
              {visibleModes.map((m) => (
                <MissionCard
                  key={m.key}
                  mode={m}
                  onStart={startMission}
                  busy={!!activeMode}
                />
              ))}
            </div>
          )}
          {missionError ? (
            <div className="text-[11.5px]" style={{ color: "var(--ai-accent-coral)" }} data-testid="speech-mission-error">
              {missionError}
            </div>
          ) : null}
        </div>
      )}

      {/* Active mission UI */}
      {mission && (
        <div className="space-y-3" data-testid="speech-active-mission">
          <div className="ai-speech-card px-3.5 py-3">
            <div className="flex items-start gap-3">
              <div className="ai-mission-tile__icon w-9 h-9 rounded-xl grid place-items-center shrink-0">
                <Mic2Icon className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-bold leading-tight">
                  {mission.mode_label || modeLabel}
                </div>
                <div className="text-[12px] opacity-80 leading-snug mt-1">
                  {mission.prompt}
                </div>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <ProgressDots
                    done={Math.max(attemptsDone, mission.attempts_completed || 0)}
                    total={attemptsReq}
                  />
                  <span className="text-[10.5px] opacity-55">
                    {Math.max(attemptsDone, mission.attempts_completed || 0)}/{attemptsReq} attempts
                  </span>
                  <StateBadge state={voiceState} />
                </div>
              </div>
              <button
                type="button"
                onClick={resetMission}
                className="text-[10.5px] opacity-60 hover:opacity-90 shrink-0"
                data-testid="speech-cancel-mission-btn"
              >
                Cancel
              </button>
            </div>
          </div>

          {/* Recorder */}
          {!recordingSupported ? (
            <div className="ai-banner ai-banner--danger px-3 py-2 text-[11.5px]" data-testid="speech-unsupported">
              Your browser does not support voice recording. You can still use Free Chat to practice with the coach.
            </div>
          ) : (
            <div className="ai-speech-card px-3.5 py-3.5 space-y-2.5" data-testid="speech-recorder">
              <div className="flex items-center justify-between">
                <div className="text-[11.5px] opacity-65">
                  Up to <span className="font-bold opacity-90">{maxDuration}s</span> recording
                  {!r2Available ? <span className="ml-1" style={{ color: "var(--ai-accent-coral)" }}>· R2 not configured</span> : null}
                </div>
                <div
                  className="ai-score-value text-[12px] font-bold tabular-nums"
                  data-testid="speech-record-timer"
                >
                  {recordTimer}s
                </div>
              </div>
              {/* v1.1.0 — live filler counter while recording (Web Speech transcript). */}
              {voiceState === "recording" ? (
                <div className="flex items-center justify-center">
                  <FillerPill
                    count={fillerLive.count}
                    pulse={fillerLive.pulse}
                    hint={
                      fillerLive.count >= 5
                        ? "Try one clean pause instead."
                        : fillerLive.count >= 2
                        ? "Watch the fillers."
                        : ""
                    }
                  />
                </div>
              ) : null}
              <div className="flex items-center justify-center py-3">
                {voiceState === "recording" ? (
                  <button
                    type="button"
                    onClick={stopRecording}
                    data-testid="speech-stop-btn"
                    className="ai-record-btn ai-record-btn--recording w-20 h-20 rounded-full grid place-items-center"
                  >
                    <SquareIcon className="w-7 h-7" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={startRecording}
                    disabled={["uploading", "analyzing", "stopping", "claiming"].includes(voiceState)}
                    data-testid="speech-start-btn"
                    className="ai-record-btn w-20 h-20 rounded-full grid place-items-center disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Mic2Icon className="w-7 h-7" />
                  </button>
                )}
              </div>
              {permissionError ? (
                <div className="text-[11px] text-center" style={{ color: "var(--ai-accent-coral)" }} data-testid="speech-permission-error">
                  {permissionError}
                </div>
              ) : null}
              {speech.transcript ? (
                <div className="rounded-xl px-3 py-2 text-[12px] opacity-85" style={{ background: "var(--ai-surface-2)", border: "1px solid var(--ai-border)" }} data-testid="speech-transcript-preview">
                  <div className="text-[9.5px] uppercase tracking-wider opacity-45 font-semibold mb-0.5">
                    Live transcript
                  </div>
                  {speech.transcript}
                </div>
              ) : null}
            </div>
          )}

          {missionError && voiceState !== "idle" ? (
            <div className="text-[11.5px]" style={{ color: "var(--ai-accent-coral)" }} data-testid="speech-mission-error">
              {missionError}
            </div>
          ) : null}

          {/* Feedback */}
          {analysis ? (
            <FeedbackCard analysis={analysis} scoringEnabled={scoringEnabled} />
          ) : null}

          {/* Reward / Bonus Box */}
          {analysis?.reward_eligible && !claimed ? (
            <BonusBox
              rewardPoints={Number(analysis.reward_points || rewardStatus?.reward_points || points[activeMode] || 0)}
              modeLabel={modeLabel}
              onClaim={claim}
              claiming={claiming}
              claimed={false}
              error={claimError}
            />
          ) : null}
          {claimed ? (
            <BonusBox
              rewardPoints={Number(analysis?.reward_points || rewardStatus?.reward_points || points[activeMode] || 0)}
              modeLabel={modeLabel}
              onClaim={() => {}}
              claiming={false}
              claimed
              error=""
            />
          ) : null}

          {/* Try-another after claim */}
          {claimed ? (
            <button
              type="button"
              onClick={resetMission}
              data-testid="speech-try-another-btn"
              className="ai-speech-card w-full text-[12px] font-bold py-2.5 inline-flex items-center justify-center gap-1.5"
            >
              Practice another mission <ArrowRight className="w-3.5 h-3.5" />
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * Personalized Hero — top dashboard card shown above the mode switch.
 * Pulls REAL student name + points from AuthContext and merges with public
 * AI Assistant config (cost, enabled flag, missions flag).
 *   • Real student name (never fake / never hardcoded)
 *   • Real points balance from portal wallet (graceful skeleton until known)
 *   • Cost per AI answer
 *   • Teacher-controlled status: AI available / AI paused / Missions paused
 *   • Time-based greeting ("Good morning, Sophea")
 * Outer Assistant component — tabs around Speech Coach (default) + Free Chat
 * ========================================================================== */
/* ──────────────────  PERSONAL HERO  ──────────────────────────────────── */
// AssistantPersonalHero delegates to the dedicated CoachHero component in
// ./components/CoachHero.jsx, preserving the data-testid contract
// (ai-assistant-hero, -avatar, -greeting, -points, -cost) so downstream
// tests continue to pass without modification.
function AssistantPersonalHero() {
  return <CoachHero />;
}

export default function Assistant() {
  const [tab, setTab] = useState("missions"); // "missions" | "chat"
  const reducedMotion = useReducedMotion();
  // v5 — "This is not a dashboard" pass. `chatActive` is a pure UI
  // signal reported by FreeChatPanel (onActiveChange) whenever a real
  // conversation is under way. While true, the header's meta line
  // (greeting/points/cost) stops mounting — wrapped in AnimatePresence
  // so it fades away instead of vanishing — reclaiming that space for
  // the conversation, per "only two things should demand attention: the
  // conversation and the composer." The Missions tab keeps the meta
  // line always, since it isn't a conversation.
  const [chatActive, setChatActive] = useState(false);
  const showMeta = !(tab === "chat" && chatActive);

  // v4 — Layout Architecture rebuild. Three regions, in normal flex
  // flow, filling a height bound to the dynamic viewport (see
  // .ai-shell-v2 in assistant-premium.css): a compact header (shrink:0),
  // then whichever tab is active filling the rest. The header is no
  // longer independently sticky with its own frosted veil — it's simply
  // the first flex child, so it never needs one.
  return (
    <section
      className="ai-assistant-shell ai-shell-v2 relative max-w-[680px] mx-auto px-1 sm:px-2"
      data-testid="ai-assistant-root"
    >
      <div className="ai-shell-header">
        <AnimatePresence initial={false}>
          {showMeta && <AssistantPersonalHero key="meta" />}
        </AnimatePresence>
        <motion.div layout transition={{ duration: reducedMotion ? 0 : DURATION, ease: EASE }}>
          <ModeSegmented tab={tab} onChange={setTab} />
        </motion.div>
      </div>

      <div className="ai-shell-body">
        {tab === "missions" ? (
          <div className="ai-shell-scroll">
            <SpeechCoachPanel onSwitchToChat={() => setTab("chat")} />
          </div>
        ) : (
          <FreeChatPanel onActiveChange={setChatActive} />
        )}
      </div>
    </section>
  );
}

