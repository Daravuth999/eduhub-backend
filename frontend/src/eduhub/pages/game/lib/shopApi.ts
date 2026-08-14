// Reward Shop API — dual-mode.
//   Sends legacy studentId/itemName/pointCost (for the un-upgraded backend)
//   AND sessionToken (for the secured backend). Secured backend looks up
//   canonical PointCost server-side and ignores the client value.
import { setSessionToken, getSessionToken, makeNonce } from "../../../lib/secureClient";

export const SHOP_ENDPOINT =
  "https://script.google.com/macros/s/AKfycbyp40ywz45gwSAJQjQpCAKR61wF5T6gh4MnQEcNltqW4V5p2DPlyQR1khAi3a3bqCHu/exec";

export interface Reward {
  ItemName: string;
  Description?: string;
  Image?: string;
  PointCost: number;
  Stock?: number | string;
}

export interface ShopStudent {
  id: string;
  name: string;
  points: number;
  history: string[];
}

export interface ShopAuthResponse {
  success: boolean;
  message?: string;
  student?: ShopStudent;
  sessionToken?: string;
}

export interface RewardsResponse {
  success: boolean;
  rewards?: Reward[];
}

export interface RedeemResponse {
  success: boolean;
  message?: string;
  points?: number;
  history?: string[];
  code?: string;
}

export interface HistoryItem {
  itemName: string;
  date: string;
  points: string;
  raw: string;
}

async function getJson<T>(params: Record<string, string>): Promise<T> {
  const url = new URL(SHOP_ENDPOINT);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const tok = getSessionToken();
  if (tok) url.searchParams.append("sessionToken", tok);
  const res = await fetch(url.toString(), { method: "GET" });
  return res.json() as Promise<T>;
}

export async function shopLogin(id: string, password: string) {
  const r = await getJson<ShopAuthResponse>({ action: "login", id, password });
  if (r && r.success && r.sessionToken) setSessionToken(r.sessionToken);
  return r;
}

export function getStudentData(id: string) {
  return getJson<ShopAuthResponse>({ action: "getStudentData", id });
}

export function getRewards() {
  return getJson<RewardsResponse>({ action: "getRewards" });
}

export async function redeemReward(
  studentId: string,
  itemName: string,
  pointCost: number,
): Promise<RedeemResponse> {
  const tok = getSessionToken();
  const body = new URLSearchParams({ studentId, itemName, pointCost: String(pointCost) });
  if (tok) body.append("sessionToken", tok);
  body.append("nonce", makeNonce());
  const res = await fetch(`${SHOP_ENDPOINT}?action=redeemReward`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return res.json();
}

// Parse "ItemName - Date - Points" history strings used by the Shop GAS.
export function parseHistoryEntry(raw: string): HistoryItem {
  const parts = raw.split(" - ");
  return {
    itemName: parts[0]?.trim() ?? raw,
    date: parts[1]?.trim() ?? "",
    points: parts[2]?.trim() ?? "",
    raw,
  };
}
