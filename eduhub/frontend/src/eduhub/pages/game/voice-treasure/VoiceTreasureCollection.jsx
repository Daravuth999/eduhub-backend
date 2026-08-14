import { useEffect, useState } from "react";
import { Library, Lock, Check, Calendar } from "lucide-react";
import { useVoiceTreasureTitle, VoiceTreasureIdentity } from "./useVoiceTreasureIdentity";
import VTStage from "./VTStage";
import * as api from "./api";
import "./VoiceTreasure.css";

/**
 * Pass B.2.1 — Collection truth corrections.
 *
 * Backend authoritative response shape (from voice_treasure_reward_tools.py
 * GET /voice-treasure/collection):
 *
 *   {
 *     "collectibles": [
 *       { "card_id": "first_voice", "name": "First Voice Card",
 *         "granted_at": "2026-05-01T12:34:56Z" }
 *     ],
 *     "first_voice_card_owned": true
 *   }
 *
 * Pass B.2 incorrectly read `first_voice_card_acquired_at` (no such field)
 * and hardcoded a fake category/rarity descriptor (the API never returns
 * rarity or category). Both are corrected here:
 *
 *   • acquisition date now derives from collectibles[].granted_at for the
 *     canonical FIRST_VOICE_CARD_ID = "first_voice".
 *   • the date renders only when present AND parseable as a real Date.
 *   • rarity / category / tier / series / class / scarcity are NOT shown —
 *     the API does not return them and we do not fabricate.
 */
const FIRST_VOICE_CARD_ID = "first_voice"; // mirrors backend constant

export default function VoiceTreasureCollection() {
  useVoiceTreasureTitle("Collection");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null); // "first-voice-card" | null

  useEffect(() => {
    let alive = true;
    api.getCollection()
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e?.message || "Could not load collection."); });
    return () => { alive = false; };
  }, []);

  if (error) {
    return (
      <VTStage>
        <VoiceTreasureIdentity subtitle="Collection" />
        <div className="vt-error" data-testid="vt-collection-error">{error}</div>
      </VTStage>
    );
  }
  if (data === null) {
    return (
      <VTStage>
        <VoiceTreasureIdentity subtitle="Collection" />
        <div className="vt-dim" data-testid="vt-collection-loading">Loading…</div>
      </VTStage>
    );
  }

  // ── Truth derivation ──────────────────────────────────────────────
  // Prefer the authoritative `collectibles[]` array; fall back to the
  // top-level boolean (still authoritative) when no item rows exist.
  const collectibles = Array.isArray(data.collectibles) ? data.collectibles : [];
  const firstVoiceRow = collectibles.find((c) => c && c.card_id === FIRST_VOICE_CARD_ID) || null;
  const owned = !!(firstVoiceRow || data.first_voice_card_owned);
  const grantedAtRaw = firstVoiceRow ? firstVoiceRow.granted_at : null;
  const grantedAt = (() => {
    if (!grantedAtRaw) return null;
    const t = new Date(grantedAtRaw);
    return Number.isFinite(t.getTime()) ? t : null;
  })();

  return (
    <VTStage>
      <VoiceTreasureIdentity subtitle="Collection" />
      <div className="vt-panel vt-card-glow vt-collection" data-testid="vt-collection">
        <div className="vt-collection-head">
          <Library size={18} aria-hidden="true" />
          <div>
            <div className="vt-h1">Your collection</div>
            <p className="vt-sub" data-testid="vt-collection-sub">
              {owned
                ? "You've earned the First Voice Card. More collectibles will appear as new missions are added."
                : "Complete a paid mission with a strong response to earn your first collectible."}
            </p>
          </div>
        </div>

        <div className="vt-collection-grid" data-testid="vt-collection-grid">
          <button
            type="button"
            className={`vt-coll-card${owned ? " vt-coll-card--owned" : ""}`}
            data-testid="vt-card-first-voice"
            data-owned={owned ? "1" : "0"}
            aria-pressed={selected === "first-voice-card"}
            onClick={() => setSelected((s) => (s === "first-voice-card" ? null : "first-voice-card"))}
          >
            <VoiceCardArt owned={owned} />
            <div className="vt-coll-card-title">First Voice Card</div>
            <div className="vt-coll-card-state" data-testid="vt-card-state">
              {owned ? (
                <span className="vt-pill vt-pill-paid"><Check size={12} aria-hidden="true" /> Owned</span>
              ) : (
                <span className="vt-pill"><Lock size={12} aria-hidden="true" /> Locked</span>
              )}
            </div>
          </button>
        </div>

        {selected === "first-voice-card" && (
          <div className="vt-panel vt-coll-detail" data-testid="vt-card-detail">
            <div className="vt-coll-detail-title">First Voice Card</div>
            <div className="vt-coll-detail-meta">
              {/* Truthful descriptor only — no rarity/category/tier
                  invention. The API does not return these fields. */}
              <span className="vt-pill" data-testid="vt-card-descriptor">
                Voice Treasure collectible
              </span>
              {owned && grantedAt ? (
                <span className="vt-pill" data-testid="vt-card-acquired">
                  <Calendar size={12} aria-hidden="true" />
                  Acquired {grantedAt.toLocaleDateString()}
                </span>
              ) : null}
            </div>
            <p className="vt-sub">
              {owned
                ? "Awarded the first time you complete a paid Voice Treasure mission. Keep practising to unlock additional voice cards as new missions are released."
                : "Locked until you complete your first paid Voice Treasure mission with a strong spoken response."}
            </p>
          </div>
        )}

        {!owned && (
          <div className="vt-panel vt-empty-state" data-testid="vt-collection-empty" style={{ marginTop: 12 }}>
            <CollectionEmptyArt />
            <div className="vt-dim" style={{ marginTop: 8 }}>
              Your collection is empty for now. Each milestone will appear here as soon as the backend records it.
            </div>
          </div>
        )}
      </div>
    </VTStage>
  );
}

