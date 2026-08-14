/**
 * AiAssistantStudio.jsx — Author Studio admin panel for the rebuilt
 * AI Assistant (Personal English Coach powered by Gemini 2.5 Flash).
 *
 * Reads/writes /api/admin/ai-assistant/config and runs a safe test
 * prompt against /api/admin/ai-assistant/test (no student points are
 * deducted by a test).
 *
 * Auth: gated by the existing StudioAuthProvider (require_admin on the
 * backend). Visual style matches the other Studio tabs (gold-on-violet
 * pill tabs, parchment text, soft cards).
 *
 * This component is NEW and does not touch any existing Studio panel.
 */
import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  RefreshCcw,
  Save,
  Settings,
  Wand2,
  ListTree,
  TestTubes,
  Coins,
  ShieldCheck,
  Sparkles,
  Mic,
  Target,
  Gift,
  ShieldAlert,
  BellRing,
  Headphones,
} from "lucide-react";
import {
  getAiAssistantConfig,
  saveAiAssistantConfig,
  testAiAssistant,
  getAiAssistantVoiceRewardsConfig,
  saveAiAssistantVoiceRewardsConfig,
} from "./api";

const PANELS = [
  { key: "general", label: "General", Icon: Settings },
  { key: "prompt", label: "Coach Prompt", Icon: Wand2 },
  { key: "modes", label: "Modes & Suggestions", Icon: ListTree },
  { key: "test", label: "Test Prompt", Icon: TestTubes },
  { key: "voice", label: "Voice Practice", Icon: Mic },
  { key: "missions", label: "Mission Control", Icon: Target },
  { key: "rewards", label: "Reward Control", Icon: Gift },
  { key: "fraud", label: "Fraud Protection", Icon: ShieldAlert },
  { key: "notify", label: "Notifications", Icon: BellRing },
];

