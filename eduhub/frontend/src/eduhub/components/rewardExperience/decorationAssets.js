/**
 * decorationAssets.js — built-in premium decoration library.
 * Every asset is a compact inline SVG served as a data URI, so the
 * decoration engine treats built-ins and custom uploads identically
 * (both are just <img src>). Adding a category = adding data here;
 * no architectural change required.
 */

const G = "#D4A843";   // gold
const I = "#F4ECDD";   // ivory
const D = "#1a1420";   // ink

const S = {
  angkor_tower: `<path d="M32 4l4 10 3 8 2 8 2 12v18H21V42l2-12 2-8 3-8z" fill="${G}"/><path d="M14 32l3 8 2 8v12H8V48l2-8zM50 32l-3 8-2 8v12h11V48l-2-8z" fill="${G}" opacity=".8"/><rect x="4" y="58" width="56" height="4" rx="1" fill="${G}"/>`,
  khmer_kbach: `<path d="M32 6c14 4 20 14 16 24-3 8-12 10-16 6 6 0 10-5 8-11-2-7-10-9-16-4-8 6-8 18 0 26 6 6 16 8 24 4-6 8-20 9-28 2C10 44 10 26 22 14c3-3 6-6 10-8z" fill="${G}"/><circle cx="45" cy="18" r="3" fill="${G}"/>`,
  golden_stupa: `<path d="M32 2l3 12h-6zM26 16h12l3 10H23zM20 28h24l3 12H17z" fill="${G}"/><path d="M14 42h36v6a10 10 0 01-10 10H24a10 10 0 01-10-10z" fill="${G}" opacity=".85"/>`,
  open_book: `<path d="M32 14c-6-5-16-6-24-3v36c8-3 18-2 24 3 6-5 16-6 24-3V11c-8-3-18-2-24 3z" fill="${I}" stroke="${G}" stroke-width="3"/><path d="M32 14v36" stroke="${G}" stroke-width="3"/>`,
  grad_cap: `<path d="M32 10L2 24l30 14 30-14z" fill="${D}" stroke="${G}" stroke-width="2"/><path d="M14 32v12c0 4 8 8 18 8s18-4 18-8V32l-18 8z" fill="${D}" stroke="${G}" stroke-width="2"/><path d="M56 26v14" stroke="${G}" stroke-width="3"/><circle cx="56" cy="43" r="3" fill="${G}"/>`,
  pencil: `<path d="M14 50L44 20l8 8-30 30-11 3z" fill="${G}"/><path d="M46 18l4-4a5.7 5.7 0 018 8l-4 4z" fill="${D}"/><path d="M14 50l8 8-11 3z" fill="${I}"/>`,
  balloon: `<ellipse cx="32" cy="24" rx="16" ry="20" fill="${G}"/><path d="M32 44l-3 5h6zM32 49c0 6-6 6-4 13" stroke="${G}" stroke-width="2" fill="none"/><ellipse cx="26" cy="17" rx="4" ry="7" fill="${I}" opacity=".5"/>`,
  party_flag: `<path d="M4 8h56" stroke="${G}" stroke-width="3"/><path d="M8 10l6 14 6-14zM26 10l6 14 6-14zM44 10l6 14 6-14z" fill="${G}" opacity=".9"/>`,
  confetti_pop: `<path d="M10 54L26 22l16 16z" fill="${G}"/><circle cx="40" cy="12" r="3" fill="${I}"/><circle cx="52" cy="24" r="3" fill="${G}"/><rect x="46" y="38" width="6" height="6" rx="1" fill="${I}" transform="rotate(20 49 41)"/><path d="M34 8l2 6M54 10l-4 5" stroke="${G}" stroke-width="2.5" stroke-linecap="round"/>`,
  crown: `<path d="M8 46l-4-26 16 10 12-18 12 18 16-10-4 26z" fill="${G}"/><rect x="6" y="48" width="52" height="8" rx="2" fill="${G}"/><circle cx="32" cy="38" r="4" fill="${I}"/>`,
  diamond: `<path d="M18 8h28l12 14-26 34L6 22z" fill="${I}" stroke="${G}" stroke-width="3"/><path d="M6 22h52M18 8l14 14L46 8M32 22v34" stroke="${G}" stroke-width="2"/>`,
  gold_corner: `<path d="M6 58V18C6 11 11 6 18 6h40" fill="none" stroke="${G}" stroke-width="4" stroke-linecap="round"/><path d="M14 58V22c0-4 4-8 8-8h36" fill="none" stroke="${G}" stroke-width="2" opacity=".6"/><circle cx="58" cy="6" r="4" fill="${G}"/><circle cx="6" cy="58" r="4" fill="${G}"/>`,
  lotus: `<path d="M32 12c4 8 4 16 0 22-4-6-4-14 0-22z" fill="#E8A0BF"/><path d="M16 20c8 2 14 8 16 14-8 0-14-6-16-14zM48 20c-8 2-14 8-16 14 8 0 14-6 16-14z" fill="#E8A0BF" opacity=".85"/><path d="M8 34c8-2 18 0 24 6-10 4-20 0-24-6zM56 34c-8-2-18 0-24 6 10 4 20 0 24-6z" fill="#D77FA1"/><path d="M20 46c8-4 16-4 24 0-8 6-16 6-24 0z" fill="#2F7D5B"/>`,
  palm_tree: `<path d="M30 26c-2 12-2 24 2 34h6c-4-10-4-22-2-34z" fill="${G}"/><path d="M32 26C22 14 10 12 4 18c10 0 20 4 28 8zM32 26c10-12 22-14 28-8-10 0-20 4-28 8zM32 26C28 12 18 4 10 6c8 4 16 12 22 20zM32 26c4-14 14-22 22-20-8 4-16 12-22 20z" fill="#3E8E5F"/>`,
  leaf: `<path d="M52 10C30 12 12 26 12 48c0 2 0 4 1 6C36 52 54 34 52 10z" fill="#3E8E5F"/><path d="M14 52C24 38 38 24 50 14" stroke="#245C3A" stroke-width="2.5" fill="none"/>`,
  snowflake: `<g stroke="${I}" stroke-width="3.5" stroke-linecap="round"><path d="M32 6v52M9 19l46 26M9 45l46-26"/><path d="M32 6l-6 8M32 6l6 8M32 58l-6-8M32 58l6-8M9 19l10 1M9 45l10-1M55 19l-10 1M55 45l-10-1"/></g>`,
  sun: `<circle cx="32" cy="32" r="13" fill="${G}"/><g stroke="${G}" stroke-width="4" stroke-linecap="round"><path d="M32 4v8M32 52v8M4 32h8M52 32h8M12 12l6 6M46 46l6 6M52 12l-6 6M18 46l-6 6"/></g>`,
  crescent_moon: `<path d="M44 6a26 26 0 100 52 22 22 0 01-2-52c1 0 1 0 2 0z" fill="${I}"/><circle cx="46" cy="18" r="3" fill="${G}"/><circle cx="54" cy="34" r="2" fill="${G}"/>`,
  ai_spark: `<rect x="10" y="14" width="44" height="36" rx="8" fill="${D}" stroke="${G}" stroke-width="3"/><circle cx="24" cy="30" r="4" fill="${G}"/><circle cx="40" cy="30" r="4" fill="${G}"/><path d="M24 41c5 4 11 4 16 0" stroke="${G}" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M32 6v8M22 8l3 6M42 8l-3 6" stroke="${G}" stroke-width="2.5" stroke-linecap="round"/>`,
  chat_bot: `<path d="M8 14h48v30H26L12 56V44H8z" fill="${I}" stroke="${G}" stroke-width="3"/><circle cx="22" cy="29" r="3.5" fill="${D}"/><circle cx="32" cy="29" r="3.5" fill="${D}"/><circle cx="42" cy="29" r="3.5" fill="${D}"/>`,
  microphone: `<rect x="24" y="6" width="16" height="30" rx="8" fill="${G}"/><path d="M14 28c0 12 8 18 18 18s18-6 18-18" stroke="${G}" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M32 46v10M22 58h20" stroke="${G}" stroke-width="4" stroke-linecap="round"/>`,
  speech_bubble: `<path d="M32 6C17 6 6 15 6 27c0 7 4 13 10 17l-2 12 12-7c2 0 4 1 6 1 15 0 26-9 26-21S47 6 32 6z" fill="${I}" stroke="${G}" stroke-width="3"/><path d="M18 27h28M22 35h20" stroke="${G}" stroke-width="3" stroke-linecap="round"/>`,
  gift_box: `<rect x="10" y="26" width="44" height="32" rx="3" fill="${I}" stroke="${D}" stroke-width="3"/><rect x="6" y="16" width="52" height="12" rx="2" fill="${G}" stroke="${D}" stroke-width="3"/><path d="M32 16v42" stroke="${D}" stroke-width="3"/><path d="M20 16c-8-12 8-18 12-4 4-14 20-8 12 4" fill="none" stroke="${D}" stroke-width="3"/>`,
  medal: `<circle cx="32" cy="40" r="16" fill="${G}"/><circle cx="32" cy="40" r="10" fill="${I}"/><path d="M32 34l2 4 5 1-4 3 1 5-4-2-4 2 1-5-4-3 5-1z" fill="${G}"/><path d="M22 6h8l4 8 4-8h8l-8 18H30z" fill="#8C1D18"/>`,
  star: `<path d="M32 4l8 18 20 2-15 13 5 20-18-11-18 11 5-20L4 24l20-2z" fill="${G}"/><path d="M32 14l5 11 12 2-9 8 3 12-11-7-11 7 3-12-9-8 12-2z" fill="${I}" opacity=".35"/>`,
  coin: `<circle cx="32" cy="32" r="26" fill="${G}"/><circle cx="32" cy="32" r="19" fill="none" stroke="${I}" stroke-width="3"/><path d="M32 20v24M26 26h9a5 5 0 010 10h-6a5 5 0 000 10h9" stroke="${I}" stroke-width="3.5" fill="none" stroke-linecap="round"/>`,
  ring_frame: `<circle cx="32" cy="32" r="27" fill="none" stroke="${G}" stroke-width="3"/><circle cx="32" cy="32" r="22" fill="none" stroke="${G}" stroke-width="1.5" stroke-dasharray="4 6"/><circle cx="32" cy="5" r="3.5" fill="${G}"/><circle cx="32" cy="59" r="3.5" fill="${G}"/>`,
  ribbon_badge: `<circle cx="32" cy="26" r="18" fill="${G}"/><circle cx="32" cy="26" r="12" fill="${I}"/><path d="M32 18l3 5 6 1-4 4 1 6-6-3-6 3 1-6-4-4 6-1z" fill="${G}"/><path d="M22 40l-6 18 10-6 6 6 3-14M42 40l6 18-10-6-3 4-2-12" fill="#8C1D18"/>`,
  border_line: `<path d="M4 32h18M42 32h18" stroke="${G}" stroke-width="2.5" stroke-linecap="round"/><path d="M26 32l6-6 6 6-6 6z" fill="${G}"/><circle cx="24" cy="32" r="1.8" fill="${G}"/><circle cx="40" cy="32" r="1.8" fill="${G}"/>`,
  corner_flourish: `<path d="M8 56V22C8 14 14 8 22 8h34" fill="none" stroke="${G}" stroke-width="3" stroke-linecap="round"/><path d="M8 40c8 0 12-4 12-12M24 8c0 8-4 12-12 12" fill="none" stroke="${G}" stroke-width="2" stroke-linecap="round"/><circle cx="8" cy="56" r="3.5" fill="${G}"/><circle cx="56" cy="8" r="3.5" fill="${G}"/>`,
  elegant_ribbon: `<path d="M6 24c18-8 34-8 52 0v14c-18-8-34-8-52 0z" fill="${G}"/><path d="M6 24l-4 20 12-6 4 8zM58 24l4 20-12-6-4 8z" fill="#8C1D18"/><path d="M12 28c14-5 26-5 40 0" stroke="${I}" stroke-width="1.6" fill="none" opacity=".6"/>`,
  flourish_swirl: `<path d="M6 40c10 2 16-4 16-12S16 14 12 20s2 14 12 14c14 0 18-12 30-12 6 0 8 6 4 10" fill="none" stroke="${G}" stroke-width="2.8" stroke-linecap="round"/><circle cx="58" cy="34" r="2.6" fill="${G}"/><circle cx="6" cy="40" r="2.6" fill="${G}"/>`,
  laurel_wreath: `<path d="M18 8c-8 12-8 30 0 44M46 8c8 12 8 30 0 44" fill="none" stroke="${G}" stroke-width="2.5"/><g fill="${G}"><ellipse cx="14" cy="16" rx="5" ry="2.5" transform="rotate(-40 14 16)"/><ellipse cx="11" cy="28" rx="5" ry="2.5" transform="rotate(-15 11 28)"/><ellipse cx="12" cy="40" rx="5" ry="2.5" transform="rotate(10 12 40)"/><ellipse cx="50" cy="16" rx="5" ry="2.5" transform="rotate(40 50 16)"/><ellipse cx="53" cy="28" rx="5" ry="2.5" transform="rotate(15 53 28)"/><ellipse cx="52" cy="40" rx="5" ry="2.5" transform="rotate(-10 52 40)"/></g><circle cx="32" cy="54" r="3" fill="${G}"/>`,
  glass_orb: `<circle cx="32" cy="32" r="24" fill="${I}" opacity=".22"/><circle cx="32" cy="32" r="24" fill="none" stroke="${I}" stroke-width="1.6" opacity=".7"/><ellipse cx="24" cy="22" rx="8" ry="5" fill="#fff" opacity=".55" transform="rotate(-25 24 22)"/><circle cx="32" cy="32" r="17" fill="none" stroke="${G}" stroke-width="1" opacity=".5"/>`,
  trophy: `<path d="M20 8h24v14a12 12 0 01-24 0z" fill="${G}"/><path d="M20 12H8c0 10 5 15 12 16M44 12h12c0 10-5 15-12 16" fill="none" stroke="${G}" stroke-width="3.5"/><path d="M28 32h8l2 12H26z" fill="${G}" opacity=".85"/><rect x="20" y="46" width="24" height="8" rx="2" fill="${G}"/><path d="M27 14h10" stroke="${I}" stroke-width="2.5" stroke-linecap="round"/>`,
  certificate: `<rect x="6" y="12" width="52" height="36" rx="4" fill="${I}" stroke="${G}" stroke-width="2.5"/><path d="M14 22h36M14 29h28" stroke="${G}" stroke-width="2" stroke-linecap="round"/><circle cx="46" cy="42" r="7" fill="${G}"/><path d="M43 47l-2 10 5-3 5 3-2-10" fill="#8C1D18"/>`,
  lightbulb: `<path d="M32 6a17 17 0 00-9 31c2 1.6 3 3 3 5h12c0-2 1-3.4 3-5a17 17 0 00-9-31z" fill="${G}"/><path d="M26 46h12M28 52h8" stroke="${G}" stroke-width="3" stroke-linecap="round"/><path d="M27 20a7 7 0 015-3" stroke="${I}" stroke-width="2.5" stroke-linecap="round" fill="none"/>`,
  laptop_learn: `<rect x="12" y="10" width="40" height="26" rx="3" fill="${D}" stroke="${G}" stroke-width="2.5"/><path d="M20 20l6 4-6 4zM32 18h12M32 24h12M32 30h8" stroke="${G}" stroke-width="2.2" stroke-linecap="round" fill="${G}"/><path d="M6 44h52l-4 8H10z" fill="${G}"/>`,
  bg_arch: `<path d="M8 60V30C8 16 18 6 32 6s24 10 24 24v30h-8V32c0-10-7-17-16-17s-16 7-16 17v28z" fill="${G}" opacity=".8"/>`,
  bg_halo: `<circle cx="32" cy="32" r="26" fill="none" stroke="${G}" stroke-width="1.2" opacity=".8"/><circle cx="32" cy="32" r="20" fill="none" stroke="${G}" stroke-width="1" opacity=".55" stroke-dasharray="3 5"/><circle cx="32" cy="32" r="13" fill="${G}" opacity=".14"/>`,
};

