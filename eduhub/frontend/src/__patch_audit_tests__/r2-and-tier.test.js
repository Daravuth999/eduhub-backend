/**
 * v9.4 Patch audit — unit tests for R2 audio support + Author-driven
 * visual treatment refactor. Designed to be runnable with the standard
 * CRA test harness (`craco test`).
 */
import {
  normalizeMediaUrl,
  isR2PublicHost,
  isDirectAudioUrl,
} from "../eduhub/pages/library/reader/media-urls";
import {
  normalizeTier,
  resolveTier,
} from "../eduhub/pages/library/books/booksService";

/* ─────────────── normalizeMediaUrl / R2 ─────────────── */

describe("normalizeMediaUrl — R2 + Dropbox + Drive parity", () => {
  test("Cloudflare R2 .r2.dev mp3 URL passes through unchanged", () => {
    const u = "https://pub-a32e06b860c14582adf3619ade1a4346.r2.dev/Audio%20Books/ElevenLabs_Blank_6_docx.mp3";
    expect(normalizeMediaUrl(u)).toBe(u);
  });
  test("Cloudflare R2 .r2.cloudflarestorage.com wav URL passes through unchanged", () => {
    const u = "https://my-bucket.eu.r2.cloudflarestorage.com/clips/track.wav";
    expect(normalizeMediaUrl(u)).toBe(u);
  });
  test("R2 URL with raw spaces in path gets percent-encoded", () => {
    const raw = "https://pub-abc.r2.dev/Audio Books/My Track.mp3";
    const out = normalizeMediaUrl(raw);
    expect(out).toBe("https://pub-abc.r2.dev/Audio%20Books/My%20Track.mp3");
  });
  test("Dropbox share URL is rewritten to dl host", () => {
    const u = "https://www.dropbox.com/s/abc/track.mp3?dl=0";
    const out = normalizeMediaUrl(u);
    expect(out).toContain("dl.dropboxusercontent.com");
    expect(out).toContain("raw=1");
    expect(out).not.toContain("dl=0");
  });
  test("Drive share URL collapses to uc?export=download", () => {
    const u = "https://drive.google.com/file/d/AAA111BBB/view";
    expect(normalizeMediaUrl(u)).toBe(
      "https://drive.google.com/uc?export=download&id=AAA111BBB"
    );
  });
  test("Empty / non-string input returns empty string", () => {
    expect(normalizeMediaUrl("")).toBe("");
    expect(normalizeMediaUrl(null)).toBe("");
    expect(normalizeMediaUrl(undefined)).toBe("");
  });
  test("Malformed URL returns the trimmed input unchanged", () => {
    expect(normalizeMediaUrl("  not a url  ")).toBe("not a url");
  });
});

describe("isR2PublicHost", () => {
  test("matches pub-*.r2.dev", () => {
    expect(isR2PublicHost("pub-a32e06b860c14582adf3619ade1a4346.r2.dev")).toBe(true);
  });
  test("matches *.r2.cloudflarestorage.com", () => {
    expect(isR2PublicHost("bucket.eu.r2.cloudflarestorage.com")).toBe(true);
  });
  test("rejects dropbox / youtube / random hosts", () => {
    expect(isR2PublicHost("dropbox.com")).toBe(false);
    expect(isR2PublicHost("youtube.com")).toBe(false);
    expect(isR2PublicHost("example.com")).toBe(false);
    expect(isR2PublicHost("")).toBe(false);
  });
});

describe("isDirectAudioUrl", () => {
  test("mp3 / wav / m4a are direct audio", () => {
    expect(isDirectAudioUrl("https://pub-x.r2.dev/a.mp3")).toBe(true);
    expect(isDirectAudioUrl("https://pub-x.r2.dev/a.WAV")).toBe(true);
    expect(isDirectAudioUrl("https://example.com/x.m4a?t=1")).toBe(true);
  });
  test("YouTube / Vimeo / random pages are NOT direct audio", () => {
    expect(isDirectAudioUrl("https://www.youtube.com/watch?v=abc")).toBe(false);
    expect(isDirectAudioUrl("https://vimeo.com/12345")).toBe(false);
    expect(isDirectAudioUrl("https://example.com/page")).toBe(false);
  });
});

/* ─────────────── normalizeTier / Author-driven treatment ─────────────── */

describe("resolveTier — Author badge is single source of truth", () => {
  test("Author-set tier 'premium' wins regardless of price=0", () => {
    expect(resolveTier("premium", 0, "")).toEqual({
      tier: "premium",
      source: "author",
    });
  });
  test("Author-set tier 'standard' wins regardless of price=750 (would be limited)", () => {
    expect(resolveTier("standard", 750, "")).toEqual({
      tier: "standard",
      source: "author",
    });
  });
  test("Author-set tier alias 'gold' maps to premium", () => {
    expect(resolveTier("gold", 0, "")).toEqual({
      tier: "premium",
      source: "author",
    });
  });
  test("Author-set tier alias 'LE' maps to limited", () => {
    expect(resolveTier("LE", 0, "")).toEqual({
      tier: "limited",
      source: "author",
    });
  });
  test("Empty tier + badge='LIMITED EDITION' resolves via badge to limited", () => {
    expect(resolveTier("", 50, "LIMITED EDITION")).toEqual({
      tier: "limited",
      source: "badge",
    });
  });
  test("Empty tier + badge='PREMIUM' resolves via badge to premium", () => {
    expect(resolveTier("", 50, "PREMIUM")).toEqual({
      tier: "premium",
      source: "badge",
    });
  });
  test("Empty tier + empty badge + price=0 → legacy free", () => {
    expect(resolveTier("", 0, "")).toEqual({
      tier: "free",
      source: "legacy-price",
    });
  });
  test("Empty tier + empty badge + price=50 → legacy standard", () => {
    expect(resolveTier("", 50, "")).toEqual({
      tier: "standard",
      source: "legacy-price",
    });
  });
  test("Empty tier + empty badge + price=300 → legacy premium", () => {
    expect(resolveTier("", 300, "")).toEqual({
      tier: "premium",
      source: "legacy-price",
    });
  });
  test("Empty tier + empty badge + price=900 → legacy limited", () => {
    expect(resolveTier("", 900, "")).toEqual({
      tier: "limited",
      source: "legacy-price",
    });
  });
});

describe("normalizeTier — string-only wrapper preserves contract", () => {
  test("returns plain string", () => {
    expect(normalizeTier("premium", 0, "")).toBe("premium");
    expect(normalizeTier("", 0, "")).toBe("free");
    expect(normalizeTier("", 50, "")).toBe("standard");
  });
  test("price NEVER overrides an Author-set tier (new rule)", () => {
    // Pre-v9.4 this would have also been "standard" (because Author-set
    // wins) but the rule is now load-bearing — assert it explicitly.
    expect(normalizeTier("standard", 9999, "")).toBe("standard");
    expect(normalizeTier("free", 9999, "")).toBe("free");
  });
});
