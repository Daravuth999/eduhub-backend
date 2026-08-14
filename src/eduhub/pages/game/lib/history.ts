export interface HistoryEntry {
  id: string;
  emoji: string;
  prize: string;
  change: number;
  timestamp: number;
  isJackpot: boolean;
}

const KEY_PREFIX = "lucky-spin:history:";
const MAX = 20;

export function loadHistory(studentId: string): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + studentId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryEntry[];
    return Array.isArray(parsed) ? parsed.slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function saveHistory(studentId: string, list: HistoryEntry[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      KEY_PREFIX + studentId,
      JSON.stringify(list.slice(0, MAX)),
    );
  } catch {
    // ignore
  }
}

export function pushHistory(
  studentId: string,
  entry: Omit<HistoryEntry, "id" | "timestamp">,
): HistoryEntry[] {
  const list = loadHistory(studentId);
  const newEntry: HistoryEntry = {
    ...entry,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
  };
  const next = [newEntry, ...list].slice(0, MAX);
  saveHistory(studentId, next);
  return next;
}

export function clearHistory(studentId: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY_PREFIX + studentId);
  } catch {
    // ignore
  }
}
