/**
 * BookFactoryVoicePicker.jsx — additive, Book-Factory-only voice selector.
 *
 * §AMENDMENT 9: the existing StudioEditor ElevenLabs voice picker is NOT
 * touched or refactored — this is a separate, standalone component that
 * fetches the same /api/studio/voices data independently. Zero risk to the
 * manual Editor's existing markup, tests, or behavior.
 */
import { useEffect, useState } from "react";
import { listVoices } from "../api";

export default function BookFactoryVoicePicker({ value, onChange, disabled, testid }) {
  const [voices, setVoices] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await listVoices();
        if (cancelled) return;
        const list = Array.isArray(res?.voices) ? res.voices : [];
        setVoices(list);
        if (!value && list.length) {
          onChange?.(res?.default_voice_id && list.some((v) => v.voice_id === res.default_voice_id)
            ? res.default_voice_id
            : list[0].voice_id);
        }
      } catch {
        // Non-fatal — narration buttons simply stay disabled until a voice loads.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <select
      data-testid={testid || "bf-voice-picker"}
      value={value || ""}
      onChange={(e) => onChange?.(e.target.value)}
      disabled={disabled || loading || voices.length === 0}
      className="rounded-full border border-gold/30 bg-walnut/60 px-3 py-1.5 text-[12px] text-parchment outline-none focus:border-gold disabled:opacity-50"
    >
      {voices.length === 0 && <option value="">{loading ? "Loading voices…" : "No voices available"}</option>}
      {voices.map((v) => {
        const tag = [v.gender, v.accent].filter(Boolean).join(" · ");
        return (
          <option key={v.voice_id} value={v.voice_id}>
            {v.name}{tag ? ` (${tag})` : ""}
          </option>
        );
      })}
    </select>
  );
}
