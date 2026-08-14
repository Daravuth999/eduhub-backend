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
const CACHE_KEY_BASE = "eduhub_books_cache_v2";
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

function cacheKey() {
  return `${CACHE_KEY_BASE}:${SHEET_ID || "local"}:${SHEET_NAME || "Books"}`;
}

function saveCache(data) {
  try {
    localStorage.setItem(cacheKey(), JSON.stringify({ ts: Date.now(), data }));
  } catch { /* ignore */ }
}
function loadCache() {
  try {
    const raw = localStorage.getItem(cacheKey());
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts < CACHE_TTL) return data;
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
              // v9.6 FIX G — preserve backend-provided per-word timing
              // arrays. The Python backend (server.py "generate AI voice"
              // endpoint) emits ElevenLabs character-level alignment
              // collapsed to word-level on each transcript block as
              // `wordTimestamps: [{word, start, end}, ...]`. Without
              // this passthrough the reader silently fell back to the
              // lossy linear-interpolation path, which drifts visibly
              // on long chapters. The reader's TranscriptParagraph
              // already knows how to consume the exact timings.
              if (Array.isArray(blk.wordTimestamps) && blk.wordTimestamps.length > 0) {
                // Defensive: keep only entries with finite numeric
                // start/end so the consumer doesn't have to re-validate.
                const wt = [];
                for (const w of blk.wordTimestamps) {
                  if (!w || typeof w !== "object") continue;
                  const ws = Number(w.start);
                  const we = Number(w.end);
                  if (Number.isFinite(ws) && Number.isFinite(we) && we >= ws) {
                    wt.push({
                      word: w.word != null ? String(w.word) : "",
                      start: ws,
                      end: we,
                    });
                  }
                }
                if (wt.length > 0) out.wordTimestamps = wt;
              }
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

async function fetchBooksFromSheet() {
  if (!SHEET_ID) {
    console.info("[booksService] no SHEET_ID configured; using local fallback");
    return null;
  }
  try {
    const url = sheetGvizURL(SHEET_ID, SHEET_NAME) + "&t=" + Math.floor(Date.now() / 10000);
    console.info("[booksService] fetching sheet:", url);
    const r = await fetch(url, { method: "GET" });
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
        "quote", "example",
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

/* --------------------------------- local --------------------------------- */
// Intentionally removed in v7.9.1 — the Library is strictly sheet-driven now.
// The former /books/index.json fallback shipped demo content which could leak
// into the live shelves when the sheet was temporarily unreachable.

/* ---------------------------------- api ---------------------------------- */
export async function getAllBooks({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = loadCache();
    if (cached) return cached;
  }
  // v7.9.1 — Library is now strictly sheet-driven. The local demo/sample
  // fallback has been removed so the shelves only ever show real content
  // the instructor publishes from Google Sheets.
  const sheetBooks = await fetchBooksFromSheet();
  const books = Array.isArray(sheetBooks) ? sheetBooks : [];
  // v7.9.4 — stamp new slugs so freshly-added books light up for 7 days
  stampFirstSeen(books.map((b) => b.slug));
  saveCache(books);
  return books;
}

export async function getBookBySlug(slug) {
  if (!slug) return null;
  const all = await getAllBooks();
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
  sheetUrl: SHEET_ID ? sheetGvizURL(SHEET_ID, SHEET_NAME) : null,
};