function svgUri(inner) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${inner}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const DECOR_CATEGORIES = [
  { id: "khmer", label: "Khmer Heritage", assets: ["angkor_tower", "khmer_kbach", "golden_stupa"] },
  { id: "education", label: "Academic", assets: ["open_book", "grad_cap", "pencil", "certificate", "laurel_wreath"] },
  { id: "celebration", label: "Celebration", assets: ["balloon", "party_flag", "confetti_pop", "elegant_ribbon"] },
  { id: "luxury", label: "Luxury", assets: ["crown", "diamond", "gold_corner", "glass_orb"] },
  { id: "nature", label: "Nature", assets: ["lotus", "palm_tree", "leaf"] },
  { id: "seasonal", label: "Seasonal", assets: ["snowflake", "sun", "crescent_moon"] },
  { id: "tech", label: "Technology & AI", assets: ["ai_spark", "chat_bot", "laptop_learn", "lightbulb"] },
  { id: "speaking", label: "Speaking", assets: ["microphone", "speech_bubble"] },
  { id: "rewards", label: "Rewards", assets: ["gift_box", "medal", "star", "coin", "trophy"] },
  { id: "frames", label: "Frames & Badges", assets: ["ring_frame", "ribbon_badge", "bg_halo"] },
  { id: "ornaments", label: "Borders & Flourishes", assets: ["border_line", "corner_flourish", "flourish_swirl", "bg_arch"] },
];

