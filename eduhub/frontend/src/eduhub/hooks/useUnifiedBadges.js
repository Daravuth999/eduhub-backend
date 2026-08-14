/**
 * useUnifiedBadges.js — the single source of truth for "does this module
 * have unread activity" across the whole app (Dashboard tiles, Sidebar,
 * bottom nav, Portal, per-module icons) and for the Home Screen app icon
 * badge (Badging API).
 *
 * Deliberately reads from ONE place: NotificationContext's `unreadCount` /
 * `unreadByCategory`, which is itself fed by the single backend event
 * stream every module already funnels through (`_fan_out_push` →
 * notification_center.py). This hook adds NO new fetch, NO new WebSocket,
 * NO new poll — it only reshapes state that already exists into a
 * module-keyed view any component can subscribe to.
 *
 * Category → module mapping mirrors activityTheme.js's CATEGORY_META
 * exactly (rewards|points|vouchers|payments|classes|speaking_lab|
 * attendance|system). If a 9th backend category is ever introduced,
 * update CATEGORY_TO_MODULE here — nothing else needs to change.
 */
import { useMemo } from "react";
import { useNotifications } from "../context/NotificationContext";

export const CATEGORY_TO_MODULE = {
  points: "wallet",
  payments: "wallet",
  vouchers: "wallet",
  rewards: "wallet",
  classes: "library",
  speaking_lab: "speakingLab",
  attendance: "attendance",
  system: "system",
};

const MODULE_KEYS = ["wallet", "library", "speakingLab", "attendance", "system"];

export function useUnifiedBadges() {
  const notifications = useNotifications();
  const unreadCount = notifications?.unreadCount || 0;
  // Read the raw object straight from context (undefined when logged out /
  // provider unavailable) — the `|| {}` fallback happens INSIDE the memo
  // callback so the dependency array below holds a stable reference
  // (either the same object identity from context, or `undefined`),
  // never a fresh `{}` literal recreated every render.
  const unreadByCategoryRaw = notifications?.unreadByCategory;

  const byModule = useMemo(() => {
    const unreadByCategory = unreadByCategoryRaw || {};
    const out = { wallet: 0, library: 0, speakingLab: 0, attendance: 0, system: 0 };
    for (const [category, count] of Object.entries(unreadByCategory)) {
      const mod = CATEGORY_TO_MODULE[category];
      if (mod && MODULE_KEYS.includes(mod)) {
        out[mod] += Number(count) || 0;
      }
    }
    return out;
  }, [unreadByCategoryRaw]);

  return { total: unreadCount, byModule };
}

export default useUnifiedBadges;
