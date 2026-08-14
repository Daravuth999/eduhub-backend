// Maps the original backend categories (story / conversation / exercise)
// to the redesigned shelf metadata (gradient, label, emoji, kind).

export const SECTION_META = {
  story: {
    key: 'story',
    label: 'Stories',
    khmer: 'រឿង',
    emoji: '📖',
    // Reading gradient from spec
    gradient: 'linear-gradient(155deg, #3A1B1B 0%, #6A2D2D 100%)',
    accent: '#E97A7A',
    iconType: 'book',
  },
  conversation: {
    key: 'conversation',
    label: 'Conversations',
    khmer: 'ការសន្ទនា',
    emoji: '🗣️',
    // Speaking gradient from spec
    gradient: 'linear-gradient(155deg, #3A2A1B 0%, #6A4A2D 100%)',
    accent: '#E8B377',
    iconType: 'comments',
  },
  exercise: {
    key: 'exercise',
    label: 'Exercises & Tests',
    khmer: 'លំហាត់ និងតេស្ត',
    emoji: '🧠',
    // Grammar gradient from spec
    gradient: 'linear-gradient(155deg, #1B2A4A 0%, #2E4A7A 100%)',
    accent: '#7DA8E0',
    iconType: 'pencil-alt',
  },
}

export const SECTION_ORDER = ['story', 'conversation', 'exercise']

// Compute live "is new" flag — backend-driven OR client time-window fallback.
//
// Field precedence (returns true on the FIRST match):
//   1. Explicit flags from the sheet / API:
//        item._isNew, item.isNew, item.is_new
//   2. Date-based heuristic (last 14 days) on any of:
//        item.createdAt, item.created_at,
//        item.publishedAt, item.published_at
//
// The 14-day window is the user-approved default for the "New for You"
// rail. Sheet-driven flags still take precedence so an instructor can
// mark a back-catalog book as "new" manually.
const NEW_WINDOW_MS = 14 * 86400000
export function isItemNew(item) {
  if (!item) return false
  if (item._isNew === true) return true
  if (item.isNew === true) return true
  if (item.is_new === true) return true
  const dateCandidates = [
    item.createdAt,
    item.created_at,
    item.publishedAt,
    item.published_at,
  ]
  for (const raw of dateCandidates) {
    if (!raw) continue
    const ts = new Date(raw).getTime()
    if (!Number.isNaN(ts)) {
      if (Date.now() - ts < NEW_WINDOW_MS) return true
    }
  }
  return false
}
