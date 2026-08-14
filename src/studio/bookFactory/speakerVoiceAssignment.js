/**
 * speakerVoiceAssignment.js — deterministic speaker→voice round-robin.
 *
 * Used to pre-fill CVS's per-speaker voice selector via
 * ConversationVoiceStudio's `initialVoiceAssignments` prop (never assigns
 * automatically inside CVS itself — the teacher always sees and can change
 * the assignment before generating). Deterministic: the same speaker list +
 * voice list always produces the same assignment, and never assigns the
 * same voice to every speaker unless only one voice exists.
 */
export function assignVoicesRoundRobin(speakers, voices) {
  const list = Array.isArray(voices) ? voices.filter((v) => v && v.voice_id) : [];
  const names = Array.isArray(speakers) ? speakers.filter(Boolean) : [];
  const out = {};
  if (!names.length || !list.length) return out;
  names.forEach((name, i) => {
    out[name] = list[i % list.length].voice_id;
  });
  return out;
}
