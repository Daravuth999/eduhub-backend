/**
 * conversationPresets.js — localStorage-backed speaker preset manager
 * for Conversation Voice Studio.
 *
 * Presets remember voice + emotion + color + avatar per speaker name across
 * sessions. When the teacher opens CVS and types a speaker name that matches
 * a saved preset, the preset is applied automatically on parse.
 *
 * Storage key: "cvs_speaker_presets_v1"
 * Shape: { [speakerName]: SpeakerPreset }
 *
 * SpeakerPreset: {
 *   voiceId: string,
 *   emotion: string,
 *   color: string,        // hex
 *   avatar: string,       // emoji or ""
 *   voiceSettings: { stability, similarity_boost, style },
 *   updatedAt: number,    // epoch ms
 * }
 */

const PRESET_KEY = "cvs_speaker_presets_v1";

export function loadPresets() {
  try {
    const raw = localStorage.getItem(PRESET_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function savePreset(speakerName, config) {
  const name = String(speakerName || "").trim();
  if (!name) return;
  try {
    const presets = loadPresets();
    presets[name] = {
      voiceId: config.voiceId || "",
      emotion: config.emotion || "neutral",
      color: config.color || "",
      avatar: config.avatar || "",
      voiceSettings: config.voiceSettings || {},
      updatedAt: Date.now(),
    };
    localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
  } catch {
    /* ignore storage quota errors */
  }
}

export function deletePreset(speakerName) {
  const name = String(speakerName || "").trim();
  if (!name) return;
  try {
    const presets = loadPresets();
    delete presets[name];
    localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
  } catch { /* ignore */ }
}

export function getPreset(speakerName) {
  const name = String(speakerName || "").trim();
  if (!name) return null;
  const presets = loadPresets();
  return presets[name] || null;
}

export function clearAllPresets() {
  try {
    localStorage.removeItem(PRESET_KEY);
  } catch { /* ignore */ }
}

/* ─── Speaker bubble colors ─── */
export const SPEAKER_COLORS = [
  "#4F8EF7",  // blue
  "#E97B7B",  // rose
  "#52C97F",  // green
  "#F5C842",  // amber
  "#B57BF5",  // violet
  "#F5A342",  // orange
  "#42D4F5",  // cyan
  "#F57BC2",  // pink
  "#7BF5B5",  // mint
  "#F5F542",  // yellow
];

export function getDefaultColor(index) {
  return SPEAKER_COLORS[index % SPEAKER_COLORS.length];
}

/* ─── Emotion options ─── */
export const EMOTION_OPTIONS = [
  { value: "neutral",   label: "Neutral",   emoji: "😐" },
  { value: "happy",     label: "Happy",     emoji: "😊" },
  { value: "excited",   label: "Excited",   emoji: "🤩" },
  { value: "sad",       label: "Sad",       emoji: "😢" },
  { value: "scared",    label: "Scared",    emoji: "😨" },
  { value: "angry",     label: "Angry",     emoji: "😠" },
  { value: "curious",   label: "Curious",   emoji: "🤔" },
  { value: "surprised", label: "Surprised", emoji: "😲" },
  { value: "calm",      label: "Calm",      emoji: "😌" },
  { value: "dramatic",  label: "Dramatic",  emoji: "🎭" },
  { value: "whisper",   label: "Whisper",   emoji: "🤫" },
];

/* ─── Voice settings presets ─── */
export const VOICE_SETTING_PRESETS = {
  default:    { stability: 0.50, similarity_boost: 0.75, style: 0.00 },
  expressive: { stability: 0.30, similarity_boost: 0.70, style: 0.35 },
  stable:     { stability: 0.80, similarity_boost: 0.85, style: 0.00 },
  classroom:  { stability: 0.60, similarity_boost: 0.75, style: 0.10 },
  dramatic:   { stability: 0.25, similarity_boost: 0.65, style: 0.50 },
  whisper:    { stability: 0.90, similarity_boost: 0.80, style: 0.05 },
};

export const PAUSE_OPTIONS = [0, 0.2, 0.35, 0.5, 0.75, 1.0, 1.5, 2.0];
