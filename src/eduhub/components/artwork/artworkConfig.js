/**
 * artworkConfig.js — shared constants for the Artwork Campaign System v1.0.
 * Pure data; imported by both the student-facing renderers and the
 * Author Studio manager so placement/animation/action keys never drift.
 */

export const PLACEMENTS = [
  { key: "dashboard_hero",   label: "Dashboard Hero",            ratio: "21/9" },
  { key: "library_hero",     label: "Library Hero",              ratio: "16/9" },
  { key: "library_featured", label: "Library Featured Collection", ratio: "21/9" },
  { key: "library_shelf",    label: "Library Shelf Card",        ratio: "2/3"  },
];

// Per-placement render aspect ratios (CSS aspect-ratio values).
export const PLACEMENT_RATIO = {
  dashboard_hero: "21 / 9",
  library_hero: "16 / 9",
  library_featured: "21 / 9",
  library_shelf: "2 / 3",
};

export const CLICK_ACTIONS = [
  { key: "topup",          label: "Open Top Up Modal",  needsValue: false },
  { key: "book",           label: "Open Specific Book", needsValue: true,  hint: "Book slug" },
  { key: "collection",     label: "Open Collection",    needsValue: false, hint: "Collection key (optional)" },
  { key: "speaking_lab",   label: "Open Speaking Lab",  needsValue: false },
  { key: "edutalk",        label: "Open EduTalk",       needsValue: false },
  { key: "reward",         label: "Open Reward Page",   needsValue: false },
  { key: "internal_route", label: "Open Internal Route",needsValue: true,  hint: "/path" },
  { key: "external_url",   label: "Open External URL",  needsValue: true,  hint: "https://…" },
];

export const ANIMATIONS = [
  { key: "none",     label: "None" },
  { key: "fade",     label: "Fade" },
  { key: "slide",    label: "Slide" },
  { key: "float",    label: "Float" },
  { key: "zoom",     label: "Zoom" },
  { key: "parallax", label: "Parallax" },
];

export const PLACEMENT_KEYS = PLACEMENTS.map((p) => p.key);
