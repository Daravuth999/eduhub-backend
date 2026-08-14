/**
 * AiToolsStudio.jsx - Author Studio AI Tools control panel.
 *
 * Phase 1 scope (approved):
 *   - 5 panels: Global Settings, Tier Rules, Pricing, Personality, Usage Logs
 *   - Reads / writes /api/admin/ai-tools-config
 *   - Reads /api/admin/ai-tools-usage
 *
 * Auth: gated by the existing StudioAuthProvider (require_admin on the
 *       backend). Non-admin users never reach this page because StudioPage
 *       already renders <StudioDenied /> for them.
 *
 * Visual style: matches the existing Studio aesthetic (gold-on-violet,
 * pill tabs, parchment text). Uses ONLY shadcn primitives already in
 * /src/components/ui/ - no new dependencies.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  RefreshCcw,
  Save,
  Settings,
  Shield,
  Tags,
  Wand2,
  ListTree,
  Sparkles,
} from "lucide-react";
import {
  getAiToolsConfig,
  saveAiToolsConfig,
  listAiUsageLogs,
} from "./api";
import EduTalkStudio from "./EduTalkStudio";

const TIERS = ["free", "standard", "premium", "limited"];
const TOOLS = [
  { key: "khmer_decoder", label: "Khmer Decoder" },
  { key: "executive_upgrade", label: "Executive Upgrade" },
  { key: "ask_book", label: "Ask This Book (Phase 2)" },
];
const TIER_RULE_OPTIONS = [
  { value: "true", label: "Enabled" },
  { value: "paid", label: "Paid only" },
  { value: "preview", label: "Preview only" },
  { value: "false", label: "Disabled" },
];

const PANELS = [
  { key: "global", label: "Global Settings", Icon: Settings },
  { key: "tiers", label: "Tier Rules", Icon: Shield },
  { key: "pricing", label: "Pricing", Icon: Tags },
  { key: "personality", label: "Personality", Icon: Wand2 },
  { key: "edutalk", label: "EduTalk (Phase 2)", Icon: Sparkles },
  { key: "logs", label: "Usage Logs", Icon: ListTree },
];

function ruleToString(v) {
  if (v === true) return "true";
  if (v === false || v == null) return "false";
  return String(v);
}
function stringToRule(s) {
  if (s === "true") return true;
  if (s === "false") return false;
  return s;
}

export default function AiToolsStudio() {
  const [panel, setPanel] = useState("global");
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [errMsg, setErrMsg] = useState("");

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setErrMsg("");
    try {
      const r = await getAiToolsConfig();
      setConfig(r?.config || null);
    } catch (e) {
      setErrMsg(e?.message || "Failed to load config.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const updateConfig = (patch) => {
    setConfig((prev) => ({ ...(prev || {}), ...patch }));
  };

  const updateNested = (key, subKey, value) => {
    setConfig((prev) => ({
      ...(prev || {}),
      [key]: { ...((prev || {})[key] || {}), [subKey]: value },
    }));
  };

  const updateTierRule = (tier, tool, value) => {
    setConfig((prev) => {
      const tr = { ...((prev || {}).tier_rules || {}) };
      tr[tier] = { ...(tr[tier] || {}), [tool]: stringToRule(value) };
      return { ...(prev || {}), tier_rules: tr };
    });
  };

  const onSave = async () => {
    if (!config) return;
    setSaving(true);
    setSaveMsg("");
    setErrMsg("");
    try {
      const payload = {
        enabled: !!config.enabled,
        free_daily_uses: Number(config.free_daily_uses) || 0,
        pricing: config.pricing || {},
        tier_rules: config.tier_rules || {},
        personality: config.personality || {},
      };
      const r = await saveAiToolsConfig(payload);
      setConfig(r?.config || config);
      setSaveMsg("Saved.");
      setTimeout(() => setSaveMsg(""), 2500);
    } catch (e) {
      setErrMsg(e?.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="text-parchment/80 text-[13px]" data-testid="aitools-loading">
        Loading AI Tools config...
      </div>
    );
  }
  if (!config) {
    return (
      <div className="text-red-300 text-[13px]" data-testid="aitools-error">
        {errMsg || "Could not load AI Tools config."}
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="aitools-studio">
      {/* Header */}
      <div className="rounded-2xl border border-gold/25 p-5"
           style={{ background: "rgba(20,14,32,0.72)", backdropFilter: "blur(8px)" }}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl"
               style={{ background: "linear-gradient(150deg, #2D1F3E 0%, #1A1420 100%)" }}>
            <Wand2 className="h-5 w-5 text-gold" />
          </div>
          <div className="flex-1 min-w-[200px]">
            <h2 className="font-display text-xl text-parchment">AI Tools Control Center</h2>
            <p className="text-[12px] text-faded">
              Configure Gemini premium utilities, point pricing, tier rules, and AI personality.
            </p>
          </div>
          <button
            type="button"
            onClick={loadConfig}
            data-testid="aitools-reload-btn"
            className="inline-flex items-center gap-1.5 rounded-full border border-parchment/20 bg-walnut/70 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold"
          >
            <RefreshCcw className="h-3.5 w-3.5" /> Reload
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            data-testid="aitools-save-btn"
            className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-ink disabled:opacity-60"
            style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}
          >
            <Save className="h-3.5 w-3.5" /> {saving ? "Saving..." : "Save"}
          </button>
        </div>
        {saveMsg && (
          <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-900/50 px-3 py-1 text-[11px] text-emerald-200" data-testid="aitools-save-success">
            <CheckCircle2 className="h-3.5 w-3.5" /> {saveMsg}
          </p>
        )}
        {errMsg && (
          <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-red-900/40 px-3 py-1 text-[11px] text-red-200" data-testid="aitools-error-msg">
            <AlertCircle className="h-3.5 w-3.5" /> {errMsg}
          </p>
        )}
      </div>

      {/* Panel tabs */}
      <nav className="flex flex-wrap gap-1.5" data-testid="aitools-panel-tabs">
        {PANELS.map(({ key, label, Icon }) => {
          const active = panel === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setPanel(key)}
              data-testid={`aitools-panel-${key}`}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-all"
              style={{
                background: active
                  ? "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)"
                  : "rgba(45,31,62,0.65)",
                color: active ? "#1a1420" : "#F4E5C1",
                border: active ? "1px solid rgba(255,225,154,0.6)" : "1px solid rgba(212,168,67,0.25)",
              }}
            >
              <Icon className="h-3 w-3" /> {label}
            </button>
          );
        })}
      </nav>

      {/* Panels */}
      {panel === "global" && (
        <GlobalPanel config={config} update={updateConfig} />
      )}
      {panel === "tiers" && (
        <TierPanel config={config} updateTierRule={updateTierRule} />
      )}
      {panel === "pricing" && (
        <PricingPanel
          pricing={config.pricing || {}}
          updateNested={(k, v) => updateNested("pricing", k, v)}
        />
      )}
      {panel === "personality" && (
        <PersonalityPanel
          personality={config.personality || {}}
          updateNested={(k, v) => updateNested("personality", k, v)}
        />
      )}
      {panel === "edutalk" && <EduTalkStudio />}
      {panel === "logs" && <UsageLogsPanel />}
    </div>
  );
}

