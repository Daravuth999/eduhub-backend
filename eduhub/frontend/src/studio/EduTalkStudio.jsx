/**
 * EduTalkStudio.jsx - Author Studio EduTalk admin panel (Phase 2A + Phase 3).
 *
 * Rendered as the 6th tab inside AiToolsStudio. Self-contained: handles
 * its own config load/save against /api/admin/edutalk-config so this
 * component does NOT touch the Phase 1 saveAiToolsConfig state machine.
 *
 * Strict rules:
 *   - Reads/writes ONLY /api/admin/edutalk-config and tone preset list.
 *   - Phase 3 panels read/write /api/admin/edutalk-tier-config,
 *     /api/admin/edutalk-promotions and /api/admin/edutalk-config/book/{slug}.
 *   - Does NOT touch ai_tools_config, ai_result_cache, ai_result_access.
 *   - Does NOT modify AiToolsStudio.jsx — all Phase 3 UI lives below the
 *     existing Save button as collapsible panels (default: collapsed).
 *   - Visual style mirrors PricingPanel / PersonalityPanel for consistency.
 */
import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Coins,
  Languages,
  Layers,
  Megaphone,
  RefreshCcw,
  Save,
  Search,
  Sparkles,
  Trash2,
  Wallet,
} from "lucide-react";
import { getEdutalkConfig, getToken, listVoices, saveEdutalkConfig } from "./api";
// Live Voice Coach Beta — NEW, isolated admin panel for the EduTalk Live Coach
// real-time speaking feature. Self-contained (reads/writes only
// /api/admin/edutalk-live/config); does not touch the EduTalk config above.
import EduTalkLivePanel from "./edutalkLive/EduTalkLivePanel";

// ============================================================================
// Phase 3 — inline admin API helpers. Kept in this file (rather than added to
// api.js) so that delivery is strictly limited to the file list in Phase 3
// SECTION 8 / SECTION 10. Mirrors the request() pattern used by api.js.
//
// v2 FIX: _PHASE3_BASE now uses process.env.REACT_APP_BACKEND_URL directly,
// matching api.js exactly. The previous defensive guard
//   `typeof process !== "undefined" && process.env && ...`
// caused _PHASE3_BASE to evaluate to "" in CRA 5 / webpack 5 production
// builds because webpack 5 does NOT polyfill `process` as a browser global.
// DefinePlugin replaces `process.env.REACT_APP_BACKEND_URL` at build time
// (text substitution), so the runtime `typeof process` check was always
// false in the browser, short-circuiting the entire expression and making
// every Phase 3 fetch go to the frontend host (Vercel) instead of Render.
// ============================================================================

/* eslint-disable no-undef */
const _PHASE3_BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
/* eslint-enable no-undef */

