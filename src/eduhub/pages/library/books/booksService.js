/**
 * booksService.js — Library in-app books CMS.
 *
 * Content sources (first success wins):
 *   1) Google Sheets (public, gviz JSON) — if REACT_APP_BOOKS_SHEET_ID is set.
 *        • The instructor edits the Sheet; frontend picks it up within seconds
 *          (client cache TTL is 10 s — live-editing mode).
 *   2) Local JSON file  /books/index.json — bundled with the app, always works.
 *
 * A "book" is:
 *   {
 *     id, slug, section ('story'|'conversation'|'exercise'),
 *     title, subtitle, author, coverEmoji, coverGradient, accent,
 *     readingMinutes, level, published (bool), newUntil (date),
 *     format ('markdown' | 'blocks'),
 *     content  — markdown string   (if format === 'markdown')
 *     chapters — [{title, blocks:[{type,text}]}]  (if format === 'blocks')
 *   }
 *
 * This file NEVER touches the existing LibraryBackend (GAS) — it is purely
 * additive. If a book is missing from this catalog, the library falls back to
 * the original external `link` behavior (backwards compatible).
 */

const LOCAL_URL = "/books/index.json";
// v7.9.8 — cache key is now scoped to the sheet ID so switching Books
// sheets (e.g. in multi-tenant or preview/production deploys) never
// leaks entries from one tenant's cache into another.
const CACHE_KEY_BASE = "eduhub_books_cache_v3";
const CACHE_TTL = 10 * 1000; // 10 seconds — live-editing mode

// Optional: point this at a published Google Sheet ID to enable CMS mode.
// The Sheet must be "Anyone with the link: Viewer" (or File → Share → Publish).
// Expected sheet name: "Books".
// NOTE: CRA inlines `process.env.REACT_APP_*` literally at build time via
// webpack's DefinePlugin, so we MUST reference it directly — any `typeof
// process` guard would short-circuit to false in the browser (where no
// `process` global exists) and the inlined value would never be read.
/* eslint-disable no-undef */
const SHEET_ID = process.env.REACT_APP_BOOKS_SHEET_ID || "";
const SHEET_NAME = process.env.REACT_APP_BOOKS_SHEET_NAME || "Books";
/* eslint-enable no-undef */

function sheetGvizURL(id, name) {
  const n = encodeURIComponent(name);
  // headers=1 forces row 1 to be treated as column labels (critical when the
  // sheet hasn't been auto-detected as having a header row).
  return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:json&sheet=${n}&headers=1`;
}

// v-p0 — cache OWNERSHIP, not just a key suffix. Root-cause finding: the
// backend's guest_content_boundary (eduhub-backend/guest_content_boundary.py)
// deliberately strips `chapters`/`content` from priced books for an
// unauthenticated caller — correct, by design. Before the guest reading
// experience shipped, no unauthenticated caller could ever reach code that
// calls getAllBooks() (LibraryPage/ReaderPage were both unconditionally
// behind ProtectedRoute), so this merged catalog was always populated from
// an authenticated-context response. Guests can now legitimately reach
// /library and /library/read/:slug, so a guest's CORRECTLY-stripped catalog
// response and an authenticated student's full response must never occupy
// the same storage slot — otherwise whichever fetch lands last on a given
// device decides what every reader on that device sees, regardless of
// their own auth state. `isAuthenticated` is supplied by the caller (which
// already has it from useAuth()) rather than inferred here, because the
// mere presence of a Bearer token is not a reliable signal — a student
// who has only ever restored a session via cookie (never typed a password
// on this device) never receives a token (see studentAuthService.js
// studentMe(), which never writes STUDENT_TOKEN_KEY on a cookie-only
// restore) yet is genuinely authenticated.
function cacheKey(isAuthenticated) {
  const scope = isAuthenticated ? "auth" : "guest";
  return `${CACHE_KEY_BASE}:${scope}:${SHEET_ID || "local"}:${SHEET_NAME || "Books"}`;
}

function saveCache(data, isAuthenticated) {
  // v-perf — NEVER persist an empty/invalid catalog. A transient backend
  // failure (or a momentarily empty response) must not be allowed to
  // overwrite a previously good cache and wipe the shelves. The only way
  // a non-empty catalog reaches storage is through a successful fetch.
  if (!Array.isArray(data) || data.length === 0) return;
  try {
    localStorage.setItem(cacheKey(isAuthenticated), JSON.stringify({ ts: Date.now(), data }));
  } catch { /* ignore */ }
}
/**
 * loadCacheEntry — return the raw cache record `{ data, ts }` (or null)
 * WITHOUT applying any freshness window. Freshness is decided by the
 * caller (getAllBooks) so it can implement stale-while-revalidate:
 * serve the last good catalog instantly and refresh in the background.
 */
function loadCacheEntry(isAuthenticated) {
  try {
    const raw = localStorage.getItem(cacheKey(isAuthenticated));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.data)) return null;
    return { data: parsed.data, ts: Number(parsed.ts) || 0 };
  } catch { /* ignore */ }
  return null;
}

/* ------------------------------- normalisers ------------------------------ */

/**
 * Convert a Dropbox / Google-Drive "share" URL into a direct content URL
 * usable as an <img src>. Any other URL is returned unchanged. Invalid
 * input returns an empty string.
 */
export function normalizeAssetUrl(raw) {
  if (!raw || typeof raw !== "string") return "";
  let u = raw.trim();
  if (!u) return "";
  // Bare Drive file ID (Google Drive IDs are typically 28-44 chars of
  // [a-zA-Z0-9_-]). The previous `{20,}` pattern was too permissive and
  // treated any long alnum token as a Drive ID — see v7.9.8 audit.
  if (/^[a-zA-Z0-9_-]{25,44}$/.test(u)) {
    return `https://lh3.googleusercontent.com/d/${u}=w1200`;
  }
  try {
    const url = new URL(u);
    // Dropbox share links → direct-content host.
    if (/(^|\.)dropbox\.com$/i.test(url.hostname)) {
      url.hostname = "dl.dropboxusercontent.com";
      url.searchParams.delete("dl");
      if (!url.searchParams.has("raw")) url.searchParams.set("raw", "1");
      return url.toString();
    }
    // Google Drive — support every common share variant:
    //   /file/d/{id}/view, /open?id={id}, /uc?id={id}, /uc?export=view&id={id}
    // and the newer /drive/folders/... (not an image, passthrough).
    if (/(^|\.)drive\.google\.com$/i.test(url.hostname)) {
      let id = "";
      const m = url.pathname.match(/\/file\/d\/([^/]+)/);
      if (m) id = m[1];
      if (!id && url.searchParams.get("id")) id = url.searchParams.get("id");
      if (id) {
        // lh3 CDN is CORS-friendly and serves the image directly without
        // the interstitial "uc?export" sometimes returns for quota-limited
        // files. Falls back gracefully if the image is private.
        return `https://lh3.googleusercontent.com/d/${id}=w1200`;
      }
    }
    // Google Docs attached images (Sheets IMAGE() fallthrough)
    if (/googleusercontent\.com$/i.test(url.hostname)) return u;
    return u;
  } catch {
    return u;
  }
}

