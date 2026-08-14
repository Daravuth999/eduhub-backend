import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  User,
  Trophy,
  Coins,
  LogIn,
  Loader2,
  PartyPopper,
  CheckCircle2,
  AlertTriangle,
  X,
  Volume2,
  VolumeX,
  Sparkles,
  Gift,
  LogOut,
} from "lucide-react";
import {
  getRestrictionMessage,
  getSlotConfig,
  handleCardGame,
  login as apiLogin,
  type Prize,
} from "../lib/api";
import {
  loadHistory,
  pushHistory,
  clearHistory,
  type HistoryEntry,
} from "../lib/history";
import {
  setMuted,
  playTick,
  playWin,
  playJackpot,
  playSpinStart,
  playChestOpen,
  playPrizeBurst,
  playNoPrize,
  playChestPick,
} from "../lib/sound";
import {
  getRewards,
  getStudentData,
  redeemReward,
  shopLogin,
  type Reward,
} from "../lib/shopApi";
import { Confetti } from "../components/Confetti";
import { SpinPanel } from "../components/SpinPanel";
import { RewardVault } from "../components/RewardVault";
import { PeekPanel } from "../components/PeekPanel";
import { RedeemConfirmModal } from "../components/RedeemConfirmModal";
import { MysteryVault, type VaultPrize } from "../components/MysteryVault";

const REVOLUTIONS = 6;
type Mode = "spin" | "vault";

interface WinState {
  message: string;
  isJackpot: boolean;
}

function AnimatedNumber({ value }: { value: number }) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to) return;
    const duration = 700;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return <span>{display}</span>;
}