function _phase3Headers() {
  // Use the same exported getToken() helper as api.js so auth behaviour is
  // identical to the working /api/admin/edutalk-config and /api/studio/voices
  // requests.  getToken() already handles localStorage exceptions internally.
  const token = getToken();
  const h = { Accept: "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function _phase3Request(path, { method = "GET", body } = {}) {
  const headers = _phase3Headers();
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(`${_PHASE3_BASE}${path}`, {
    method,
    headers,
    credentials: "include",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await r.json();
  } catch {
    /* server returned no JSON */
  }
  if (!r.ok) {
    const detail = (data && (data.detail || data.message)) || `HTTP ${r.status}`;
    // Log path + status for debugging without exposing the token or full URL.
    console.error(`[EduTalkStudio] _phase3Request ${method} ${path} → HTTP ${r.status}`, detail);
    throw new Error(String(detail));
  }
  return data || {};
}

const tcGetTierConfig = () => _phase3Request("/api/admin/edutalk-tier-config");
const tcSaveTierConfig = (tiers) =>
  _phase3Request("/api/admin/edutalk-tier-config", { method: "PUT", body: { tiers } });
const tcListPromotions = () => _phase3Request("/api/admin/edutalk-promotions");
const tcCreatePromotion = (payload) =>
  _phase3Request("/api/admin/edutalk-promotions", { method: "POST", body: payload });
const tcUpdatePromotion = (id, payload) =>
  _phase3Request(`/api/admin/edutalk-promotions/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: payload,
  });
const tcDeletePromotion = (id) =>
  _phase3Request(`/api/admin/edutalk-promotions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
const tcGetBookOverride = (slug) =>
  _phase3Request(`/api/admin/edutalk-config/book/${encodeURIComponent(slug)}`);
const tcSaveBookOverride = (slug, payload) =>
  _phase3Request(`/api/admin/edutalk-config/book/${encodeURIComponent(slug)}`, {
    method: "PUT",
    body: payload,
  });
const tcDeleteBookOverride = (slug) =>
  _phase3Request(`/api/admin/edutalk-config/book/${encodeURIComponent(slug)}`, {
    method: "DELETE",
  });
const tcListBooks = () => _phase3Request("/api/studio/books");

const NUMBER_FIELDS = [
  { key: "session_cost", label: "Session cost (points)", min: 0, max: 50, step: 1 },
  { key: "reply_limit", label: "Replies per session", min: 1, max: 20, step: 1 },
  { key: "session_expiry_minutes", label: "Session expiry (minutes)", min: 5, max: 240, step: 5 },
];

export default function EduTalkStudio() {
  const [config, setConfig] = useState(null);
  const [tonePresets, setTonePresets] = useState(["Friendly Coach"]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getEdutalkConfig();
      if (r?.success) {
        setConfig(r.config || {});
        setTonePresets(Array.isArray(r.tone_presets) && r.tone_presets.length
          ? r.tone_presets
          : ["Friendly Coach"]);
      }
    } catch { /* surfaced via toast on save */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const update = (k, v) => setConfig((prev) => ({ ...(prev || {}), [k]: v }));

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setToast("");
    try {
      const r = await saveEdutalkConfig(config);
      if (r?.success) {
        setConfig(r.config || config);
        setToast("EduTalk settings saved.");
      } else {
        setToast("Save failed. Please retry.");
      }
    } catch (e) {
      setToast(e?.message || "Save failed.");
    }
    setSaving(false);
    setTimeout(() => setToast(""), 2500);
  };

  if (loading || !config) {
    return (
      <div className="rounded-2xl border border-gold/15 p-5"
           style={{ background: "rgba(20,14,32,0.55)" }}
           data-testid="edutalk-studio-loading">
        <div className="text-parchment/80 text-[13px]">Loading EduTalk settings…</div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-gold/15 p-5 space-y-5"
         style={{ background: "rgba(20,14,32,0.55)" }}
         data-testid="edutalk-studio-panel">
      <header className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-gold" />
        <h3 className="text-[15px] font-bold text-parchment tracking-wide">
          EduTalk · Book-Aware Coach (Phase 2)
        </h3>
      </header>

      <p className="text-[12px] text-parchment/80 leading-relaxed">
        EduTalk is a separate Phase 2 feature. Turning it OFF does not affect
        Khmer Decoder or Executive Upgrade. EduTalk uses a session-ticket
        model: one charge = N guided replies inside the current chapter.
      </p>

      {/* Enable toggle */}
      <label className="flex items-center justify-between gap-3 rounded-xl border border-gold/15 px-4 py-3"
             data-testid="edutalk-enabled-row">
        <span className="text-[13px] text-parchment font-semibold">
          Enable EduTalk
        </span>
        <input
          type="checkbox"
          checked={!!config.enabled}
          onChange={(e) => update("enabled", e.target.checked)}
          data-testid="edutalk-enabled-toggle"
          className="h-4 w-4 accent-gold"
        />
      </label>

      {/* Numeric fields */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {NUMBER_FIELDS.map((f) => (
          <label key={f.key} className="block">
            <span className="block text-[11.5px] uppercase tracking-wider text-parchment/70 mb-1">
              {f.label}
            </span>
            <input
              type="number"
              min={f.min}
              max={f.max}
              step={f.step}
              value={config[f.key] ?? ""}
              onChange={(e) => update(f.key, Number(e.target.value) || 0)}
              data-testid={`edutalk-num-${f.key}`}
              className="w-full bg-black/30 border border-gold/20 rounded-lg px-3 py-2 text-parchment text-[13px] focus:outline-none focus:border-gold"
            />
          </label>
        ))}
      </div>

      {/* Tone preset */}
      <label className="block">
        <span className="block text-[11.5px] uppercase tracking-wider text-parchment/70 mb-1">
          Tone preset
        </span>
        <select
          value={config.tone_preset || "Friendly Coach"}
          onChange={(e) => update("tone_preset", e.target.value)}
          data-testid="edutalk-tone-preset"
          className="w-full bg-black/30 border border-gold/20 rounded-lg px-3 py-2 text-parchment text-[13px] focus:outline-none focus:border-gold"
        >
          {tonePresets.map((tp) => <option key={tp} value={tp}>{tp}</option>)}
        </select>
      </label>

      {/* Output language */}
      <label className="block">
        <span className="block text-[11.5px] uppercase tracking-wider text-parchment/70 mb-1">
          Output language rule
        </span>
        <input
          type="text"
          maxLength={200}
          value={config.output_language_rule || ""}
          onChange={(e) => update("output_language_rule", e.target.value)}
          data-testid="edutalk-language-rule"
          className="w-full bg-black/30 border border-gold/20 rounded-lg px-3 py-2 text-parchment text-[13px] focus:outline-none focus:border-gold"
        />
      </label>

      {/* System instruction */}
      <label className="block">
        <span className="block text-[11.5px] uppercase tracking-wider text-parchment/70 mb-1">
          EduTalk system instruction (admin override — max 4000 chars)
        </span>
        <textarea
          rows={6}
          maxLength={4000}
          value={config.system_instruction || ""}
          onChange={(e) => update("system_instruction", e.target.value)}
          data-testid="edutalk-system-instruction"
          placeholder="Leave empty to use the built-in coach instruction."
          className="w-full bg-black/30 border border-gold/20 rounded-lg px-3 py-2 text-parchment text-[12.5px] leading-relaxed focus:outline-none focus:border-gold"
        />
        <span className="block mt-1 text-[10.5px] text-parchment/55">
          Built-in rules (book-context restriction, unrelated-question redirect, language rule, exercise-first behavior) are always enforced. This field appends extra guidance.
        </span>
      </label>

      {/* Behavior toggles */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {[
          { key: "restrict_to_book_context", label: "Restrict to book context" },
          { key: "allow_unrelated_questions", label: "Allow unrelated questions" },
          { key: "require_learning_purpose", label: "Require learning purpose" },
        ].map((b) => (
          <label key={b.key}
                 className="flex items-center justify-between gap-3 rounded-xl border border-gold/15 px-3 py-2">
            <span className="text-[12px] text-parchment">{b.label}</span>
            <input
              type="checkbox"
              checked={!!config[b.key]}
              onChange={(e) => update(b.key, e.target.checked)}
              data-testid={`edutalk-bool-${b.key}`}
              className="h-4 w-4 accent-gold"
            />
          </label>
        ))}
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          data-testid="edutalk-save-btn"
          className="inline-flex items-center gap-2 rounded-xl bg-gold/15 hover:bg-gold/25 border border-gold/40 px-4 py-2 text-[13px] font-semibold text-parchment transition disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {saving ? "Saving…" : "Save EduTalk settings"}
        </button>
        <button
          type="button"
          onClick={load}
          disabled={saving}
          data-testid="edutalk-reload-btn"
          className="inline-flex items-center gap-2 rounded-xl border border-gold/20 px-3 py-2 text-[12.5px] text-parchment/85 hover:border-gold/50 transition disabled:opacity-50"
        >
          <RefreshCcw className="h-3.5 w-3.5" />
          Reload
        </button>
        {toast && (
          <span className="inline-flex items-center gap-1 text-[12px] text-emerald-300"
                data-testid="edutalk-save-toast">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {toast}
          </span>
        )}
      </div>

      {/* ============================================================ */}
      {/*  PHASE 3 — collapsible panels (default: all collapsed).       */}
      {/*  Each panel is self-contained: it fetches/saves its own data  */}
      {/*  the first time it is expanded. None of them touch the global */}
      {/*  EduTalk config above.                                        */}
      {/* ============================================================ */}
      <div className="mt-6 pt-5 border-t border-gold/15 space-y-3"
           data-testid="edutalk-phase3-panels">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-parchment/55">
          Tier-aware AI feature config (Phase 3)
        </div>

        <CollapsiblePanel
          icon={<Layers className="h-4 w-4" />}
          title="Tier Defaults"
          subtitle="Free · Standard · Premium · Limited Edition"
          testIdBase="edutalk-phase3-tier-defaults"
        >
          <TierDefaultsPanel />
        </CollapsiblePanel>

        <CollapsiblePanel
          icon={<Search className="h-4 w-4" />}
          title="Per-Book Override"
          subtitle="Pick a book and override its tier-derived config"
          testIdBase="edutalk-phase3-book-override"
        >
          <BookOverridePanel />
        </CollapsiblePanel>

        <CollapsiblePanel
          icon={<Megaphone className="h-4 w-4" />}
          title="Promotions"
          subtitle="Time-bounded discounts on EduTalk / Voice / Replies"
          testIdBase="edutalk-phase3-promotions"
        >
          <PromotionsPanel />
        </CollapsiblePanel>

        <CollapsiblePanel
          icon={<Languages className="h-4 w-4" />}
          title="Language & Voice Settings"
          subtitle="Explanation / greeting / encouragement + ElevenLabs voice"
          testIdBase="edutalk-phase3-lang-voice"
        >
          <LanguageVoicePanel config={config} update={update} />
        </CollapsiblePanel>

        <CollapsiblePanel
          icon={<Languages className="h-4 w-4" />}
          title="🎙️ Audio Depth & Coaching Behaviour"
          subtitle="Tune Khmer audio length, depth, and exercise scaffolding without code changes"
          testIdBase="edutalk-phase3-audio-depth"
        >
          <AudioDepthPanel config={config} update={update} />
        </CollapsiblePanel>

        <CollapsiblePanel
          icon={<Wallet className="h-4 w-4" />}
          title="Top-Up Prompt Settings"
          subtitle="Inline top-up modal copy + behaviour"
          testIdBase="edutalk-phase3-topup"
        >
          <TopUpPromptPanel config={config} update={update} />
        </CollapsiblePanel>

        <CollapsiblePanel
          icon={<Sparkles className="h-4 w-4" />}
          title="🎙️ Live Voice Coach Beta"
          subtitle="Real-time voice-to-voice speaking coach (EduTalk Live Coach) — Gemini Live"
          testIdBase="edutalk-live-voice-coach"
        >
          <EduTalkLivePanel />
        </CollapsiblePanel>

        <p className="text-[10.5px] text-parchment/45 leading-relaxed">
          Language &amp; Voice / Top-Up panels save together with the main
          “Save EduTalk settings” button above. Tier Defaults, Per-Book Override
          and Promotions save independently inside their own panels.
        </p>
      </div>
    </div>
  );
}

/* ============================================================ */
/*  Phase 3 — small shared building blocks                       */
/* ============================================================ */

function CollapsiblePanel({ icon, title, subtitle, testIdBase, children }) {
  const [open, setOpen] = useState(false); // default: collapsed
  return (
    <div
      className="rounded-xl border border-gold/15 bg-black/15"
      data-testid={`${testIdBase}-panel`}
    >
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        aria-expanded={open}
        aria-label={`Toggle ${title}`}
        data-testid={`${testIdBase}-toggle`}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-gold/80">{icon}</span>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-parchment truncate">{title}</div>
            {subtitle && (
              <div className="text-[11px] text-parchment/55 truncate">{subtitle}</div>
            )}
          </div>
        </div>
        <span className="text-parchment/60">
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </span>
      </button>
      {open && (
        <div
          className="px-4 pb-4 pt-1 border-t border-gold/10"
          data-testid={`${testIdBase}-body`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function PanelToast({ msg }) {
  if (!msg) return null;
  return (
    <div
      className="mt-2 inline-flex items-center gap-1 text-[11.5px] text-emerald-300"
      data-testid="edutalk-phase3-panel-toast"
    >
      <CheckCircle2 className="h-3.5 w-3.5" />
      {msg}
    </div>
  );
}

function NumberField({ label, value, onChange, min = 0, max = 200, step = 1, testId }) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-[11px] text-parchment/65 truncate">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(Number(e.target.value))}
        data-testid={testId}
        className="bg-black/30 border border-gold/20 rounded-lg px-2.5 py-1.5 text-[12.5px] text-parchment focus:outline-none focus:border-gold/55"
      />
    </label>
  );
}

function ToggleRow({ label, checked, onChange, testId, hint }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-[12px] text-parchment truncate">{label}</div>
        {hint && <div className="text-[10.5px] text-parchment/50 leading-snug">{hint}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={!!checked}
        aria-label={label}
        data-testid={testId}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition ${
          checked ? "bg-gold/70" : "bg-parchment/15"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-parchment shadow transition-transform ${
            checked ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}

function TextField({ label, value, onChange, placeholder, testId, maxLength = 200 }) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-[11px] text-parchment/65 truncate">{label}</span>
      <input
        type="text"
        value={value || ""}
        maxLength={maxLength}
        placeholder={placeholder || ""}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
        className="bg-black/30 border border-gold/20 rounded-lg px-2.5 py-1.5 text-[12.5px] text-parchment focus:outline-none focus:border-gold/55"
      />
    </label>
  );
}

function SelectField({ label, value, onChange, options, testId }) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-[11px] text-parchment/65 truncate">{label}</span>
      <select
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
        className="bg-black/30 border border-gold/20 rounded-lg px-2.5 py-1.5 text-[12.5px] text-parchment focus:outline-none focus:border-gold/55"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/* ============================================================ */
/*  Phase 3 — Panel 1: Tier Defaults                             */
/* ============================================================ */

const TIER_ORDER = ["free", "standard", "premium", "limited_edition"];
const TIER_LABEL = {
  free: "Free",
  standard: "Standard",
  premium: "Premium",
  limited_edition: "Limited Edition",
};

function TierDefaultsPanel() {
  const [tiers, setTiers] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tierError, setTierError] = useState("");
  const [saving, setSaving] = useState(false);
  const [voices, setVoices] = useState([]);
  const [toast, setToast] = useState("");
  const [expanded, setExpanded] = useState({ premium: true });

  const load = useCallback(async () => {
    setLoading(true);
    setTierError("");
    try {
      const [tc, vc] = await Promise.all([
        tcGetTierConfig(),
        listVoices().catch(() => ({ voices: [] })),
      ]);
      if (tc && tc.success && tc.tiers && typeof tc.tiers === "object") {
        setTiers(tc.tiers);
        setTierError("");
      } else {
        setTiers(null);
        setTierError("Could not load tier config. Please tap Retry.");
      }
      const v = Array.isArray(vc?.voices) ? vc.voices : [];
      setVoices(v);
    } catch (e) {
      setTiers(null);
      setTierError(e?.message || "Could not load tier config. Please tap Retry.");
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const updateTier = (tier, key, value) => {
    setTiers((prev) => ({
      ...(prev || {}),
      [tier]: { ...((prev || {})[tier] || {}), [key]: value },
    }));
  };

  const handleSave = async () => {
    if (!tiers) return;
    setSaving(true);
    setToast("");
    try {
      const r = await tcSaveTierConfig(tiers);
      if (r?.success) {
        setTiers(r.tiers || tiers);
        setToast("Tier defaults saved.");
      } else {
        setToast("Save failed. Please retry.");
      }
    } catch (e) {
      setToast(e?.message || "Save failed.");
    }
    setSaving(false);
    setTimeout(() => setToast(""), 2500);
  };

  if (loading) {
    return (
      <div className="text-[12px] text-parchment/70" data-testid="edutalk-phase3-tier-loading">
        Loading tier defaults…
      </div>
    );
  }

  if (tierError || !tiers) {
    return (
      <div
        className="rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-3 text-[12px] text-red-100 space-y-2"
        data-testid="edutalk-phase3-tier-error"
      >
        <div className="font-medium">
          {tierError || "Could not load tier config. Please tap Retry."}
        </div>
        <button
          type="button"
          onClick={load}
          data-testid="edutalk-phase3-tier-retry"
          className="inline-flex items-center gap-1.5 rounded-md border border-red-300/40 bg-red-500/15 px-2.5 py-1 text-[11.5px] font-medium text-red-50 hover:bg-red-500/25 transition"
        >
          Retry
        </button>
      </div>
    );
  }

  const voiceOptions = [
    { value: "", label: "(use ELEVENLABS_DEFAULT_VOICE env)" },
    ...voices.map((v) => ({
      value: v.voice_id,
      label: `${v.name || "Voice"}${v.gender ? " · " + v.gender : ""}${v.accent ? " · " + v.accent : ""}`,
    })),
  ];

  return (
    <div className="space-y-3">
      {TIER_ORDER.map((tier) => {
        const t = tiers[tier] || {};
        const open = !!expanded[tier];
        return (
          <div
            key={tier}
            className="rounded-lg border border-gold/15 bg-black/20"
            data-testid={`edutalk-phase3-tier-${tier}`}
          >
            <button
              type="button"
              onClick={() => setExpanded((p) => ({ ...p, [tier]: !p[tier] }))}
              aria-expanded={open}
              aria-label={`Toggle ${TIER_LABEL[tier]} tier defaults`}
              data-testid={`edutalk-phase3-tier-${tier}-toggle`}
              className="w-full flex items-center justify-between px-3.5 py-2.5 text-left"
            >
              <span className="text-[12.5px] font-semibold text-parchment">
                {TIER_LABEL[tier]}
              </span>
              <span className="text-parchment/55">
                {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </span>
            </button>
            {open && (
              <div className="px-3.5 pb-3.5 pt-1 border-t border-gold/10 space-y-2.5">
                <div className="grid grid-cols-2 gap-2.5">
                  <ToggleRow
                    label="EduTalk enabled"
                    checked={t.edutalk_enabled}
                    onChange={(v) => updateTier(tier, "edutalk_enabled", v)}
                    testId={`edutalk-phase3-tier-${tier}-edutalk-enabled`}
                  />
                  <ToggleRow
                    label="Khmer Decoder"
                    checked={t.khmer_decoder}
                    onChange={(v) => updateTier(tier, "khmer_decoder", v)}
                    testId={`edutalk-phase3-tier-${tier}-khmer-decoder`}
                  />
                  <ToggleRow
                    label="Executive Tone"
                    checked={t.executive_tone}
                    onChange={(v) => updateTier(tier, "executive_tone", v)}
                    testId={`edutalk-phase3-tier-${tier}-executive-tone`}
                  />
                  <ToggleRow
                    label="Score-aware coaching"
                    checked={t.score_aware}
                    onChange={(v) => updateTier(tier, "score_aware", v)}
                    testId={`edutalk-phase3-tier-${tier}-score-aware`}
                  />
                  <ToggleRow
                    label="Voice reply"
                    checked={t.voice_reply}
                    onChange={(v) => updateTier(tier, "voice_reply", v)}
                    testId={`edutalk-phase3-tier-${tier}-voice-reply`}
                  />
                </div>
                <div className="grid grid-cols-3 gap-2.5">
                  <NumberField
                    label="EduTalk cost"
                    value={t.edutalk_cost}
                    onChange={(v) => updateTier(tier, "edutalk_cost", v)}
                    max={50}
                    testId={`edutalk-phase3-tier-${tier}-edutalk-cost`}
                  />
                  <NumberField
                    label="Replies / session"
                    value={t.edutalk_replies}
                    onChange={(v) => updateTier(tier, "edutalk_replies", v)}
                    min={1} max={30}
                    testId={`edutalk-phase3-tier-${tier}-edutalk-replies`}
                  />
                  <NumberField
                    label="Voice cost"
                    value={t.voice_cost}
                    onChange={(v) => updateTier(tier, "voice_cost", v)}
                    max={50}
                    testId={`edutalk-phase3-tier-${tier}-voice-cost`}
                  />
                  <NumberField
                    label="Khmer Decoder cost"
                    value={t.khmer_decoder_cost}
                    onChange={(v) => updateTier(tier, "khmer_decoder_cost", v)}
                    max={50}
                    testId={`edutalk-phase3-tier-${tier}-khmer-decoder-cost`}
                  />
                  <NumberField
                    label="Executive Tone cost"
                    value={t.executive_tone_cost}
                    onChange={(v) => updateTier(tier, "executive_tone_cost", v)}
                    max={50}
                    testId={`edutalk-phase3-tier-${tier}-executive-tone-cost`}
                  />
                  <NumberField
                    label="Session expiry (min)"
                    value={t.session_expiry_minutes}
                    onChange={(v) => updateTier(tier, "session_expiry_minutes", v)}
                    min={5} max={240} step={5}
                    testId={`edutalk-phase3-tier-${tier}-expiry`}
                  />
                </div>
                <div className="grid grid-cols-1 gap-2.5">
                  <SelectField
                    label="Voice ID (ElevenLabs)"
                    value={t.custom_voice_id || ""}
                    onChange={(v) => updateTier(tier, "custom_voice_id", v)}
                    options={voiceOptions}
                    testId={`edutalk-phase3-tier-${tier}-voice-id`}
                  />
                  {/* v1.4 — per-tier Audio support language override.
                      "" = inherit global; otherwise clamps to khmer/english
                      server-side.  Precedence:
                        per-book override → tier config → global → "khmer". */}
                  <SelectField
                    label="Audio support language"
                    value={t.audio_support_lang || ""}
                    onChange={(v) => updateTier(tier, "audio_support_lang", v)}
                    options={[
                      { value: "",        label: "Use Global Default" },
                      { value: "khmer",   label: "Khmer support audio — Gemini Khmer TTS" },
                      { value: "english", label: "English audio — ElevenLabs voice" },
                    ]}
                    testId={`edutalk-phase3-tier-${tier}-audio-support-lang`}
                  />
                  {tier === "free" && (
                    <>
                      <TextField
                        label="Upgrade prompt (KH)"
                        value={t.upgrade_prompt_kh}
                        onChange={(v) => updateTier(tier, "upgrade_prompt_kh", v)}
                        placeholder="សារពេលត្រូវការ Premium…"
                        maxLength={500}
                        testId={`edutalk-phase3-tier-${tier}-upgrade-kh`}
                      />
                      <TextField
                        label="Upgrade prompt (EN)"
                        value={t.upgrade_prompt_en}
                        onChange={(v) => updateTier(tier, "upgrade_prompt_en", v)}
                        placeholder="This feature requires Premium…"
                        maxLength={500}
                        testId={`edutalk-phase3-tier-${tier}-upgrade-en`}
                      />
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          data-testid="edutalk-phase3-tier-save"
          className="inline-flex items-center gap-2 rounded-xl bg-gold/15 hover:bg-gold/25 border border-gold/40 px-3.5 py-1.5 text-[12.5px] font-semibold text-parchment transition disabled:opacity-50"
        >
          <Save className="h-3.5 w-3.5" />
          {saving ? "Saving…" : "Save Tier Defaults"}
        </button>
        <button
          type="button"
          onClick={load}
          disabled={saving}
          data-testid="edutalk-phase3-tier-reload"
          className="inline-flex items-center gap-2 rounded-xl border border-gold/20 px-3 py-1.5 text-[12px] text-parchment/85 hover:border-gold/50 transition disabled:opacity-50"
        >
          <RefreshCcw className="h-3 w-3" />
          Reload
        </button>
      </div>
      <PanelToast msg={toast} />
    </div>
  );
}

/* ============================================================ */
/*  Phase 3 — Panel 2: Per-Book Override                         */
/* ============================================================ */

function BookOverridePanel() {
  const [books, setBooks] = useState([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null); // book slug
  const [bookCfg, setBookCfg] = useState(null);
  const [loadingList, setLoadingList] = useState(true);
  const [booksError, setBooksError] = useState("");
  const [loadingBook, setLoadingBook] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  const loadBooks = useCallback(async () => {
    setLoadingList(true);
    setBooksError("");
    try {
      const r = await tcListBooks();
      const list = Array.isArray(r?.books) ? r.books : Array.isArray(r) ? r : [];
      setBooks(list);
      setBooksError("");
    } catch (e) {
      setBooks([]);
      setBooksError(e?.message || "Could not load books. Please tap Retry.");
    }
    setLoadingList(false);
  }, []);

  useEffect(() => { loadBooks(); }, [loadBooks]);

  const loadBook = async (slug) => {
    setSelected(slug);
    setLoadingBook(true);
    try {
      const r = await tcGetBookOverride(slug);
      setBookCfg({
        tier_override: !!r?.tier_override,
        config: r?.config || {},
      });
    } catch (e) {
      setToast(e?.message || "Could not load book override.");
      setBookCfg({ tier_override: false, config: {} });
    }
    setLoadingBook(false);
  };

  const update = (k, v) => {
    setBookCfg((prev) => ({
      ...(prev || { tier_override: false, config: {} }),
      config: { ...((prev || {}).config || {}), [k]: v },
    }));
  };

  const setTierOverride = (v) => {
    setBookCfg((prev) => ({
      ...(prev || { tier_override: false, config: {} }),
      tier_override: !!v,
    }));
  };

  const handleSave = async () => {
    if (!selected || !bookCfg) return;
    setSaving(true);
    setToast("");
    try {
      const payload = { ...(bookCfg.config || {}), tier_override: bookCfg.tier_override };
      const r = await tcSaveBookOverride(selected, payload);
      if (r?.success) {
        setBookCfg({
          tier_override: !!r.tier_override,
          config: r.config || {},
        });
        setToast("Book override saved.");
      } else {
        setToast("Save failed.");
      }
    } catch (e) {
      setToast(e?.message || "Save failed.");
    }
    setSaving(false);
    setTimeout(() => setToast(""), 2500);
  };

  const handleDelete = async () => {
    if (!selected) return;
    if (!window.confirm(`Delete EduTalk override for "${selected}"? Tier defaults will apply.`)) {
      return;
    }
    setSaving(true);
    try {
      await tcDeleteBookOverride(selected);
      setBookCfg({ tier_override: false, config: {} });
      setToast("Override deleted. Tier defaults now apply.");
    } catch (e) {
      setToast(e?.message || "Delete failed.");
    }
    setSaving(false);
    setTimeout(() => setToast(""), 2500);
  };

  const filtered = (books || []).filter((b) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      (b.slug || "").toLowerCase().includes(q) ||
      (b.title || "").toLowerCase().includes(q)
    );
  }).slice(0, 30);

  const cfg = (bookCfg && bookCfg.config) || {};
  const overrideOn = !!(bookCfg && bookCfg.tier_override);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Search className="h-4 w-4 text-parchment/55" />
        <input
          type="text"
          value={query}
          placeholder="Search book by slug or title…"
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search book by slug or title"
          data-testid="edutalk-phase3-book-search"
          className="flex-1 bg-black/30 border border-gold/20 rounded-lg px-2.5 py-1.5 text-[12px] text-parchment focus:outline-none focus:border-gold/55"
        />
      </div>

      {loadingList ? (
        <div className="text-[12px] text-parchment/70">Loading books…</div>
      ) : booksError ? (
        <div
          className="rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-3 text-[12px] text-red-100 space-y-2"
          data-testid="edutalk-phase3-books-error"
        >
          <div className="font-medium">{booksError}</div>
          <button
            type="button"
            onClick={loadBooks}
            data-testid="edutalk-phase3-books-retry"
            className="inline-flex items-center gap-1.5 rounded-md border border-red-300/40 bg-red-500/15 px-2.5 py-1 text-[11.5px] font-medium text-red-50 hover:bg-red-500/25 transition"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="max-h-44 overflow-y-auto rounded-lg border border-gold/15 bg-black/15">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-[11.5px] text-parchment/55">No books match.</div>
          ) : (
            filtered.map((b) => (
              <button
                key={b.slug}
                type="button"
                onClick={() => loadBook(b.slug)}
                aria-label={`Select book ${b.title || b.slug}`}
                data-testid={`edutalk-phase3-book-select-${b.slug}`}
                className={`w-full text-left px-3 py-2 text-[12px] border-b border-gold/5 hover:bg-gold/8 transition ${
                  selected === b.slug ? "bg-gold/15 text-parchment" : "text-parchment/85"
                }`}
              >
                <div className="font-semibold truncate">{b.title || b.slug}</div>
                <div className="text-[10.5px] text-parchment/55 truncate">
                  {b.slug}
                  {b.tier ? ` · ${b.tier}` : ""}
                </div>
              </button>
            ))
          )}
        </div>
      )}

      {selected && (
        <div className="space-y-2.5 rounded-lg border border-gold/15 bg-black/20 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[12px] font-semibold text-parchment truncate">
              {selected}
            </div>
            <button
              type="button"
              onClick={handleDelete}
              disabled={saving}
              aria-label={`Delete override for ${selected}`}
              data-testid="edutalk-phase3-book-delete"
              className="inline-flex items-center gap-1.5 text-[11px] text-rose-300/85 hover:text-rose-200 transition disabled:opacity-50"
            >
              <Trash2 className="h-3 w-3" />
              Delete override
            </button>
          </div>

          {loadingBook ? (
            <div className="text-[12px] text-parchment/70">Loading book config…</div>
          ) : (
            <>
              <ToggleRow
                label="Override tier defaults for this book"
                checked={overrideOn}
                onChange={setTierOverride}
                testId="edutalk-phase3-book-override-toggle"
                hint="When OFF, this book inherits its tier defaults."
              />

              {/* Audio Depth Engine v1.1 — per-book audio_depth_override.
                  Rendered OUTSIDE the tier_override gate because it is a
                  SAFE additive field: it cannot unlock paid features or
                  alter points spend.  Saving "Use Global Default" clears
                  it back to inheriting the global audio_depth_mode. */}
              <div className="pt-1 border-t border-gold/8">
                <SelectField
                  label="Per-book audio depth override"
                  value={cfg.audio_depth_override || ""}
                  onChange={(v) => update("audio_depth_override", v)}
                  options={[
                    { value: "",                  label: "Use Global Default" },
                    { value: "standard",          label: "Standard" },
                    { value: "detailed",          label: "Detailed" },
                    { value: "premium_coach",     label: "Premium Coach" },
                    { value: "exercise_scaffold", label: "Exercise Scaffold Mode" },
                  ]}
                  testId="edutalk-phase3-book-audio-depth-override"
                />
                <p className="text-[10.5px] text-parchment/55 leading-relaxed mt-1">
                  Audio depth override is additive — it does NOT require
                  “Override tier defaults” above to be ON.
                </p>
                {/* v1.2 — per-book Audio support language override.
                    Also additive (does not require tier override) because
                    it only changes which TTS provider is called for this
                    book; it cannot increase points spent.  Empty value
                    inherits the tier → global → "khmer" default. */}
                <div className="mt-2">
                  <SelectField
                    label="Per-book audio support language"
                    value={cfg.audio_support_lang || ""}
                    onChange={(v) => update("audio_support_lang", v)}
                    options={[
                      { value: "",        label: "Use Global / Tier Default" },
                      { value: "khmer",   label: "Khmer support audio — Gemini Khmer TTS" },
                      { value: "english", label: "English audio — ElevenLabs voice" },
                    ]}
                    testId="edutalk-phase3-book-audio-support-lang"
                  />
                  <p className="text-[10.5px] text-parchment/55 leading-relaxed mt-1">
                    Overrides the audio button language for this book only.
                    English audio uses the ElevenLabs voice selected above
                    (or the per-book voice ID override when set).
                  </p>
                </div>
              </div>

              {overrideOn && (
                <div className="space-y-2.5 pt-1 border-t border-gold/8">
                  <div className="grid grid-cols-2 gap-2.5">
                    <ToggleRow label="EduTalk enabled" checked={cfg.edutalk_enabled} onChange={(v) => update("edutalk_enabled", v)} testId="edutalk-phase3-book-edutalk-enabled" />
                    <ToggleRow label="Score-aware" checked={cfg.score_aware} onChange={(v) => update("score_aware", v)} testId="edutalk-phase3-book-score-aware" />
                    <ToggleRow label="Voice reply" checked={cfg.voice_reply} onChange={(v) => update("voice_reply", v)} testId="edutalk-phase3-book-voice-reply" />
                    <ToggleRow label="Khmer Decoder" checked={cfg.khmer_decoder} onChange={(v) => update("khmer_decoder", v)} testId="edutalk-phase3-book-khmer-decoder" />
                    <ToggleRow label="Executive Tone" checked={cfg.executive_tone} onChange={(v) => update("executive_tone", v)} testId="edutalk-phase3-book-executive-tone" />
                  </div>
                  <div className="grid grid-cols-3 gap-2.5">
                    <NumberField label="EduTalk cost" value={cfg.edutalk_cost} onChange={(v) => update("edutalk_cost", v)} max={50} testId="edutalk-phase3-book-edutalk-cost" />
                    <NumberField label="Replies / session" value={cfg.edutalk_replies} onChange={(v) => update("edutalk_replies", v)} min={1} max={30} testId="edutalk-phase3-book-edutalk-replies" />
                    <NumberField label="Voice cost" value={cfg.voice_cost} onChange={(v) => update("voice_cost", v)} max={50} testId="edutalk-phase3-book-voice-cost" />
                  </div>
                  <TextField
                    label="Voice ID override"
                    value={cfg.custom_voice_id}
                    onChange={(v) => update("custom_voice_id", v)}
                    placeholder="Leave empty to use tier voice"
                    maxLength={80}
                    testId="edutalk-phase3-book-voice-id"
                  />
                </div>
              )}
            </>
          )}

          <div className="pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || loadingBook}
              data-testid="edutalk-phase3-book-save"
              className="inline-flex items-center gap-2 rounded-xl bg-gold/15 hover:bg-gold/25 border border-gold/40 px-3.5 py-1.5 text-[12.5px] font-semibold text-parchment transition disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? "Saving…" : "Save Book Override"}
            </button>
          </div>
          <PanelToast msg={toast} />
        </div>
      )}
    </div>
  );
}

/* ============================================================ */
/*  Phase 3 — Panel 3: Promotions                                */
/* ============================================================ */

const PROMO_FEATURES = [
  { value: "edutalk_cost", label: "EduTalk session cost" },
  { value: "voice_cost", label: "Voice reply cost" },
  { value: "edutalk_replies", label: "Replies per session" },
  { value: "khmer_decoder_cost", label: "Khmer Decoder cost" },
  { value: "executive_tone_cost", label: "Executive Tone cost" },
  { value: "free_first_session", label: "Free first session" },
];
const PROMO_DISCOUNT_TYPES = [
  { value: "percent", label: "Percent off (%)" },
  { value: "fixed", label: "Fixed points off" },
  { value: "override", label: "Override final cost" },
];
const PROMO_TARGETS = [
  { value: "all", label: "All books" },
  { value: "tier", label: "By tier" },
  { value: "book", label: "Specific book" },
];

const emptyPromo = () => ({
  promo_id: "",
  name: "",
  active: true,
  target_type: "all",
  target_tier: "",
  target_book_slug: "",
  feature: "edutalk_cost",
  discount_type: "percent",
  discount_value: 50,
  start_at: "",
  end_at: "",
  show_banner: true,
  banner_text_en: "",
  banner_text_kh: "",
});

function PromotionsPanel() {
  const [promotions, setPromotions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // promo object being edited
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await tcListPromotions();
      setPromotions(Array.isArray(r?.promotions) ? r.promotions : []);
    } catch (e) {
      setToast(e?.message || "Could not load promotions.");
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const startCreate = () => setEditing(emptyPromo());
  const startEdit = (p) => setEditing({ ...emptyPromo(), ...p });
  const cancelEdit = () => setEditing(null);

  const updateField = (k, v) => setEditing((prev) => ({ ...(prev || {}), [k]: v }));

  const handleSave = async () => {
    if (!editing) return;
    if (!editing.name.trim()) { setToast("Name is required."); return; }
    setSaving(true);
    setToast("");
    try {
      const payload = { ...editing };
      // Drop fields the backend infers from target_type.
      if (payload.target_type !== "tier") payload.target_tier = "";
      if (payload.target_type !== "book") payload.target_book_slug = "";
      const r = editing.promo_id
        ? await tcUpdatePromotion(editing.promo_id, payload)
        : await tcCreatePromotion(payload);
      if (r?.success) {
        setToast(editing.promo_id ? "Promotion updated." : "Promotion created.");
        setEditing(null);
        load();
      } else {
        setToast("Save failed.");
      }
    } catch (e) {
      setToast(e?.message || "Save failed.");
    }
    setSaving(false);
    setTimeout(() => setToast(""), 2500);
  };

  const handleDelete = async (promoId) => {
    if (!window.confirm("Delete this promotion?")) return;
    setSaving(true);
    try {
      await tcDeletePromotion(promoId);
      setToast("Promotion deleted.");
      load();
    } catch (e) {
      setToast(e?.message || "Delete failed.");
    }
    setSaving(false);
    setTimeout(() => setToast(""), 2500);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-parchment/55">
          {loading ? "Loading…" : `${promotions.length} promotion${promotions.length === 1 ? "" : "s"}`}
        </div>
        <button
          type="button"
          onClick={startCreate}
          disabled={!!editing}
          aria-label="Create new promotion"
          data-testid="edutalk-phase3-promo-new"
          className="inline-flex items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 py-1 text-[11.5px] text-parchment hover:bg-gold/10 transition disabled:opacity-40"
        >
          <Sparkles className="h-3 w-3" />
          + New Promotion
        </button>
      </div>

      {!loading && promotions.length > 0 && (
        <div className="space-y-2">
          {promotions.map((p) => (
            <div
              key={p.promo_id}
              className="rounded-lg border border-gold/15 bg-black/20 px-3 py-2"
              data-testid={`edutalk-phase3-promo-row-${p.promo_id}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[12.5px] font-semibold text-parchment truncate">
                    {p.name}
                    {p.active ? (
                      <span className="inline-flex items-center text-[9.5px] uppercase tracking-wider bg-emerald-500/20 text-emerald-200 px-1.5 py-0.5 rounded">
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center text-[9.5px] uppercase tracking-wider bg-parchment/15 text-parchment/70 px-1.5 py-0.5 rounded">
                        Inactive
                      </span>
                    )}
                  </div>
                  <div className="text-[10.5px] text-parchment/55 truncate">
                    {p.feature} · {p.discount_type} {p.discount_value}
                    {p.target_type === "tier" && ` · tier=${p.target_tier}`}
                    {p.target_type === "book" && ` · book=${p.target_book_slug}`}
                    {p.start_at && ` · from ${p.start_at.slice(0, 16)}`}
                    {p.end_at && ` → ${p.end_at.slice(0, 16)}`}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => startEdit(p)}
                    aria-label={`Edit ${p.name}`}
                    data-testid={`edutalk-phase3-promo-edit-${p.promo_id}`}
                    className="text-[11px] text-parchment/80 hover:text-parchment transition"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(p.promo_id)}
                    aria-label={`Delete ${p.name}`}
                    data-testid={`edutalk-phase3-promo-delete-${p.promo_id}`}
                    className="text-[11px] text-rose-300/85 hover:text-rose-200 transition"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <div
          className="rounded-lg border border-gold/30 bg-black/25 p-3 space-y-2.5"
          data-testid="edutalk-phase3-promo-form"
        >
          <div className="text-[12px] font-semibold text-parchment">
            {editing.promo_id ? "Edit Promotion" : "New Promotion"}
          </div>
          <TextField
            label="Name"
            value={editing.name}
            onChange={(v) => updateField("name", v)}
            placeholder="Back to School Special"
            maxLength={120}
            testId="edutalk-phase3-promo-name"
          />
          <div className="grid grid-cols-2 gap-2.5">
            <SelectField
              label="Target"
              value={editing.target_type}
              onChange={(v) => updateField("target_type", v)}
              options={PROMO_TARGETS}
              testId="edutalk-phase3-promo-target-type"
            />
            <SelectField
              label="Feature"
              value={editing.feature}
              onChange={(v) => updateField("feature", v)}
              options={PROMO_FEATURES}
              testId="edutalk-phase3-promo-feature"
            />
            {editing.target_type === "tier" && (
              <SelectField
                label="Tier"
                value={editing.target_tier}
                onChange={(v) => updateField("target_tier", v)}
                options={[
                  { value: "", label: "(select)" },
                  ...TIER_ORDER.map((t) => ({ value: t, label: TIER_LABEL[t] })),
                ]}
                testId="edutalk-phase3-promo-tier"
              />
            )}
            {editing.target_type === "book" && (
              <TextField
                label="Book slug"
                value={editing.target_book_slug}
                onChange={(v) => updateField("target_book_slug", v)}
                placeholder="exact-book-slug"
                maxLength={200}
                testId="edutalk-phase3-promo-book-slug"
              />
            )}
            <SelectField
              label="Discount type"
              value={editing.discount_type}
              onChange={(v) => updateField("discount_type", v)}
              options={PROMO_DISCOUNT_TYPES}
              testId="edutalk-phase3-promo-discount-type"
            />
            <NumberField
              label="Discount value"
              value={editing.discount_value}
              onChange={(v) => updateField("discount_value", v)}
              min={0}
              max={1000}
              testId="edutalk-phase3-promo-discount-value"
            />
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="flex flex-col gap-1 min-w-0">
              <span className="text-[11px] text-parchment/65">Start at (ISO)</span>
              <input
                type="datetime-local"
                value={editing.start_at ? editing.start_at.slice(0, 16) : ""}
                onChange={(e) => updateField("start_at", e.target.value ? `${e.target.value}:00Z` : "")}
                data-testid="edutalk-phase3-promo-start"
                className="bg-black/30 border border-gold/20 rounded-lg px-2.5 py-1.5 text-[12px] text-parchment focus:outline-none focus:border-gold/55"
              />
            </label>
            <label className="flex flex-col gap-1 min-w-0">
              <span className="text-[11px] text-parchment/65">End at (ISO)</span>
              <input
                type="datetime-local"
                value={editing.end_at ? editing.end_at.slice(0, 16) : ""}
                onChange={(e) => updateField("end_at", e.target.value ? `${e.target.value}:00Z` : "")}
                data-testid="edutalk-phase3-promo-end"
                className="bg-black/30 border border-gold/20 rounded-lg px-2.5 py-1.5 text-[12px] text-parchment focus:outline-none focus:border-gold/55"
              />
            </label>
          </div>
          <ToggleRow
            label="Active"
            checked={editing.active}
            onChange={(v) => updateField("active", v)}
            testId="edutalk-phase3-promo-active"
          />
          <ToggleRow
            label="Show banner in Reader"
            checked={editing.show_banner}
            onChange={(v) => updateField("show_banner", v)}
            testId="edutalk-phase3-promo-show-banner"
          />
          <TextField
            label="Banner text (KH)"
            value={editing.banner_text_kh}
            onChange={(v) => updateField("banner_text_kh", v)}
            placeholder="EduTalk បញ្ចុះតម្លៃ ៥០% សប្តាហ៍នេះ!"
            maxLength={240}
            testId="edutalk-phase3-promo-banner-kh"
          />
          <TextField
            label="Banner text (EN)"
            value={editing.banner_text_en}
            onChange={(v) => updateField("banner_text_en", v)}
            placeholder="EduTalk 50% OFF this week!"
            maxLength={240}
            testId="edutalk-phase3-promo-banner-en"
          />

          {/* Preview */}
          <div
            className="rounded-md border border-gold/20 bg-gold/8 px-2.5 py-1.5 text-[11.5px] text-parchment/85"
            data-testid="edutalk-phase3-promo-preview"
          >
            <span className="text-[10px] uppercase tracking-wider text-parchment/55 mr-2">Preview:</span>
            {editing.banner_text_kh || editing.banner_text_en || "(empty banner)"}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              data-testid="edutalk-phase3-promo-save"
              className="inline-flex items-center gap-2 rounded-xl bg-gold/15 hover:bg-gold/25 border border-gold/40 px-3.5 py-1.5 text-[12.5px] font-semibold text-parchment transition disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? "Saving…" : editing.promo_id ? "Update" : "Create"}
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              disabled={saving}
              data-testid="edutalk-phase3-promo-cancel"
              className="inline-flex items-center rounded-xl border border-gold/20 px-3 py-1.5 text-[12px] text-parchment/85 hover:border-gold/50 transition disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <PanelToast msg={toast} />
    </div>
  );
}

/* ============================================================ */
/*  Phase 3 — Panel 4: Language & Voice Settings                 */
/*  Saved together with the main "Save EduTalk settings" button. */
/* ============================================================ */

function LanguageVoicePanel({ config, update }) {
  const [voices, setVoices] = useState([]);
  useEffect(() => {
    listVoices()
      .then((r) => setVoices(Array.isArray(r?.voices) ? r.voices : []))
      .catch(() => setVoices([]));
  }, []);

  const voiceOptions = [
    { value: "", label: "(use ELEVENLABS_DEFAULT_VOICE env)" },
    ...voices.map((v) => ({
      value: v.voice_id,
      label: `${v.name || "Voice"}${v.gender ? " · " + v.gender : ""}${v.accent ? " · " + v.accent : ""}`,
    })),
  ];

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2.5">
        <SelectField
          label="Explanation language"
          value={config?.explanation_language || "khmer"}
          onChange={(v) => update("explanation_language", v)}
          options={[
            { value: "khmer", label: "Khmer" },
            { value: "english", label: "English" },
            { value: "mixed", label: "Mixed (KH + EN)" },
          ]}
          testId="edutalk-phase3-lang-explanation"
        />
        <div>
          <div className="text-[11px] text-parchment/65 mb-1">Practice language</div>
          <div className="bg-black/30 border border-gold/15 rounded-lg px-2.5 py-1.5 text-[12px] text-parchment/65"
               data-testid="edutalk-phase3-lang-practice-readonly">
            English (always)
          </div>
        </div>
        <SelectField
          label="Greeting language"
          value={config?.greeting_language || "khmer"}
          onChange={(v) => update("greeting_language", v)}
          options={[
            { value: "khmer", label: "Khmer" },
            { value: "english", label: "English" },
          ]}
          testId="edutalk-phase3-lang-greeting"
        />
        <SelectField
          label="Encouragement style"
          value={config?.encouragement_style || "khmer_motivational"}
          onChange={(v) => update("encouragement_style", v)}
          options={[
            { value: "khmer_motivational", label: "Khmer motivational" },
            { value: "english", label: "English" },
            { value: "mixed", label: "Mixed" },
          ]}
          testId="edutalk-phase3-lang-encouragement"
        />
        <SelectField
          label="Correction style"
          value={config?.correction_style || "gentle_khmer_english_model"}
          onChange={(v) => update("correction_style", v)}
          options={[
            { value: "gentle_khmer_english_model", label: "Gentle Khmer + English model" },
            { value: "english_only", label: "English only" },
          ]}
          testId="edutalk-phase3-lang-correction"
        />
      </div>

      <div className="pt-2 border-t border-gold/8 space-y-2.5">
        <div className="text-[11px] font-semibold text-parchment/65 uppercase tracking-wider">
          Voice Reply
        </div>
        <ToggleRow
          label="Enable Voice Reply (global)"
          hint="When OFF, no tier or book can use voice reply regardless of its own setting."
          checked={!!config?.voice_reply_enabled}
          onChange={(v) => update("voice_reply_enabled", v)}
          testId="edutalk-phase3-voice-master"
        />
        <div className="grid grid-cols-2 gap-2.5">
          <NumberField
            label="Default voice cost (pts)"
            value={Number(config?.voice_cost ?? 1)}
            onChange={(v) => update("voice_cost", v)}
            max={50}
            testId="edutalk-phase3-voice-cost"
          />
          <SelectField
            label="Default voice"
            value={config?.voice_id || ""}
            onChange={(v) => update("voice_id", v)}
            options={voiceOptions}
            testId="edutalk-phase3-voice-id"
          />
        </div>
        {/* v1.2 — Audio support language selector.  Lets admin pick whether
            the audio button speaks Khmer support (Gemini Khmer TTS) or
            English audio (ElevenLabs voice).  Default "khmer" preserves
            today's English-learning model for every existing book. */}
        <SelectField
          label="Audio support language"
          value={config?.audio_support_lang || "khmer"}
          onChange={(v) => update("audio_support_lang", v)}
          options={[
            { value: "khmer",   label: "Khmer support audio — Gemini Khmer TTS" },
            { value: "english", label: "English audio — ElevenLabs voice" },
          ]}
          testId="edutalk-phase3-audio-support-lang"
        />
        <p className="text-[10.5px] text-parchment/55 leading-snug">
          “Khmer support audio” keeps the existing English-learning model
          (English text + Khmer audio explanation). “English audio” routes
          the audio button to ElevenLabs using the configured voice above.
          Visible reply language is controlled separately by
          “Explanation language”.
        </p>
        <p className="text-[10.5px] text-parchment/45 leading-snug flex items-center gap-1">
          <Coins className="h-3 w-3" />
          Voice cost is also configurable per tier. Tier value wins when set.
        </p>
      </div>
    </div>
  );
}

/* ============================================================ */
/*  Phase 3 — Panel 5: Top-Up Prompt Settings                    */
/*  Saved together with the main "Save EduTalk settings" button. */
/* ============================================================ */

function TopUpPromptPanel({ config, update }) {
  return (
    <div className="space-y-2.5">
      <SelectField
        label="Prompt language"
        value={config?.topup_prompt_lang || "both"}
        onChange={(v) => update("topup_prompt_lang", v)}
        options={[
          { value: "both", label: "Both Khmer + English" },
          { value: "khmer", label: "Khmer only" },
          { value: "english", label: "English only" },
        ]}
        testId="edutalk-phase3-topup-lang"
      />
      <TextField
        label="Custom message (KH)  —  {cost} / {balance} placeholders"
        value={config?.topup_prompt_kh}
        onChange={(v) => update("topup_prompt_kh", v)}
        placeholder="មុខងារនេះត្រូវការ {cost} ពិន្ទុ។ សមតុល្យបច្ចុប្បន្ន {balance}។"
        maxLength={600}
        testId="edutalk-phase3-topup-kh"
      />
      <TextField
        label="Custom message (EN)"
        value={config?.topup_prompt_en}
        onChange={(v) => update("topup_prompt_en", v)}
        placeholder="This feature costs {cost} points. Your balance is {balance}."
        maxLength={600}
        testId="edutalk-phase3-topup-en"
      />
      <div className="grid grid-cols-2 gap-2.5">
        <ToggleRow
          label="Show packages inline"
          checked={config?.topup_show_packages !== false}
          onChange={(v) => update("topup_show_packages", v)}
          testId="edutalk-phase3-topup-show-packages"
        />
        <ToggleRow
          label="Highlight recommended"
          checked={config?.topup_highlight_recommended !== false}
          onChange={(v) => update("topup_highlight_recommended", v)}
          testId="edutalk-phase3-topup-highlight"
        />
        <TextField
          label="Recommended label (KH)"
          value={config?.topup_recommended_label_kh}
          onChange={(v) => update("topup_recommended_label_kh", v)}
          placeholder="ស្នើ"
          maxLength={40}
          testId="edutalk-phase3-topup-rec-kh"
        />
        <TextField
          label="Recommended label (EN)"
          value={config?.topup_recommended_label_en}
          onChange={(v) => update("topup_recommended_label_en", v)}
          placeholder="Recommended"
          maxLength={40}
          testId="edutalk-phase3-topup-rec-en"
        />
      </div>
      <SelectField
        label="After top-up behaviour"
        value={config?.topup_after_behaviour || "auto_start"}
        onChange={(v) => update("topup_after_behaviour", v)}
        options={[
          { value: "auto_start", label: "Auto-start the feature" },
          { value: "return_to_book", label: "Return to book (manual)" },
        ]}
        testId="edutalk-phase3-topup-after"
      />

      {/* Premium Smart Badge controls (Top-Up modal/banner).
          Wired to PointsGateModal.jsx via the existing book-config flow.
          Saved together with the main "Save EduTalk settings" button. */}
      <div className="pt-2 border-t border-gold/8 space-y-2.5">
        <div className="text-[11px] font-semibold text-parchment/65 uppercase tracking-wider">
          Smart Badge (premium pill in top-up modal)
        </div>
        <ToggleRow
          label="Show smart badge"
          hint="When OFF, the modal hides the badge entirely (clean UI)."
          checked={config?.topup_badge_enabled !== false}
          onChange={(v) => update("topup_badge_enabled", v)}
          testId="edutalk-phase3-topup-badge-enabled"
        />
        <div className="grid grid-cols-2 gap-2.5">
          <TextField
            label="Badge text (EN)"
            value={config?.topup_badge_text_en}
            onChange={(v) => update("topup_badge_text_en", v)}
            placeholder="Best Value"
            maxLength={40}
            testId="edutalk-phase3-topup-badge-text-en"
          />
          <TextField
            label="Badge text (KH)"
            value={config?.topup_badge_text_kh}
            onChange={(v) => update("topup_badge_text_kh", v)}
            placeholder="តម្លៃល្អ"
            maxLength={40}
            testId="edutalk-phase3-topup-badge-text-kh"
          />
          <SelectField
            label="Badge style"
            value={config?.topup_badge_style || "bonus"}
            onChange={(v) => update("topup_badge_style", v)}
            options={[
              { value: "bonus",        label: "Bonus (gold/yellow)" },
              { value: "recommended",  label: "Recommended (green)" },
              { value: "flash_sale",   label: "Flash sale (red/amber)" },
              { value: "premium",      label: "Premium (violet)" },
            ]}
            testId="edutalk-phase3-topup-badge-style"
          />
          <SelectField
            label="Badge target"
            value={config?.topup_badge_target || "recommended_package"}
            onChange={(v) => update("topup_badge_target", v)}
            options={[
              { value: "recommended_package",         label: "Recommended package" },
              { value: "first_package",               label: "First package" },
              { value: "highest_value_package",       label: "Highest-value package" },
              { value: "promotion_package_if_available", label: "Active promotion (fallback otherwise)" },
            ]}
            testId="edutalk-phase3-topup-badge-target"
          />
        </div>
        <ToggleRow
          label="Promotion-aware badge"
          hint="When an active promotion exists, the badge reflects the promotion copy. Falls back to the configured Badge text when no promotion is active."
          checked={config?.topup_badge_promotion_aware !== false}
          onChange={(v) => update("topup_badge_promotion_aware", v)}
          testId="edutalk-phase3-topup-badge-promotion-aware"
        />
        <ToggleRow
          label="Sticky mini top-up hook"
          hint="Compact pill above the EduTalk typing box. Tapping it opens the full top-up modal. Respects the same cooldown / dismiss-cap / audio-playing / free-read guards as the modal itself."
          checked={config?.topup_mini_hook_enabled !== false}
          onChange={(v) => update("topup_mini_hook_enabled", v)}
          testId="edutalk-phase3-topup-mini-hook-enabled"
        />
        <p className="text-[10.5px] text-parchment/55 leading-snug">
          Badge is visual/copy only. It does NOT alter payment, coupon, or
          package logic. Leave Badge text empty to fall back to a safe,
          non-claim default (“Best Value” / “តម្លៃល្អ”); turn the toggle
          off to hide the badge entirely. Use “Badge target” to choose
          which top-up package card also wears the badge.
        </p>
      </div>

      {/* ════════════════════════════════════════════════════════════════
          Smart Top-Up Triggers (Part 2 — business strategy controls)
          ─────────────────────────────────────────────────────────────
          These knobs drive useTopUpTriggerGuard() in EduTalkPanel.jsx.
          All defaults are intentionally conservative so the modal never
          feels spammy:
            • cooldown          180s
            • max per session   3
            • dismiss cap       2
            • after-value       OFF (admin must opt-in)
            • low-balance       ON, threshold 10
            • replies-left      ON  (reminds before final reply)
            • promotion-aware   ON  (inline banner inside modal)
          Anti-spam state lives in sessionStorage only (no Mongo writes,
          no localStorage) so it resets cleanly per learning session.
          ════════════════════════════════════════════════════════════════ */}
      <div
        data-testid="edutalk-phase3-smart-topup-section"
        className="mt-4 pt-3 border-t border-aurora-violet/15 space-y-2.5"
      >
        <div className="flex items-center gap-2">
          <Coins className="h-3.5 w-3.5 text-aurora-gold" />
          <h4 className="text-[12px] font-semibold tracking-wide text-parchment/85">
            Smart Top-Up Triggers
          </h4>
        </div>
        <p className="text-[10.5px] text-parchment/55 leading-relaxed">
          Business-strategy controls. Encourage learners to continue at the
          right moment — never aggressive, never blocking free reading,
          never interrupting audio playback. State is per-session only.
        </p>

        <div className="grid grid-cols-2 gap-2.5">
          <NumberField
            label="Low balance threshold (pts)"
            value={config?.topup_low_balance_threshold ?? 10}
            onChange={(v) => update("topup_low_balance_threshold", v)}
            min={0} max={1000} step={1}
            testId="edutalk-phase3-topup-low-threshold"
          />
          <NumberField
            label="Cooldown between prompts (sec)"
            value={config?.topup_cooldown_seconds ?? 180}
            onChange={(v) => update("topup_cooldown_seconds", v)}
            min={30} max={1800} step={10}
            testId="edutalk-phase3-topup-cooldown"
          />
          <NumberField
            label="Max prompts per session"
            value={config?.topup_max_per_session ?? 3}
            onChange={(v) => update("topup_max_per_session", v)}
            min={1} max={10} step={1}
            testId="edutalk-phase3-topup-max"
          />
          <NumberField
            label="Dismiss cap per session"
            value={config?.topup_dismiss_cap_per_session ?? 2}
            onChange={(v) => update("topup_dismiss_cap_per_session", v)}
            min={1} max={10} step={1}
            testId="edutalk-phase3-topup-dismiss-cap"
          />
          <NumberField
            label="After-value · every N replies"
            value={config?.topup_after_value_every_n ?? 3}
            onChange={(v) => update("topup_after_value_every_n", v)}
            min={1} max={20} step={1}
            testId="edutalk-phase3-topup-after-value-n"
          />
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <ToggleRow
            label="Low-balance trigger"
            checked={config?.topup_trigger_low_balance !== false}
            onChange={(v) => update("topup_trigger_low_balance", v)}
            testId="edutalk-phase3-topup-trigger-low-balance"
          />
          <ToggleRow
            label="Replies-left trigger"
            checked={config?.topup_trigger_replies_left !== false}
            onChange={(v) => update("topup_trigger_replies_left", v)}
            testId="edutalk-phase3-topup-trigger-replies-left"
          />
          <ToggleRow
            label="After-value trigger (opt-in)"
            checked={!!config?.topup_trigger_after_value}
            onChange={(v) => update("topup_trigger_after_value", v)}
            testId="edutalk-phase3-topup-trigger-after-value"
          />
          <ToggleRow
            label="Promotion-aware banner"
            checked={config?.topup_trigger_promotion_aware !== false}
            onChange={(v) => update("topup_trigger_promotion_aware", v)}
            testId="edutalk-phase3-topup-trigger-promotion"
          />
          <ToggleRow
            label="Respect audio playing"
            checked={config?.topup_respect_audio_playing !== false}
            onChange={(v) => update("topup_respect_audio_playing", v)}
            testId="edutalk-phase3-topup-respect-audio"
          />
          <ToggleRow
            label="Respect free-reading flow"
            checked={config?.topup_respect_free_read !== false}
            onChange={(v) => update("topup_respect_free_read", v)}
            testId="edutalk-phase3-topup-respect-free-read"
          />
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
/*  Audio Depth Engine v1 — Audio Depth & Coaching Behaviour     */
/*  Drives the backend _resolve_audio_budget resolver.           */
/*  All numeric fields are server-side clamped on save:          */
/*    short:    15–45 s                                          */
/*    normal:   30–90 s                                          */
/*    complex:  60–120 s                                         */
/*    hard max: 60–150 s  (cost protection ceiling)              */
/*    hint count: 1–5                                            */
/*  When audio_depth_mode = "auto_smart" (the default), behaviour*/
/*  is bit-identical to current production targets.              */
/* ============================================================ */
function AudioDepthPanel({ config, update }) {
  const mode = config?.audio_depth_mode || "auto_smart";
  const exMode = config?.exercise_audio_mode || "hints_first";
  return (
    <div className="space-y-2.5" data-testid="edutalk-phase3-audio-depth-panel">
      <SelectField
        label="Audio depth mode"
        value={mode}
        onChange={(v) => update("audio_depth_mode", v)}
        options={[
          { value: "auto_smart",    label: "Auto Smart — backend picks per reply (recommended)" },
          { value: "short",         label: "Short — ~30s (cheaper, free / lite tier)" },
          { value: "standard",      label: "Standard — ~60s (balanced)" },
          { value: "detailed",      label: "Detailed — ~80s (richer)" },
          { value: "premium_coach", label: "Premium Coach — ~105s (deep explanation)" },
        ]}
        testId="edutalk-phase3-audio-depth-mode"
      />
      <p className="text-[10.5px] text-parchment/55 leading-relaxed -mt-1">
        Auto Smart picks short / normal / complex automatically based on the
        reply (length, vocabulary, grammar, exercise). The other modes force a
        single length for every audio call.
      </p>

      <div className="grid grid-cols-2 gap-2.5">
        <NumberField
          label="Short target (sec)"
          value={config?.audio_short_target_sec ?? 30}
          onChange={(v) => update("audio_short_target_sec", v)}
          min={15} max={45} step={1}
          testId="edutalk-phase3-audio-short-sec"
        />
        <NumberField
          label="Normal target (sec)"
          value={config?.audio_normal_target_sec ?? 60}
          onChange={(v) => update("audio_normal_target_sec", v)}
          min={30} max={90} step={1}
          testId="edutalk-phase3-audio-normal-sec"
        />
        <NumberField
          label="Complex target (sec)"
          value={config?.audio_complex_target_sec ?? 105}
          onChange={(v) => update("audio_complex_target_sec", v)}
          min={60} max={120} step={1}
          testId="edutalk-phase3-audio-complex-sec"
        />
        <NumberField
          label="Hard max ceiling (sec) — cost cap"
          value={config?.audio_hard_max_sec ?? 130}
          onChange={(v) => update("audio_hard_max_sec", v)}
          min={60} max={150} step={1}
          testId="edutalk-phase3-audio-hard-max-sec"
        />
      </div>
      <p className="text-[10.5px] text-parchment/55 leading-relaxed -mt-1">
        Hard max ceiling protects business quota — no audio will ever exceed
        this length, regardless of mode or override.
      </p>

      <SelectField
        label="Exercise / challenge behaviour"
        value={exMode}
        onChange={(v) => update("exercise_audio_mode", v)}
        options={[
          { value: "scaffold_only",          label: "Scaffold Only — never reveal answer" },
          { value: "hints_first",            label: "Hints First — give hints, do not spell out (default)" },
          { value: "full_answer_after_try",  label: "Full Answer After Try — reveal only if student asks after trying" },
        ]}
        testId="edutalk-phase3-exercise-mode"
      />
      <div className="grid grid-cols-2 gap-2.5">
        <NumberField
          label="Hint count before reveal"
          value={config?.exercise_hint_count ?? 2}
          onChange={(v) => update("exercise_hint_count", v)}
          min={1} max={5} step={1}
          testId="edutalk-phase3-exercise-hint-count"
        />
        <ToggleRow
          label="Reveal only after student tries"
          checked={config?.exercise_reveal_after_try !== false}
          onChange={(v) => update("exercise_reveal_after_try", v)}
          testId="edutalk-phase3-exercise-reveal-after-try"
        />
      </div>

      <p className="text-[10.5px] text-parchment/55 leading-relaxed -mt-1">
        Per-book audio depth override lives in the “Per-Book Override” panel
        above — select a book there to override audio depth for just that book.
      </p>
    </div>
  );
}

