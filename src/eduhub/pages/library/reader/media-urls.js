/**
 * media-urls.js — pure URL helpers for the reader's media blocks.
 *
 * Extracted in v9.4 so they can be unit-tested in isolation without
 * pulling in <Markdown> + lucide-react + the audio context, all of
 * which need a DOM. The functions remain re-exported from
 * ChapterBlocks.jsx to preserve every existing import path.
 */

/**
 * Convert a "share" URL (Dropbox / Google Drive) into a direct-content
 * URL usable as an <audio src> / <video src>. Cloudflare R2 public URLs
 * are passed through (only normalising any unencoded path segments).
 * Anything else is returned unchanged.
 */
export function normalizeMediaUrl(raw) {
  if (!raw || typeof raw !== "string") return "";
  const u = raw.trim();
  try {
    const url = new URL(u);
    if (/(^|\.)dropbox\.com$/i.test(url.hostname)) {
      url.hostname = "dl.dropboxusercontent.com";
      url.searchParams.delete("dl");
      if (!url.searchParams.has("raw")) url.searchParams.set("raw", "1");
      return url.toString();
    }
    if (/(^|\.)drive\.google\.com$/i.test(url.hostname)) {
      let id = "";
      const m = url.pathname.match(/\/file\/d\/([^/]+)/);
      if (m) id = m[1];
      if (!id && url.searchParams.get("id")) id = url.searchParams.get("id");
      if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
    }
    // v9.4 — Cloudflare R2 public bucket support.
    //
    // R2 public dev URLs (`https://pub-<hash>.r2.dev/<key>`) serve the
    // object body verbatim with the correct Content-Type (audio/mpeg,
    // audio/wav, audio/mp4 …), so they require no URL rewriting — they
    // are already a direct-content URL. We pass them through unchanged
    // and rely on the <audio> element's own MIME negotiation.
    //
    // We also guarantee the path component is percent-encoded so that
    // R2 keys containing spaces or unicode (e.g. "Audio Books/My Track.mp3")
    // never produce a malformed request when an author pastes the raw key.
    if (isR2PublicHost(url.hostname)) {
      try {
        const segments = url.pathname.split("/").map((seg) => {
          if (!seg) return seg;
          try { return encodeURIComponent(decodeURIComponent(seg)); }
          catch { return encodeURIComponent(seg); }
        });
        url.pathname = segments.join("/");
        return url.toString();
      } catch {
        return u;
      }
    }
    return u;
  } catch {
    return u;
  }
}

/**
 * Convert YouTube / Vimeo / Loom share URLs into embeddable iframe URLs.
 * Any other URL is returned unchanged.
 */
export function toEmbedUrl(raw) {
  if (!raw || typeof raw !== "string") return "";
  const u = raw.trim();
  try {
    const url = new URL(u);
    if (/youtube\.com$/i.test(url.hostname) || url.hostname === "youtu.be") {
      let id = "";
      if (url.hostname === "youtu.be") id = url.pathname.replace(/^\//, "");
      else if (url.pathname.startsWith("/watch")) id = url.searchParams.get("v") || "";
      else if (url.pathname.startsWith("/shorts/")) id = url.pathname.replace("/shorts/", "");
      else if (url.pathname.startsWith("/embed/")) return u;
      if (id) return `https://www.youtube.com/embed/${id}`;
    }
    if (/vimeo\.com$/i.test(url.hostname) && !url.hostname.startsWith("player.")) {
      const id = url.pathname.replace(/^\//, "").split("/")[0];
      if (/^\d+$/.test(id)) return `https://player.vimeo.com/video/${id}`;
    }
    if (/loom\.com$/i.test(url.hostname) && url.pathname.startsWith("/share/")) {
      return u.replace("/share/", "/embed/");
    }
    return u;
  } catch {
    return u;
  }
}

/**
 * v9.4 — Public-host predicate for Cloudflare R2 buckets.
 *
 * Matches the two public URL shapes Cloudflare exposes:
 *   • `pub-<hash>.r2.dev`            — default public dev domain
 *   • `<anything>.r2.cloudflarestorage.com` — custom S3-compatible endpoint
 */
export function isR2PublicHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return /(^|\.)r2\.dev$/.test(h) || /(^|\.)r2\.cloudflarestorage\.com$/.test(h);
}

/**
 * v9.4 — Returns true when the URL points at a direct audio file we can
 * feed into <audio src=…>. Used as a defensive check by audio block
 * renderers so a malformed sheet entry (e.g. a YouTube link mis-typed
 * into the audio column) is rendered as an embed instead of a broken
 * <audio> tag.
 */
export function isDirectAudioUrl(raw) {
  if (!raw || typeof raw !== "string") return false;
  try {
    const url = new URL(raw.trim());
    const tail = url.pathname.toLowerCase() + url.search + url.hash;
    return /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|weba)(\?|$|#)/.test(tail);
  } catch {
    return false;
  }
}

/**
 * v9.4 — Iframe-only hosts that cannot play through <video>/<audio>.
 */
export function isIframeHost(raw) {
  try {
    const h = new URL(raw).hostname.toLowerCase();
    return (
      /youtube\.com$/.test(h) ||
      h === "youtu.be" ||
      /vimeo\.com$/.test(h) ||
      /loom\.com$/.test(h) ||
      /dailymotion\.com$/.test(h) ||
      /facebook\.com$/.test(h)
    );
  } catch {
    return false;
  }
}
