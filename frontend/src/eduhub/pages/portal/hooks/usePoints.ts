import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  readLastBalance,
  writeLastBalance,
  lastBalanceTimestamp,
} from "../lib/pointsMemory";
import {
  writeLatestReward,
  type RewardSnapshot,
} from "../lib/rewardMemory";
import type { PointsTransfer } from "../types";
import {
  POLL_POINTS_MS,
  classifyPointsDelta,
  type PointsTier,
} from "../config/sections";
import { vibrate, VibratePattern } from "../lib/vibrate";

export interface PointsDeltaEvent {
  amount: number;
  /** Most recent transfer match — undefined for teacher / game / system rewards. */
  from?: string;
  /** Tier drives the celebration intensity. */
  tier: PointsTier;
  /** True when this delta accumulated between sessions (welcome-back). */
  whileAway?: boolean;
  /** Unique id so React can re-trigger the same-amount celebration. */
  id: number;
}

export interface SpendDeltaEvent {
  /** Absolute value of the spent amount (always positive). */
  amount: number;
  tier: PointsTier;
  id: number;
  /** True when the spend was detected on welcome-back (between sessions). */
  whileAway?: boolean;
}

export interface PollDebug {
  lastPolledAt: number | null;
  previous: number;
  lastRawPoints: unknown;
  lastDelta: number;
  pollCount: number;
  baselineFromMemory: number | null;
  baselineWrittenAt: number | null;
}

interface State {
  points: number;
  loading: boolean;
  receiveEvent: PointsDeltaEvent | null;
  consumeReceiveEvent: () => void;
  spendEvent: SpendDeltaEvent | null;
  consumeSpendEvent: () => void;
  /** Last known balance before the current value — for subtitle UX. */
  previousPoints: number;
  refresh: () => Promise<void>;
  fetchTransfers: () => Promise<PointsTransfer[]>;
  debug: PollDebug;
  triggerTestEvent: (amount: number) => void;
  rewardVersion: number;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^0-9.\-]/g, "");
    const n = parseFloat(cleaned);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

const REWARD_COPY_EN = [
  "Teacher reward",
  "Surprise points",
  "Game bonus",
  "Bonus boost",
  "You earned it",
];
const REWARD_COPY_KM = [
  "រង្វាន់ពីគ្រូ",
  "ពិន្ទុភ្ញាក់ផ្អើល",
  "ប្រាក់រង្វាន់ហ្គេម",
  "ការបន្ថែមពិសេស",
  "អ្នកសមនឹងទទួលបាន",
];

function pickRewardCopy(eventId: number, whileAway?: boolean) {
  if (whileAway) {
    return {
      copy: "Earned while you were away",
      copyKm: "ទទួលបានពេលអ្នកមិននៅ",
    };
  }
  const i = eventId % REWARD_COPY_EN.length;
  return { copy: REWARD_COPY_EN[i], copyKm: REWARD_COPY_KM[i] };
}

const LOW_BALANCE_THRESHOLD = 100;

