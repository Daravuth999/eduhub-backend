// Game / Lucky-Spin API — dual-mode.
//   Sends the classic id + password the legacy backend expects, AND the
//   sessionToken the secured backend expects. Whichever backend is live
//   uses the one it understands; the other is ignored.
import { setSessionToken, getSessionToken, makeNonce } from "../../../lib/secureClient";

export const ENDPOINT =
  "https://script.google.com/macros/s/AKfycbxKSDSZm-iM9dTqT_noZ_EC1DV-lFcIinJGt-2sIdBCcWbfahyx_8uOKsEbenaeQMKa/exec";

export interface Prize {
  Emoji: string;
  PrizeName: string;
  RewardPoints: number;
}

export interface LoginResponse {
  success: boolean;
  message?: string;
  name?: string;
  points?: number;
  sessionToken?: string;
}

export interface SlotConfigResponse {
  spinCost: number;
  prizes: Prize[];
}

export interface SpinResponse {
  success: boolean;
  message?: string;
  emoji?: string;
  prize?: string;
  change?: number;
  remaining?: number;
  hitJackpot?: boolean;
}

export interface RestrictionResponse {
  message?: string;
}

async function postForm<T>(
  payload: Record<string, string>,
  opts: { requireNonce?: boolean } = {},
): Promise<T> {
  const body = new FormData();
  Object.entries(payload).forEach(([k, v]) => body.append(k, v));
  const tok = getSessionToken();
  if (tok) body.append("sessionToken", tok);
  if (opts.requireNonce) body.append("nonce", makeNonce());
  const res = await fetch(ENDPOINT, { method: "POST", body });
  return res.json() as Promise<T>;
}

export async function login(id: string, password: string) {
  const r = await postForm<LoginResponse>({ action: "login", id, password });
  if (r && r.success && r.sessionToken) setSessionToken(r.sessionToken);
  return r;
}

export function getSlotConfig() {
  return postForm<SlotConfigResponse>({ action: "getSlotConfig" });
}

export function handleCardGame(id: string, password: string) {
  // Keep id+password for legacy compatibility; sessionToken is added
  // automatically by postForm when present.
  return postForm<SpinResponse>(
    { action: "handleCardGame", id, password },
    { requireNonce: true },
  );
}

export function getRestrictionMessage(id: string) {
  return postForm<RestrictionResponse>({ action: "getRestrictionMessage", id });
}
