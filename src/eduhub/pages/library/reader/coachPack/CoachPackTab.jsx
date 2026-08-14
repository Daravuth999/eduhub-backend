/**
 * CoachPackTab.jsx — Tools/Coach tab content for EduTalkPanel.
 *
 * Self-contained: receives bookSlug + chapterIdx + tier, fetches its own
 * data via coachPackApi, renders all 10+ cards (each is a small inline
 * component for shipping density). Wrapped in an ErrorBoundary so a card
 * crash cannot blank the EduTalk drawer.
 *
 * Hard isolation:
 *   - Does NOT touch EduTalk chat state, voice entitlements, or the
 *     v9.6 audio cache contract.
 *   - Does NOT debit points client-side. Every paid action calls the
 *     backend, which gates + debits via points_ledger_api.
 *   - Reuses the existing student `password` value from AuthContext
 *     for paid actions (same shape EduTalkPanel uses).
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  BookOpen, Sparkles, Heart, MessageSquare, Target, Map, Calendar,
  Drama, Award, AlertCircle, Loader2, ChevronRight, RefreshCcw,
} from "lucide-react";
import { useAuth } from "../../../../context/AuthContext";
import {
  listWords, wordExample, listSentences, sentenceRewrite,
  generateChapterReview, quizStart, quizSubmit,
  getWeaknessMap, diagnoseWeakness, getStudyPath, recomputeStudyPath,
  roleplayStart, roleplayMessage,
  listBadges, getWeeklyReport, getContinueCard,
} from "../../../../lib/coachPackApi";
import "./coachPack.css";

class _ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { broken: false }; }
  static getDerivedStateFromError() { return { broken: true }; }
  componentDidCatch(err) { try { console.warn("[CoachPack] tab caught:", err); } catch {} }
  render() {
    if (this.state.broken) {
      return (
        <div className="coach-card coach-card__error" data-testid="coach-tab-error">
          Coach tools temporarily unavailable. Your reading is unaffected.
        </div>
      );
    }
    return this.props.children;
  }
}

function CardShell({ title, subtitle, tier, children, testId }) {
  return (
    <section className="coach-card" data-tier={tier} data-testid={testId}>
      <header className="coach-card__head">
        <h3 className="coach-card__title">{title}</h3>
        {subtitle && <span className="coach-card__subtitle">{subtitle}</span>}
      </header>
      <div className="coach-card__body">{children}</div>
    </section>
  );
}

function ErrorLine({ message, testId }) {
  if (!message) return null;
  return (
    <div className="coach-card__error" data-testid={testId}>
      <AlertCircle size={12} aria-hidden="true" /> {message}
    </div>
  );
}

/* ────────────────────────── Word Growth Bank ─────────────────────── */
function WordBankCard({ tier, bookSlug, password }) {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setBusy(true); setError("");
    const r = await listWords({ bookSlug, limit: 12 });
    setBusy(false);
    if (r?.success) setItems(r.items || []);
    else setError(r?.message || "Could not load saved words.");
  }, [bookSlug]);
  useEffect(() => { refresh(); }, [refresh]);

  const onGetExample = async (word) => {
    if (!password) {
      setError("Please re-enter your password from the EduTalk start screen first.");
      return;
    }
    setPending(word); setError("");
    const r = await wordExample({ word, bookSlug, password });
    setPending(null);
    if (!r?.success) {
      setError(r?.message || "Could not get an example.");
      return;
    }
    await refresh();
  };

  return (
    <CardShell title="Word Growth Bank" subtitle={items.length ? `${items.length} saved` : ""} tier={tier} testId="coach-word-bank">
      {busy ? (
        <div style={{ color: "var(--coach-text-muted)" }}><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ color: "var(--coach-text-muted)", fontSize: 13 }}>
          Long-press any word in the chapter to save it. Your bank will appear here.
        </div>
      ) : (
        <ul className="coach-list">
          {items.map((w) => (
            <li key={`${w.word}_${w.book_slug || ""}`}>
              <span className="coach-list__word" data-testid={`coach-word-${w.word}`}>{w.word}</span>
              {w.khmer_hint && <span className="coach-list__kh"> — {w.khmer_hint}</span>}
              {w.ai_example_payload?.example_sentence && (
                <div style={{ fontSize: 12, color: "var(--coach-text-muted)", marginTop: 4 }}>
                  “{w.ai_example_payload.example_sentence}”
                </div>
              )}
              {!w.ai_example_payload?.example_sentence && tier !== "free" && (
                <button
                  type="button"
                  className="coach-pill"
                  style={{ marginTop: 4 }}
                  disabled={pending === w.word}
                  onClick={() => onGetExample(w.word)}
                  data-testid={`coach-word-example-btn-${w.word}`}
                >
                  {pending === w.word ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                  AI example
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorLine message={error} testId="coach-word-bank-error" />
    </CardShell>
  );
}

/* ─────────────────────── Hard Sentences Coach ────────────────────── */
function HardSentencesCard({ tier, bookSlug, chapterIdx, password }) {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(null);
  const refresh = useCallback(async () => {
    setBusy(true); setError("");
    const r = await listSentences({ bookSlug, limit: 8 });
    setBusy(false);
    if (r?.success) setItems(r.items || []);
    else setError(r?.message || "Could not load saved sentences.");
  }, [bookSlug]);
  useEffect(() => { refresh(); }, [refresh]);

  const onRewrite = async (s) => {
    if (!password) {
      setError("Please re-enter your password from the EduTalk start screen first.");
      return;
    }
    setPending(s.sentence_hash); setError("");
    const r = await sentenceRewrite({
      sentenceText: s.sentence_text, bookSlug, chapterIdx, password,
    });
    setPending(null);
    if (!r?.success) {
      setError(r?.message || "Could not rewrite.");
      return;
    }
    // Surface payload inline.
    setItems((prev) => prev.map((x) =>
      x.sentence_hash === s.sentence_hash
        ? { ...x, _rewrite: r.payload }
        : x,
    ));
  };

  return (
    <CardShell title="Hard Sentences" subtitle={items.length ? `${items.length} saved` : ""} tier={tier} testId="coach-hard-sentences">
      {busy ? (
        <div style={{ color: "var(--coach-text-muted)" }}><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ color: "var(--coach-text-muted)", fontSize: 13 }}>
          Highlight a tricky sentence and tap “Save sentence” in the chapter to grow your bank.
        </div>
      ) : (
        <ul className="coach-list">
          {items.map((s) => (
            <li key={s.sentence_hash}>
              <span style={{ fontSize: 13 }}>{s.sentence_text}</span>
              {s._rewrite?.khmer_translation && (
                <div style={{ fontSize: 12, color: "var(--coach-text-muted)", marginTop: 4 }}>
                  ➜ {s._rewrite.easy_rewrite}<br/>
                  <span style={{ opacity: 0.8 }}>{s._rewrite.khmer_translation}</span>
                </div>
              )}
              {tier !== "free" && !s._rewrite && (
                <button
                  type="button"
                  className="coach-pill"
                  style={{ marginTop: 4 }}
                  disabled={pending === s.sentence_hash}
                  onClick={() => onRewrite(s)}
                  data-testid={`coach-sentence-rewrite-btn-${s.sentence_hash}`}
                >
                  {pending === s.sentence_hash ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                  Rewrite + Khmer
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorLine message={error} testId="coach-hard-sentences-error" />
    </CardShell>
  );
}

/* ─────────────────────── Personalised Chapter Review ─────────────── */
function ChapterReviewCard({ tier, bookSlug, chapterIdx, chapterText, password }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const onGenerate = async () => {
    if (!password) {
      setError("Please re-enter your password from the EduTalk start screen first.");
      return;
    }
    setBusy(true); setError("");
    const r = await generateChapterReview({
      bookSlug, chapterIdx, chapterText, password,
    });
    setBusy(false);
    if (!r?.success) {
      setError(r?.message || "Could not generate review.");
      return;
    }
    setData(r.payload);
  };
  const locked = tier === "free";
  return (
    <CardShell title="Chapter Review" subtitle={locked ? "Standard+" : ""} tier={tier} testId="coach-chapter-review">
      {locked ? (
        <div className="coach-card__locked">Available on Standard — unlock chapter summaries, key points, and vocabulary.</div>
      ) : data ? (
        <div>
          <p style={{ fontSize: 13 }}>{data.summary}</p>
          {(data.sections || []).map((s, i) => (
            <div key={i} style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--coach-accent)" }}>{s.title}</div>
              <div style={{ fontSize: 13, marginTop: 2 }}>{s.body}</div>
            </div>
          ))}
          {data.teacher_note && (
            <p style={{ fontSize: 12, color: "var(--coach-accent)", marginTop: 8 }}>{data.teacher_note}</p>
          )}
        </div>
      ) : (
        <>
          <p style={{ fontSize: 13, color: "var(--coach-text-muted)" }}>
            Get a personalised review of this chapter — key points, vocab, and grammar focus.
          </p>
          <button
            type="button"
            className="coach-card__cta"
            disabled={busy}
            onClick={onGenerate}
            data-testid="coach-chapter-review-btn"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {busy ? "Generating…" : "Generate review"}
          </button>
        </>
      )}
      <ErrorLine message={error} testId="coach-chapter-review-error" />
    </CardShell>
  );
}

/* ────────────────────────── Mini Quiz ───────────────────────────── */
function MiniQuizCard({ tier, bookSlug, chapterIdx, chapterText, password }) {
  const [quiz, setQuiz] = useState(null);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = !(tier === "premium" || tier === "limited_edition");

  const start = async () => {
    if (!password) { setError("Please re-enter your password first."); return; }
    setBusy(true); setError(""); setResult(null); setAnswers({});
    const r = await quizStart({ bookSlug, chapterIdx, chapterText, password });
    setBusy(false);
    if (!r?.success) { setError(r?.message || "Could not start quiz."); return; }
    setQuiz(r);
  };

  const submit = async () => {
    if (!quiz) return;
    setBusy(true); setError("");
    const r = await quizSubmit({
      quizId: quiz.quiz_id, items: quiz.items,
      answers: quiz.items.map((_, i) => answers[i] ?? ""),
    });
    setBusy(false);
    if (!r?.success) { setError(r?.message || "Could not submit."); return; }
    setResult(r);
  };

  return (
    <CardShell title="Mini Quiz" subtitle={locked ? "Premium+" : ""} tier={tier} testId="coach-mini-quiz">
      {locked ? (
        <div className="coach-card__locked">Available on Premium — adaptive 3-question quiz with retry.</div>
      ) : result ? (
        <div data-testid="coach-quiz-result">
          <p style={{ fontWeight: 700, fontSize: 16 }}>
            Score: {result.score_pct}% ({result.correct}/{result.total})
          </p>
          {(result.details || []).map((d, i) => (
            <p key={i} style={{ fontSize: 12, color: d.correct ? "var(--coach-success)" : "var(--coach-error)", marginTop: 4 }}>
              {d.correct ? "✓" : "✗"} {d.explanation}
            </p>
          ))}
          <button type="button" className="coach-card__cta coach-card__cta--ghost"
                  style={{ marginTop: 8 }}
                  onClick={() => { setQuiz(null); setResult(null); setAnswers({}); }}
                  data-testid="coach-quiz-restart">
            Try another quiz
          </button>
        </div>
      ) : quiz ? (
        <div>
          {quiz.items.map((it, i) => (
            <div key={i} style={{ marginTop: 6 }}>
              <p style={{ fontSize: 13, fontWeight: 600 }}>{i + 1}. {it.question}</p>
              {(it.choices || []).map((c, j) => (
                <label key={j} style={{ display: "block", fontSize: 12, padding: "4px 0", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name={`q_${i}`}
                    value={c}
                    checked={answers[i] === c}
                    onChange={() => setAnswers((a) => ({ ...a, [i]: c }))}
                    data-testid={`coach-quiz-q${i}-choice-${j}`}
                  />{" "}{c}
                </label>
              ))}
            </div>
          ))}
          <button type="button" className="coach-card__cta" disabled={busy} onClick={submit}
                  data-testid="coach-quiz-submit">
            {busy ? "Submitting…" : "Submit answers"}
          </button>
        </div>
      ) : (
        <>
          <p style={{ fontSize: 13, color: "var(--coach-text-muted)" }}>
            Quick adaptive quiz on what you just read.
          </p>
          <button type="button" className="coach-card__cta" disabled={busy} onClick={start}
                  data-testid="coach-quiz-start-btn">
            {busy ? "Starting…" : "Start quiz"}
          </button>
        </>
      )}
      <ErrorLine message={error} testId="coach-mini-quiz-error" />
    </CardShell>
  );
}

/* ────────────────────────── Weakness Map ───────────────────────── */
function WeaknessMapCard({ tier, password }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancel = false;
    setBusy(true);
    getWeaknessMap().then((r) => {
      if (!cancel) { setData(r); setBusy(false); }
    });
    return () => { cancel = true; };
  }, []);
  const onDiagnose = async () => {
    if (!password) { setError("Please re-enter your password first."); return; }
    setBusy(true); setError("");
    const r = await diagnoseWeakness({ password });
    setBusy(false);
    if (!r?.success) { setError(r?.message || "Diagnose unavailable."); return; }
    setData({ success: true, enabled: true, dials: r.payload?.dials, diagnosis: r.payload });
  };
  return (
    <CardShell title="Weakness Map" tier={tier} testId="coach-weakness-map">
      {busy && !data ? <div style={{ color: "var(--coach-text-muted)" }}><Loader2 size={14} className="animate-spin" /></div>
        : !data?.enabled ? (
          <div className="coach-card__locked" data-testid="coach-weakness-locked">
            {data?.message || "Unlocks after more reading data."}
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6, marginTop: 4 }}>
              {["grammar", "vocabulary", "comprehension", "tone", "pronunciation"].map((k) => (
                <div key={k} style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "var(--coach-accent)" }}>
                    {(data.dials?.[k] ?? 0)}
                  </div>
                  <div style={{ fontSize: 9, textTransform: "uppercase", color: "var(--coach-text-muted)" }}>{k}</div>
                </div>
              ))}
            </div>
            {data.diagnosis?.diagnosis && (
              <p style={{ fontSize: 12, color: "var(--coach-text-muted)", marginTop: 8 }}>
                {data.diagnosis.diagnosis}
              </p>
            )}
            {tier === "limited_edition" && !data.diagnosis && (
              <button type="button" className="coach-card__cta" style={{ marginTop: 8 }} onClick={onDiagnose}
                      data-testid="coach-weakness-diagnose-btn">
                Get weekly diagnosis
              </button>
            )}
          </>
        )}
      <ErrorLine message={error} testId="coach-weakness-error" />
    </CardShell>
  );
}

/* ────────────────────────── Study Path ─────────────────────────── */
function StudyPathCard({ tier, password }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancel = false;
    setBusy(true);
    getStudyPath().then((r) => { if (!cancel) { setData(r); setBusy(false); } });
    return () => { cancel = true; };
  }, []);
  const recompute = async () => {
    if (!password) { setError("Please re-enter your password first."); return; }
    setBusy(true); setError("");
    const r = await recomputeStudyPath({ password });
    setBusy(false);
    if (!r?.success) { setError(r?.message || "Could not recompute."); return; }
    setData({ success: true, enabled: true, plan: r.payload });
  };
  if (tier !== "limited_edition") {
    return (
      <CardShell title="Study Path" subtitle="Limited" tier={tier} testId="coach-study-path">
        <div className="coach-card__locked">A 7-day personal plan, available on Limited tier.</div>
      </CardShell>
    );
  }
  return (
    <CardShell title="Study Path" subtitle="Limited" tier={tier} testId="coach-study-path">
      {busy && !data ? <Loader2 size={14} className="animate-spin" />
        : !data?.enabled ? (
          <div className="coach-card__locked">{data?.message || "Study Path unlocks soon."}</div>
        ) : !data?.plan ? (
          <>
            <p style={{ fontSize: 13, color: "var(--coach-text-muted)" }}>Build this week's plan.</p>
            <button type="button" className="coach-card__cta" onClick={recompute} disabled={busy}
                    data-testid="coach-study-path-build-btn">
              {busy ? "Building…" : "Build my week"}
            </button>
          </>
        ) : (
          <div>
            {(data.plan.days || []).slice(0, 7).map((d, i) => (
              <div key={i} style={{ padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                <span style={{ color: "var(--coach-accent)", fontWeight: 700 }}>{d.day}</span>{" — "}
                <span style={{ fontSize: 13 }}>{d.focus}</span>
              </div>
            ))}
            {data.plan.encouragement && (
              <p style={{ fontSize: 12, color: "var(--coach-accent)", marginTop: 8 }}>{data.plan.encouragement}</p>
            )}
          </div>
        )}
      <ErrorLine message={error} testId="coach-study-path-error" />
    </CardShell>
  );
}

/* ─────────────────────────── Roleplay ──────────────────────────── */
function RoleplayCard({ tier, bookSlug, bookTitle, chapterIdx, chapterTheme, password }) {
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (tier !== "limited_edition") {
    return (
      <CardShell title="AI Roleplay" subtitle="Limited" tier={tier} testId="coach-roleplay">
        <div className="coach-card__locked">
          Practice scenes from this book with your personal coach — available on Limited tier.
        </div>
      </CardShell>
    );
  }
  const start = async () => {
    if (!password) { setError("Please re-enter your password first."); return; }
    setBusy(true); setError("");
    const r = await roleplayStart({
      bookSlug, bookTitle, chapterIdx, chapterTheme, scenario: "", password,
    });
    setBusy(false);
    if (!r?.success) { setError(r?.message || "Could not start roleplay."); return; }
    setSession({ sessionId: r.session_id, msgCap: r.msg_cap, msgCount: 1 });
    setMessages([r.first_message]);
  };
  const send = async () => {
    const text = input.trim();
    if (!text || !session) return;
    setBusy(true); setError("");
    const newMsgs = [...messages, { message_idx: messages.length, role: "user", content: text }];
    setMessages(newMsgs);
    setInput("");
    const r = await roleplayMessage({ sessionId: session.sessionId, text });
    setBusy(false);
    if (!r?.success) {
      setError(r?.message || "Roleplay paused.");
      return;
    }
    setMessages((m) => [...m, r.message]);
    setSession((s) => ({ ...s, msgCount: r.msg_count, msgCap: r.msg_cap }));
  };
  return (
    <CardShell title="AI Roleplay" subtitle={session ? `${session.msgCount}/${session.msgCap} msgs` : "Limited"} tier={tier} testId="coach-roleplay">
      {!session ? (
        <>
          <p style={{ fontSize: 13, color: "var(--coach-text-muted)" }}>
            Practice English with a character from this book.
          </p>
          <button type="button" className="coach-card__cta" disabled={busy} onClick={start}
                  data-testid="coach-roleplay-start-btn">
            {busy ? "Starting…" : "Start roleplay"}
          </button>
        </>
      ) : (
        <>
          <div style={{ maxHeight: 220, overflowY: "auto", padding: 6,
                        background: "rgba(0,0,0,0.22)", borderRadius: 10 }}
               data-testid="coach-roleplay-history">
            {messages.map((m, i) => (
              <div key={i} style={{
                marginBottom: 6,
                color: m.role === "assistant" ? "var(--coach-text)" : "var(--coach-accent)",
              }}>
                <strong>{m.role === "assistant" ? "Coach:" : "You:"}</strong> {m.content}
                {m.correction && (
                  <div style={{ fontSize: 11, color: "var(--coach-warn)", marginTop: 2 }}>
                    Note: {m.correction}
                  </div>
                )}
              </div>
            ))}
          </div>
          <input
            className="coach-input"
            style={{ marginTop: 8 }}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type your reply…"
            disabled={busy}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            data-testid="coach-roleplay-input"
          />
          <button type="button" className="coach-card__cta" disabled={busy || !input.trim()}
                  onClick={send} style={{ marginTop: 6 }} data-testid="coach-roleplay-send">
            {busy ? "Thinking…" : "Send"}
          </button>
        </>
      )}
      <ErrorLine message={error} testId="coach-roleplay-error" />
    </CardShell>
  );
}

/* ────────────────────── Continue / Weekly / Badges ─────────────── */
function ContinueCard({ tier }) {
  const [data, setData] = useState(null);
  useEffect(() => { getContinueCard().then(setData); }, []);
  if (!data?.success) return null;
  return (
    <CardShell title="Continue your journey" tier={tier} testId="coach-continue-card">
      <p style={{ fontSize: 14 }} data-testid="coach-continue-primary">
        <ChevronRight size={14} style={{ verticalAlign: "middle" }} /> {data.primary?.label}
      </p>
      {(data.alternatives || []).map((a, i) => (
        <p key={i} style={{ fontSize: 12, color: "var(--coach-text-muted)", marginTop: 4 }}>
          • {a.label}
        </p>
      ))}
    </CardShell>
  );
}

function WeeklyReportCard({ tier }) {
  const [data, setData] = useState(null);
  useEffect(() => { getWeeklyReport().then(setData); }, []);
  if (!data?.success) return null;
  if (!data.enabled) {
    return (
      <CardShell title="Weekly Improved" tier={tier} testId="coach-weekly-report">
        <div className="coach-card__locked">{data.message}</div>
      </CardShell>
    );
  }
  const r = data.report || {};
  return (
    <CardShell title="Weekly Improved" tier={tier} testId="coach-weekly-report">
      <p style={{ fontSize: 13 }}>
        This week: {r.chapters_this_week} chapters · {r.words_this_week} words · {r.sentences_this_week} sentences
      </p>
      {r.encouragement && <p style={{ fontSize: 12, color: "var(--coach-accent)", marginTop: 6 }}>{r.encouragement}</p>}
    </CardShell>
  );
}

function BadgesCard({ tier }) {
  const [items, setItems] = useState([]);
  useEffect(() => { listBadges().then((r) => { if (r?.success) setItems(r.items || []); }); }, []);
  if (!items.length) return null;
  return (
    <CardShell title="Badges" subtitle={`${items.length}`} tier={tier} testId="coach-badges">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {items.slice(0, 8).map((b) => (
          <span key={b.badge_id} className="coach-pill" data-testid={`coach-badge-${b.badge_id}`}>
            <Award size={11} /> {b.label || b.kind}
          </span>
        ))}
      </div>
    </CardShell>
  );
}

/* ─────────────────────────── Tab parent ────────────────────────── */
export default function CoachPackTab({
  bookSlug, bookTitle, bookTier, chapterIdx, chapterTitle, visibleText, password,
}) {
  const { isAuthenticated, student } = useAuth();
  if (!isAuthenticated || !student?.studentId) return null;
  const tier = (bookTier || "free").toLowerCase();
  return (
    <_ErrorBoundary>
      <div className="coach-tools-host" data-testid="coach-pack-tab">
        <ContinueCard tier={tier} />
        <WordBankCard tier={tier} bookSlug={bookSlug} password={password} />
        <HardSentencesCard tier={tier} bookSlug={bookSlug} chapterIdx={chapterIdx} password={password} />
        <ChapterReviewCard
          tier={tier} bookSlug={bookSlug} chapterIdx={chapterIdx}
          chapterText={visibleText} password={password}
        />
        <MiniQuizCard
          tier={tier} bookSlug={bookSlug} chapterIdx={chapterIdx}
          chapterText={visibleText} password={password}
        />
        <WeaknessMapCard tier={tier} password={password} />
        <StudyPathCard tier={tier} password={password} />
        <RoleplayCard
          tier={tier} bookSlug={bookSlug} bookTitle={bookTitle}
          chapterIdx={chapterIdx} chapterTheme={chapterTitle} password={password}
        />
        <WeeklyReportCard tier={tier} />
        <BadgesCard tier={tier} />
      </div>
    </_ErrorBoundary>
  );
}