/** Original SVG: stylised voice card with a soundwave. Replaces the 🃏 emoji. */
function VoiceCardArt({ owned }) {
  return (
    <svg
      width="92"
      height="120"
      viewBox="0 0 92 120"
      role="img"
      aria-hidden="true"
      data-testid="vt-card-art"
      className="vt-coll-art"
      style={{ opacity: owned ? 1 : 0.55, filter: owned ? "none" : "saturate(0.4) brightness(0.85)" }}
    >
      <defs>
        <linearGradient id="vt-card-bg" x1="0" y1="0" x2="92" y2="120" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1d2356" />
          <stop offset="1" stopColor="#3a2c7a" />
        </linearGradient>
        <linearGradient id="vt-card-gold" x1="0" y1="0" x2="0" y2="120" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffe19a" />
          <stop offset="1" stopColor="#d4a843" />
        </linearGradient>
      </defs>
      <rect x="3" y="3" width="86" height="114" rx="14" fill="url(#vt-card-bg)" stroke="url(#vt-card-gold)" strokeWidth="2" />
      <g transform="translate(46 36)">
        <g fill="url(#vt-card-gold)" data-testid="vt-card-wave">
          <rect x="-26" y="-3" width="4" height="6" rx="2" />
          <rect x="-18" y="-7" width="4" height="14" rx="2" />
          <rect x="-10" y="-12" width="4" height="24" rx="2" />
          <rect x="-2"  y="-16" width="4" height="32" rx="2" />
          <rect x="6"   y="-12" width="4" height="24" rx="2" />
          <rect x="14"  y="-7"  width="4" height="14" rx="2" />
          <rect x="22"  y="-3"  width="4" height="6"  rx="2" />
        </g>
      </g>
      <g transform="translate(46 78)" fill="#f3ead2">
        <text textAnchor="middle" fontSize="11" fontWeight="700" letterSpacing="0.04em">VOICE</text>
        <text textAnchor="middle" fontSize="11" fontWeight="700" letterSpacing="0.04em" y="14">CARD · I</text>
      </g>
    </svg>
  );
}

/** Original empty-state SVG — open chest outline with a question mark. */
function CollectionEmptyArt() {
  return (
    <svg width="72" height="56" viewBox="0 0 72 56" role="img" aria-hidden="true" data-testid="vt-collection-empty-art">
      <rect x="6" y="20" width="60" height="28" rx="6" fill="none" stroke="#d4a843" strokeWidth="2" opacity="0.55" />
      <path d="M6 26 H66" stroke="#d4a843" strokeWidth="2" opacity="0.55" />
      <path d="M16 20 Q36 -2 56 20" fill="none" stroke="#d4a843" strokeWidth="2" opacity="0.55" />
      <circle cx="36" cy="34" r="2" fill="#d4a843" opacity="0.7" />
    </svg>
  );
}