function normalizeBook(raw) {
  if (!raw) return null;
  const b = { ...raw };
  b.id = String(b.id || b.slug || b.title || "").trim();
  b.slug = String(b.slug || b.id || b.title || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  b.section = String(b.section || "story").toLowerCase().trim();
  // Accept common variants: "Stories" → "story", "Conversations" → "conversation"
  if (b.section.endsWith("s")) b.section = b.section.slice(0, -1);
  if (b.section === "exercise" || b.section === "exercises" || b.section === "test" || b.section === "tests") {
    b.section = "exercise";
  }
  if (!["story", "conversation", "exercise"].includes(b.section)) b.section = "story";
  b.title = String(b.title || "Untitled").trim();
  b.subtitle = b.subtitle ? String(b.subtitle).trim() : "";
  b.author = b.author ? String(b.author).trim() : "Classroom Library";
  b.coverEmoji = b.coverEmoji || "📖";
  // v7.9: optional cover image (Dropbox/Drive/HTTP) + badge label.
  // Note: we deliberately do NOT alias `b.image` here because chapter
  // rows use the `image` column for in-page artwork (image blocks).
  b.coverImage = normalizeAssetUrl(b.coverImage || b.cover || "");
  b.badge = b.badge ? String(b.badge).trim().toUpperCase().slice(0, 14) : "";
  b.coverGradient =
    b.coverGradient || "linear-gradient(155deg, #2a2140 0%, #4a3a6a 100%)";
  b.accent = b.accent || "#D4A843";
  b.readingMinutes = Number(b.readingMinutes) || 6;
  b.level = b.level || "";
  b.price = Math.max(0, Math.floor(Number(b.price) || 0));
  // v9.4 — Visual treatment now flows from the Author-Studio-selected
  // badge / tier. The legacy price-band fallback is preserved ONLY for
  // pre-v9.4 books where the Author has not yet set a `tier` value and
  // the badge text carries no tier keyword. `_tierSource` captures the
  // resolution path so Studio / debug surfaces can explain why a given
  // book is styled the way it is.
  const _resolved = resolveTier(b.tier, b.price, b.badge);
  b.tier = _resolved.tier;
  b._tierSource = _resolved.source; // "author" | "badge" | "legacy-price"
  // v7.9.4 — strict Publish TRUE/FALSE parsing. ANY of these means FALSE:
  //   boolean false | "FALSE" | "false" | "0" | "" | 0 | "no"
  // Everything else → TRUE (default). This guarantees the sheet column
  // reliably toggles shelf visibility in real-time.
  const pRaw = b.published;
  if (
    pRaw === false ||
    pRaw === 0 ||
    pRaw === null ||
    pRaw === undefined ||
    pRaw === "" ||
    (typeof pRaw === "string" &&
      ["false", "0", "no", "n", "off", "hidden", "unpublished"].includes(
        pRaw.trim().toLowerCase()
      ))
  ) {
    b.published = false;
  } else {
    b.published = true;
  }
  b.newUntil = b.newUntil || "";
  // v7.9.6 — optional `contentType` override column (audio|video|text).
  // When blank, detectContentType() auto-detects from chapter block types.
  b.contentType = normalizeContentType(b.contentType);
  b.format = (b.format || "markdown").toLowerCase();

  if (b.format === "markdown") {
    b.content = String(b.content || "");
    b.chapters = markdownToChapters(b.content);
  } else if (b.format === "blocks") {
    b.chapters = Array.isArray(b.chapters) ? b.chapters : [];
    // Defensive: ensure shape — keep optional media metadata (poster, heading/title)
    b.chapters = b.chapters
      .filter(Boolean)
      .map((ch) => ({
        title: String(ch.title || "Section").trim(),
        blocks: Array.isArray(ch.blocks)
          ? ch.blocks.filter(Boolean).map((blk) => {
              const out = {
                type: (blk.type || "paragraph").toLowerCase(),
                text: String(blk.text || "").trim(),
              };
              if (blk.heading) out.heading = String(blk.heading).trim();
              if (blk.title) out.title = String(blk.title).trim();
              if (blk.poster) out.poster = String(blk.poster).trim();
              // Transcript timing — preserve as numbers so the reader's
              // word-level highlighter can interpolate.
              if (blk.start !== undefined && blk.start !== null && blk.start !== "") {
                const n = Number(blk.start);
                if (Number.isFinite(n)) out.start = n;
              }
              if (blk.end !== undefined && blk.end !== null && blk.end !== "") {
                const n = Number(blk.end);
                if (Number.isFinite(n)) out.end = n;
              }
              if (blk.audio) out.audio = String(blk.audio).trim();
              // v7.9.8 — preserve new content-engine fields.
              if (blk.speaker) out.speaker = String(blk.speaker).trim();
              if (blk.options !== undefined) out.options = blk.options;
              if (blk.answer) out.answer = String(blk.answer).trim();
              if (blk.explain) out.explain = String(blk.explain).trim();
              return out;
            })
          : [],
      }));
  } else {
    b.chapters = [];
  }

  // v7.9.6 — final content-type resolution (override column wins).
  b._contentType = b.contentType || detectContentType(b);

  return b;
}

/**
 * normalizeContentType — accept any casing/variant of the instructor's
 * override column and coerce it to the canonical set {audio,video,text}.
 * Empty / unknown values return "" so auto-detection can take over.
 */
function normalizeContentType(raw) {
  if (!raw) return "";
  const v = String(raw).trim().toLowerCase();
  if (!v) return "";
  if (["audio", "podcast", "listen", "listening"].includes(v)) return "audio";
  if (["video", "watch", "movie", "embed", "youtube"].includes(v)) return "video";
  if (["text", "read", "reading", "story", "article", "markdown"].includes(v)) return "text";
  return "";
}

/**
 * normalizeTier — v9.4 Author-driven visual treatment.
 *
 * Returns one of: "free" | "standard" | "premium" | "limited".
 *
 * v9.4 RULE — Author-defined badge is the SINGLE SOURCE OF TRUTH for the
 * book's visual treatment. The previous behaviour (price-band fallback as
 * the primary classifier) has been removed: a 200-pt book is no longer
 * forced into "premium" styling just because of its price. Pricing and
 * visual styling are now fully decoupled — storefront / access-control /
 * filter-chip code paths continue to read the same `tier` string and are
 * therefore unaffected.
 *
 * Resolution order:
 *   1) Explicit `tier` column from the Author Studio (any casing/alias).
 *   2) Author-defined badge text mentioning a tier word
 *      ("FREE" | "STANDARD" | "PREMIUM" | "LIMITED" | "LE" | "EXCLUSIVE").
 *   3) Legacy auto-migration (only when 1 + 2 are both empty): derive
 *      from the price band so books published before v9.4 keep their
 *      previous visual treatment until the Author opens the Studio and
 *      explicitly picks a badge. Once they do, step 1 wins forever.
 *
 * The `__autoMigrated` flag on the returned wrapper is intentionally
 * NOT used here — we keep the return type as a plain string to preserve
 * the existing callers' contract. Migration-source attribution lives on
 * the normalised book object (see normalizeBook → `b._tierSource`).
 */
export const TIER_ORDER = ["free", "standard", "premium", "limited"];
// Retained for backward compatibility with any external consumer that
// imported these bands (search/filter chips currently use the `tier`
// string directly, not the bands). Marked "legacy" to discourage new use.
export const TIER_PRICE_BANDS = {
  free: { min: 0, max: 0 },
  standard: { min: 1, max: 100 },
  premium: { min: 101, max: 500 },
  limited: { min: 501, max: Infinity },
};

const TIER_ALIASES = {
  free: ["free", "complimentary", "open"],
  standard: ["standard", "basic", "regular"],
  premium: ["premium", "pro", "plus", "gold"],
  limited: ["limited", "limited edition", "le", "exclusive", "platinum"],
};

function tierFromAlias(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return "";
  for (const t of TIER_ORDER) {
    if (TIER_ALIASES[t].includes(v)) return t;
  }
  return "";
}

function tierFromBadgeText(badge) {
  const bg = String(badge || "").trim().toUpperCase();
  if (!bg) return "";
  if (/\b(LIMITED|LE|EXCLUSIVE)\b/.test(bg)) return "limited";
  if (/\bPREMIUM\b/.test(bg)) return "premium";
  if (/\bSTANDARD\b/.test(bg)) return "standard";
  if (/\bFREE\b/.test(bg)) return "free";
  return "";
}

function tierFromPriceBand(price) {
  const p = Math.max(0, Math.floor(Number(price) || 0));
  if (p === 0) return "free";
  if (p <= TIER_PRICE_BANDS.standard.max) return "standard";
  if (p <= TIER_PRICE_BANDS.premium.max) return "premium";
  return "limited";
}

/**
 * resolveTier — full resolution with source attribution. Returns
 * `{ tier, source }` where `source` ∈ "author" | "badge" | "legacy-price".
 * Exposed so the Studio / debug surfaces can show why a given book is
 * styled the way it is. The simple-string variant (`normalizeTier`)
 * remains the public API used by everything else.
 */
export function resolveTier(raw, price, badge) {
  const authorTier = tierFromAlias(raw);
  if (authorTier) return { tier: authorTier, source: "author" };
  const badgeTier = tierFromBadgeText(badge);
  if (badgeTier) return { tier: badgeTier, source: "badge" };
  // Legacy auto-migration: pre-v9.4 books without an explicit author
  // badge keep their previous visual treatment via the old price-band
  // map. Once the Author selects a badge in the Studio, this branch
  // stops firing for that book.
  return { tier: tierFromPriceBand(price), source: "legacy-price" };
}

export function normalizeTier(raw, price, badge) {
  return resolveTier(raw, price, badge).tier;
}

/**
 * detectContentType — scans a normalized book's chapter blocks and
 * returns the dominant media flavour so BookCard / BookCover can show
 * the right lucide icon on the cover.
 *
 *   • any `audio` block      → "audio"
 *   • any `video` / `embed`  → "video"
 *   • otherwise              → "text"
 */
export function detectContentType(book) {
  const chapters = Array.isArray(book?.chapters) ? book.chapters : [];
  let hasAudio = false;
  let hasVideo = false;
  for (const ch of chapters) {
    const blocks = Array.isArray(ch?.blocks) ? ch.blocks : [];
    for (const blk of blocks) {
      const t = String(blk?.type || "").toLowerCase();
      if (t === "audio" || t === "transcript") hasAudio = true;
      else if (t === "video" || t === "embed") hasVideo = true;
    }
  }
  if (hasAudio) return "audio";
  if (hasVideo) return "video";
  return "text";
}

/**
 * Split a markdown document into chapters using `## Heading` as boundaries.
 * Everything before the first `##` is treated as an intro under the book title.
 */
export function markdownToChapters(md) {
  if (!md || typeof md !== "string") return [];
  const lines = md.split(/\r?\n/);
  const chapters = [];
  let current = { title: "Introduction", body: [] };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (current.body.join("").trim() || current.title !== "Introduction") {
        chapters.push({
          title: current.title,
          blocks: [{ type: "markdown", text: current.body.join("\n").trim() }],
        });
      }
      current = { title: m[1].trim(), body: [] };
    } else {
      // Skip H1 (book title) lines when building chapters
      if (/^#\s+/.test(line)) continue;
      current.body.push(line);
    }
  }
  if (current.body.join("").trim() || chapters.length === 0) {
    chapters.push({
      title: current.title,
      blocks: [{ type: "markdown", text: current.body.join("\n").trim() }],
    });
  }
  return chapters.filter((c) => c.blocks.some((b) => b.text));
}