export function usePoints(
  studentId: string,
  password: string,
  initial: number,
): State {
  const memoryAtMountRef = useRef<{ value: number | null; ts: number | null }>(
    {
      value: readLastBalance(studentId),
      ts: lastBalanceTimestamp(studentId),
    },
  );

  const initialBaseline =
    memoryAtMountRef.current.value !== null
      ? memoryAtMountRef.current.value
      : initial;

  const [points, setPoints] = useState<number>(initial);
  const [previousPoints, setPreviousPoints] =
    useState<number>(initialBaseline);
  const [loading, setLoading] = useState(false);
  const [receiveEvent, setReceiveEvent] = useState<PointsDeltaEvent | null>(
    null,
  );
  const [spendEvent, setSpendEvent] = useState<SpendDeltaEvent | null>(null);
  const [debug, setDebug] = useState<PollDebug>({
    lastPolledAt: null,
    previous: initialBaseline,
    lastRawPoints: initial,
    lastDelta: 0,
    pollCount: 0,
    baselineFromMemory: memoryAtMountRef.current.value,
    baselineWrittenAt: memoryAtMountRef.current.ts,
  });

  const prevRef = useRef<number>(initialBaseline);
  const eventIdRef = useRef<number>(0);
  const welcomeFiredRef = useRef<boolean>(false);
  const lowBalanceFiredRef = useRef<boolean>(initial < LOW_BALANCE_THRESHOLD);
  const [rewardVersion, setRewardVersion] = useState<number>(0);

  const fireReceive = useCallback(
    (delta: number, opts?: { from?: string; whileAway?: boolean }) => {
      const tier = classifyPointsDelta(delta);
      if (!tier) return;
      eventIdRef.current += 1;
      const id = eventIdRef.current;
      setReceiveEvent({
        amount: delta,
        tier,
        id,
        from: opts?.from,
        whileAway: opts?.whileAway,
      });

      // Haptic feedback per tier.
      vibrate(VibratePattern[tier]);

      const copy = pickRewardCopy(id, opts?.whileAway);
      const snap: RewardSnapshot = {
        amount: delta,
        ts: Date.now(),
        copy: copy.copy,
        copyKm: copy.copyKm,
        tier,
        from: opts?.from,
        whileAway: opts?.whileAway,
      };
      writeLatestReward(studentId, snap);
      setRewardVersion((v) => v + 1);
    },
    [studentId],
  );

  const fireSpend = useCallback(
    (absAmount: number, opts?: { whileAway?: boolean }) => {
      const tier = classifyPointsDelta(absAmount);
      if (!tier) return;
      eventIdRef.current += 1;
      const id = eventIdRef.current;
      setSpendEvent({
        amount: absAmount,
        tier,
        id,
        whileAway: opts?.whileAway,
      });
      vibrate(VibratePattern.spend);
    },
    [],
  );

  /* ---------- WELCOME-BACK celebration on dashboard mount ---------- */
  useEffect(() => {
    if (welcomeFiredRef.current) return;
    const baseline = memoryAtMountRef.current.value;
    if (baseline === null) {
      writeLastBalance(studentId, initial);
      welcomeFiredRef.current = true;
      return;
    }
    const delta = initial - baseline;
    welcomeFiredRef.current = true;

    if (delta > 0) {
      const t = setTimeout(() => fireReceive(delta, { whileAway: true }), 1800);
      writeLastBalance(studentId, initial);
      return () => clearTimeout(t);
    }
    if (delta < 0) {
      const t = setTimeout(
        () => fireSpend(Math.abs(delta), { whileAway: true }),
        1800,
      );
      writeLastBalance(studentId, initial);
      return () => clearTimeout(t);
    }
    writeLastBalance(studentId, initial);
    prevRef.current = initial;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId, initial]);

  /* ---------- Periodic polling ---------- */
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const p = await api.pointsLogin(studentId, password);
      const rawPoints = p?.points;
      const next = toNumber(rawPoints);

      // eslint-disable-next-line no-console
      console.log(
        "[points] poll",
        new Date().toISOString(),
        "raw=",
        rawPoints,
        "parsed=",
        next,
        "prev=",
        prevRef.current,
        "ok=",
        p?.success,
      );

      if (p && p.success && next !== null) {
        const delta = next - prevRef.current;
        const wasPrev = prevRef.current;
        prevRef.current = next;
        // Always update "previous" BEFORE updating "next" so UI can read it.
        setPreviousPoints(wasPrev);
        setPoints(next);

        writeLastBalance(studentId, next);

        // Low balance warning — fires once per "drop below threshold" cycle.
        if (next < LOW_BALANCE_THRESHOLD) {
          if (!lowBalanceFiredRef.current) {
            vibrate(VibratePattern.lowBalance);
            lowBalanceFiredRef.current = true;
          }
        } else {
          // Reset so it can fire again next time we drop below.
          lowBalanceFiredRef.current = false;
        }

        setDebug((d) => ({
          ...d,
          lastPolledAt: Date.now(),
          previous: wasPrev,
          lastRawPoints: rawPoints,
          lastDelta: delta,
          pollCount: d.pollCount + 1,
        }));

        if (delta > 0) {
          fireReceive(delta);

          api
            .recentTransfers(studentId)
            .then((tx) => {
              if (!tx?.success || !tx.history) return;
              const match = tx.history.find(
                (t) => t.direction === "received" && t.amount === delta,
              );
              if (match?.from) {
                setReceiveEvent((curr) =>
                  curr && curr.amount === delta
                    ? { ...curr, from: match.from }
                    : curr,
                );
              }
            })
            .catch(() => undefined);
        } else if (delta < 0) {
          fireSpend(Math.abs(delta));
        }
      } else {
        setDebug((d) => ({
          ...d,
          lastPolledAt: Date.now(),
          lastRawPoints: rawPoints,
          pollCount: d.pollCount + 1,
        }));
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[points] poll failed", err);
    } finally {
      setLoading(false);
    }
  }, [studentId, password, fireReceive, fireSpend]);

  const fetchTransfers = useCallback(async (): Promise<PointsTransfer[]> => {
    try {
      const res = await api.recentTransfers(studentId);
      return res?.success && res.history ? res.history : [];
    } catch {
      return [];
    }
  }, [studentId]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_POINTS_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh]);

  const consumeReceiveEvent = useCallback(() => setReceiveEvent(null), []);
  const consumeSpendEvent = useCallback(() => setSpendEvent(null), []);

  const triggerTestEvent = useCallback(
    (amount: number) => {
      if (amount >= 0) {
        fireReceive(amount, undefined);
      } else {
        fireSpend(Math.abs(amount));
      }
    },
    [fireReceive, fireSpend],
  );

  return {
    points,
    loading,
    receiveEvent,
    consumeReceiveEvent,
    spendEvent,
    consumeSpendEvent,
    previousPoints,
    refresh,
    fetchTransfers,
    debug,
    triggerTestEvent,
    rewardVersion,
  };
}
