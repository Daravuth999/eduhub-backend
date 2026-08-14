/**
 * topupCopy.js — Khmer copy bank + smart-trigger thresholds
 * =========================================================
 * Single source of truth for every Khmer label and contextual
 * sub-message used by the v1.3 Top-Up flow. Editing one line
 * here changes the wording across the whole modal and the
 * smart trigger.
 *
 * Per spec (verbatim, no auto-translation):
 *   បញ្ចូលពិន្ទុ          (Buy Points / Top Up)
 *   ជ្រើសរើសកញ្ចប់         (Select a package)
 *   ទិញឥឡូវនេះ           (Pay)
 *   បង់ប្រាក់ជាមួយ ABA     (Open ABA app to pay)
 *   ផុតកំណត់ការបង់ប្រាក់ក្នុងរយៈ (Complete payment within)
 *   ខ្ញុំបានបង់ប្រាក់រួចរាល់   (I've paid — check now)
 *   រៀល                  (KHR / ៛)
 */

export const KHMER_FONT_STACK =
  `'Noto Sans Khmer', 'Kantumruy Pro', 'Battambang', 'Khmer OS', ` +
  `'Khmer OS Battambang', 'Hanuman', 'Bayon', system-ui, ` +
  `-apple-system, sans-serif`;

// Per-route low-balance triggers. Tune freely without touching code.
export const TOPUP_THRESHOLDS = {
  "/library":    50,
  "/game":       20,
  "/game/play":  20,
  "/assistant":  15,
  "/portal":     30,
  "/portal/me":  30,
};

// Order matters — first match wins.
export const ROUTE_REASON = [
  { test: (p) => p.startsWith("/library"),   reason: "library"   },
  { test: (p) => p.startsWith("/assistant"), reason: "assistant" },
  { test: (p) => p.startsWith("/game"),      reason: "lucky"     },
  { test: (p) => p.startsWith("/portal"),    reason: "low"       },
];

export function reasonForPath(pathname) {
  for (const r of ROUTE_REASON) if (r.test(pathname || "")) return r.reason;
  return "manual";
}

export function thresholdForPath(pathname) {
  // longest matching prefix wins
  const keys = Object.keys(TOPUP_THRESHOLDS).sort((a, b) => b.length - a.length);
  for (const k of keys) if ((pathname || "").startsWith(k)) return TOPUP_THRESHOLDS[k];
  return 30;
}

// Contextual headlines + bodies — every trigger reason maps to one.
// Khmer first; small English helper below it where helpful.
export const CONTEXT_COPY = {
  library: {
    headline_km: "ដោះសោសៀវភៅ Premium",
    body_km:
      "ពិន្ទុរបស់អ្នកសល់តិច។ បន្ថែមឥឡូវ ដើម្បីបន្តដោះសោសៀវភៅ និងមាតិកាសិក្សា។",
    badge_km: "ល្អបំផុតសម្រាប់ Library",
  },
  lucky: {
    headline_km: "មុនបង្វិល Lucky Spin",
    body_km:
      "បន្ថែមពិន្ទុ ដើម្បីបង្វិលម្ដងទៀត និងឆ្នោតរង្វាន់ធំ។",
    badge_km: "ល្អបំផុតសម្រាប់ Lucky Spin",
  },
  assistant: {
    headline_km: "សន្ទនាជាមួយ AI បន្ថែមទៀត",
    body_km:
      "ពិន្ទុរបស់អ្នកជិតអស់។ បន្ថែមឥឡូវ ដើម្បីបន្តសន្ទនាជាមួយ AI Assistant។",
    badge_km: "ល្អបំផុតសម្រាប់ AI",
  },
  low: {
    headline_km: "ពិន្ទុរបស់អ្នកសល់តិច",
    body_km:
      "បន្ថែមឥឡូវ ដើម្បីបន្តដោះសោមុខងារសំខាន់ៗរបស់ EduHub។",
    badge_km: "តម្លៃល្អបំផុត",
  },
  manual: {
    headline_km: "ជ្រើសរើសកញ្ចប់ដែលសាកសម",
    body_km:
      "បន្ថែមពិន្ទុ ដើម្បីដោះសោរាល់មុខងារ Premium របស់ EduHub។",
    badge_km: "តម្លៃល្អបំផុត",
  },
};

// 8 verbatim labels (used across the modal). Importing from here makes
// future spelling changes a one-line edit.
export const KM_LABELS = {
  buy_points:        "បញ្ចូលពិន្ទុ",
  select_package:    "ជ្រើសរើសកញ្ចប់",
  pay_now:           "ទិញឥឡូវនេះ",
  pay_with_aba:      "បង់ប្រាក់ជាមួយ ABA",
  complete_within:   "ផុតកំណត់ការបង់ប្រាក់ក្នុងរយៈ",
  i_have_paid:       "ខ្ញុំបានបង់ប្រាក់រួចរាល់",
  checking:          "កំពុងពិនិត្យការទូទាត់…",
  riel:              "រៀល",
  // status screens
  success_title:     "ការទូទាត់ជោគជ័យ",
  success_subtitle:  "ពិន្ទុរបស់អ្នកត្រូវបានបញ្ចូលដោយស្វ័យប្រវត្តិ",
  pts_added:         "ពិន្ទុបន្ថែម",
  done:              "រួចរាល់",
  reviewing:         "កំពុងពិនិត្យ",
  review_body:
    "ការទូទាត់របស់អ្នកកំពុងពិនិត្យ។ ប្រសិនបើអ្នកបានបង់ប្រាក់រួចហើយ ពិន្ទុនឹងបញ្ចូលក្នុងពេលឆាប់ៗ។",
  expired_title:     "ផុតកំណត់ការបង់ប្រាក់",
  expired_body:      "ប្រសិនបើអ្នកបានបង់ប្រាក់រួចហើយ ប្រព័ន្ធនឹងពិនិត្យក្នុងពេលឆាប់ៗ។",
  close:             "បិទ",
  error_title:       "មានបញ្ហាបណ្តោះអាសន្ន",
  try_again:         "ព្យាយាមម្ដងទៀត",
  current_balance:   "ពិន្ទុបច្ចុប្បន្ន",
  recommended:       "ណែនាំ",
};
