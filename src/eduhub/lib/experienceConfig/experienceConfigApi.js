/**
 * experienceConfigApi.js — thin client for the Experience Configuration
 * Platform's read API. Public, unauthenticated (GET /experience-configs/active
 * never requires a session — experience surfaces render for logged-out
 * visitors too, e.g. the public Dashboard).
 *
 * This file knows nothing about Welcome Dashboard specifically, or about
 * Google Sheets — it is a pure transport for the generic backend contract.
 *
 * Dashboard Bootstrap (stale-while-revalidate): every successful response
 * is cached per experienceType via swrCache so a returning visitor's LAST
 * KNOWN published config is available synchronously on next launch
 * (see getCachedActiveExperienceConfig, used by useExperienceConfig's
 * initial state) — the resolver still treats a live "no config" response
 * as authoritative once it arrives, this cache only covers the gap before
 * the network round trip resolves.
 */
import { readSwrCache, writeSwrCache } from "../swrCache";

/* eslint-disable no-undef */
const BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
/* eslint-enable no-undef */

const CACHE_KEY = (experienceType) => `eduhub_experience_active_v1_${experienceType}`;

/** Synchronous cache read — last successfully fetched published config for
 * this experienceType, or null if we've never had one. Used to seed first
 * paint before the network fetch below resolves. */
export function getCachedActiveExperienceConfig(experienceType) {
  if (!experienceType) return null;
  const entry = readSwrCache(CACHE_KEY(experienceType));
  return entry ? entry.data : null;
}

/**
 * Fetch the currently-active published config for an experience type.
 * Returns the raw `{ id, experienceType, content, appearance, motion,
 * playback, ... }` object, or null if none is active — this is a normal,
 * expected outcome (the resolver falls through to legacy/defaults), never
 * treated as an error by this function.
 */
export async function fetchActiveExperienceConfig(experienceType, { timeoutMs = 4000 } = {}) {
  if (!BASE || !experienceType) return null;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(
      `${BASE}/api/experience-configs/active?type=${encodeURIComponent(experienceType)}`,
      { signal: controller ? controller.signal : undefined },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const config = data && data.config ? data.config : null;
    // Only cache a real published config. A confirmed "nothing published"
    // response clears any stale cache instead of silently keeping an old
    // one around forever (an admin unpublishing IS a real state change the
    // next launch should reflect, not something SWR should mask).
    if (config) writeSwrCache(CACHE_KEY(experienceType), config);
    else writeSwrCache(CACHE_KEY(experienceType), null);
    return config;
  } catch {
    // Network failure, timeout, backend offline -- never throw, and never
    // touch the cache — an unreachable network is exactly the case SWR
    // exists for; keep serving the last known-good value.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const LIST_CACHE_KEY = (experienceType) => `eduhub_experience_active_list_v1_${experienceType}`;

/** Synchronous cache read for fetchActiveExperienceConfigList's last
 * successful result — same seed-first-paint role as
 * getCachedActiveExperienceConfig, for experience types with more than
 * one simultaneous instance (e.g. "winner_showcase"). */
export function getCachedActiveExperienceConfigList(experienceType) {
  if (!experienceType) return [];
  const entry = readSwrCache(LIST_CACHE_KEY(experienceType));
  return entry ? entry.data : [];
}

/**
 * Fetch EVERY currently-active published config for an experience type
 * (unlike fetchActiveExperienceConfig, which returns only the single
 * "best" one) — via GET /experience-configs/active-list. Used by
 * experience types with more than one legitimately-simultaneous instance,
 * e.g. one "winner_showcase" per settled event, rotated client-side.
 * Never throws; returns [] on any failure.
 */
export async function fetchActiveExperienceConfigList(experienceType, { timeoutMs = 4000 } = {}) {
  if (!BASE || !experienceType) return [];
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(
      `${BASE}/api/experience-configs/active-list?type=${encodeURIComponent(experienceType)}`,
      { signal: controller ? controller.signal : undefined },
    );
    if (!res.ok) return [];
    const data = await res.json();
    const configs = Array.isArray(data?.configs) ? data.configs : [];
    writeSwrCache(LIST_CACHE_KEY(experienceType), configs);
    return configs;
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default {
  fetchActiveExperienceConfig, getCachedActiveExperienceConfig,
  fetchActiveExperienceConfigList, getCachedActiveExperienceConfigList,
};
