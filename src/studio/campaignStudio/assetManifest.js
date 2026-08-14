/**
 * assetManifest.js — Campaign Design Studio 2.0 premium asset library.
 *
 * Pack-driven and open-ended: adding a future asset pack = appending one
 * entry here + dropping files in /public/assets/campaign/<pack>/. No
 * component changes required (AssetLibraryPanel renders from this manifest).
 *
 * kind: "png" (AI-crafted transparent hero artwork) | "svg" (hand-crafted
 * vector decorations). aspect = width/height hint for smart insert sizing —
 * measured from the actual shipped files (PNG pixel dims / SVG viewBox),
 * so inserted frames start close to the artwork's true proportions.
 */

const P = "/assets/campaign";

export const ASSET_PACKS = [
  {
    id: "finance",
    label: "Finance",
    assets: [
      { id: "coin-stack", label: "Coin Stack", src: `${P}/finance/coin-stack.png`, kind: "png", aspect: 0.67 },
      { id: "coin-rain", label: "Coin Rain", src: `${P}/finance/coin-rain.png`, kind: "png", aspect: 0.38 },
      { id: "wallet", label: "Wallet", src: `${P}/finance/wallet.png`, kind: "png", aspect: 0.9 },
      { id: "credit-card", label: "Credit Card", src: `${P}/finance/credit-card.png`, kind: "png", aspect: 1.06 },
      { id: "qr-payment", label: "QR Payment", src: `${P}/finance/qr-payment.png`, kind: "png", aspect: 0.89 },
      { id: "phone", label: "Phone", src: `${P}/finance/phone.png`, kind: "png", aspect: 0.7 },
      { id: "treasure-chest", label: "Treasure Chest", src: `${P}/finance/treasure-chest.png`, kind: "png", aspect: 1.07 },
      { id: "gift-box", label: "Gift Box", src: `${P}/finance/gift-box.png`, kind: "png", aspect: 0.87 },
      { id: "reward-token", label: "Reward Token", src: `${P}/finance/reward-token.png`, kind: "png", aspect: 0.97 },
    ],
  },
  {
    id: "education",
    label: "Education",
    assets: [
      { id: "books", label: "Book Stack", src: `${P}/education/books.png`, kind: "png", aspect: 0.94 },
      { id: "graduation-cap", label: "Graduation Cap", src: `${P}/education/graduation-cap.png`, kind: "png", aspect: 1.23 },
      { id: "diploma", label: "Diploma", src: `${P}/education/diploma.png`, kind: "png", aspect: 0.98 },
      { id: "ai-assistant", label: "AI Assistant", src: `${P}/education/ai-assistant.png`, kind: "png", aspect: 0.93 },
      { id: "trophy", label: "Golden Trophy", src: `${P}/education/trophy.png`, kind: "png", aspect: 1.09 },
    ],
  },
  {
    id: "marketing",
    label: "Marketing",
    assets: [
      { id: "luxury-ribbon", label: "Luxury Ribbon", src: `${P}/svg/luxury-ribbon.svg`, kind: "svg", aspect: 3.4 },
      { id: "offer-starburst", label: "Offer Starburst", src: `${P}/svg/offer-starburst.svg`, kind: "svg", aspect: 1 },
      { id: "premium-border", label: "Premium Border", src: `${P}/svg/premium-border.svg`, kind: "svg", aspect: 2.33 },
      { id: "corner-flourish", label: "Corner Flourish", src: `${P}/svg/corner-flourish.svg`, kind: "svg", aspect: 1 },
      { id: "gold-seal", label: "Gold Seal", src: `${P}/svg/gold-seal.svg`, kind: "svg", aspect: 0.9 },
      { id: "laurel", label: "Laurel Wreath", src: `${P}/svg/laurel.svg`, kind: "svg", aspect: 1.25 },
      { id: "deco-line", label: "Deco Divider", src: `${P}/svg/deco-line.svg`, kind: "svg", aspect: 6 },
      { id: "glass-panel", label: "Glass Panel", src: `${P}/svg/glass-panel.svg`, kind: "svg", aspect: 1.6 },
    ],
  },
  {
    id: "celebration",
    label: "Celebration",
    assets: [
      { id: "celebration-burst", label: "Celebration Burst", src: `${P}/celebration/celebration-burst.png`, kind: "png", aspect: 1.04 },
      { id: "golden-balloons", label: "Golden Balloons", src: `${P}/celebration/golden-balloons.png`, kind: "png", aspect: 0.75 },
      { id: "ribbon-swirl", label: "Ribbon Swirl", src: `${P}/svg/ribbon-swirl.svg`, kind: "svg", aspect: 1.38 },
    ],
  },
  {
    id: "seasonal",
    label: "Seasonal",
    assets: [
      { id: "khmer-new-year", label: "Khmer New Year", src: `${P}/seasonal/khmer-new-year.png`, kind: "png", aspect: 0.87 },
      { id: "christmas", label: "Christmas", src: `${P}/seasonal/christmas.png`, kind: "png", aspect: 0.82 },
      { id: "graduation-season", label: "Graduation", src: `${P}/seasonal/graduation-season.png`, kind: "png", aspect: 0.93 },
      { id: "back-to-school", label: "Back To School", src: `${P}/seasonal/back-to-school.png`, kind: "png", aspect: 0.99 },
    ],
  },
];

export function findAsset(assetId) {
  for (const pack of ASSET_PACKS) {
    const hit = pack.assets.find((a) => a.id === assetId);
    if (hit) return hit;
  }
  return null;
}

const assetManifest = { ASSET_PACKS, findAsset };
export default assetManifest;
