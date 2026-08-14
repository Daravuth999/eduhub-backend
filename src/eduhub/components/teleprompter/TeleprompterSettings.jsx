/**
 * TeleprompterSettings.jsx — the shared teleprompter configuration surface.
 * Author Studio saves these settings onto the lesson (teleprompterConfig);
 * the student player layers local reading-preference overrides on top.
 * One component, two hosts — so the author always configures exactly what
 * students experience.
 */
import { DEFAULT_TELEPROMPTER_CONFIG } from "./teleprompterConfig";

const GOLD = "#D4A843";

function Toggle({ label, value, onChange, testId }) {
  return (
    <button onClick={() => onChange(!value)} data-testid={testId}
            className="flex items-center justify-between w-full py-1.5 group">
      <span className="text-[12px] text-white/70 group-hover:text-white/90">{label}</span>
      <span className="relative w-8 h-[18px] rounded-full transition-colors"
            style={{ background: value ? GOLD : "rgba(255,255,255,0.15)" }}>
        <span className="absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-[left]"
              style={{ left: value ? 16 : 2 }} />
      </span>
    </button>
  );
}

function Slider({ label, value, min, max, step, onChange, format, testId }) {
  return (
    <label className="block py-1.5">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[12px] text-white/70">{label}</span>
        <span className="text-[11px] tabular-nums" style={{ color: GOLD }}>{format ? format(value) : value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
             data-testid={testId}
             onChange={(e) => onChange(Number(e.target.value))}
             className="w-full accent-[#D4A843] h-1" />
    </label>
  );
}

function Segmented({ label, value, options, onChange, testId }) {
  return (
    <div className="py-1.5">
      <div className="text-[12px] text-white/70 mb-1.5">{label}</div>
      <div className="flex gap-1 rounded-lg bg-white/5 p-0.5" data-testid={testId}>
        {options.map((o) => (
          <button key={o.value} onClick={() => onChange(o.value)}
                  className="flex-1 text-[11px] font-semibold px-2 py-1 rounded-md transition-colors"
                  style={value === o.value
                    ? { background: "rgba(212,168,67,0.18)", color: GOLD }
                    : { color: "rgba(255,255,255,0.5)" }}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function TeleprompterSettings({ config, onChange, showModeControls = true, onReset }) {
  const set = (key) => (val) => onChange({ ...config, [key]: val });
  return (
    <div className="space-y-1" data-testid="teleprompter-settings">
      {showModeControls && (
        <Segmented label="Display mode" value={config.mode} onChange={set("mode")}
                   testId="tp-setting-mode"
                   options={[
                     { value: "auto", label: "Auto" },
                     { value: "conversation", label: "Conversation" },
                     { value: "storytelling", label: "Storytelling" },
                   ]} />
      )}
      <Toggle label="Word highlight" value={config.wordHighlight} onChange={set("wordHighlight")} testId="tp-setting-word" />
      <Toggle label="Sentence highlight" value={config.sentenceHighlight} onChange={set("sentenceHighlight")} testId="tp-setting-sentence" />
      <Toggle label="Paragraph highlight" value={config.paragraphHighlight} onChange={set("paragraphHighlight")} testId="tp-setting-paragraph" />
      <Toggle label="Karaoke mode" value={config.karaoke} onChange={set("karaoke")} testId="tp-setting-karaoke" />
      <Toggle label="Centered reading" value={config.centered} onChange={set("centered")} testId="tp-setting-centered" />
      <Toggle label="Confidence visualization" value={config.showConfidence} onChange={set("showConfidence")} testId="tp-setting-confidence" />
      <Slider label="Font size" value={config.fontScale} min={0.8} max={1.6} step={0.05}
              format={(v) => `${Math.round(v * 100)}%`} onChange={set("fontScale")} testId="tp-setting-fontscale" />
      <Segmented label="Font family" value={config.fontFamily} onChange={set("fontFamily")}
                 testId="tp-setting-fontfamily"
                 options={[
                   { value: "default", label: "Sans" },
                   { value: "serif", label: "Serif" },
                   { value: "mono", label: "Mono" },
                 ]} />
      <Slider label="Line spacing" value={config.lineSpacing} min={1.4} max={2.6} step={0.1}
              format={(v) => v.toFixed(1)} onChange={set("lineSpacing")} testId="tp-setting-linespacing" />
      <Toggle label="Follow playback (auto-scroll)" value={config.autoScroll} onChange={set("autoScroll")} testId="tp-setting-autoscroll" />
      {config.autoScroll && (
        <Slider label="Scroll anchor" value={config.scrollSpeed} min={0.5} max={2} step={0.1}
                format={(v) => (v < 0.9 ? "Low" : v > 1.2 ? "Leading" : "Center")}
                onChange={set("scrollSpeed")} testId="tp-setting-scrollspeed" />
      )}
      {onReset && (
        <button onClick={() => onReset({ ...DEFAULT_TELEPROMPTER_CONFIG })}
                data-testid="tp-setting-reset"
                className="text-[11px] mt-1 text-white/45 hover:text-white/70 underline underline-offset-2">
          Reset to defaults
        </button>
      )}
    </div>
  );
}
