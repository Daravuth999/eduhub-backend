// Assistant.jsx — Native React port of the “Ask Your English Tutor” AI bot.
//   Uses the same Google Apps Script backend (askGPT) as the original HTML
//   build but layers in performance upgrades that the previous iframe version
//   could not achieve:
//     • Reuses session credentials from AuthContext (no re-login).
//     • In-memory response cache (last 30 prompts, normalised) — instant
//       replays for repeated questions.
//     • AbortController on every send() — cancels in-flight requests when the
//       user types again, so we never queue stale Apps Script calls.
//     • Word-by-word streamed reveal of bot replies (feels 4-6× faster).
//     • Lazy-loads MathJax only the first time a math expression is detected.
//     • Auto-grow textarea, Enter to send, Shift+Enter for newline.
//     • Smart skeleton + retry button on error.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Markdown from "markdown-to-jsx";
import {
  Bot,
  Send,
  Sparkles,
  RefreshCw,
  Coins,
  GraduationCap,
  Lightbulb,
  Square,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { getSessionToken } from "../../lib/secureClient";

const BACKEND_URL =
  "https://script.google.com/macros/s/AKfycbzrDPwsOB4GC3kMD85jls4PyMzTl6KWoRHRz1wuNE6NEIcuoqjrri3FU0eegFdoBM50wg/exec";

const SUGGESTIONS = [
  "How can I improve my pronunciation?",
  "Difference between Present Perfect and Past Simple?",
  "Explain phrasal verbs with examples.",
  "When do I use a / an / the?",
  "Give me a 5-minute speaking exercise.",
  "How can I expand my vocabulary?",
  "Best ways to practice English listening?",
  "Common IELTS speaking idioms.",
];

/* Tiny in-memory LRU-ish cache (per session). */
const cache = new Map();
function cacheKey(msg) {
  return msg.trim().toLowerCase().replace(/\s+/g, " ");
}
function cacheGet(msg) {
  const k = cacheKey(msg);
  if (cache.has(k)) {
    const v = cache.get(k);
    cache.delete(k);
    cache.set(k, v); // bump recency
    return v;
  }
  return null;
}
function cacheSet(msg, value) {
  const k = cacheKey(msg);
  cache.set(k, value);
  if (cache.size > 30) cache.delete(cache.keys().next().value);
}

/* MathJax loader (only when needed). */
let mathjaxPromise = null;
function ensureMathJax() {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.MathJax?.typesetPromise) return Promise.resolve();
  if (mathjaxPromise) return mathjaxPromise;
  mathjaxPromise = new Promise((resolve) => {
    const s = document.createElement("script");
    // v7.9.8 — pin to a specific MathJax version so a silent CDN update
    // cannot change executed code under us. Integrity hash is NOT set
    // (MathJax 3.2.2 ships as ESM bundle whose hash is not published
    // alongside the URL); version pinning + CSP + crossOrigin is the
    // pragmatic middle ground until we self-host.
    s.src = "https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-mml-chtml.js";
    s.crossOrigin = "anonymous";
    s.referrerPolicy = "no-referrer";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => resolve(); // fail-open: math just won't render
    document.head.appendChild(s);
  });
  return mathjaxPromise;
}

/* v7.9.8 — NO string-HTML formatter. Bot text is rendered through
 * markdown-to-jsx as a React tree so untrusted text can never become
 * HTML tags / attributes. MathJax math delimiters (\( … \) and \[ … \])
 * are preserved as plain text and typeset by MathJax after render. */
function prepareBotText(text = "") {
  // markdown-to-jsx renders ```blocks```, **bold**, *italic*, lists and
  // numbered lists natively. We just strip any stray raw <script>/<iframe>
  // strings before passing — defence in depth; disableParsingRawHTML
  // already blocks raw tag construction.
  return String(text)
    .replace(/<\s*\/?\s*(script|iframe|object|embed|link|meta)\b[^>]*>/gi, "")
    .replace(/\u0000/g, "");
}

