/**
 * coachPackApi.js — EduHub Coach Pack v3 client helpers.
 *
 * Single consolidated helper that mirrors the v9.6 EduTalkPanel HTTP
 * pattern (Bearer token from sessionStorage + credentials:include) so the
 * existing student auth model is reused byte-for-byte. Every call hits
 * /api/student/* routes registered by the Coach Pack backend modules.
 *
 * Failure-safe: every helper returns a plain object — on any HTTP error
 * the caller receives `{ success: false, error, message }` and can render
 * a friendly fallback. The reader must never crash because of Coach Pack.
 */
const API_BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
const TOKEN_KEY = "eduhub_session_token";

function _bearer() {
  try {
    const t = sessionStorage.getItem(TOKEN_KEY) || "";
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}

async function _post(path, body) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ..._bearer() },
      body: JSON.stringify(body || {}),
    });
    const txt = await res.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch { data = null; }
    if (!res.ok) {
      return {
        success: false,
        error: (data && data.error) || `http_${res.status}`,
        message: (data && (data.message || data.detail)) || `Request failed (${res.status}).`,
        status: res.status,
      };
    }
    return data || { success: true };
  } catch (err) {
    return { success: false, error: "network", message: err?.message || "Network error." };
  }
}

async function _get(path) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "GET",
      credentials: "include",
      headers: { ..._bearer() },
    });
    const txt = await res.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch { data = null; }
    if (!res.ok) {
      return {
        success: false,
        error: (data && data.error) || `http_${res.status}`,
        message: (data && (data.message || data.detail)) || `Request failed (${res.status}).`,
        status: res.status,
      };
    }
    return data || { success: true };
  } catch (err) {
    return { success: false, error: "network", message: err?.message || "Network error." };
  }
}

/* ============================== SLP ============================== */
export const getSLP = () => _get("/api/student/slp");
export const touchActiveDay = () => _post("/api/student/slp/touch", {});
export const getCoachBriefing = ({ bookSlug, chapterIdx = -1 }) =>
  _post("/api/student/coach-briefing", { book_slug: bookSlug, chapter_idx: chapterIdx });

/* ============================== Vocab ============================ */
export const saveWord = ({ word, bookSlug, chapterIdx, contextSentence, khmerHint }) =>
  _post("/api/student/vocab/save", {
    word, book_slug: bookSlug, chapter_idx: chapterIdx,
    context_sentence: contextSentence, khmer_hint: khmerHint,
  });
export const listWords = ({ bookSlug = "", limit = 50 } = {}) =>
  _get(`/api/student/vocab?book_slug=${encodeURIComponent(bookSlug)}&limit=${limit}`);
export const wordExample = ({ word, bookSlug, password }) =>
  _post("/api/student/vocab/example", { word, book_slug: bookSlug, password });
export const weeklyPick = () => _get("/api/student/vocab/weekly-pick");

/* ============================ Sentences ========================== */
export const saveSentence = ({ sentenceText, bookSlug, chapterIdx, whyHard }) =>
  _post("/api/student/sentences/save", {
    sentence_text: sentenceText, book_slug: bookSlug,
    chapter_idx: chapterIdx, why_hard: whyHard,
  });
export const listSentences = ({ bookSlug = "", limit = 50 } = {}) =>
  _get(`/api/student/sentences?book_slug=${encodeURIComponent(bookSlug)}&limit=${limit}`);
export const sentenceRewrite = ({ sentenceText, bookSlug, chapterIdx, password }) =>
  _post("/api/student/sentences/rewrite", {
    sentence_text: sentenceText, book_slug: bookSlug,
    chapter_idx: chapterIdx, password,
  });
export const tomorrowReview = () => _get("/api/student/sentences/tomorrow-review");

/* ====================== Chapter Review =========================== */
export const generateChapterReview = ({ bookSlug, chapterIdx, chapterText, password }) =>
  _post("/api/student/chapter-review/generate", {
    book_slug: bookSlug, chapter_idx: chapterIdx,
    chapter_text: chapterText, password,
  });
export const replayChapterReview = (contentHash) =>
  _get(`/api/student/chapter-review/replay?content_hash_q=${encodeURIComponent(contentHash)}`);

/* ========================== Mini Quiz ============================ */
export const quizStart = ({ bookSlug, chapterIdx, chapterText, password }) =>
  _post("/api/student/quiz/start", {
    book_slug: bookSlug, chapter_idx: chapterIdx,
    chapter_text: chapterText, password,
  });
export const quizSubmit = ({ quizId, items, answers, attemptIdx = 1 }) =>
  _post("/api/student/quiz/submit", {
    quiz_id: quizId, items, answers, attempt_idx: attemptIdx,
  });
export const quizRetry = ({ quizId }) =>
  _post("/api/student/quiz/retry", { quiz_id: quizId });

/* ======================== Weakness Map =========================== */
export const getWeaknessMap = () => _get("/api/student/weakness-map");
export const diagnoseWeakness = ({ password }) =>
  _post("/api/student/weakness-map/diagnose", { password });

/* ========================== Study Path =========================== */
export const getStudyPath = () => _get("/api/student/study-path");
export const recomputeStudyPath = ({ password }) =>
  _post("/api/student/study-path/recompute", { password });

/* ========================== Roleplay ============================= */
export const roleplayStart = ({ bookSlug, bookTitle, chapterIdx, chapterTheme, scenario, password }) =>
  _post("/api/student/roleplay/start", {
    book_slug: bookSlug, book_title: bookTitle,
    chapter_idx: chapterIdx, chapter_theme: chapterTheme,
    scenario, password,
  });
export const roleplayMessage = ({ sessionId, text }) =>
  _post("/api/student/roleplay/message", { session_id: sessionId, text });
export const roleplaySessions = ({ limit = 10 } = {}) =>
  _get(`/api/student/roleplay/sessions?limit=${limit}`);

/* ========================== Progress ============================= */
export const getProgress = (bookSlug) =>
  _get(`/api/student/progress/${encodeURIComponent(bookSlug)}`);
export const completeChapter = ({ bookSlug, chapterIdx, totalChapters }) =>
  _post("/api/student/progress/complete-chapter", {
    book_slug: bookSlug, chapter_idx: chapterIdx, total_chapters: totalChapters,
  });
export const listBadges = () => _get("/api/student/badges");
export const getWeeklyReport = () => _get("/api/student/weekly-report");
export const getContinueCard = () => _get("/api/student/continue-card");
