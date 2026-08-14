/**
 * RxpDemoPage.jsx — hidden debug/verification harness for the Reward
 * Experience Engine (same pattern as /__pwa-debug). Lets the owner verify
 * every environment / glass / reveal combination WITHOUT needing a student
 * session or a live campaign. Pure presentation — no reward API calls.
 */
import { useState } from "react";
import RewardExperiencePreview from "../../studio/rewardExperience/RewardExperiencePreview";
import {
  ENVIRONMENTS, ENVIRONMENT_IDS, GLASS_STYLES, REVEAL_STYLES,
  normalizeExperience,
} from "../components/rewardExperience/experienceThemes";

const DEMO_FORM = {
  title: "Welcome back!",
  subtitle: "Claim your surprise learning points today.",
  cta_text: "Claim Reward",
  success_message: "Your reward has been credited!",
  accent_color: "#D4A843",
  reward_kind: "points_voucher",
  reward_points: 50,
  voucher_discount_type: "percent",
  voucher_discount_value: 100,
  countdown_enabled: true,
  countdown_mode: "expires_after_open",
  countdown_label: "Claim before it expires",
};

export default function RxpDemoPage() {
  const [env, setEnv] = useState("morning_angkor");
  const [glass, setGlass] = useState("auto");
  const [reveal, setReveal] = useState("cinematic");
  const [device, setDevice] = useState("iphone");
  const [phase, setPhase] = useState("idle");
  const [replayKey, setReplayKey] = useState(0);

  const experience = normalizeExperience({
    environment: env, glass, reveal,
    decorations: [
      { id: "demo1", kind: "builtin", asset: "lotus", x: 12, y: 14, size: 56, glow: 0.5, layer: "front" },
      { id: "demo2", kind: "builtin", asset: "star", x: 88, y: 18, size: 40, glow: 0.7, layer: "front", rotation: 18 },
      { id: "demo3", kind: "builtin", asset: "gold_corner", x: 8, y: 90, size: 72, layer: "back", opacity: 0.8 },
    ],
  });

  const btn = (active) =>
    `rounded-full px-3 py-1 text-[11px] font-bold border ${active ? "border-amber-400 text-amber-300" : "border-white/20 text-white/60"}`;

  return (
    <div className="min-h-screen p-6 text-white" style={{ background: "#0d0a16" }} data-testid="rxp-demo-page">
      <h1 className="text-lg font-black mb-1">Reward Experience — verification harness</h1>
      <p className="text-[12px] text-white/50 mb-4">Presentation-only. No reward APIs are called from this page.</p>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {ENVIRONMENT_IDS.map((id) => (
          <button key={id} className={btn(env === id)} data-testid={`demo-env-${id}`}
                  onClick={() => { setEnv(id); setReplayKey((k) => k + 1); }}>
            {ENVIRONMENTS[id].label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {GLASS_STYLES.map((g) => (
          <button key={g} className={btn(glass === g)} data-testid={`demo-glass-${g}`} onClick={() => setGlass(g)}>glass: {g}</button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5 mb-4">
        {REVEAL_STYLES.map((r) => (
          <button key={r} className={btn(reveal === r)} data-testid={`demo-reveal-${r}`} onClick={() => { setReveal(r); setReplayKey((k) => k + 1); }}>
            reveal: {r}
          </button>
        ))}
        {["iphone", "android", "tablet", "desktop"].map((d) => (
          <button key={d} className={btn(device === d)} data-testid={`demo-device-${d}`} onClick={() => setDevice(d)}>{d}</button>
        ))}
        <button className={btn(phase === "success")} data-testid="demo-phase-toggle"
                onClick={() => { setPhase((p) => (p === "success" ? "idle" : "success")); setReplayKey((k) => k + 1); }}>
          {phase === "success" ? "success ✓" : "show success"}
        </button>
        <button className={btn(false)} data-testid="demo-replay" onClick={() => setReplayKey((k) => k + 1)}>replay</button>
      </div>
      <RewardExperiencePreview
        form={{ ...DEMO_FORM, experience }}
        device={device}
        phase={phase}
        replayKey={replayKey}
      />
    </div>
  );
}
