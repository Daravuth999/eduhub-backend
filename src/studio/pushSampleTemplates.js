/**
 * pushSampleTemplates.js — local, template-based smart push message generator.
 *
 * v11.0 (2026-02) — Author Studio Push UI reconstruction.
 *
 * Strict design contract:
 *   - LOCAL ONLY. No external API, no network call, no AI provider.
 *   - Pure function `generateSamples(typeKey, opts?)` returns an array of
 *     { title, body, lang, tags } objects ready to fill the Push compose
 *     form (existing { title, body } fields, plus optional `url`).
 *   - Teacher must still manually click "Use this sample" and then
 *     "Send Now". Nothing here calls the backend.
 *   - Bilingual support: each preset returns English, Khmer, and a
 *     bilingual EN+KH combo sample. The Push UI decides whether to
 *     show all three or just one based on context.
 *
 * To extend: add a new entry to PUSH_PRESETS and (optionally) an extra
 * sample inside its `samples` array. No other file needs touching.
 */

/* ──────────────────────────────────────────────────────────────────────
   Presets
   ──────────────────────────────────────────────────────────────────── */
export const PUSH_PRESETS = [
  {
    key: "new-book",
    label: "New Book Launch",
    emoji: "📚",
    suggestedUrl: "/library",
    samples: [
      {
        lang: "en",
        title: "New book just dropped! 📚",
        body: "A fresh story is waiting in your Library. Tap to start reading tonight.",
      },
      {
        lang: "en",
        title: "Fresh chapter unlocked",
        body: "Your next adventure is live. Open the Library and dive in!",
      },
      {
        lang: "kh",
        title: "សៀវភៅថ្មីបានចេញហើយ! 📚",
        body: "សាច់រឿងថ្មីកំពុងរង់ចាំអ្នកនៅក្នុងបណ្ណាល័យ។ ប៉ះដើម្បីចាប់ផ្ដើមអាន។",
      },
      {
        lang: "bi",
        title: "📚 New book / សៀវភៅថ្មី",
        body: "Open Library to read tonight's new story · បើកបណ្ណាល័យដើម្បីអានរឿងថ្មី",
      },
    ],
  },
  {
    key: "login-reward",
    label: "Login Reward",
    emoji: "🎁",
    suggestedUrl: "/portal",
    samples: [
      {
        lang: "en",
        title: "Daily reward ready 🎁",
        body: "Log in today and claim your bonus points. Don't break your streak!",
      },
      {
        lang: "en",
        title: "Streak bonus inside",
        body: "Sign in now to keep your streak alive and grab today's reward.",
      },
      {
        lang: "kh",
        title: "រង្វាន់ប្រចាំថ្ងៃរួចរាល់ 🎁",
        body: "ចូលគណនីថ្ងៃនេះដើម្បីទទួលពិន្ទុបន្ថែម។ កុំបង្អង់ឱ្យបាត់រង្វាន់!",
      },
      {
        lang: "bi",
        title: "🎁 Daily reward / រង្វាន់ប្រចាំថ្ងៃ",
        body: "Sign in to claim your bonus · ចូលគណនីដើម្បីទទួលរង្វាន់ថ្ងៃនេះ",
      },
    ],
  },
  {
    key: "voucher",
    label: "Voucher / Discount",
    emoji: "🎟️",
    suggestedUrl: "/portal",
    samples: [
      {
        lang: "en",
        title: "Special voucher unlocked 🎟️",
        body: "A new discount is waiting in your wallet. Tap to use it before it expires.",
      },
      {
        lang: "en",
        title: "Limited-time book voucher",
        body: "Save on your next book unlock — open your wallet now to apply.",
      },
      {
        lang: "kh",
        title: "ប័ណ្ណបញ្ចុះតម្លៃថ្មី 🎟️",
        body: "ប័ណ្ណបញ្ចុះតម្លៃថ្មីកំពុងរង់ចាំក្នុងកាបូបអ្នក។ ប៉ះប្រើមុនពេលផុតកំណត់។",
      },
      {
        lang: "bi",
        title: "🎟️ Voucher ready / ប័ណ្ណបញ្ចុះតម្លៃ",
        body: "Open wallet to redeem · បើកកាបូបដើម្បីប្រើប័ណ្ណ",
      },
    ],
  },
  {
    key: "class-reminder",
    label: "Class Reminder",
    emoji: "⏰",
    suggestedUrl: "/",
    samples: [
      {
        lang: "en",
        title: "Class starts soon ⏰",
        body: "Don't forget — your next class begins shortly. See you there!",
      },
      {
        lang: "en",
        title: "Gentle reminder",
        body: "Your lesson is coming up. Take a deep breath and let's learn together.",
      },
      {
        lang: "kh",
        title: "ថ្នាក់រៀននឹងចាប់ផ្ដើមឆាប់ៗ ⏰",
        body: "កុំភ្លេចថ្នាក់រៀនរបស់អ្នកនឹងចាប់ផ្ដើមក្នុងពេលឆាប់ៗនេះ។ ជួបគ្នានៅទីនោះ!",
      },
      {
        lang: "bi",
        title: "⏰ Class soon / ថ្នាក់រៀនឆាប់ៗ",
        body: "See you in class! · ជួបគ្នានៅថ្នាក់!",
      },
    ],
  },
  {
    key: "edutalk",
    label: "EduTalk / AI Tutor",
    emoji: "🤖",
    suggestedUrl: "/portal?tab=edutalk",
    samples: [
      {
        lang: "en",
        title: "Your AI tutor is ready 🤖",
        body: "Practice speaking with EduTalk anytime. Try a quick 2-minute session now!",
      },
      {
        lang: "en",
        title: "New AI mission unlocked",
        body: "Sharpen your English with a fresh EduTalk challenge. Tap to begin.",
      },
      {
        lang: "kh",
        title: "គ្រូ AI របស់អ្នករួចរាល់ហើយ 🤖",
        body: "អនុវត្តការនិយាយជាមួយ EduTalk។ សាកល្បងពេលនេះ ២ នាទីមើល!",
      },
      {
        lang: "bi",
        title: "🤖 EduTalk ready / គ្រូ AI",
        body: "Practice speaking now · អនុវត្តការនិយាយឥឡូវនេះ",
      },
    ],
  },
  {
    key: "payment",
    label: "Payment / Top-up",
    emoji: "💳",
    suggestedUrl: "/portal?tab=topup",
    samples: [
      {
        lang: "en",
        title: "Top-up your account 💳",
        body: "Keep your learning going — add points anytime with ABA, KHQR or CamRapidPay.",
      },
      {
        lang: "en",
        title: "Easy payment options",
        body: "Top up in seconds and unlock more lessons. Tap to open the wallet.",
      },
      {
        lang: "kh",
        title: "បញ្ចូលទឹកប្រាក់ក្នុងគណនី 💳",
        body: "បន្តការរៀនសូត្ររបស់អ្នក — បន្ថែមពិន្ទុជាមួយ ABA, KHQR ឬ CamRapidPay។",
      },
      {
        lang: "bi",
        title: "💳 Top-up / បញ្ចូលទឹកប្រាក់",
        body: "Open wallet to top up · បើកកាបូបដើម្បីបញ្ចូលទឹកប្រាក់",
      },
    ],
  },
  {
    key: "referral",
    label: "Referral / Invite",
    emoji: "🤝",
    suggestedUrl: "/portal?tab=referral",
    samples: [
      {
        lang: "en",
        title: "Invite a friend, earn rewards 🤝",
        body: "Share EduHub with a friend. Both of you get bonus points when they join!",
      },
      {
        lang: "en",
        title: "Your invite link is ready",
        body: "Tap to copy your referral link and share it with a classmate today.",
      },
      {
        lang: "kh",
        title: "អញ្ជើញមិត្ត ទទួលរង្វាន់ 🤝",
        body: "ចែករំលែក EduHub ជាមួយមិត្ត។ ទាំងពីរនាក់នឹងទទួលពិន្ទុបន្ថែម!",
      },
      {
        lang: "bi",
        title: "🤝 Invite & earn / អញ្ជើញ និង ទទួលរង្វាន់",
        body: "Share your link, earn points · ចែករំលែកតំណ ទទួលពិន្ទុ",
      },
    ],
  },
  {
    key: "general",
    label: "General Announcement",
    emoji: "📣",
    suggestedUrl: "/",
    samples: [
      {
        lang: "en",
        title: "A quick update for you 📣",
        body: "We've got news! Tap to see what's new at EduHub today.",
      },
      {
        lang: "en",
        title: "Something new at EduHub",
        body: "Check out the latest update. We made the app even better for you.",
      },
      {
        lang: "kh",
        title: "ព័ត៌មានថ្មីសម្រាប់អ្នក 📣",
        body: "យើងមានព័ត៌មានថ្មី! ប៉ះដើម្បីមើលអ្វីដែលថ្មីនៅ EduHub ថ្ងៃនេះ។",
      },
      {
        lang: "bi",
        title: "📣 News update / ព័ត៌មានថ្មី",
        body: "Tap to see what's new · ប៉ះដើម្បីមើលអ្វីដែលថ្មី",
      },
    ],
  },
];

/* ──────────────────────────────────────────────────────────────────────
   Public helper used by the Push compose UI.
   ──────────────────────────────────────────────────────────────────── */
export function getPreset(key) {
  return PUSH_PRESETS.find((p) => p.key === key) || null;
}

export function generateSamples(typeKey) {
  const preset = getPreset(typeKey);
  if (!preset) return [];
  return preset.samples.map((s, i) => ({
    ...s,
    id: `${typeKey}-${i}`,
    presetKey: typeKey,
    presetLabel: preset.label,
    presetEmoji: preset.emoji,
    suggestedUrl: preset.suggestedUrl,
  }));
}

export const LANG_LABELS = {
  en: "English",
  kh: "ខ្មែរ Khmer",
  bi: "EN + KH",
};