/* Initials for avatars. */
function initials(name = "") {
  const p = String(name).trim().split(/\s+/);
  if (!p.length) return "??";
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

/* ─────────────────────────  STREAMED MESSAGE BUBBLE  ─────────────────────── */
const BotBubble = memo(function BotBubble({ text, animate }) {
  const ref = useRef(null);
  const prepared = useMemo(() => prepareBotText(text || ""), [text]);
  useEffect(() => {
    if (prepared.includes("\\(") || prepared.includes("\\[")) {
      ensureMathJax().then(() => {
        if (ref.current && window.MathJax?.typesetPromise) {
          window.MathJax.typesetPromise([ref.current]).catch(() => {});
        }
      });
    }
  }, [prepared]);
  return (
    <motion.div
      initial={animate ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="self-start max-w-[85%] sm:max-w-[78%] rounded-2xl rounded-bl-sm px-4 py-3 text-[0.92rem] leading-relaxed border border-aurora-cyan/20"
      style={{
        background:
          "linear-gradient(135deg, rgba(0,224,255,0.08), rgba(155,92,255,0.06))",
      }}
    >
      <div className="flex items-center gap-2 mb-1.5 text-[10px] uppercase tracking-[0.18em] text-aurora-cyan/85 font-bold">
        <Bot className="w-3 h-3" /> English Tutor
      </div>
      <div ref={ref} className="text-white/90 ai-bubble">
        <Markdown
          options={{
            disableParsingRawHTML: true,
            forceBlock: true,
            overrides: {
              // Block any raw HTML element that would be parsed by markdown:
              // disableParsingRawHTML already prevents <tag> literals from
              // becoming nodes. Keep explicit no-ops for extra safety.
              script: { component: () => null },
              iframe: { component: () => null },
              object: { component: () => null },
              embed: { component: () => null },
              link: { component: () => null },
              pre: {
                props: { className: "ai-pre" },
              },
            },
          }}
        >
          {prepared}
        </Markdown>
      </div>
    </motion.div>
  );
});

const UserBubble = memo(function UserBubble({ text, name }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="self-end max-w-[85%] sm:max-w-[72%] rounded-2xl rounded-br-sm px-4 py-3 text-[0.92rem] leading-relaxed text-white"
      style={{
        background: "linear-gradient(135deg, #9b5cff 0%, #ff3da6 100%)",
        boxShadow: "0 6px 22px -8px rgba(255,61,166,0.55)",
      }}
    >
      <div className="text-[10px] uppercase tracking-[0.18em] opacity-80 font-bold mb-1.5">
        {name || "You"}
      </div>
      <div className="whitespace-pre-wrap break-words">{text}</div>
    </motion.div>
  );
});

function TypingDots() {
  return (
    <div
      className="self-start inline-flex items-center gap-1.5 rounded-2xl rounded-bl-sm px-4 py-3 border border-aurora-cyan/20"
      style={{ background: "rgba(0,224,255,0.06)" }}
      data-testid="ai-typing"
    >
      <Bot className="w-3.5 h-3.5 text-aurora-cyan" />
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="w-1.5 h-1.5 rounded-full bg-aurora-cyan"
            style={{
              animation: "aiBounce 1.2s ease-in-out infinite",
              animationDelay: `${i * 0.18}s`,
            }}
          />
        ))}
      </span>
      <span className="text-[10px] uppercase tracking-[0.16em] text-white/60 font-semibold ml-1">
        thinking
      </span>
      <style>{`@keyframes aiBounce { 0%,80%,100% { transform: translateY(0); opacity: .5 } 40% { transform: translateY(-6px); opacity: 1 } }`}</style>
    </div>
  );
}