export function LuckySpin() {
  // Auth
  const [studentId, setStudentId] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);

  // Profile
  const [studentName, setStudentName] = useState("");
  const [points, setPoints] = useState(0);

  // Spin Game state
  const [prizes, setPrizes] = useState<Prize[]>([]);
  const [spinCost, setSpinCost] = useState<number | null>(null);
  const [rotation, setRotation] = useState(0);
  const [isSpinning, setIsSpinning] = useState(false);
  const [isPreloading, setIsPreloading] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [winState, setWinState] = useState<WinState | null>(null);
  const [confettiActive, setConfettiActive] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  // Reward Shop state
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [shopHistory, setShopHistory] = useState<string[]>([]);
  const [loadingRewards, setLoadingRewards] = useState(true);
  const [redeemingItem, setRedeemingItem] = useState<string | null>(null);
  const [giftCode, setGiftCode] = useState<string | null>(null);
  const [redeemToast, setRedeemToast] = useState<string | null>(null);
  const [shopWarning, setShopWarning] = useState("");

  // UI
  const [mode, setMode] = useState<Mode>("spin");
  const [showAgreement, setShowAgreement] = useState(false);
  const [restrictionMsg, setRestrictionMsg] = useState("");
  const [muted, setMutedLocal] = useState(false);

  // Engagement state — pure frontend, no backend coupling
  const [winningIndex, setWinningIndex] = useState<number | null>(null);
  const [sessionStreak, setSessionStreak] = useState(0);
  const [spinCount, setSpinCount] = useState(0);
  const [isIdle, setIsIdle] = useState(false);

  // Mystery Vault state
  const [showVault, setShowVault] = useState(false);
  const [vaultPicked, setVaultPicked] = useState<number | null>(null);
  const [vaultPicking, setVaultPicking] = useState(false);
  const [vaultRevealed, setVaultRevealed] = useState<VaultPrize | null>(null);
  const lastVaultSpinRef = useRef<number>(-100);

  // Mystery spin every 5th spin (1, 6, 11, ...) — purely cosmetic.
  const isMysterySpin = spinCount % 5 === 0;

  // Build a name → image lookup so wheel segments can show real reward art.
  const prizeImages = useMemo(() => {
    const map: Record<string, string> = {};
    rewards.forEach((r) => {
      if (r.Image) map[r.ItemName.toLowerCase().trim()] = r.Image;
    });
    return map;
  }, [rewards]);

  // Idle attractor — pulse the spin button if user hasn't acted in 15s.
  useEffect(() => {
    if (!loggedIn || isSpinning || isPreloading) {
      setIsIdle(false);
      return;
    }
    let t: ReturnType<typeof setTimeout> | null = null;
    const reset = () => {
      setIsIdle(false);
      if (t) clearTimeout(t);
      t = setTimeout(() => setIsIdle(true), 15000);
    };
    reset();
    const events: (keyof WindowEventMap)[] = [
      "pointerdown",
      "pointermove",
      "keydown",
      "scroll",
      "wheel",
    ];
    events.forEach((e) => window.addEventListener(e, reset));
    return () => {
      if (t) clearTimeout(t);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [loggedIn, isSpinning, isPreloading]);

  const pendingResultRef = useRef<{
    remaining: number;
    message: string;
    isJackpot: boolean;
    prizeIndex: number;
    emoji: string;
    prize: string;
    change: number;
  } | null>(null);

  const credentialsRef = useRef({ id: "", password: "" });

  // Confirm-redeem modal
  const [pendingRedeem, setPendingRedeem] = useState<Reward | null>(null);

  // Session persistence — uses localStorage so it survives tab close, refresh,
  // and browser restart. We also cache the last-known profile so the dashboard
  // appears instantly on reload (no flash of login screen) while we silently
  // re-auth in the background.
  const SESSION_KEY = "lucky-spin:session-v2";

  type CachedSession = {
    id: string;
    password: string;
    name?: string;
    points?: number;
    shopHistory?: string[];
  };

  function persistSession(next: Partial<CachedSession>) {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      const prev = raw ? (JSON.parse(raw) as CachedSession) : null;
      const merged = { ...(prev ?? {}), ...next } as CachedSession;
      localStorage.setItem(SESSION_KEY, JSON.stringify(merged));
    } catch {
      // ignore quota / disabled storage
    }
  }

  function clearSession() {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      // ignore
    }
  }

  // Auto-rehydrate on first mount.
  // Strategy: paint cached profile immediately, then silently re-auth in the
  // background. NETWORK errors do NOT clear the session — only an explicit
  // "wrong credentials" response from BOTH backends does.
  useEffect(() => {
    let cached: CachedSession | null = null;
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw) cached = JSON.parse(raw) as CachedSession;
    } catch {
      // ignore
    }
    if (!cached?.id || !cached?.password) return;

    // 1) Paint cached profile immediately so user feels logged in.
    credentialsRef.current = { id: cached.id, password: cached.password };
    if (cached.name) setStudentName(cached.name);
    if (typeof cached.points === "number") setPoints(cached.points);
    if (Array.isArray(cached.shopHistory)) setShopHistory(cached.shopHistory);
    setLoggedIn(true);
    setHistory(loadHistory(cached.id));
    loadSlotConfig();
    checkRestriction(cached.id);

    // 2) Silently refresh from the canonical Shop GAS in the background.
    // CRITICAL: this is fire-and-forget. We NEVER auto-logout from here —
    // not on `success: false`, not on network error, not on slow GAS.
    // The only path that clears the session is the explicit Logout button.
    (async () => {
      try {
        const data = await getStudentData(cached!.id);
        const s = data?.student;
        if (s) {
          if (s.name) setStudentName(s.name);
          if (typeof s.points === "number") setPoints(Number(s.points));
          if (Array.isArray(s.history)) setShopHistory(s.history);
          persistSession({
            name: s.name,
            points: typeof s.points === "number" ? Number(s.points) : undefined,
            shopHistory: Array.isArray(s.history) ? s.history : undefined,
          });
        }
      } catch {
        // Network blip — keep the user logged in with cached values.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleMute() {
    const next = !muted;
    setMutedLocal(next);
    setMuted(next);
  }

  // Load reward catalog as soon as the app mounts (mirrors original window.onload)
  useEffect(() => {
    (async () => {
      try {
        const data = await getRewards();
        if (data.success && Array.isArray(data.rewards)) {
          setRewards(data.rewards);
        }
      } catch {
        // silent — vault will show empty state
      } finally {
        setLoadingRewards(false);
      }
    })();
  }, []);

  async function handleLogin(e?: React.FormEvent) {
    e?.preventDefault();
    if (!studentId.trim() || !password.trim()) {
      setLoginError("Please enter both ID and password.");
      return;
    }
    setLoginError("");
    setLoginLoading(true);
    const id = studentId.trim();
    const pw = password.trim();
    try {
      // Fan out: both backends authenticate in parallel.
      const [spinRes, shopRes] = await Promise.allSettled([
        apiLogin(id, pw),
        shopLogin(id, pw),
      ]);

      const spinOk = spinRes.status === "fulfilled" && spinRes.value.success;
      const shopOk = shopRes.status === "fulfilled" && shopRes.value.success;

      if (!spinOk && !shopOk) {
        const msg =
          (spinRes.status === "fulfilled" && spinRes.value.message) ||
          (shopRes.status === "fulfilled" && shopRes.value.message) ||
          "Login failed.";
        setLoginError(msg);
        setLoginLoading(false);
        return;
      }

      credentialsRef.current = { id, password: pw };

      // Prefer Shop balance + history (canonical ledger from the original Reward Shop).
      // Fallback to Spin profile when Shop is unavailable.
      let cachedName = "";
      let cachedPoints = 0;
      let cachedHistory: string[] = [];
      if (shopOk && shopRes.status === "fulfilled" && shopRes.value.student) {
        const s = shopRes.value.student;
        cachedName = s.name ?? "";
        cachedPoints = typeof s.points === "number" ? Number(s.points) : 0;
        cachedHistory = Array.isArray(s.history) ? s.history : [];
        setStudentName(cachedName);
        setPoints(cachedPoints);
        setShopHistory(cachedHistory);
      } else if (spinOk && spinRes.status === "fulfilled") {
        cachedName = spinRes.value.name ?? "";
        cachedPoints = Number(spinRes.value.points ?? 0);
        setStudentName(cachedName);
        setPoints(cachedPoints);
        setShopWarning("Reward Vault temporarily unavailable.");
      }

      // Persist credentials AND profile snapshot so reload paints instantly.
      persistSession({
        id,
        password: pw,
        name: cachedName,
        points: cachedPoints,
        shopHistory: cachedHistory,
      });

      // If only Shop succeeded, still try to use spin (rare).
      if (!spinOk) {
        setShopWarning((w) => w || "Spin service unavailable. Try again soon.");
      }

      setLoggedIn(true);
      setShowAgreement(true);
      setHistory(loadHistory(id));
      loadSlotConfig();
      checkRestriction(id);
    } catch {
      setLoginError("Error connecting to server.");
    } finally {
      setLoginLoading(false);
    }
  }

  async function loadSlotConfig() {
    try {
      const cfg = await getSlotConfig();
      setSpinCost(cfg.spinCost);
      setPrizes(cfg.prizes ?? []);
    } catch {
      setStatusMsg("Error loading prize board.");
    }
  }

  async function checkRestriction(id: string) {
    try {
      const r = await getRestrictionMessage(id);
      if (r?.message && r.message.trim() !== "") {
        setRestrictionMsg(r.message);
      }
    } catch {
      // silent
    }
  }

  async function refreshShopBalance() {
    const id = credentialsRef.current.id;
    if (!id) return;
    try {
      const data = await getStudentData(id);
      const s = data.student;
      if (s) {
        if (typeof s.points === "number") setPoints(Number(s.points));
        if (Array.isArray(s.history)) setShopHistory(s.history);
        // Keep the persisted snapshot fresh for next reload.
        persistSession({
          name: s.name,
          points: typeof s.points === "number" ? Number(s.points) : undefined,
          shopHistory: Array.isArray(s.history) ? s.history : undefined,
        });
      }
    } catch {
      // silent — never logout on a network blip
    }
  }

  async function handleSpin() {
    if (isSpinning || isPreloading) return;
    if (showVault) return;
    if (spinCost == null || prizes.length === 0) return;
    if (points < spinCost) {
      setStatusMsg("Not enough points to spin!");
      return;
    }

    // Decide if THIS spin should be a Mystery Vault round.
    // Rule: every 5th spin guaranteed + 15% random + 3-spin cooldown.
    const upcomingSpinIndex = spinCount + 1;
    const spinsSinceVault = upcomingSpinIndex - lastVaultSpinRef.current;
    const guaranteed = upcomingSpinIndex > 0 && upcomingSpinIndex % 5 === 0;
    const randomHit = Math.random() < 0.15;
    const inCooldown = spinsSinceVault < 3;

    if (!inCooldown && (guaranteed || randomHit)) {
      // Open the vault — backend call will happen when user picks a chest.
      setShowVault(true);
      setVaultPicked(null);
      setVaultRevealed(null);
      setVaultPicking(false);
      lastVaultSpinRef.current = upcomingSpinIndex;
      return;
    }

    // Otherwise: normal wheel spin path.
    setStatusMsg("");
    setWinState(null);
    setIsPreloading(true);
    playSpinStart();

    try {
      const data = await handleCardGame(
        credentialsRef.current.id,
        credentialsRef.current.password,
      );

      if (!data.success) {
        setStatusMsg(data.message ?? "Spin failed.");
        setIsPreloading(false);
        return;
      }

      const prizeIndex = prizes.findIndex((p) => p.Emoji === data.emoji);
      if (prizeIndex === -1) {
        setStatusMsg("Prize not found.");
        setIsPreloading(false);
        return;
      }

      const segCount = prizes.length;
      const segAngle = 360 / segCount;
      const jitter = (Math.random() - 0.5) * (segAngle * 0.6);
      const targetWithin = 360 - (prizeIndex * segAngle + segAngle / 2) + jitter;

      const currentMod = ((rotation % 360) + 360) % 360;
      const delta = ((targetWithin - currentMod) % 360 + 360) % 360;
      const next = rotation + REVOLUTIONS * 360 + delta;

      pendingResultRef.current = {
        remaining: data.remaining ?? points - spinCost,
        message:
          (data.change ?? 0) > 0
            ? `You won ${data.prize} (+${data.change} points!)`
            : "Thank you for playing!",
        isJackpot: !!data.hitJackpot,
        prizeIndex,
        emoji: data.emoji ?? "",
        prize: data.prize ?? "",
        change: data.change ?? 0,
      };

      setPoints((p) => p - spinCost);
      setIsPreloading(false);
      setWinningIndex(null);
      setSpinCount((c) => c + 1);
      setIsSpinning(true);
      setRotation(next);
    } catch {
      setStatusMsg("Error contacting server.");
      setIsPreloading(false);
    }
  }

  // Apply a spin result to all engagement state. Used by both onWheelStop
  // and the Mystery Vault reveal path so the side effects stay identical.
  function applySpinResult(r: {
    remaining: number;
    message: string;
    isJackpot: boolean;
    prizeIndex: number;
    emoji: string;
    prize: string;
    change: number;
  }) {
    setPoints(r.remaining);
    setWinState({ message: r.message, isJackpot: r.isJackpot });
    setSessionStreak((s) => (r.change > 0 ? s + 1 : 0));

    if (r.isJackpot) {
      setConfettiActive(true);
      playJackpot();
      setTimeout(() => setConfettiActive(false), 5000);
    } else if (r.change > 0) {
      playWin();
    } else {
      playNoPrize();
    }

    const id = credentialsRef.current.id;
    if (id) {
      const next = pushHistory(id, {
        emoji: r.emoji,
        prize: r.prize,
        change: r.change,
        isJackpot: r.isJackpot,
      });
      setHistory(next);
    }

    refreshShopBalance();
    setTimeout(() => setWinState(null), 3500);
  }

  async function handleVaultPick(boxIndex: number) {
    if (vaultPicked !== null || vaultPicking) return;
    if (spinCost == null) return;

    setVaultPicked(boxIndex);
    setVaultPicking(true);
    playChestPick();
    playSpinStart();

    try {
      const data = await handleCardGame(
        credentialsRef.current.id,
        credentialsRef.current.password,
      );

      if (!data.success) {
        setStatusMsg(data.message ?? "Spin failed.");
        setShowVault(false);
        setVaultPicked(null);
        setVaultPicking(false);
        return;
      }

      const prizeIndex = prizes.findIndex((p) => p.Emoji === data.emoji);
      const safePrizeIndex = prizeIndex === -1 ? 0 : prizeIndex;

      const result = {
        remaining: data.remaining ?? points - spinCost,
        message:
          (data.change ?? 0) > 0
            ? `You won ${data.prize} (+${data.change} points!)`
            : "Thank you for playing!",
        isJackpot: !!data.hitJackpot,
        prizeIndex: safePrizeIndex,
        emoji: data.emoji ?? "",
        prize: data.prize ?? "",
        change: data.change ?? 0,
      };

      // Reveal in the picked chest
      setVaultRevealed(result);
      setSpinCount((c) => c + 1);
      setWinningIndex(safePrizeIndex);
      setPoints((p) => Math.max(0, p - spinCost));

      // Sound design — chest creak first, then prize fanfare or no-prize tone.
      playChestOpen();
      const burstDelay = result.isJackpot ? 700 : 480;
      setTimeout(() => {
        if (result.change > 0) {
          if (result.isJackpot) playJackpot();
          else playPrizeBurst();
          setConfettiActive(true);
          setTimeout(() => setConfettiActive(false), 4500);
        } else {
          playNoPrize();
        }
      }, burstDelay);

      // After the reveal animation settles, apply full result + close vault.
      setTimeout(() => {
        applySpinResult(result);
        setShowVault(false);
        setVaultPicked(null);
        setVaultPicking(false);
        setVaultRevealed(null);
      }, 3600);
    } catch {
      setStatusMsg("Error contacting server.");
      setShowVault(false);
      setVaultPicked(null);
      setVaultPicking(false);
    }
  }

  function handleVaultClose() {
    if (vaultPicking || vaultRevealed) return;
    setShowVault(false);
    setVaultPicked(null);
  }

  function onWheelStop() {
    const r = pendingResultRef.current;
    if (!r) {
      setIsSpinning(false);
      return;
    }
    setIsSpinning(false);
    setStatusMsg("");
    setWinningIndex(r.prizeIndex);
    applySpinResult(r);
    pendingResultRef.current = null;
  }

  function tickHaptic() {
    playTick();
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate?.(8);
    }
  }

  function handleClearHistory() {
    const id = credentialsRef.current.id;
    if (!id) return;
    clearHistory(id);
    setHistory([]);
  }

  async function handleRedeem(reward: Reward) {
    const id = credentialsRef.current.id;
    if (!id) return;
    const stock = Number(reward.Stock ?? 0);
    if (stock <= 0) return;
    if (points < reward.PointCost) return;

    setPendingRedeem(null);
    setRedeemingItem(reward.ItemName);
    try {
      const res = await redeemReward(id, reward.ItemName, reward.PointCost);
      if (!res.success) {
        setRedeemToast(res.message ?? "Redemption failed.");
        setTimeout(() => setRedeemToast(null), 3500);
        return;
      }
      // Update points (canonical from Shop response, fallback to local subtract)
      setPoints(
        typeof res.points === "number"
          ? Number(res.points)
          : points - reward.PointCost,
      );
      // Decrement stock locally so UI reflects immediately
      setRewards((prev) =>
        prev.map((r) =>
          r.ItemName === reward.ItemName
            ? { ...r, Stock: Math.max(0, Number(r.Stock ?? 0) - 1) }
            : r,
        ),
      );
      // Append to history (server is canonical, but optimistic update is fine)
      if (Array.isArray(res.history)) {
        setShopHistory(res.history);
      } else {
        const stamp = new Date().toLocaleString();
        setShopHistory((h) => [
          `${reward.ItemName} - ${stamp} - -${reward.PointCost}pts`,
          ...h,
        ]);
      }
      // Celebrate
      setConfettiActive(true);
      playWin();
      setTimeout(() => setConfettiActive(false), 4000);
      setRedeemToast(`Redeemed ${reward.ItemName}!`);
      setTimeout(() => setRedeemToast(null), 3500);
      if (res.code && res.code !== "No Code Available") setGiftCode(res.code);
      // Refresh in background to stay perfectly in sync
      refreshShopBalance();
    } catch {
      setRedeemToast("Error contacting server.");
      setTimeout(() => setRedeemToast(null), 3500);
    } finally {
      setRedeemingItem(null);
    }
  }

  function handleLogout() {
    setLoggedIn(false);
    setStudentId("");
    setPassword("");
    setStudentName("");
    setPoints(0);
    setHistory([]);
    setShopHistory([]);
    setMode("spin");
    credentialsRef.current = { id: "", password: "" };
    clearSession();
  }

  // ----- Render -----

  if (!loggedIn) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4 py-8">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="glass-strong w-full max-w-md rounded-3xl p-8 text-center shadow-[0_12px_40px_rgba(0,0,0,0.3)] sm:p-10"
        >
          <motion.div
            initial={{ scale: 0.5, rotate: -30 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ delay: 0.2, type: "spring", stiffness: 150 }}
            className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full"
            style={{
              background: "linear-gradient(135deg, #FFD85C, #13C2C2)",
              boxShadow: "0 0 30px rgba(255, 216, 92, 0.5)",
            }}
          >
            <Trophy className="h-10 w-10 text-[#0B0520]" />
          </motion.div>

          <h1 className="text-3xl font-extrabold tracking-wider text-gradient-gold">
            LUCKY SPIN × VAULT
          </h1>
          <p className="mt-1 text-sm text-white/70">
            Sign in to play and redeem
          </p>

          <form onSubmit={handleLogin} className="mt-7 flex flex-col gap-3">
            <input
              type="text"
              autoComplete="username"
              value={studentId}
              onChange={(e) => setStudentId(e.target.value)}
              placeholder="Student ID"
              className="w-full rounded-xl border border-white/15 bg-black/25 px-4 py-3 text-base text-white outline-none transition placeholder:text-white/50 focus:border-[#13C2C2] focus:ring-2 focus:ring-[#13C2C2]/30"
              data-testid="login-id-input"
            />
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="w-full rounded-xl border border-white/15 bg-black/25 px-4 py-3 text-base text-white outline-none transition placeholder:text-white/50 focus:border-[#13C2C2] focus:ring-2 focus:ring-[#13C2C2]/30"
              data-testid="login-password-input"
            />
            <motion.button
              type="submit"
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              disabled={loginLoading}
              className="mt-2 flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-base font-semibold text-white shadow-[0_6px_20px_rgba(19,194,194,0.4)] transition disabled:opacity-60"
              style={{
                background: "linear-gradient(135deg, #13C2C2, #0D9488)",
              }}
              data-testid="login-submit-btn"
            >
              {loginLoading ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <LogIn className="h-5 w-5" />
              )}
              {loginLoading ? "Signing in..." : "Enter Game"}
            </motion.button>
          </form>

          {loginError && (
            <p className="mt-4 rounded-lg bg-red-500/20 px-4 py-2 text-sm text-red-200">
              {loginError}
            </p>
          )}
        </motion.div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col items-center gap-4 px-3 py-4 sm:px-5 sm:py-6">
      {/* Sticky floating header with live glowing ring */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass-strong sticky top-2 z-40 flex w-full flex-col items-stretch gap-2 overflow-hidden rounded-2xl p-3 shadow-[0_12px_40px_rgba(0,0,0,0.4)] sm:flex-row sm:items-center sm:justify-between sm:p-4"
        data-testid="top-bar"
      >
        {/* animated glow ring */}
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[2px]"
          style={{
            background:
              "linear-gradient(90deg, transparent, #FFD85C, #13C2C2, #FF4081, #FFD85C, transparent)",
            backgroundSize: "200% 100%",
          }}
          animate={{ backgroundPositionX: ["0%", "200%"] }}
          transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
        />
        <motion.div
          aria-hidden
          className="pointer-events-none absolute -inset-1 rounded-2xl"
          style={{
            background:
              "radial-gradient(circle at 20% 50%, rgba(255,216,92,0.18), transparent 60%), radial-gradient(circle at 80% 50%, rgba(19,194,194,0.18), transparent 60%)",
          }}
          animate={{ opacity: [0.55, 0.95, 0.55] }}
          transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
        />
        <div className="grid grid-cols-3 gap-2 text-center sm:flex sm:flex-wrap sm:items-center sm:gap-3 sm:text-left">
          <div className="flex flex-col items-center gap-0.5 rounded-xl border border-white/10 bg-black/30 px-2 py-2 sm:flex-row sm:items-center sm:gap-2 sm:px-4 sm:py-2">
            <User className="h-4 w-4 text-[#FFD85C]" />
            <span className="truncate max-w-[80px] text-xs sm:text-sm font-semibold text-white/90 sm:max-w-none">
              {studentName || "Player"}
            </span>
          </div>
          <div
            className="flex flex-col items-center gap-0.5 rounded-xl border border-white/10 bg-black/30 px-2 py-2 sm:flex-row sm:items-center sm:gap-2 sm:px-4 sm:py-2"
            data-testid="points-balance"
          >
            <Trophy className="h-4 w-4 text-[#FFD85C]" />
            <span className="text-xs font-semibold sm:text-sm">
              <span className="text-white/60">Pts </span>
              <span className="font-bold text-[#FFD85C]">
                <AnimatedNumber value={points} />
              </span>
            </span>
          </div>
          <motion.div
            className="relative flex flex-col items-center gap-0.5 overflow-hidden rounded-xl border border-[#FFD85C]/40 bg-black/30 px-2 py-2 sm:flex-row sm:items-center sm:gap-2 sm:px-4 sm:py-2"
            animate={{
              boxShadow: [
                "0 0 0 rgba(255,216,92,0.0)",
                "0 0 18px rgba(255,216,92,0.55)",
                "0 0 0 rgba(255,216,92,0.0)",
              ],
            }}
            transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
            data-testid="jackpot-pill"
          >
            <motion.span
              aria-hidden
              className="absolute inset-0 -translate-x-full"
              style={{
                background:
                  "linear-gradient(90deg, transparent, rgba(255,216,92,0.25), transparent)",
              }}
              animate={{ x: ["-100%", "200%"] }}
              transition={{ duration: 2.4, repeat: Infinity, ease: "linear" }}
            />
            <Coins className="relative h-4 w-4 text-[#FFD85C]" />
            <span className="relative text-xs font-semibold sm:text-sm">
              <span className="text-white/60">Jackpot </span>
              <span className="font-bold text-[#FFD85C]">350</span>
            </span>
          </motion.div>
        </div>
        <div className="flex items-center justify-center gap-2 self-center">
          <button
            onClick={toggleMute}
            className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-xs font-semibold text-white/80 transition hover:bg-white/10"
            aria-label={muted ? "Unmute" : "Mute"}
          >
            {muted ? (
              <VolumeX className="h-4 w-4" />
            ) : (
              <Volume2 className="h-4 w-4 text-[#13C2C2]" />
            )}
            <span className="hidden sm:inline">{muted ? "Muted" : "Sound"}</span>
          </button>
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-xs font-semibold text-white/80 transition hover:bg-[#FF4081]/15 hover:text-[#FF4081]"
            data-testid="logout-btn"
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline">Logout</span>
          </button>
        </div>
      </motion.div>

      {/* Mode Switcher */}
      <div
        className="glass relative flex items-center gap-1 rounded-full p-1.5"
        data-testid="mode-switcher"
      >
        {(
          [
            { id: "spin", label: "Spin", Icon: Sparkles },
            { id: "vault", label: "Vault", Icon: Gift },
          ] as { id: Mode; label: string; Icon: typeof Sparkles }[]
        ).map(({ id, label, Icon }) => {
          const active = mode === id;
          return (
            <button
              key={id}
              onClick={() => setMode(id)}
              className={`relative z-10 flex items-center gap-2 rounded-full px-5 py-2 text-sm font-bold transition ${
                active ? "text-[#0B0520]" : "text-white/70 hover:text-white"
              }`}
              data-testid={`mode-${id}`}
            >
              {active && (
                <motion.span
                  layoutId="mode-pill"
                  transition={{ type: "spring", stiffness: 320, damping: 30 }}
                  className="absolute inset-0 rounded-full"
                  style={{
                    background: "linear-gradient(135deg, #FFD85C, #13C2C2)",
                    boxShadow: "0 6px 20px rgba(255,216,92,0.45)",
                  }}
                />
              )}
              <Icon className="relative z-10 h-4 w-4" />
              <span className="relative z-10">{label}</span>
              {id === "vault" && rewards.length > 0 && (
                <span
                  className={`relative z-10 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                    active
                      ? "bg-[#0B0520]/20 text-[#0B0520]"
                      : "bg-[#FF4081]/20 text-[#FF4081]"
                  }`}
                >
                  {rewards.length}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {shopWarning && (
        <div className="rounded-lg border border-yellow-400/30 bg-yellow-400/10 px-4 py-2 text-xs text-yellow-200">
          {shopWarning}
        </div>
      )}

      {/* Stage: side-by-side on desktop, single column with peek panel on mobile */}
      <div className="flex w-full flex-col items-stretch gap-5 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <AnimatePresence mode="wait">
            {mode === "spin" ? (
              <SpinPanel
                key="spin"
                prizes={prizes}
                rotation={rotation}
                isSpinning={isSpinning}
                isPreloading={isPreloading}
                spinCost={spinCost}
                statusMsg={statusMsg}
                history={history}
                shopHistory={shopHistory}
                prizeImages={prizeImages}
                winningIndex={winningIndex}
                streak={sessionStreak}
                isMysterySpin={isMysterySpin}
                isIdle={isIdle}
                onSpin={handleSpin}
                onWheelStop={onWheelStop}
                onTick={tickHaptic}
                onClearHistory={handleClearHistory}
              />
            ) : (
              <RewardVault
                key="vault"
                rewards={rewards}
                history={shopHistory}
                points={points}
                loadingRewards={loadingRewards}
                redeemingItem={redeemingItem}
                giftCode={giftCode}
                onRedeem={(r) => setPendingRedeem(r)}
                onCloseGiftCode={() => setGiftCode(null)}
              />
            )}
          </AnimatePresence>
        </div>

        {/* Cross-promotion peek panel — shows the OTHER mode */}
        <div className="lg:sticky lg:top-4 lg:w-72 lg:shrink-0">
          <PeekPanel
            mode={mode}
            rewards={rewards}
            points={points}
            onSwitch={() => setMode(mode === "spin" ? "vault" : "spin")}
          />
        </div>
      </div>

      <Confetti active={confettiActive} />

      {/* Mystery Vault — pops up every 5 spins (+ random) */}
      <MysteryVault
        open={showVault}
        picking={vaultPicking}
        picked={vaultPicked}
        revealed={vaultRevealed}
        prizeImages={prizeImages}
        prizes={prizes}
        onPick={handleVaultPick}
        onClose={handleVaultClose}
      />

      {/* Redeem Confirmation Modal */}
      <AnimatePresence>
        {pendingRedeem && (
          <RedeemConfirmModal
            reward={pendingRedeem}
            currentPoints={points}
            busy={redeemingItem === pendingRedeem.ItemName}
            onCancel={() => setPendingRedeem(null)}
            onConfirm={() => handleRedeem(pendingRedeem)}
          />
        )}
      </AnimatePresence>

      {/* Win Toast (spin) */}
      <AnimatePresence>
        {winState && (
          <motion.div
            key="win-toast"
            initial={{ opacity: 0, y: -40, scale: 0.8 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            transition={{ type: "spring", stiffness: 220, damping: 18 }}
            className="fixed left-1/2 top-1/2 z-[200] flex max-w-[90%] -translate-x-1/2 -translate-y-1/2 items-center gap-3 rounded-2xl px-6 py-5 text-center text-base font-bold text-[#0B0520] shadow-[0_15px_40px_rgba(0,0,0,0.4)] sm:px-8 sm:py-6 sm:text-lg"
            style={{
              background:
                "linear-gradient(135deg, rgba(255,216,92,0.95), rgba(19,194,194,0.95))",
              border: "1px solid rgba(255,255,255,0.3)",
              backdropFilter: "blur(8px)",
            }}
          >
            <PartyPopper className="h-6 w-6 shrink-0 sm:h-7 sm:w-7" />
            {winState.message}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Redeem Toast (vault) */}
      <AnimatePresence>
        {redeemToast && (
          <motion.div
            key="redeem-toast"
            initial={{ opacity: 0, y: -30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="fixed right-4 top-4 z-[200] flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-bold text-white shadow-[0_10px_25px_rgba(0,0,0,0.3)]"
            style={{
              background: "linear-gradient(135deg, #FF4081, #D81B60)",
            }}
          >
            <Gift className="h-4 w-4" />
            {redeemToast}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Jackpot Modal */}
      <AnimatePresence>
        {winState?.isJackpot && (
          <motion.div
            key="jackpot"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[150] flex items-center justify-center bg-[rgba(11,5,32,0.85)] backdrop-blur-sm px-4"
          >
            <motion.div
              initial={{ scale: 0.5 }}
              animate={{ scale: [1, 1.05, 1] }}
              transition={{ duration: 1.4, repeat: Infinity }}
              className="rounded-3xl border-2 border-white/30 p-8 text-center shadow-[0_20px_50px_rgba(0,0,0,0.5)] sm:p-10"
              style={{
                background:
                  "linear-gradient(135deg, rgba(255,216,92,0.95), rgba(19,194,194,0.95))",
                backdropFilter: "blur(10px)",
              }}
            >
              <h2 className="text-4xl font-extrabold text-[#0B0520] drop-shadow-[0_2px_5px_rgba(255,255,255,0.5)] sm:text-5xl">
                JACKPOT!
              </h2>
              <p className="mt-4 text-xl font-bold text-[#FF4081] drop-shadow-[0_2px_5px_rgba(255,255,255,0.5)] sm:text-2xl">
                +20 BONUS POINTS!
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Agreement Modal */}
      <AnimatePresence>
        {showAgreement && (
          <motion.div
            key="agreement"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[300] flex items-center justify-center bg-black/75 px-4 backdrop-blur-md"
          >
            <motion.div
              initial={{ scale: 0.9, y: 30 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="glass-strong w-full max-w-xl rounded-2xl p-6 sm:p-8"
            >
              <h2 className="mb-3 text-xl font-bold text-gradient-gold sm:text-2xl">
                Game Participation Agreement
              </h2>
              <p className="text-sm text-white/80 sm:text-base">
                This game is part of our classroom activities to help you stay
                motivated and improve your English communication skills.
              </p>
              <ul className="mt-4 space-y-2 text-sm text-white/85 sm:text-base">
                {[
                  "Use your points responsibly and fairly.",
                  "Understand that prizes are randomly given.",
                  "Do not attempt to cheat or abuse the system.",
                  "Respect classroom rules and purpose of this game.",
                ].map((line) => (
                  <li key={line} className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[#13C2C2]" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-sm text-white/80 sm:text-base">
                By clicking "I Agree", you accept the terms and may begin
                playing.
              </p>
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => setShowAgreement(false)}
                className="mt-5 rounded-xl px-6 py-3 font-bold text-white shadow-[0_6px_20px_rgba(19,194,194,0.4)]"
                style={{
                  background: "linear-gradient(to right, #13C2C2, #0D9488)",
                }}
              >
                I Agree
              </motion.button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Restriction Overlay */}
      <AnimatePresence>
        {restrictionMsg && (
          <motion.div
            key="restriction"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[400] flex items-center justify-center bg-[rgba(11,5,32,0.85)] backdrop-blur-md px-4"
          >
            <motion.div
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              className="glass-strong relative w-full max-w-lg rounded-2xl p-6 text-center sm:p-8"
            >
              <button
                onClick={() => setRestrictionMsg("")}
                className="absolute right-3 top-3 rounded-full p-2 text-white/60 transition hover:bg-white/10 hover:text-white"
                aria-label="Dismiss"
              >
                <X className="h-5 w-5" />
              </button>
              <AlertTriangle className="mx-auto mb-3 h-12 w-12 text-[#FF4081]" />
              <p className="text-base font-medium text-white sm:text-lg">
                {restrictionMsg}
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