/* ----------------------- Global Settings ----------------------- */
function GlobalPanel({ config, update }) {
  return (
    <div className="rounded-2xl border border-gold/15 p-5 space-y-4"
         style={{ background: "rgba(20,14,32,0.55)" }}
         data-testid="aitools-global-panel">
      <Row label="Gemini status">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-900/40 px-2.5 py-1 text-[11px] text-emerald-200">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Configured via Render env
        </span>
      </Row>
      <Row label="Current model">
        <code className="text-gold text-[12px]">{config.model || "gemini-2.5-flash"}</code>
      </Row>
      <Row label="Enable premium AI tools">
        <Toggle
          checked={!!config.enabled}
          onChange={(v) => update({ enabled: v })}
          testid="aitools-toggle-enabled"
        />
      </Row>
      <Row label="Free daily uses per student">
        <input
          type="number"
          min="0"
          max="50"
          value={config.free_daily_uses ?? 0}
          onChange={(e) => update({ free_daily_uses: Number(e.target.value) || 0 })}
          data-testid="aitools-free-daily-uses"
          className="w-24 rounded-lg border border-parchment/20 bg-walnut/70 px-2 py-1 text-[12px] text-parchment focus:border-gold focus:outline-none"
        />
      </Row>
      <p className="text-[11px] text-faded">
        Note: Phase 1 enables Khmer Decoder and Executive Upgrade. Ask This Book is reserved for Phase 2 and is shown in the UI for forward-compatibility.
      </p>
    </div>
  );
}