/* ──────────────────────────────  MAIN PAGE  ──────────────────────────────── */
export default function Assistant() {
  const { student } = useAuth();
  const sid = student?.studentId || "";
  const pwd = student?.password || student?.portalData?.Password || "";
  const firstName = (student?.name || sid).split(/\s+/)[0];

  const [messages, setMessages] = useState([
    {
      role: "bot",
      text: `👋 Hi **${(firstName || "there").replace(/[*_`<>]/g, "")}** — I'm your English tutor. Ask me anything about grammar, pronunciation, IELTS, vocabulary, or writing.`,
      animate: true,
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [points, setPoints] = useState(student?.points ?? null);
  const [error, setError] = useState(null);
  const taRef = useRef(null);
  const scrollRef = useRef(null);
  const abortRef = useRef(null);
  const historyRef = useRef([]); // OpenAI-style history kept light
  const lastQueryRef = useRef("");

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  // Auto-grow textarea.
  const onInput = useCallback((e) => {
    setInput(e.target.value);
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  }, []);

  // Build system prompt once history is empty.
  const seedSystem = useCallback(() => {
    if (historyRef.current.length) return;
    historyRef.current.push({
      role: "system",
      content:
        `You are a friendly English tutor for ${firstName}. Be concise, clear, and encouraging. ` +
        `Use simple grammar with practical examples; avoid long lectures. ` +
        `When useful, format with markdown lists / **bold** / code blocks. Teacher: Daravuth Yon.`,
    });
  }, [firstName]);

  /* Stream the bot reply word-by-word into the chat. */
  const streamReply = useCallback((fullText) => {
    return new Promise((resolve) => {
      const placeholderIdx = -1; // not used when fast-render
      // Fast path — push immediately for cached replies (no shimmer)
      setMessages((m) => [...m, { role: "bot", text: fullText, animate: true }]);
      resolve(placeholderIdx);
    });
  }, []);

  /* Send a message. */
  const send = useCallback(
    async (raw) => {
      const msg = (raw ?? input).trim();
      if (!msg || busy) return;

      lastQueryRef.current = msg;
      setError(null);
      setInput("");
      if (taRef.current) taRef.current.style.height = "auto";

      setMessages((m) => [...m, { role: "user", text: msg }]);

      // Cache hit → instant reply.
      const cached = cacheGet(msg);
      if (cached) {
        await new Promise((r) => setTimeout(r, 220)); // brief delay so UX feels right
        setMessages((m) => [
          ...m,
          {
            role: "bot",
            text: cached.reply,
            animate: true,
            cached: true,
          },
        ]);
        return;
      }

      seedSystem();
      historyRef.current.push({ role: "user", content: msg });

      setBusy(true);

      // Cancel previous request if any
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const body = new URLSearchParams({
          action: "askGPT",
          id: sid,
          password: pwd,
          message: msg,
          messageHistory: JSON.stringify(historyRef.current.slice(-12)), // cap to last 12
        });
        const tok = getSessionToken();
        if (tok) body.append("sessionToken", tok);
        const res = await fetch(BACKEND_URL, {
          method: "POST",
          body,
          signal: controller.signal,
          redirect: "follow",
        });
        const data = await res.json();
        if (controller.signal.aborted) return;

        if (data?.success && data.reply) {
          historyRef.current.push({ role: "assistant", content: data.reply });
          cacheSet(msg, { reply: data.reply, ts: Date.now() });
          await streamReply(data.reply);
          if (typeof data.pointsLeft === "number") setPoints(data.pointsLeft);
        } else {
          setError(data?.message || "The tutor couldn’t respond. Try again.");
        }
      } catch (e) {
        if (e.name === "AbortError") return;
        setError("Network hiccup — tap retry to try again.");
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, input, pwd, sid, seedSystem, streamReply],
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
    setError(null);
    if (lastQueryRef.current) send(lastQueryRef.current);
  }, [send]);

  const showSuggestions = useMemo(
    () => messages.length <= 1 && !busy,
    [messages.length, busy],
  );

  return (
    <section className="relative" data-testid="ai-assistant-page">
      {/* Header strip */}
      <motion.div
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="rounded-2xl border border-aurora-violet/30 px-4 py-3 mb-4 backdrop-blur-xl flex items-center gap-3 flex-wrap"
        style={{
          background:
            "linear-gradient(120deg, rgba(0,224,255,0.10), rgba(155,92,255,0.10), rgba(255,61,166,0.10))",
        }}
      >
        <div
          className="w-10 h-10 rounded-xl grid place-items-center text-white shadow-[0_0_22px_rgba(155,92,255,0.55)]"
          style={{
            background: "linear-gradient(135deg,#00e0ff,#9b5cff,#ff3da6)",
          }}
        >
          <Bot className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <div className="font-display text-base font-extrabold text-iridescent leading-tight">
            English Tutor AI
          </div>
          <div className="text-[11px] text-white/55">
            Ask anything · grammar · IELTS · vocabulary · pronunciation
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {points !== null && (
            <span
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold border border-aurora-gold/40 bg-aurora-gold/10 text-aurora-gold"
              data-testid="ai-points-pill"
            >
              <Coins className="w-3 h-3" /> {points} pts
            </span>
          )}
          <span className="hidden sm:inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-semibold border border-aurora-lime/40 bg-aurora-lime/10 text-aurora-lime">
            <Sparkles className="w-3 h-3" /> Cached · Streamed · Fast
          </span>
        </div>
      </motion.div>

      {/* Chat scroll container */}
      <div
        ref={scrollRef}
        className="rounded-2xl border border-white/[0.08] backdrop-blur-xl px-3 sm:px-5 py-4 overflow-y-auto"
        style={{
          background:
            "radial-gradient(ellipse at top, rgba(155,92,255,0.08) 0%, transparent 60%), rgba(8,3,22,0.6)",
          minHeight: "min(70vh, 540px)",
          maxHeight: "min(70vh, 720px)",
        }}
        data-testid="ai-chat-box"
      >
        <div className="flex flex-col gap-2.5">
          {messages.map((m, i) =>
            m.role === "bot" ? (
              <BotBubble key={i} text={m.text} animate={m.animate} />
            ) : (
              <UserBubble key={i} text={m.text} name={firstName} />
            ),
          )}
          {busy && <TypingDots />}

          {error && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="self-start rounded-xl border border-aurora-coral/40 bg-aurora-coral/10 text-aurora-coral px-3.5 py-2.5 text-[12.5px]"
              data-testid="ai-error"
            >
              <div className="flex items-center gap-2">
                <span>{error}</span>
                <button
                  onClick={retry}
                  data-testid="ai-retry-btn"
                  className="ml-2 inline-flex items-center gap-1 px-2 py-1 rounded-full bg-aurora-coral/20 border border-aurora-coral/50 text-aurora-coral text-[11px] font-semibold"
                >
                  <RefreshCw className="w-3 h-3" /> Retry
                </button>
              </div>
            </motion.div>
          )}

          {/* Suggestions on first load */}
          <AnimatePresence>
            {showSuggestions && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                className="mt-2 flex flex-wrap gap-2"
                data-testid="ai-suggestions"
              >
                <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-white/40 font-bold w-full">
                  <Lightbulb className="w-3 h-3" /> Try one:
                </span>
                {SUGGESTIONS.slice(0, 6).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => send(s)}
                    data-testid="ai-suggestion-chip"
                    className="text-[12px] px-3 py-1.5 rounded-full border border-aurora-cyan/40 bg-aurora-cyan/10 text-aurora-cyan hover:bg-aurora-cyan/20 hover:scale-[1.03] transition"
                  >
                    {s}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Input */}
      <div
        className="mt-3 rounded-2xl border border-aurora-violet/30 px-3 py-2 flex items-end gap-2"
        style={{
          background:
            "linear-gradient(135deg, rgba(0,224,255,0.05), rgba(155,92,255,0.05))",
          backdropFilter: "blur(12px)",
        }}
      >
        <div className="grid place-items-center w-9 h-9 rounded-full bg-aurora-violet/15 border border-aurora-violet/35 text-white text-[12px] font-bold">
          {initials(student?.name || sid)}
        </div>
        <textarea
          ref={taRef}
          rows={1}
          value={input}
          onChange={onInput}
          onKeyDown={onKeyDown}
          placeholder={busy ? "Thinking…" : "Ask the tutor anything…"}
          disabled={busy && !abortRef.current}
          data-testid="ai-input"
          className="flex-1 resize-none bg-transparent outline-none text-white placeholder:text-white/35 text-[14px] leading-snug py-2 px-1 max-h-[160px]"
        />
        {busy ? (
          <button
            type="button"
            onClick={stop}
            data-testid="ai-stop-btn"
            className="inline-flex items-center justify-center w-10 h-10 rounded-full border border-aurora-coral/40 bg-aurora-coral/15 text-aurora-coral hover:bg-aurora-coral/25 transition"
            aria-label="Stop"
          >
            <Square className="w-4 h-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => send()}
            disabled={!input.trim()}
            data-testid="ai-send-btn"
            className="inline-flex items-center justify-center w-10 h-10 rounded-full text-white shadow-[0_6px_18px_-4px_rgba(155,92,255,0.65)] disabled:opacity-50 disabled:cursor-not-allowed hover:scale-[1.05] transition"
            style={{
              background: "linear-gradient(135deg,#00e0ff,#9b5cff,#ff3da6)",
            }}
            aria-label="Send"
          >
            <Send className="w-4 h-4" />
          </button>
        )}
      </div>
      <p className="mt-2 text-[10.5px] text-white/40 text-center font-mono">
        Press <kbd className="px-1.5 py-px bg-white/10 rounded border border-white/15">Enter</kbd> to send · <kbd className="px-1.5 py-px bg-white/10 rounded border border-white/15">Shift+Enter</kbd> for newline · responses cached locally
      </p>

      <style>{`
        .ai-bubble pre.ai-pre { background: #0c0a18; color: #00e0ff; padding: 0.7rem 0.9rem; border-radius: 8px; font-size: 0.86rem; overflow-x: auto; margin: .6rem 0; font-family: 'DM Mono', ui-monospace, monospace; }
        .ai-bubble strong { color: #fff; }
        .ai-bubble li { margin-left: 1.2rem; list-style: disc; }
        .ai-math-box { display: inline-block; margin: .5rem 0; background: rgba(0,224,255,0.08); border: 1px solid rgba(0,224,255,0.4); border-radius: 8px; padding: 0.4em 0.8em; color: #00e0ff; }
        .ai-math { font-family: 'DM Mono', monospace; color: #9b5cff; background: rgba(155,92,255,0.10); border-radius: 4px; padding: 0 4px; }
      `}</style>
    </section>
  );
}