/* --------------------------------- sheets --------------------------------- */
/**
 * filterToLatestRevisionRows — keep only rows whose `revision` matches the
 * highest revision number observed for each slug. Rows without any
 * revision value are treated as revision 0 (legacy/pre-Author-Studio
 * data). The function is a pure filter — input rows are not mutated.
 *
 * Rationale: the Author Studio writes content APPEND-ONLY. Whenever the
 * teacher edits a book, the new version is appended with revision = N+1
 * and the previous rows stay in the sheet as immutable history. At read
 * time we always pick the latest revision so students never see a mix.
 */
function filterToLatestRevisionRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows || [];
  const revOf = (r) => {
    const v = r && (r.revision !== undefined && r.revision !== ""
      ? r.revision
      : (r.rev !== undefined && r.rev !== "" ? r.rev : ""));
    if (v === "" || v === null || v === undefined) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const maxBySlug = new Map();
  for (const r of rows) {
    const slug = (r.slug || r.id || "").toString().trim();
    if (!slug) continue;
    const rev = revOf(r);
    const cur = maxBySlug.get(slug);
    if (cur === undefined || rev > cur) maxBySlug.set(slug, rev);
  }
  return rows.filter((r) => {
    const slug = (r.slug || r.id || "").toString().trim();
    if (!slug) return true; // pass through (will be skipped later)
    return revOf(r) === maxBySlug.get(slug);
  });
}

/** Parse the gviz JSON response (it's JSONP-ish). */
function parseGviz(text) {
  const m = text.match(/google\.visualization\.Query\.setResponse\(([\s\S]+?)\);?\s*$/);
  const jsonStr = m ? m[1] : text;
  return JSON.parse(jsonStr);
}