/* ----------------------- Tier Rules ----------------------- */
function TierPanel({ config, updateTierRule }) {
  const rules = config.tier_rules || {};
  return (
    <div className="rounded-2xl border border-gold/15 p-5 overflow-x-auto"
         style={{ background: "rgba(20,14,32,0.55)" }}
         data-testid="aitools-tier-panel">
      <table className="w-full text-[12px] text-parchment">
        <thead>
          <tr className="text-[10.5px] uppercase tracking-[0.18em] text-faded">
            <th className="text-left py-2 pr-3">Tier</th>
            {TOOLS.map((t) => (
              <th key={t.key} className="text-left py-2 pr-3">{t.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {TIERS.map((tier) => (
            <tr key={tier} className="border-t border-parchment/10" data-testid={`aitools-tier-row-${tier}`}>
              <td className="py-2.5 pr-3 capitalize font-semibold">{tier}</td>
              {TOOLS.map((t) => (
                <td key={t.key} className="py-2.5 pr-3">
                  <select
                    value={ruleToString((rules[tier] || {})[t.key])}
                    onChange={(e) => updateTierRule(tier, t.key, e.target.value)}
                    data-testid={`aitools-tier-${tier}-${t.key}`}
                    className="rounded-lg border border-parchment/20 bg-walnut/70 px-2 py-1 text-[11px] text-parchment focus:border-gold focus:outline-none"
                  >
                    {TIER_RULE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------- Pricing ----------------------- */
function PricingPanel({ pricing, updateNested }) {
  return (
    <div className="rounded-2xl border border-gold/15 p-5 space-y-4"
         style={{ background: "rgba(20,14,32,0.55)" }}
         data-testid="aitools-pricing-panel">
      {TOOLS.map((t) => (
        <Row key={t.key} label={`${t.label} cost (points)`}>
          <input
            type="number"
            min="0"
            max="200"
            value={pricing[t.key] ?? 0}
            onChange={(e) => updateNested(t.key, Number(e.target.value) || 0)}
            data-testid={`aitools-pricing-${t.key}`}
            className="w-24 rounded-lg border border-parchment/20 bg-walnut/70 px-2 py-1 text-[12px] text-parchment focus:border-gold focus:outline-none"
          />
        </Row>
      ))}
      <p className="text-[11px] text-faded">
        Cost is charged ONLY after a successful Gemini response. Failed AI calls never deduct points.
      </p>
    </div>
  );
}

/* ----------------------- Personality ----------------------- */
function PersonalityPanel({ personality, updateNested }) {
  return (
    <div className="rounded-2xl border border-gold/15 p-5 space-y-4"
         style={{ background: "rgba(20,14,32,0.55)" }}
         data-testid="aitools-personality-panel">
      <Row label="Tone preset">
        <select
          value={personality.tone || "professional"}
          onChange={(e) => updateNested("tone", e.target.value)}
          data-testid="aitools-personality-tone"
          className="rounded-lg border border-parchment/20 bg-walnut/70 px-2 py-1.5 text-[12px] text-parchment focus:border-gold focus:outline-none"
        >
          <option value="professional">Professional</option>
          <option value="friendly">Friendly</option>
          <option value="executive">Executive</option>
          <option value="encouraging">Encouraging</option>
        </select>
      </Row>
      <div>
        <label className="block text-[11px] uppercase tracking-[0.18em] text-faded mb-1.5">
          System instruction
        </label>
        <textarea
          rows={6}
          value={personality.system_instruction || ""}
          onChange={(e) => updateNested("system_instruction", e.target.value)}
          data-testid="aitools-personality-instruction"
          className="w-full rounded-xl border border-parchment/20 bg-walnut/70 p-3 text-[12.5px] text-parchment focus:border-gold focus:outline-none"
          placeholder="You are EduHub's private English coach for Cambodian learners..."
        />
        <p className="mt-1.5 text-[10.5px] text-faded">
          This instruction is read on the server side at every AI call. It is never exposed to the student.
        </p>
      </div>
    </div>
  );
}

/* ----------------------- Usage Logs ----------------------- */
function UsageLogsPanel() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const r = await listAiUsageLogs({ limit: 100 });
      setItems(r?.items || []);
      setTotal(r?.total || 0);
    } catch (e) {
      setErr(e?.message || "Failed to load logs.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="rounded-2xl border border-gold/15 p-5"
         style={{ background: "rgba(20,14,32,0.55)" }}
         data-testid="aitools-logs-panel">
      <div className="mb-3 flex items-center gap-3">
        <h3 className="text-[13px] font-bold uppercase tracking-[0.18em] text-parchment">
          Recent Usage
        </h3>
        <span className="text-[11px] text-faded">{total} total entries</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={load}
          data-testid="aitools-logs-refresh"
          className="inline-flex items-center gap-1.5 rounded-full border border-parchment/20 bg-walnut/70 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold"
        >
          <RefreshCcw className="h-3 w-3" /> Refresh
        </button>
      </div>
      {err && <p className="text-[12px] text-red-300 mb-3">{err}</p>}
      {loading ? (
        <p className="text-[12px] text-faded">Loading logs...</p>
      ) : items.length === 0 ? (
        <p className="text-[12px] text-faded" data-testid="aitools-logs-empty">
          No usage logs yet. Logs will appear here after the first student call.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11.5px] text-parchment">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.18em] text-faded">
                <th className="text-left py-2 pr-3">Time (UTC)</th>
                <th className="text-left py-2 pr-3">Student</th>
                <th className="text-left py-2 pr-3">Book</th>
                <th className="text-left py-2 pr-3">Tool</th>
                <th className="text-left py-2 pr-3">Pts</th>
                <th className="text-left py-2 pr-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => (
                <tr key={idx} className="border-t border-parchment/10" data-testid={`aitools-log-row-${idx}`}>
                  <td className="py-1.5 pr-3 text-faded">
                    {String(it.created_at || "").slice(0, 19).replace("T", " ")}
                  </td>
                  <td className="py-1.5 pr-3">
                    <span className="text-parchment">{it.student_name || it.clean_id || it.student_id}</span>
                    <span className="text-faded ml-1.5 text-[10.5px]">({it.clean_id})</span>
                  </td>
                  <td className="py-1.5 pr-3 text-faded">{it.book_slug || "-"}</td>
                  <td className="py-1.5 pr-3 text-parchment">{it.tool}</td>
                  <td className="py-1.5 pr-3 text-gold font-semibold">{it.points_deducted || 0}</td>
                  <td className="py-1.5 pr-3">
                    <StatusPill status={it.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }) {
  const map = {
    success: { bg: "bg-emerald-900/50", color: "text-emerald-200", label: "success" },
    insufficient_points: { bg: "bg-amber-900/40", color: "text-amber-200", label: "no funds" },
    ai_error: { bg: "bg-red-900/40", color: "text-red-200", label: "ai error" },
    debit_failed: { bg: "bg-red-900/40", color: "text-red-200", label: "debit failed" },
  };
  const s = map[status] || { bg: "bg-walnut/70", color: "text-parchment", label: status || "?" };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full ${s.bg} ${s.color} px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wider`}>
      {s.label}
    </span>
  );
}

/* ----------------------- shared primitives ----------------------- */
function Row({ label, children }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-[200px] text-[11px] uppercase tracking-[0.18em] text-faded">
        {label}
      </div>
      <div className="flex-1 min-w-[140px]">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, testid }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      data-testid={testid}
      className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors"
      style={{
        background: checked
          ? "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)"
          : "rgba(212,168,67,0.18)",
      }}
    >
      <span
        className="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
        style={{ transform: `translateX(${checked ? 22 : 4}px)` }}
      />
    </button>
  );
}