export const ASSET_LABELS = {
  angkor_tower: "Angkor Tower", khmer_kbach: "Kbach Ornament", golden_stupa: "Golden Stupa",
  open_book: "Open Book", grad_cap: "Graduation Cap", pencil: "Pencil",
  balloon: "Balloon", party_flag: "Party Flags", confetti_pop: "Confetti Pop",
  crown: "Crown", diamond: "Diamond", gold_corner: "Gold Corner",
  lotus: "Lotus", palm_tree: "Palm Tree", leaf: "Leaf",
  snowflake: "Snowflake", sun: "Sun", crescent_moon: "Crescent Moon",
  ai_spark: "AI Companion", chat_bot: "Chat Bot",
  microphone: "Microphone", speech_bubble: "Speech Bubble",
  gift_box: "Gift Box", medal: "Medal", star: "Star", coin: "Coin",
  ring_frame: "Ring Frame", ribbon_badge: "Ribbon Badge",
  border_line: "Divider Border", corner_flourish: "Corner Flourish",
  elegant_ribbon: "Elegant Ribbon", flourish_swirl: "Flourish Swirl",
  laurel_wreath: "Laurel Wreath", glass_orb: "Glass Orb", trophy: "Trophy",
  certificate: "Certificate", lightbulb: "Idea Bulb", laptop_learn: "Learning Laptop",
  bg_arch: "Golden Arch", bg_halo: "Halo Rings",
};

export function decorAssetUri(id) {
  const inner = S[id];
  return inner ? svgUri(inner) : "";
}

export function decorationSrc(dec) {
  if (!dec) return "";
  return dec.kind === "custom" ? dec.url : decorAssetUri(dec.asset);
}