async function fetchBooksFromSheet(signal) {
  if (!SHEET_ID) {
    console.info("[booksService] no SHEET_ID configured; using local fallback");
    return null;
  }
  try {
    const url = sheetGvizURL(SHEET_ID, SHEET_NAME) + "&t=" + Math.floor(Date.now() / 10000);
    console.info("[booksService] fetching sheet:", url);
    const r = await fetch(url, { method: "GET", signal });
    if (!r.ok) {
      console.warn("[booksService] sheet HTTP", r.status);
      return null;
    }
    const text = await r.text();
    let g;
    try {
      g = parseGviz(text);
    } catch (parseErr) {
      console.warn("[booksService] parseGviz failed", parseErr, "sample:", text.slice(0, 200));
      return null;
    }
    if (g.status !== "ok") {
      console.warn("[booksService] sheet status:", g.status, g.errors);
      return null;
    }
    const cols = (g.table.cols || []).map((c) =>
      (c.label || c.id || "").toString().trim()
    );
    let rows = (g.table.rows || []).map((r) => {
      const obj = {};
      (r.c || []).forEach((cell, i) => {
        const key = cols[i];
        if (!key) return;
        let v = cell ? cell.v : "";
        if (v === null || v === undefined) v = "";
        obj[key] = typeof v === "string" ? v.trim() : v;
      });
      return obj;
    });
    // v7.9 — Build a case-insensitive accessor over each row so columns
    // named "coverImage", "Cover Image", "cover_image", "Cover" all hit
    // the same canonical field. The original case-sensitive keys are
    // preserved on the row too (used as a fallback) and the canonical
    // ones overwrite only when they're empty.
    const NORMALIZE_KEY = (k) =>
      String(k || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    rows.forEach((row) => {
      const indexed = {};
      Object.keys(row).forEach((k) => {
        const nk = NORMALIZE_KEY(k);
        if (nk && indexed[nk] === undefined) indexed[nk] = row[k];
      });
      // Canonical field aliases — sheet headers can use any reasonable
      // variant of these names and they will all resolve here.
      const ALIASES = {
        coverImage:  ["coverimage", "coverurl", "cover", "cv", "thumbnail", "thumb", "image", "imageurl", "picture", "photo", "artwork"],
        badge:       ["badge", "ribbon", "tag", "label"],
        chapter:     ["chapter", "chaptertitle", "section"],
        heading:     ["heading", "subhead", "subheading"],
        body:        ["body", "text", "paragraph", "passage"],
        type:        ["type", "blocktype"],
        media:       ["media", "url"],
        audio:       ["audio", "audiourl", "audiolink"],
        video:       ["video", "videourl", "videolink"],
        embed:       ["embed", "embedurl", "iframe"],
        poster:      ["poster", "thumbnailposter"],
        published:   ["published", "publish", "live", "isactive"],
        section:     ["section", "shelf"],
        slug:        ["slug", "id"],
        title:       ["title", "name"],
        subtitle:    ["subtitle", "tagline"],
        author:      ["author", "writer"],
        coverEmoji:  ["coveremoji", "emoji", "icon"],
        coverGradient: ["covergradient", "gradient"],
        accent:      ["accent", "accentcolor"],
        readingMinutes: ["readingminutes", "minutes", "duration"],
        level:       ["level"],
        newUntil:    ["newuntil", "newdate"],
        format:      ["format"],
        content:     ["content", "markdown"],
        price:       ["price", "cost"],
        contentType:   ["contenttype", "booktype", "kind", "mediatype", "format2"],
        tier:          ["tier", "edition", "class", "category", "plan"],
        options:       ["options", "choices", "answers"],
        answer:        ["answer", "correct", "correctanswer"],
        explain:       ["explain", "explanation", "feedback"],
        speaker:       ["speaker", "role", "character"],
        mediaPosition: ["mediaposition", "mediaalign", "align"],
        // v7.9.10 — Author Studio revision tracking. Higher number = newer.
        // Rows lacking a revision column behave as revision 0 (legacy data).
        revision:      ["revision", "rev", "version", "ver"],
      };
      Object.entries(ALIASES).forEach(([canonical, names]) => {
        if (row[canonical] !== undefined && row[canonical] !== "") return;
        for (const n of names) {
          if (indexed[n] !== undefined && indexed[n] !== "") {
            row[canonical] = indexed[n];
            break;
          }
        }
      });
    });
    console.info(
      `[booksService] fetched ${rows.length} rows (cols: ${cols.filter(Boolean).join(", ")})`
    );
    // v7.9.10 — Author-Studio revision filter.
    //
    // The Author Studio appends new content as additional rows tagged with
    // a higher `revision` number (e.g. existing book is revision 1, an
    // edit is appended as revision 2, etc.). Old rows are NEVER deleted
    // so the sheet keeps a full audit trail. At read time we keep ONLY
    // the rows belonging to the *highest* revision per slug, so students
    // always see the latest published content and never a mix.
    //
    // Backward compatible: rows without any `revision` value are treated
    // as revision 0 (the original schema), so existing sheets work as-is.
    rows = filterToLatestRevisionRows(rows);
    // Rows may have chapter content split across rows keyed by `slug`.
    // Supported columns (flexible):
    //   id, slug, section, title, subtitle, author, coverEmoji, coverGradient,
    //   accent, readingMinutes, level, published, newUntil, format, content,
    //   chapter, heading, body, image, quote, type, media, audio, video, embed,
    //   poster
    const booksBySlug = new Map();
    // v7.9 — book-level fields that we want to PROMOTE from any row in
    // a multi-row book entry. If the first row didn't supply a cover or
    // badge but a later chapter row did, capture it instead of dropping.
    const PROMOTABLE = [
      "coverImage", "badge", "title", "subtitle", "author",
      "coverEmoji", "coverGradient", "accent", "readingMinutes",
      "level", "newUntil", "format", "section", "price", "contentType",
      "tier",
      // v7.9.4 — intentionally EXCLUDE `published`. If the instructor
      // sets published=FALSE on the book's first row, chapter rows
      // leaving the column blank (or mistakenly set to TRUE) must not
      // resurrect the book on the shelf.
    ];
    for (const r of rows) {
      const slug = (r.slug || r.id || "").toString().trim();
      if (!slug) continue;
      // v7.9.3 — Canonicalize `section` on EVERY row. The sheet commonly
      // has "Stories ", "Stories", "story", "Conversations", "Exercises"
      // — normalize to the lowercase singular form the shelves expect.
      if (r.section !== undefined) {
        const raw = String(r.section).trim().toLowerCase();
        let s = raw.replace(/s$/, ""); // plural → singular
        if (s.startsWith("convo")) s = "conversation";
        if (s.startsWith("exercise")) s = "exercise";
        if (s.startsWith("stor")) s = "story";
        r.section = ["story", "conversation", "exercise"].includes(s) ? s : "story";
      }
      if (!booksBySlug.has(slug)) {
        booksBySlug.set(slug, { ...r, chapters: [] });
      }
      const book = booksBySlug.get(slug);
      // Promote any book-level field that is empty on `book` but set on
      // this row — so cover images / badges added on chapter rows still
      // count.
      for (const k of PROMOTABLE) {
        const cur = book[k];
        const incoming = r[k];
        const hasIncoming = incoming !== undefined && incoming !== "";
        const hasCur = cur !== undefined && cur !== "" && cur !== false;
        if (hasIncoming && !hasCur) book[k] = incoming;
      }
      // Any chapter-row hints?
      const chTitle = (r.chapter || r.chapterTitle || "").toString().trim();
      const bType = (r.type || "").toString().trim().toLowerCase();
      const heading = (r.heading || "").toString().trim();
      const body = (r.body || r.text || "").toString().trim();
      // Media-URL-only columns — editors can fill `audio`/`video`/`embed` in
      // a dedicated column without setting `type` explicitly.
      const mediaUrl =
        (r.media || r.audio || r.video || r.embed || r.url || "")
          .toString()
          .trim();
      const poster = (r.poster || r.thumbnail || "").toString().trim();
      let resolvedType = bType;
      // v7.9.3 — If `type` is a non-standard value (e.g. "form", "clip",
      // "asset") but we have a media URL, infer the right block type from
      // the URL itself so the content still renders.
      const KNOWN_TYPES = new Set([
        "heading", "body", "text", "image", "audio", "video", "embed",
        "quote", "example", "paragraph", "paragraphs", "markdown",
        // v7.9.8 — content-type engines:
        "dialog", "mcq", "fillblank", "transcript",
      ]);
      if (resolvedType && !KNOWN_TYPES.has(resolvedType)) resolvedType = "";
      if (!resolvedType && mediaUrl) {
        if (r.audio) resolvedType = "audio";
        else if (r.video) resolvedType = "video";
        else if (r.embed) resolvedType = "embed";
        else {
          // Infer from URL: audio/video extension or iframe host.
          const low = mediaUrl.toLowerCase();
          if (/\.(mp3|m4a|wav|ogg|aac|flac)(\?|$)/.test(low)) resolvedType = "audio";
          else if (/\.(mp4|webm|mov|m3u8)(\?|$)/.test(low)) resolvedType = "video";
          else if (/\.(png|jpe?g|webp|gif|avif|svg)(\?|$)/.test(low)) resolvedType = "image";
          else {
            try {
              const h = new URL(mediaUrl).hostname.toLowerCase();
              if (/youtube\.com$/.test(h) || h === "youtu.be" ||
                  /vimeo\.com$/.test(h) || /loom\.com$/.test(h) ||
                  /dailymotion\.com$/.test(h) || /facebook\.com$/.test(h)) {
                resolvedType = "embed";
              } else if (/dropbox\.com$|dropboxusercontent\.com$/.test(h)) {
                // Dropbox by default → audio (most common use case); the
                // extension check above catches video/image explicitly.
                resolvedType = "audio";
              } else {
                resolvedType = "audio"; // safe default
              }
            } catch { resolvedType = "audio"; }
          }
        }
      }
      // v7.9.2 — auto-promote iframe-only hosts (YouTube / Vimeo / Loom /
      // Dailymotion / Facebook) to `embed` so they render as an iframe,
      // not a raw <video> (which fails for those hosts).
      if (resolvedType === "video" && mediaUrl) {
        try {
          const h = new URL(mediaUrl).hostname.toLowerCase();
          if (
            /youtube\.com$/.test(h) ||
            h === "youtu.be" ||
            /vimeo\.com$/.test(h) ||
            /loom\.com$/.test(h) ||
            /dailymotion\.com$/.test(h) ||
            /facebook\.com$/.test(h)
          ) {
            resolvedType = "embed";
          }
        } catch { /* ignore */ }
      }
      if (chTitle || resolvedType || heading || body || mediaUrl) {
        let ch = book.chapters.find((c) => c.title === (chTitle || "Main"));
        if (!ch) {
          ch = { title: chTitle || "Main", blocks: [] };
          book.chapters.push(ch);
        }
        // v7.7 fix: heading, audio/video/embed, and body are all
        // independent blocks. Previously a row carrying BOTH a media URL
        // AND body text silently dropped the body, so audio chapters
        // rendered without their passage. Each present field now pushes
        // its own block.
        if (heading && !mediaUrl) ch.blocks.push({ type: "heading", text: heading });
        if (mediaUrl && (resolvedType === "audio" || resolvedType === "video" || resolvedType === "embed" || resolvedType === "image")) {
          const blk = { type: resolvedType, text: mediaUrl };
          if (heading) blk.heading = heading;
          if (poster) blk.poster = poster;
          ch.blocks.push(blk);
        }
        // v7.9.8 — new content-type blocks (dialog / mcq / fillblank /
        // transcript). Each reads from dedicated columns but remains
        // fully backward-compatible: a row that doesn't use them
        // behaves exactly as it did before.
        if (resolvedType === "dialog" && body) {
          ch.blocks.push({
            type: "dialog",
            text: body,
            speaker: String(r.speaker || "").trim(),
            audio: r.audio ? String(r.audio).trim() : "",
          });
        } else if (resolvedType === "mcq" && body) {
          const opts = r.options ? String(r.options) : "";
          const ans = r.answer ? String(r.answer).trim() : "";
          if (opts && ans) {
            ch.blocks.push({
              type: "mcq",
              text: body,
              options: opts,
              answer: ans,
              explain: r.explain ? String(r.explain).trim() : "",
            });
          }
        } else if (resolvedType === "fillblank" && body) {
          const ans = r.answer ? String(r.answer).trim() : "";
          if (ans) {
            ch.blocks.push({
              type: "fillblank",
              text: body,
              answer: ans,
              explain: r.explain ? String(r.explain).trim() : "",
            });
          }
        } else if (resolvedType === "transcript" && body) {
          const blk = { type: "transcript", text: body };
          if (r.start !== undefined && r.start !== "") blk.start = Number(r.start);
          if (r.end !== undefined && r.end !== "") blk.end = Number(r.end);
          ch.blocks.push(blk);
        } else if (body) {
          // If the row also declared an audio/video/embed, treat `body`
          // as paragraph text (not the media type) so the passage shows.
          const bodyType =
            resolvedType && !["audio", "video", "embed"].includes(resolvedType)
              ? resolvedType
              : "paragraph";
          ch.blocks.push({ type: bodyType, text: body });
        }
      }
    }
    const arr = [];
    for (const [, v] of booksBySlug) {
      // If we built chapters from rows, switch format to blocks
      if (v.chapters && v.chapters.length > 0 && (!v.content || v.content === "")) {
        v.format = "blocks";
      }
      const nb = normalizeBook(v);
      if (nb) arr.push(nb);
    }
    const publishedBooks = arr.filter((b) => b.published);
    console.info(`[booksService] ${publishedBooks.length} published book(s) ready`);
    return publishedBooks;
  } catch (e) {
    console.warn("[booksService] sheet fetch failed, falling back to JSON", e);
    return null;
  }
}

/* ------------------------------ backend CMS ------------------------------ */
// v8 (Author Studio) — dynamic in-app CMS. Books authored through the React
// Studio live in the project's own FastAPI/MongoDB backend and are merged
// with the existing Google-Sheet catalog so nothing breaks.
/* eslint-disable no-undef */
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "";
/* eslint-enable no-undef */

// v-p0 — auth transport fix (root cause). eduhub-backend's current_student
// dependency is explicitly "cookie first, Bearer fallback (Safari ITP)" —
// verified directly against server.py — and /api/books depends on it, so
// the backend already expects and correctly handles this header. Every
// other authenticated Render call in this codebase attaches it
// (studentAuthService.js's _bearerHeaders(), src/studio/api.js's request())
// except this one. On any device where the cookie doesn't reach the
// backend (Safari ITP being the case the backend's own comment names),
// this fetch previously authenticated as a guest even for a genuinely
// logged-in student, and the backend's guest_content_boundary correctly
// (per its own logic) stripped chapters/content from every priced book in
// the response as a result — not a backend bug, a missing header here.
const STUDENT_TOKEN_KEY = "student_session_token"; // matches studentAuthService.js's LS_KEY
function authHeaders() {
  try {
    const t = localStorage.getItem(STUDENT_TOKEN_KEY);
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}

async function fetchBooksFromBackend(signal) {
  if (!BACKEND_URL) return null;
  try {
    const r = await fetch(`${BACKEND_URL.replace(/\/$/, "")}/api/books`, {
      credentials: "include",
      headers: authHeaders(),
      signal,
    });
    if (!r.ok) {
      console.warn("[booksService] backend HTTP", r.status);
      return null;
    }
    const json = await r.json();
    const books = Array.isArray(json?.books) ? json.books : [];
    // Run the same normalisation the sheet path uses so every downstream
    // consumer (BookCard, reader, ContinueReading) receives consistent data.
    return books.map(normalizeBook).filter(Boolean).filter((b) => b.published);
  } catch (e) {
    console.warn("[booksService] backend fetch failed", e);
    return null;
  }
}

/* ---------------------------------------------------------------------- *
 *  Phase 4 — Static CDN catalog                                          *
 *                                                                        *
 *  Same-origin static asset served by Vercel out of the frontend repo at *
 *  /public/books/index.json. Acts as a FAST FIRST-PAINT layer in front of *
 *  Render /api/books — never the source of truth.                        *
 *                                                                        *
 *  Accepted payload shapes:                                              *
 *    1. { success: true, version: 1, generated_at, source, books: [...] }*
 *    2. { books: [...] }   ← legacy shape, kept for backward compat      *
 *    3. [ ... ]            ← bare array (defensive)                      *
 *                                                                        *
 *  Critical contract:                                                    *
 *    • A static file with `books: []` is treated as UNUSABLE for the     *
 *      initial paint so an empty stub never hides real Author Studio     *
 *      books that are about to arrive from /api/books.                   *
 *    • A 404 / network failure is silent — the existing backend+sheet+   *
 *      cache chain takes over and the student sees no scary error.       *
 *    • Books returned here are normalized through the SAME `normalizeBook`*
 *      used by sheet/backend so every downstream consumer is identical.  *
 *    • Backend `/api/books` still revalidates after a successful static  *
 *      load — see `revalidateCatalog`.                                   *
 * ---------------------------------------------------------------------- */

const STATIC_CATALOG_URL = "/books/index.json";

/**
 * Validate the static payload. Returns true only when the payload is a
 * shape we can safely consume AND it advertises a non-empty `books` array.
 * Empty `books: []` is explicitly invalid for this guard so the caller
 * falls through to backend/cache (see Phase 4 brief: an empty stub must
 * never hide real backend books).
 */
function isValidStaticCatalog(payload) {
  if (!payload) return false;
  if (Array.isArray(payload)) return payload.length > 0;
  if (typeof payload !== "object") return false;
  if (payload.success === false) return false;
  return Array.isArray(payload.books) && payload.books.length > 0;
}

async function fetchBooksFromStaticCatalog(signal) {
  try {
    const r = await fetch(STATIC_CATALOG_URL, {
      // Same-origin static asset — credentials irrelevant, but keep
      // `cache: "no-store"` off so the browser/CDN cache works.
      credentials: "omit",
      signal,
    });
    if (!r.ok) {
      // 404 / 304 / 5xx — silent fall-through to backend.
      return null;
    }
    let json;
    try {
      json = await r.json();
    } catch {
      // Invalid JSON — silent fall-through.
      return null;
    }
    if (!isValidStaticCatalog(json)) {
      // Empty `books: []` (the default stub shipped with the repo) or
      // unrecognised shape — treat as unusable for initial paint.
      return null;
    }
    const rawBooks = Array.isArray(json) ? json : json.books;
    return rawBooks
      .map(normalizeBook)
      .filter(Boolean)
      .filter((b) => b.published !== false);
  } catch {
    // AbortError, network failure, CORS — silent fall-through.
    return null;
  }
}

/* ---------------------------------------------------------------------- *
 *  v-perf — resilient catalog loading.                                   *
 *                                                                        *
 *  Goals (the set of books returned and the normalized book shape are    *
 *  UNCHANGED — only the *timing* and *resilience* of the fetch change):  *
 *    1. Serve the last successful catalog instantly when present.        *
 *    2. Refresh quietly in the background (stale-while-revalidate).       *
 *    3. Coalesce concurrent callers into ONE network round-trip.         *
 *    4. Time-box the network per-situation (see timeout policy below) so a  *
 *       Render free-tier cold start never freezes the Reader, while a       *
 *       first-time user with no cache still waits long enough to actually   *
 *       receive books instead of seeing an empty shelf.                     *
 *    5. NEVER overwrite a good cache with an empty/failed result.         *
 *                                                                        *
 *  The sheet ∪ backend merge (backend slug wins on collision) is the     *
 *  same as before; getBookBySlug() is unaffected.                        *
 * ---------------------------------------------------------------------- */

// ── Timeout policy (v2) ──────────────────────────────────────────────
// The previous single 6 s ceiling was applied to EVERY caller, including a
// first-time user with no cache. Against a sleeping Render free instance —
// which the dashboard itself warns "can delay requests by 50 seconds or
// more" — 6 s aborts the cold start long before it can answer, so a brand-
// new student saw EMPTY shelves. We now size the wait to the situation:
//
//   • COLD_START — the ONLY path that can ever surface an empty list. Used
//     when there is no usable cache, so the user has nothing else to see.
//     Generous enough to ride out a real Render cold start, yet still
//     bounded so a genuinely-down backend can't hang the UI forever.
//   • FORCE_REFRESH — the manual "refresh" button. The user is waiting, but
//     a good cache is the safety net, so keep it responsive and fall back
//     to cache if Render is cold.
//   • BACKGROUND — stale-while-revalidate. Never blocks the user (they were
//     already served from cache), so it is generous: a cold-start refresh
//     can run to completion and self-heal the cache for next time.
//
// All three are far "safer than 6 seconds" for the no-cache case while
// preserving the instant-from-cache experience for everyone else. Tunable.
const COLD_START_TIMEOUT_MS   = 60000; // 60 s — first load, no cache to fall back on
const FORCE_REFRESH_TIMEOUT_MS = 15000; // 15 s — manual refresh (cache is the net)
const BACKGROUND_TIMEOUT_MS   = 60000; // 60 s — non-blocking SWR refresh

// Module-level in-flight promise — the dedup gate shared by every caller
// (LibraryPage, ReaderPage, CoverPrefetcher, LibraryShowcase) and by both
// the foreground and the background (SWR) refresh paths. While a refresh is
// running, additional callers attach to the same promise instead of firing
// their own (thundering-herd) request at the backend.
// v-p0 — split by auth scope (same reasoning as cacheKey() above): a guest
// revalidation in flight must never let an authenticated caller attach to
// and inherit ITS response, or vice versa.
const _inFlightCatalog = { guest: null, auth: null };

/**
 * Run `task(signal)` but abort it after `ms`. Resolves with whatever the
 * task resolves to; on timeout the AbortController fires and each fetch
 * helper (which already wraps fetch in try/catch) returns null for the
 * source that didn't finish in time. Degrades gracefully where
 * AbortController is unavailable.
 */
function withTimeout(task, ms) {
  if (typeof AbortController === "undefined") {
    return Promise.race([
      Promise.resolve().then(() => task(undefined)),
      new Promise((resolve) =>
        setTimeout(() => resolve({ books: null, ok: false }), ms)
      ),
    ]);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try { controller.abort(); } catch { /* ignore */ }
  }, ms);
  return Promise.resolve()
    .then(() => task(controller.signal))
    .finally(() => clearTimeout(timer));
}

/**
 * One network pass: fetch sheet + backend (+ static CDN catalog, Phase 4)
 * in parallel and merge them. Returns `{ books, ok }`:
 *   • ok=false when ALL three sources were unreachable (null) — so the
 *     caller keeps the last good cache and never clobbers it.
 *   • ok=true otherwise. A successful-but-empty merge is reported as
 *     ok=true with an empty array, but the caller still refuses to persist
 *     it (see revalidateCatalog) — protecting against the "all books
 *     disappeared" failure mode.
 *
 * Merge priority (lower → higher; later overwrites earlier):
 *   1. Static CDN catalog  (fast, may be stale)
 *   2. Google Sheet         (legacy fallback if configured)
 *   3. Render /api/books    (source-of-truth — wins all collisions)
 *
 * This guarantees that any book that is newer in Mongo/Author Studio
 * replaces a stale entry in the static catalog. A backend-only book that
 * is not yet in /books/index.json still appears in the merged result.
 */
async function fetchFreshCatalog(signal) {
  const [backendBooks, sheetBooks, staticBooks] = await Promise.all([
    fetchBooksFromBackend(signal),
    fetchBooksFromSheet(signal),
    fetchBooksFromStaticCatalog(signal),
  ]);
  if (backendBooks == null && sheetBooks == null && staticBooks == null) {
    return { books: null, ok: false };
  }
  const merged = new Map();
  // Static CDN catalog goes in first — lowest priority.
  for (const b of staticBooks || []) {
    if (b?.slug) merged.set(b.slug, b);
  }
  // Sheet next.
  for (const b of sheetBooks || []) {
    if (b?.slug) merged.set(b.slug, b);
  }
  // Backend last — wins every collision, surfaces newly published books.
  for (const b of backendBooks || []) {
    if (b?.slug) merged.set(b.slug, b);
  }
  return { books: Array.from(merged.values()), ok: true };
}

/**
 * Revalidate the catalog against the network — deduped + time-boxed.
 * `timeoutMs` is chosen by the caller to match its situation (cold-start /
 * manual-refresh / background — see the timeout policy above). Persists +
 * stamps ONLY when the fresh result is non-empty, so a transient failure
 * (or a momentarily empty response) can never wipe a previously good
 * catalog. Resolves to the fresh non-empty array, or null when there was
 * nothing good to adopt. Never rejects.
 *
 * NOTE on dedup: when a refresh is already in flight, additional callers
 * attach to it and inherit ITS timeout. In practice the caller populations
 * never mix (a no-cache cold-start caller can only exist when there is no
 * cache, at which point no background/force caller exists, and vice-versa),
 * so the inherited timeout is always the appropriate one.
 */
function revalidateCatalog(timeoutMs, isAuthenticated) {
  const scope = isAuthenticated ? "auth" : "guest";
  if (_inFlightCatalog[scope]) return _inFlightCatalog[scope];
  const work = (async () => {
    let result;
    try {
      result = await withTimeout(
        (signal) => fetchFreshCatalog(signal),
        timeoutMs
      );
    } catch {
      result = { books: null, ok: false };
    }
    const fresh = result && Array.isArray(result.books) ? result.books : null;
    if (fresh && fresh.length > 0) {
      // v7.9.4 — stamp new slugs so freshly-added books light up for 7 days
      try { stampFirstSeen(fresh.map((b) => b.slug)); } catch { /* ignore */ }
      saveCache(fresh, isAuthenticated); // saveCache itself refuses empty/invalid payloads
      return fresh;
    }
    // Empty or failed → do NOT persist; preserve whatever good cache exists.
    return null;
  })();
  _inFlightCatalog[scope] = work;
  // Release the gate once settled so the next read can refresh again.
  work.then(
    () => { _inFlightCatalog[scope] = null; },
    () => { _inFlightCatalog[scope] = null; }
  );
  return work;
}

/* ---------------------------------- api ---------------------------------- */
// v-p0 — `isAuthenticated` is REQUIRED context from the caller (every
// caller already has it from useAuth()), not inferred from token presence.
// See the cacheKey() comment above for why a token-presence heuristic is
// unreliable. Defaults to false (guest) only so existing call sites that
// haven't been updated yet fail toward the MORE restrictive, never-shows-
// stale-authenticated-content side, never the other way.
export async function getAllBooks({ forceRefresh = false, isAuthenticated = false } = {}) {
  const entry = loadCacheEntry(isAuthenticated);
  const cached =
    entry && Array.isArray(entry.data) && entry.data.length > 0
      ? entry.data
      : null;
  const age = entry ? Date.now() - entry.ts : Infinity;

  // ── No usable cache ────────────────────────────────────────────────
  // Phase 4 — fast first-paint via the Vercel-hosted /books/index.json
  // static catalog. The static asset is same-origin and typically lands in
  // under 100 ms even from a cold edge, so we try it FIRST whenever the
  // localStorage cache is missing. If it yields a non-empty array we:
  //   1. Return it immediately for the initial paint, AND
  //   2. Kick off a background revalidation against Render /api/books so
  //      newly published Author Studio books appear within seconds and
  //      backend results overwrite any stale static entries on the next
  //      read (saved to cache by revalidateCatalog).
  //
  // If the static catalog is missing, invalid, or empty (`books: []`), we
  // FALL THROUGH to the original cold-start backend wait so an empty stub
  // can never hide real backend books — see the Phase 4 brief.
  if (!cached) {
    let staticBooks = null;
    try {
      staticBooks = await fetchBooksFromStaticCatalog();
    } catch {
      staticBooks = null;
    }
    if (Array.isArray(staticBooks) && staticBooks.length > 0) {
      // Persist for the next visit and stamp NEW badges; SWR keeps things
      // honest in the background.
      try { stampFirstSeen(staticBooks.map((b) => b.slug)); } catch { /* ignore */ }
      saveCache(staticBooks, isAuthenticated);
      // Background backend revalidation — newly published Author Studio
      // books arrive on the *next* read (revalidateCatalog writes to
      // localStorage so the very next getAllBooks() call returns merged
      // fresh data, with backend winning on slug collisions).
      revalidateCatalog(BACKGROUND_TIMEOUT_MS, isAuthenticated).catch(() => {
        /* background — never throws to caller */
      });
      return staticBooks;
    }

    // No static catalog (or empty) → original cold-start path. The
    // generous timeout gives a sleeping Render free instance time to
    // answer before we ever surface an empty shelf — this is the ONLY
    // path that can return [].
    const fresh = await revalidateCatalog(COLD_START_TIMEOUT_MS, isAuthenticated);
    if (Array.isArray(fresh) && fresh.length > 0) return fresh;
    // Last resort, only after the generous wait: re-read storage in case a
    // concurrent tab populated it, then fall back to whatever is there
    // (possibly empty — a genuine first-ever load with no network).
    const after = loadCacheEntry(isAuthenticated);
    if (after && Array.isArray(after.data) && after.data.length > 0) {
      return after.data;
    }
    return after && Array.isArray(after.data) ? after.data : [];
  }

  // ── From here we HAVE a good cache → the user always gets books NOW. ──

  // Fast path — fresh within the live-editing window: serve cache, no
  // network. Identical to the original 10 s behaviour.
  if (!forceRefresh && age < CACHE_TTL) {
    return cached;
  }

  // Manual refresh — the user asked for fresh data and is waiting. Await a
  // shorter, responsive refresh; fall back to the good cache if Render is
  // cold so the button never hangs and books never vanish.
  if (forceRefresh) {
    const fresh = await revalidateCatalog(FORCE_REFRESH_TIMEOUT_MS, isAuthenticated);
    if (Array.isArray(fresh) && fresh.length > 0) return fresh;
    return cached;
  }

  // Stale-while-revalidate — hand back the good cache INSTANTLY and refresh
  // quietly in the background (non-blocking; generous timeout so a cold-
  // start refresh can finish and self-heal the cache for next time).
  revalidateCatalog(BACKGROUND_TIMEOUT_MS, isAuthenticated).catch(() => {
    /* background — never throws to caller */
  });
  return cached;
}

export async function getBookBySlug(slug, { isAuthenticated = false } = {}) {
  if (!slug) return null;
  const all = await getAllBooks({ isAuthenticated });
  return all.find((b) => b.slug === slug) || null;
}

/**
 * Merge the in-app books catalog with the Library backend's existing shelf
 * content (the legacy items with external `link` fields).
 *
 *  • Any book present in the catalog appears with an `inAppSlug` — the
 *    Library will route those to /library/read/:slug.
 *  • Any legacy item without a catalog match keeps its external `link`.
 *  • Catalog-only books are added to their section so new uploads show up
 *    immediately without any backend change.
 */
export function mergeCatalogIntoShelves(legacyShelves, catalog) {
  // v7.9.1 — Library now ONLY surfaces books that exist in the sheet
  // catalog (i.e. books with real fetchable in-app content). Any legacy
  // GAS `content` item that doesn't have a catalog match is a redirect-
  // only entry (external `link`) — those are intentionally dropped.
  const out = { story: [], conversation: [], exercise: [] };

  // Build a lookup of legacy items by (section + lowercased title) so
  // we can enrich a catalog book with any pre-existing legacy metadata
  // (e.g. progress, subtitle) when the instructor already had the book
  // listed on the old backend.
  const byTitle = new Map();
  ["story", "conversation", "exercise"].forEach((k) => {
    (legacyShelves?.[k] || []).forEach((it) => {
      const key = `${k}::${String(it.title || "").toLowerCase().trim()}`;
      if (!byTitle.has(key)) byTitle.set(key, it);
    });
  });

  for (const b of catalog || []) {
    if (!b || !b.published) continue;
    const section = ["story", "conversation", "exercise"].includes(b.section)
      ? b.section
      : "story";
    const key = `${section}::${String(b.title).toLowerCase().trim()}`;
    const legacy = byTitle.get(key) || {};
    out[section].push({
      title: b.title,
      subtitle: b.subtitle || legacy.subtitle || "",
      emoji: b.coverEmoji || legacy.emoji,
      coverImage: b.coverImage || legacy.coverImage || "",
      badge: b.badge || legacy.badge || "",
      // Intentionally NO `link` — redirect-only items are no longer surfaced.
      inAppSlug: b.slug,
      price: b.price,
      tier: b.tier || "free",
      _book: b,
      _contentType: b._contentType || detectContentType(b),
      _isNew: isBookNew(b) || legacy._isNew || false,
      progress: typeof legacy.progress === "number" ? legacy.progress : 0,
    });
  }

  return out;
}

/**
 * isBookNew — "new book" detection. v7.9.4 introduces a 2-tier system:
 *
 *   1) Instructor-declared: `newUntil` column — while the date is in the
 *      future the book is flagged NEW. Authoritative.
 *
 *   2) Client-discovered: a scalable per-device "first seen" ledger in
 *      localStorage. The FIRST time we observe a slug on this browser we
 *      stamp it with the current timestamp; for the next 7 days the book
 *      wears the golden live badge. This means any book added to the
 *      Sheet — even weeks from now — lights up for existing students the
 *      moment it appears, without any instructor effort.
 */
const FIRST_SEEN_KEY = "eduhub_book_first_seen_v1";
const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function readFirstSeen() {
  try {
    return JSON.parse(localStorage.getItem(FIRST_SEEN_KEY) || "{}") || {};
  } catch { return {}; }
}
function writeFirstSeen(map) {
  try { localStorage.setItem(FIRST_SEEN_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}
/** Stamp every currently-known slug; call once per catalog load. */
export function stampFirstSeen(slugs) {
  const map = readFirstSeen();
  const now = Date.now();
  let changed = false;
  for (const s of slugs || []) {
    if (s && map[s] === undefined) {
      map[s] = now;
      changed = true;
    }
  }
  if (changed) writeFirstSeen(map);
}

function isBookNew(book) {
  if (!book?.slug) return false;
  // Tier 1 — instructor flag
  if (book.newUntil) {
    const t = new Date(book.newUntil).getTime();
    if (!Number.isNaN(t) && Date.now() < t) return true;
  }
  // Tier 2 — client-discovered "first-seen < 7 days ago"
  const map = readFirstSeen();
  const seenAt = map[book.slug];
  if (seenAt && Date.now() - seenAt < NEW_WINDOW_MS) return true;
  return false;
}

export const BOOKS_CONFIG = {
  SHEET_ID,
  SHEET_NAME,
  LOCAL_URL,
  STATIC_CATALOG_URL, // Phase 4 — Vercel public/books/index.json
  sheetUrl: SHEET_ID ? sheetGvizURL(SHEET_ID, SHEET_NAME) : null,
};

// Phase 4 exports — exposed for tests / dev tooling. Library code paths
// use these via getAllBooks() and never need to call them directly.
export {
  fetchBooksFromStaticCatalog,
  isValidStaticCatalog,
  STATIC_CATALOG_URL,
};
