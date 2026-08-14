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
export function isItemNew(item) {
  if (item?._isNew === true) return true
  if (item?.isNew === true) return true
  if (item?.createdAt) {
    const ts = new Date(item.createdAt).getTime()
    if (!Number.isNaN(ts)) {
      return Date.now() - ts < 7 * 86400000
    }
  }
  return false
}