export default function AiAssistantStudio() {
  const [panel, setPanel] = useState("general");
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [errMsg, setErrMsg] = useState("");

  // Test panel state
  const [testPrompt, setTestPrompt] = useState(
    "Explain the difference between 'since' and 'for' with two examples.",
  );
  const [testing, setTesting] = useState(false);
  const [testAnswer, setTestAnswer] = useState("");
  const [testError, setTestError] = useState("");

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setErrMsg("");
    try {
      const r = await getAiAssistantConfig();
      setConfig(r?.config || null);
    } catch (e) {
      setErrMsg(e?.message || "Failed to load AI Assistant config.");
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Voice / Missions / Rewards / Fraud / Notifications config ──────
  const [vrConfig, setVrConfig] = useState(null);
  const [vrSaving, setVrSaving] = useState(false);
  const [vrLoading, setVrLoading] = useState(true);

  const loadVrConfig = useCallback(async () => {
    setVrLoading(true);
    try {
      const r = await getAiAssistantVoiceRewardsConfig();
      setVrConfig(r?.config || null);
    } catch (e) {
      // non-fatal — chat config still works
      setVrConfig(null);
    } finally {
      setVrLoading(false);
    }
  }, []);

  const updateVr = (section, patch) => {
    setVrConfig((prev) => ({
      ...(prev || {}),
      [section]: { ...((prev || {})[section] || {}), ...patch },
    }));
  };

  const onSaveVr = async () => {
    if (!vrConfig) return;
    setVrSaving(true);
    setSaveMsg("");
    setErrMsg("");
    try {
      const r = await saveAiAssistantVoiceRewardsConfig({
        voice_practice: vrConfig.voice_practice || {},
        missions: vrConfig.missions || {},
        rewards: vrConfig.rewards || {},
        fraud: vrConfig.fraud || {},
        notifications: vrConfig.notifications || {},
      });
      setVrConfig(r?.config || vrConfig);
      setSaveMsg("Speech Coach settings saved.");
    } catch (e) {
      setErrMsg(e?.message || "Save failed.");
    } finally {
      setVrSaving(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line
    loadConfig();
    loadVrConfig();
  }, [loadConfig, loadVrConfig]);

  const update = (patch) => {
    setConfig((prev) => ({ ...(prev || {}), ...patch }));
  };

  const onSave = async () => {
    if (!config) return;
    setSaving(true);
    setSaveMsg("");
    setErrMsg("");
    try {
      const r = await saveAiAssistantConfig({
        enabled: !!config.enabled,
        model: String(config.model || "gemini-2.5-flash"),
        cost_points: Math.max(0, Number(config.cost_points) || 0),
        voice_input_enabled: !!config.voice_input_enabled,
        khmer_support_enabled: !!config.khmer_support_enabled,
        system_prompt: String(config.system_prompt || ""),
        temperature: Math.max(0, Math.min(2, Number(config.temperature) || 0.6)),
        max_output_tokens: Math.max(
          64,
          Math.min(4096, Number(config.max_output_tokens) || 800),
        ),
        book_redirect_enabled: !!config.book_redirect_enabled,
        book_redirect_message: String(config.book_redirect_message || ""),
        modes: Array.isArray(config.modes) ? config.modes : [],
        suggestions: Array.isArray(config.suggestions) ? config.suggestions : [],
      });
      setConfig(r?.config || config);
      setSaveMsg("Saved. Students will see the new settings on next load.");
    } catch (e) {
      setErrMsg(e?.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    if (!testPrompt.trim()) return;
    setTesting(true);
    setTestAnswer("");
    setTestError("");
    try {
      const r = await testAiAssistant({
        prompt: testPrompt.trim(),
        model: config?.model,
        temperature: Number(config?.temperature) || 0.6,
        max_output_tokens: Number(config?.max_output_tokens) || 800,
        system_prompt: config?.system_prompt,
      });
      if (r?.success && r.answer) {
        setTestAnswer(r.answer);
      } else {
        setTestError(r?.message || "Gemini did not return an answer.");
      }
    } catch (e) {
      setTestError(e?.message || "Test failed.");
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div
        className="rounded-2xl border border-gold/20 p-6 text-faded text-[13px]"
        style={{ background: "rgba(20,14,32,0.6)" }}
        data-testid="ai-assistant-studio-loading"
      >
        Loading AI Assistant config…
      </div>
    );
  }

  if (!config) {
    return (
      <div
        className="rounded-2xl border border-red-400/40 p-6 text-red-200 text-[13px]"
        style={{ background: "rgba(40,10,20,0.6)" }}
        data-testid="ai-assistant-studio-error"
      >
        <div className="flex items-center gap-2 mb-2 font-bold">
          <AlertCircle className="h-4 w-4" /> {errMsg || "Config unavailable"}
        </div>
        <button
          onClick={loadConfig}
          data-testid="ai-assistant-studio-retry"
          className="inline-flex items-center gap-1.5 rounded-full border border-gold/40 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-gold hover:bg-gold/10"
        >
          <RefreshCcw className="h-3.5 w-3.5" /> Retry
        </button>
      </div>
    );
  }

  const providerReady = !!config.provider_ready;

  return (
    <div className="text-parchment" data-testid="ai-assistant-studio">
      {/* Header */}
      <div
        className="rounded-2xl border border-gold/25 p-4 mb-4 flex items-center gap-3 flex-wrap"
        style={{ background: "rgba(20,14,32,0.7)" }}
      >
        <div
          className="grid h-11 w-11 place-items-center rounded-xl text-ink"
          style={{
            background:
              "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
          }}
        >
          <Sparkles className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="font-display text-[17px] leading-tight">
            AI Assistant — Personal English Coach
          </div>
          <div className="text-[11.5px] text-faded">
            Gemini 2.5 Flash · text + voice · isolated from EduTalk &amp;
            Premium AI Reader
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10.5px] font-bold border"
            style={{
              borderColor: providerReady
                ? "rgba(120, 220, 130, 0.5)"
                : "rgba(255, 110, 120, 0.5)",
              background: providerReady
                ? "rgba(120, 220, 130, 0.1)"
                : "rgba(255, 110, 120, 0.1)",
              color: providerReady ? "#7BE08A" : "#FF8B95",
            }}
            data-testid="ai-assistant-provider-status"
          >
            <ShieldCheck className="h-3 w-3" />
            {providerReady
              ? "GEMINI_API_KEY detected"
              : "GEMINI_API_KEY missing"}
          </span>
        </div>
      </div>

      {/* Panel tabs */}
      <nav
        className="flex flex-wrap gap-1.5 mb-4"
        data-testid="ai-assistant-studio-tabs"
      >
        {PANELS.map(({ key, label, Icon }) => {
          const active = panel === key;
          return (
            <button
              key={key}
              onClick={() => setPanel(key)}
              data-testid={`ai-assistant-tab-${key}`}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-all"
              style={{
                background: active
                  ? "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)"
                  : "rgba(45,31,62,0.65)",
                color: active ? "#1a1420" : "#F4E5C1",
                border: active
                  ? "1px solid rgba(255,225,154,0.6)"
                  : "1px solid rgba(212,168,67,0.25)",
              }}
            >
              <Icon className="h-3 w-3" /> {label}
            </button>
          );
        })}
      </nav>

      {/* Save/error toast */}
      {(saveMsg || errMsg) && (
        <div
          className="rounded-xl border p-3 mb-4 text-[12.5px] flex items-center gap-2"
          style={{
            background: errMsg ? "rgba(80,20,30,0.5)" : "rgba(20,50,30,0.5)",
            borderColor: errMsg
              ? "rgba(255,90,100,0.4)"
              : "rgba(120,220,130,0.45)",
            color: errMsg ? "#FF8B95" : "#A9F0B5",
          }}
          data-testid="ai-assistant-studio-toast"
        >
          {errMsg ? (
            <AlertCircle className="h-3.5 w-3.5" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" />
          )}
          <span>{errMsg || saveMsg}</span>
        </div>
      )}

      {/* General panel */}
      {panel === "general" && (
        <div
          className="rounded-2xl border border-gold/20 p-5 space-y-5"
          style={{ background: "rgba(20,14,32,0.6)" }}
        >
          <Row label="Feature enabled">
            <Toggle
              checked={!!config.enabled}
              onChange={(v) => update({ enabled: v })}
              testId="ai-assistant-enabled-toggle"
            />
          </Row>

          <Row label="Gemini model">
            <input
              type="text"
              value={config.model || ""}
              onChange={(e) => update({ model: e.target.value })}
              placeholder="gemini-2.5-flash"
              data-testid="ai-assistant-model-input"
              className="w-full rounded-xl border border-gold/30 bg-walnut/40 px-3 py-2 text-[13px] text-parchment outline-none focus:border-gold"
            />
            <p className="text-[10.5px] text-faded mt-1">
              Default and recommended: <code className="text-gold">gemini-2.5-flash</code>.
            </p>
          </Row>

          <Row label="Cost per answer (points)">
            <input
              type="number"
              min="0"
              step="1"
              value={Number(config.cost_points) || 0}
              onChange={(e) =>
                update({ cost_points: Math.max(0, Number(e.target.value) || 0) })
              }
              data-testid="ai-assistant-cost-input"
              className="w-32 rounded-xl border border-gold/30 bg-walnut/40 px-3 py-2 text-[13px] text-parchment outline-none focus:border-gold"
            />
            <p className="text-[10.5px] text-faded mt-1 inline-flex items-center gap-1">
              <Coins className="h-3 w-3 text-gold" /> Charged only AFTER a
              successful Gemini answer. Voice transcription alone is free.
            </p>
          </Row>

          <Row label="Voice input (Web Speech API)">
            <Toggle
              checked={!!config.voice_input_enabled}
              onChange={(v) => update({ voice_input_enabled: v })}
              testId="ai-assistant-voice-toggle"
            />
            <p className="text-[10.5px] text-faded mt-1">
              When off, the microphone button is hidden. Text input always
              works.
            </p>
          </Row>

          <Row label="Khmer support">
            <Toggle
              checked={!!config.khmer_support_enabled}
              onChange={(v) => update({ khmer_support_enabled: v })}
              testId="ai-assistant-khmer-toggle"
            />
            <p className="text-[10.5px] text-faded mt-1">
              Allow the coach to add one short Khmer helper line when useful.
              The primary language remains English.
            </p>
          </Row>

          <Row label="Temperature">
            <input
              type="number"
              step="0.05"
              min="0"
              max="2"
              value={Number(config.temperature ?? 0.6)}
              onChange={(e) =>
                update({ temperature: Number(e.target.value) || 0 })
              }
              data-testid="ai-assistant-temperature-input"
              className="w-28 rounded-xl border border-gold/30 bg-walnut/40 px-3 py-2 text-[13px] text-parchment outline-none focus:border-gold"
            />
          </Row>

          <Row label="Max output tokens">
            <input
              type="number"
              step="32"
              min="64"
              max="4096"
              value={Number(config.max_output_tokens ?? 800)}
              onChange={(e) =>
                update({ max_output_tokens: Number(e.target.value) || 0 })
              }
              data-testid="ai-assistant-maxtokens-input"
              className="w-28 rounded-xl border border-gold/30 bg-walnut/40 px-3 py-2 text-[13px] text-parchment outline-none focus:border-gold"
            />
          </Row>

          <Row label="Redirect book-specific questions to EduTalk">
            <Toggle
              checked={!!config.book_redirect_enabled}
              onChange={(v) => update({ book_redirect_enabled: v })}
              testId="ai-assistant-redirect-toggle"
            />
          </Row>

          <Row label="Redirect message">
            <textarea
              value={config.book_redirect_message || ""}
              onChange={(e) => update({ book_redirect_message: e.target.value })}
              rows={2}
              data-testid="ai-assistant-redirect-message"
              className="w-full rounded-xl border border-gold/30 bg-walnut/40 px-3 py-2 text-[13px] text-parchment outline-none focus:border-gold"
            />
          </Row>
        </div>
      )}

      {/* Prompt panel */}
      {panel === "prompt" && (
        <div
          className="rounded-2xl border border-gold/20 p-5"
          style={{ background: "rgba(20,14,32,0.6)" }}
        >
          <label className="block text-[11px] uppercase tracking-wider text-faded font-bold mb-1.5">
            System prompt (coach personality)
          </label>
          <textarea
            value={config.system_prompt || ""}
            onChange={(e) => update({ system_prompt: e.target.value })}
            rows={14}
            data-testid="ai-assistant-system-prompt"
            className="w-full rounded-xl border border-gold/30 bg-walnut/40 px-3 py-2 text-[12.5px] text-parchment outline-none focus:border-gold font-mono"
          />
          <p className="text-[10.5px] text-faded mt-2">
            Keep the coach style: direct answer, simple explanation, two
            examples, one practice task, one follow-up question. EduTalk is
            handled by a separate prompt — do NOT include book-specific
            instructions here.
          </p>
        </div>
      )}

      {/* Modes & Suggestions */}
      {panel === "modes" && (
        <div className="grid sm:grid-cols-2 gap-4">
          <ListEditor
            title="Mode chips"
            description="Short labels shown above the chat (e.g. Grammar, Speaking)."
            value={config.modes || []}
            onChange={(v) => update({ modes: v })}
            testIdBase="ai-assistant-modes"
          />
          <ListEditor
            title="Prompt suggestions"
            description="Shown on first load as quick-start chips."
            value={config.suggestions || []}
            onChange={(v) => update({ suggestions: v })}
            testIdBase="ai-assistant-suggestions"
          />
        </div>
      )}

      {/* Test panel */}
      {panel === "test" && (
        <div
          className="rounded-2xl border border-gold/20 p-5"
          style={{ background: "rgba(20,14,32,0.6)" }}
        >
          <label className="block text-[11px] uppercase tracking-wider text-faded font-bold mb-1.5">
            Test prompt (no student points are deducted)
          </label>
          <textarea
            value={testPrompt}
            onChange={(e) => setTestPrompt(e.target.value)}
            rows={4}
            data-testid="ai-assistant-test-prompt"
            className="w-full rounded-xl border border-gold/30 bg-walnut/40 px-3 py-2 text-[13px] text-parchment outline-none focus:border-gold"
          />
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={runTest}
              disabled={testing || !providerReady}
              data-testid="ai-assistant-test-run"
              className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[12px] font-bold uppercase tracking-wider text-ink disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background:
                  "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
              }}
            >
              <TestTubes className="h-3.5 w-3.5" />
              {testing ? "Running…" : "Run test"}
            </button>
            {!providerReady && (
              <span className="text-[11px] text-red-300">
                Set GEMINI_API_KEY on the server before testing.
              </span>
            )}
          </div>

          {testError && (
            <div
              className="mt-4 rounded-xl border border-red-400/40 bg-red-400/10 text-red-200 p-3 text-[12.5px] flex items-start gap-2"
              data-testid="ai-assistant-test-error"
            >
              <AlertCircle className="h-3.5 w-3.5 mt-0.5" />
              <span>{testError}</span>
            </div>
          )}

          {testAnswer && (
            <div
              className="mt-4 rounded-xl border border-gold/25 bg-walnut/50 p-4 text-[13px] whitespace-pre-wrap text-parchment"
              data-testid="ai-assistant-test-answer"
            >
              {testAnswer}
            </div>
          )}
        </div>
      )}

      {/* ── Voice Practice panel ─────────────────────────────────── */}
      {panel === "voice" && (
        <VrPanel
          title="Voice Practice"
          icon={<Mic className="h-4 w-4" />}
          loading={vrLoading}
          available={!!vrConfig}
        >
          <Row label="Enable real voice recording">
            <Toggle
              checked={!!vrConfig?.voice_practice?.real_recording_enabled}
              onChange={(v) => updateVr("voice_practice", { real_recording_enabled: v })}
              testId="vr-voice-recording-toggle"
            />
            <p className="text-[10.5px] text-faded mt-1">
              When OFF, students can still submit a typed transcript (audio is
              not stored). v1 analyses the transcript only — phoneme/audio
              level scoring is intentionally NOT advertised.
            </p>
          </Row>
          <Row label="Store recordings in Cloudflare R2">
            <Toggle
              checked={!!vrConfig?.voice_practice?.store_in_r2}
              onChange={(v) => updateVr("voice_practice", { store_in_r2: v })}
              testId="vr-voice-r2-toggle"
            />
            <p className="text-[10.5px] text-faded mt-1 inline-flex items-center gap-1">
              <Headphones className="h-3 w-3 text-gold" /> Reuses the same
              R2 env vars Author Studio already uses. R2 detected:{" "}
              <code className="text-gold ml-1">
                {vrConfig?._r2_available ? "yes" : "no"}
              </code>
            </p>
          </Row>
          <Row label="Max duration (seconds)">
            <NumberInput
              value={vrConfig?.voice_practice?.max_duration_seconds ?? 30}
              min={5}
              max={120}
              onChange={(n) => updateVr("voice_practice", { max_duration_seconds: n })}
              testId="vr-voice-maxdur"
            />
          </Row>
          <Row label="Max file size (MB)">
            <NumberInput
              value={vrConfig?.voice_practice?.max_file_size_mb ?? 5}
              min={1}
              max={20}
              onChange={(n) => updateVr("voice_practice", { max_file_size_mb: n })}
              testId="vr-voice-maxsize"
            />
          </Row>
          <Row label="Retention (days)">
            <NumberInput
              value={vrConfig?.voice_practice?.retention_days ?? 90}
              min={1}
              max={3650}
              onChange={(n) => updateVr("voice_practice", { retention_days: n })}
              testId="vr-voice-retention"
            />
          </Row>
          <Row label="Teacher review enabled">
            <Toggle
              checked={!!vrConfig?.voice_practice?.teacher_review_enabled}
              onChange={(v) => updateVr("voice_practice", { teacher_review_enabled: v })}
              testId="vr-voice-teacher-toggle"
            />
          </Row>
        </VrPanel>
      )}

      {/* ── Mission Control panel ────────────────────────────────── */}
      {panel === "missions" && (
        <VrPanel
          title="Mission Control"
          icon={<Target className="h-4 w-4" />}
          loading={vrLoading}
          available={!!vrConfig}
        >
          <Row label="Enable Speech Missions">
            <Toggle
              checked={!!vrConfig?.missions?.enabled}
              onChange={(v) => updateVr("missions", { enabled: v })}
              testId="vr-missions-enabled"
            />
          </Row>
          <Row label="Speaking Challenge enabled">
            <Toggle
              checked={!!vrConfig?.missions?.speaking_challenge_enabled}
              onChange={(v) => updateVr("missions", { speaking_challenge_enabled: v })}
              testId="vr-missions-speaking"
            />
          </Row>
          <Row label="Pronunciation Drill enabled">
            <Toggle
              checked={!!vrConfig?.missions?.pronunciation_drill_enabled}
              onChange={(v) => updateVr("missions", { pronunciation_drill_enabled: v })}
              testId="vr-missions-pronunciation"
            />
          </Row>
          <Row label="Friday Class Prep enabled">
            <Toggle
              checked={!!vrConfig?.missions?.friday_class_prep_enabled}
              onChange={(v) => updateVr("missions", { friday_class_prep_enabled: v })}
              testId="vr-missions-friday"
            />
          </Row>
          <Row label="Sentence Delivery Coach enabled">
            <Toggle
              checked={!!vrConfig?.missions?.sentence_delivery_enabled}
              onChange={(v) => updateVr("missions", { sentence_delivery_enabled: v })}
              testId="vr-missions-sentence"
            />
          </Row>
          <Row label="Retry required before reward">
            <Toggle
              checked={!!vrConfig?.missions?.retry_required}
              onChange={(v) => updateVr("missions", { retry_required: v })}
              testId="vr-missions-retry"
            />
          </Row>
          <Row label="Voice required for rewards">
            <Toggle
              checked={!!vrConfig?.missions?.voice_required_for_rewards}
              onChange={(v) => updateVr("missions", { voice_required_for_rewards: v })}
              testId="vr-missions-voice-required"
            />
          </Row>
          <Row label="Mission expiry (minutes)">
            <NumberInput
              value={vrConfig?.missions?.mission_expiry_minutes ?? 30}
              min={5}
              max={240}
              onChange={(n) => updateVr("missions", { mission_expiry_minutes: n })}
              testId="vr-missions-expiry"
            />
          </Row>
        </VrPanel>
      )}

      {/* ── Reward Control panel ─────────────────────────────────── */}
      {panel === "rewards" && (
        <VrPanel
          title="Reward Control"
          icon={<Gift className="h-4 w-4" />}
          loading={vrLoading}
          available={!!vrConfig}
        >
          <Row label="Enable Coach Rewards">
            <Toggle
              checked={!!vrConfig?.rewards?.enabled}
              onChange={(v) => updateVr("rewards", { enabled: v })}
              testId="vr-rewards-enabled"
            />
            <p className="text-[10.5px] text-faded mt-1 inline-flex items-center gap-1">
              <ShieldCheck className="h-3 w-3 text-gold" /> Mongo wallet credit ready:{" "}
              <code className="text-gold ml-1">
                {vrConfig?._wallet_ready ? "yes" : "no"}
              </code>
            </p>
          </Row>
          <Row label="Enable Bonus Box UI">
            <Toggle
              checked={!!vrConfig?.rewards?.bonus_box_enabled}
              onChange={(v) => updateVr("rewards", { bonus_box_enabled: v })}
              testId="vr-rewards-bonus"
            />
          </Row>
          <Row label="Speaking Challenge reward (pts)">
            <NumberInput
              value={vrConfig?.rewards?.speaking_challenge_pts ?? 2}
              min={0}
              max={50}
              onChange={(n) => updateVr("rewards", { speaking_challenge_pts: n })}
              testId="vr-rewards-speaking"
            />
          </Row>
          <Row label="Pronunciation Drill reward (pts)">
            <NumberInput
              value={vrConfig?.rewards?.pronunciation_drill_pts ?? 2}
              min={0}
              max={50}
              onChange={(n) => updateVr("rewards", { pronunciation_drill_pts: n })}
              testId="vr-rewards-pronunciation"
            />
          </Row>
          <Row label="Friday Class Prep reward (pts)">
            <NumberInput
              value={vrConfig?.rewards?.friday_class_prep_pts ?? 3}
              min={0}
              max={50}
              onChange={(n) => updateVr("rewards", { friday_class_prep_pts: n })}
              testId="vr-rewards-friday"
            />
          </Row>
          <Row label="Sentence Delivery reward (pts)">
            <NumberInput
              value={vrConfig?.rewards?.sentence_delivery_pts ?? 1}
              min={0}
              max={50}
              onChange={(n) => updateVr("rewards", { sentence_delivery_pts: n })}
              testId="vr-rewards-sentence"
            />
          </Row>
          <Row label="Daily reward cap (pts)">
            <NumberInput
              value={vrConfig?.rewards?.daily_cap_pts ?? 5}
              min={0}
              max={500}
              onChange={(n) => updateVr("rewards", { daily_cap_pts: n })}
              testId="vr-rewards-daily-cap"
            />
          </Row>
          <Row label="Weekly special cap (pts)">
            <NumberInput
              value={vrConfig?.rewards?.weekly_cap_pts ?? 10}
              min={0}
              max={1000}
              onChange={(n) => updateVr("rewards", { weekly_cap_pts: n })}
              testId="vr-rewards-weekly-cap"
            />
          </Row>
          <Row label="Claim expiry (minutes)">
            <NumberInput
              value={vrConfig?.rewards?.claim_expiry_minutes ?? 5}
              min={1}
              max={60}
              onChange={(n) => updateVr("rewards", { claim_expiry_minutes: n })}
              testId="vr-rewards-claim-expiry"
            />
          </Row>
        </VrPanel>
      )}

      {/* ── Fraud Protection panel ───────────────────────────────── */}
      {panel === "fraud" && (
        <VrPanel
          title="Fraud Protection"
          icon={<ShieldAlert className="h-4 w-4" />}
          loading={vrLoading}
          available={!!vrConfig}
        >
          <Row label="Minimum words per attempt">
            <NumberInput
              value={vrConfig?.fraud?.min_words ?? 8}
              min={1}
              max={200}
              onChange={(n) => updateVr("fraud", { min_words: n })}
              testId="vr-fraud-minwords"
            />
          </Row>
          <Row label="Minimum duration (seconds)">
            <NumberInput
              value={vrConfig?.fraud?.min_duration_seconds ?? 10}
              min={1}
              max={120}
              onChange={(n) => updateVr("fraud", { min_duration_seconds: n })}
              testId="vr-fraud-mindur"
            />
          </Row>
          <Row label="Minimum attempts required">
            <NumberInput
              value={vrConfig?.fraud?.min_attempts ?? 2}
              min={1}
              max={10}
              onChange={(n) => updateVr("fraud", { min_attempts: n })}
              testId="vr-fraud-minatt"
            />
          </Row>
          <Row label="Block duplicate transcripts">
            <Toggle
              checked={!!vrConfig?.fraud?.block_duplicate_transcript}
              onChange={(v) => updateVr("fraud", { block_duplicate_transcript: v })}
              testId="vr-fraud-dup"
            />
          </Row>
          <Row label="Cooldown between claims (seconds)">
            <NumberInput
              value={vrConfig?.fraud?.cooldown_seconds_between_claims ?? 60}
              min={0}
              max={86400}
              onChange={(n) => updateVr("fraud", { cooldown_seconds_between_claims: n })}
              testId="vr-fraud-cooldown"
            />
          </Row>
          <Row label="Max claims per day">
            <NumberInput
              value={vrConfig?.fraud?.max_claims_per_day ?? 3}
              min={1}
              max={50}
              onChange={(n) => updateVr("fraud", { max_claims_per_day: n })}
              testId="vr-fraud-maxclaims"
            />
          </Row>
          <Row label="Require voice for high rewards">
            <Toggle
              checked={!!vrConfig?.fraud?.require_voice_for_high_rewards}
              onChange={(v) => updateVr("fraud", { require_voice_for_high_rewards: v })}
              testId="vr-fraud-voice-required"
            />
          </Row>
          <Row label="Teacher review for high rewards">
            <Toggle
              checked={!!vrConfig?.fraud?.teacher_review_for_high_rewards}
              onChange={(v) => updateVr("fraud", { teacher_review_for_high_rewards: v })}
              testId="vr-fraud-teacher-review"
            />
          </Row>
        </VrPanel>
      )}

      {/* ── Notifications panel ──────────────────────────────────── */}
      {panel === "notify" && (
        <VrPanel
          title="Notifications"
          icon={<BellRing className="h-4 w-4" />}
          loading={vrLoading}
          available={!!vrConfig}
        >
          <Row label="Push reward notifications">
            <Toggle
              checked={!!vrConfig?.notifications?.push_enabled}
              onChange={(v) => updateVr("notifications", { push_enabled: v })}
              testId="vr-notify-push"
            />
            <p className="text-[10.5px] text-faded mt-1">
              Reuses existing EduHub web push. Only sent AFTER a successful
              MongoDB points credit.{" "}
              <code className="text-gold">
                push channel: {vrConfig?._push_available ? "available" : "unavailable"}
              </code>
            </p>
          </Row>
          <Row label="Notification template">
            <input
              type="text"
              value={vrConfig?.notifications?.template ?? ""}
              onChange={(e) => updateVr("notifications", { template: e.target.value })}
              placeholder="You earned +{points} points for completing {mission}!"
              data-testid="vr-notify-template"
              className="w-full rounded-xl border border-gold/30 bg-walnut/40 px-3 py-2 text-[13px] text-parchment outline-none focus:border-gold"
            />
            <p className="text-[10.5px] text-faded mt-1">
              Use <code className="text-gold">{"{points}"}</code> and{" "}
              <code className="text-gold">{"{mission}"}</code> placeholders.
            </p>
          </Row>
        </VrPanel>
      )}

      {/* Sticky save bar */}
      {panel !== "test" && (
        <div className="mt-5 flex items-center gap-3">
          {["voice", "missions", "rewards", "fraud", "notify"].includes(panel) ? (
            <button
              onClick={onSaveVr}
              disabled={vrSaving || !vrConfig}
              data-testid="ai-assistant-vr-save-btn"
              className="inline-flex items-center gap-2 rounded-full px-5 py-2 text-[12px] font-bold uppercase tracking-wider text-ink disabled:opacity-50"
              style={{
                background:
                  "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
              }}
            >
              <Save className="h-3.5 w-3.5" />
              {vrSaving ? "Saving…" : "Save Speech Coach settings"}
            </button>
          ) : (
            <button
              onClick={onSave}
              disabled={saving}
              data-testid="ai-assistant-save-btn"
              className="inline-flex items-center gap-2 rounded-full px-5 py-2 text-[12px] font-bold uppercase tracking-wider text-ink disabled:opacity-50"
              style={{
                background:
                  "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
              }}
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? "Saving…" : "Save changes"}
            </button>
          )}
          <button
            onClick={() => {
              loadConfig();
              loadVrConfig();
            }}
            disabled={saving || vrSaving}
            data-testid="ai-assistant-reload-btn"
            className="inline-flex items-center gap-1.5 rounded-full border border-gold/40 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-gold hover:bg-gold/10"
          >
            <RefreshCcw className="h-3.5 w-3.5" /> Reload
          </button>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────  VR PANEL WRAPPER  ─────────────────────── */
function VrPanel({ title, icon, loading, available, children }) {
  if (loading) {
    return (
      <div
        className="rounded-2xl border border-gold/20 p-5 text-faded text-[12.5px]"
        style={{ background: "rgba(20,14,32,0.6)" }}
        data-testid="vr-panel-loading"
      >
        Loading Speech Coach settings…
      </div>
    );
  }
  if (!available) {
    return (
      <div
        className="rounded-2xl border border-red-400/40 p-5 text-red-200 text-[12.5px]"
        style={{ background: "rgba(40,10,20,0.5)" }}
        data-testid="vr-panel-unavailable"
      >
        <div className="font-bold mb-1 flex items-center gap-2">
          <AlertCircle className="h-3.5 w-3.5" /> {title} unavailable
        </div>
        <p>
          The Speech Coach module is not registered on this backend. Make sure
          <code className="text-gold mx-1">ai_assistant_voice_tools.py</code>
          is deployed and that server.py registers it after the chat module.
        </p>
      </div>
    );
  }
  return (
    <div
      className="rounded-2xl border border-gold/20 p-5 space-y-5"
      style={{ background: "rgba(20,14,32,0.6)" }}
      data-testid={`vr-panel-${title.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <div className="flex items-center gap-2 font-display text-[14px] text-gold">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

/* ─────────────────────────  NUMBER INPUT  ─────────────────────────── */
function NumberInput({ value, min = 0, max = 1000, onChange, testId }) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      step="1"
      value={Number(value) || 0}
      onChange={(e) => {
        const n = Math.max(min, Math.min(max, Number(e.target.value) || 0));
        onChange(n);
      }}
      data-testid={testId}
      className="w-28 rounded-xl border border-gold/30 bg-walnut/40 px-3 py-2 text-[13px] text-parchment outline-none focus:border-gold"
    />
  );
}

/* ─────────────────────────  REUSABLE BITS  ───────────────────────────── */

function Row({ label, children }) {
  return (
    <div>
      <label className="block text-[11px] uppercase tracking-wider text-faded font-bold mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange, testId }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      data-testid={testId}
      aria-pressed={checked}
      className="inline-flex items-center gap-2"
    >
      <span
        className="inline-block w-10 h-6 rounded-full relative transition-colors"
        style={{
          background: checked ? "#D4A843" : "rgba(255,255,255,0.15)",
        }}
      >
        <span
          className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
          style={{ left: checked ? "20px" : "2px" }}
        />
      </span>
      <span className="text-[12px] font-semibold">
        {checked ? "Enabled" : "Disabled"}
      </span>
    </button>
  );
}

function ListEditor({ title, description, value, onChange, testIdBase }) {
  const [draft, setDraft] = useState("");
  const list = Array.isArray(value) ? value : [];

  const add = () => {
    const t = draft.trim();
    if (!t) return;
    onChange([...list, t]);
    setDraft("");
  };

  const remove = (i) => onChange(list.filter((_, idx) => idx !== i));

  return (
    <div
      className="rounded-2xl border border-gold/20 p-4"
      style={{ background: "rgba(20,14,32,0.6)" }}
      data-testid={`${testIdBase}-editor`}
    >
      <div className="font-display text-[14px] mb-1">{title}</div>
      <p className="text-[10.5px] text-faded mb-3">{description}</p>

      <div className="flex flex-wrap gap-1.5 mb-3" data-testid={`${testIdBase}-chips`}>
        {list.length === 0 && (
          <span className="text-[11px] text-faded">Empty — defaults will be used.</span>
        )}
        {list.map((item, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1.5 rounded-full border border-gold/30 bg-walnut/40 px-3 py-1 text-[11.5px] text-parchment"
          >
            {item}
            <button
              type="button"
              onClick={() => remove(i)}
              data-testid={`${testIdBase}-remove-${i}`}
              className="text-red-300 hover:text-red-200"
              aria-label={`Remove ${item}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Add a new entry…"
          data-testid={`${testIdBase}-input`}
          className="flex-1 rounded-xl border border-gold/30 bg-walnut/40 px-3 py-2 text-[12.5px] text-parchment outline-none focus:border-gold"
        />
        <button
          type="button"
          onClick={add}
          data-testid={`${testIdBase}-add`}
          className="inline-flex items-center gap-1.5 rounded-full border border-gold/40 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-gold hover:bg-gold/10"
        >
          Add
        </button>
      </div>
    </div>
  );
}
