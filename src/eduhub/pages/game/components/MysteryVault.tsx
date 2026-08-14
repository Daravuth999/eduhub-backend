import { useEffect, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X, Loader2, Sparkles, Crown, ArrowUp, PartyPopper } from "lucide-react";
import type { Prize } from "../lib/api";

export interface VaultPrize {
  prize: string;
  emoji: string;
  change: number;
  isJackpot: boolean;
  prizeIndex: number;
  remaining: number;
  message: string;
}

interface MysteryVaultProps {
  open: boolean;
  picking: boolean; // backend call in flight
  picked: number | null; // 0/1/2
  revealed: VaultPrize | null;
  prizeImages: Record<string, string>;
  prizes: Prize[];
  onPick: (boxIndex: number) => void;
  onClose: () => void;
}

export function MysteryVault({
  open,
  picking,
  picked,
  revealed,
  prizeImages,
  prizes,
  onPick,
  onClose,
}: MysteryVaultProps) {
  // Shuffle box positions every time so muscle memory can't bias picks.
  const order = useMemo(() => {
    if (!open) return [0, 1, 2];
    const arr = [0, 1, 2];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ESC closes when allowed
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && picked === null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, picked, onClose]);

  const revealedImage = revealed
    ? prizeImages[
        prizes[revealed.prizeIndex]?.PrizeName.toLowerCase().trim() ?? ""
      ]
    : undefined;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="mystery-vault"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[280] flex flex-col items-center justify-center px-4"
          style={{
            background:
              "radial-gradient(circle at 50% 50%, rgba(60,30,120,0.85), rgba(11,5,32,0.97))",
            backdropFilter: "blur(14px)",
          }}
          data-testid="mystery-vault"
        >
          {/* Background sparkles */}
          <BackgroundSparkles />

          {/* Skip button */}
          {picked === null && (
            <button
              onClick={onClose}
              className="absolute right-4 top-4 z-10 flex items-center gap-1.5 rounded-full border border-white/15 bg-black/40 px-3 py-1.5 text-xs font-semibold text-white/70 transition hover:bg-white/10 hover:text-white"
              data-testid="mystery-vault-skip"
            >
              <X className="h-3.5 w-3.5" />
              Skip
            </button>
          )}

          {/* Title */}
          <motion.div
            initial={{ y: -40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.15, type: "spring", stiffness: 220 }}
            className="mb-3 text-center"
          >
            <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-2xl shadow-[0_10px_30px_rgba(255,216,92,0.55)]"
              style={{ background: "linear-gradient(135deg, #FFD85C, #FF4081)" }}
            >
              <Crown className="h-7 w-7 text-[#0B0520]" />
            </div>
            <h2 className="text-2xl font-extrabold tracking-[3px] text-gradient-gold drop-shadow-[0_0_20px_rgba(255,216,92,0.5)] sm:text-3xl">
              MYSTERY VAULT
            </h2>
            <p className="mt-1 text-xs text-white/70 sm:text-sm">
              {revealed
                ? "Your prize has been chosen by fate."
                : picked !== null
                ? "Unlocking your destiny..."
                : "Pick a treasure chest — only one reveals its prize."}
            </p>
          </motion.div>

          {/* 3 chests */}
          <div className="flex flex-wrap items-end justify-center gap-4 sm:gap-8">
            {order.map((idx, slot) => {
              const isPicked = picked === idx;
              const isFading = picked !== null && picked !== idx;
              const isOpening = isPicked && revealed !== null;
              const showInside = isOpening;
              return (
                <ChestCard
                  key={idx}
                  slot={slot}
                  disabled={picked !== null || picking}
                  picked={isPicked}
                  fading={isFading}
                  opening={isOpening}
                  loading={isPicked && picking && !revealed}
                  reveal={
                    showInside && revealed
                      ? {
                          name: revealed.prize || prizes[revealed.prizeIndex]?.PrizeName || "Mystery",
                          emoji: revealed.emoji || prizes[revealed.prizeIndex]?.Emoji || "🎁",
                          image: revealedImage,
                          change: revealed.change,
                          isJackpot: revealed.isJackpot,
                        }
                      : null
                  }
                  onPick={() => onPick(idx)}
                />
              );
            })}
          </div>

          {/* "Sealed forever" caption when reveal complete */}
          {revealed && (
            <motion.p
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.6 }}
              className="mt-6 text-center text-xs italic text-white/50"
            >
              The other chests remain sealed forever…
            </motion.p>
          )}

          {/* IMMERSIVE BURST OVERLAY — prize text flies out of the box and
              grows huge in the middle of the screen. This is the eye-catcher. */}
          <AnimatePresence>
            {revealed && (
              <BurstOverlay
                key="burst"
                prizeName={
                  revealed.prize ||
                  prizes[revealed.prizeIndex]?.PrizeName ||
                  "Mystery"
                }
                emoji={
                  revealed.emoji ||
                  prizes[revealed.prizeIndex]?.Emoji ||
                  "🎁"
                }
                image={revealedImage}
                change={revealed.change}
                isJackpot={revealed.isJackpot}
              />
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// Burst overlay: prize text scales up dramatically into the middle of the
// screen on top of the chest. Win = gold gradient + party icon. No-prize =
// silver "Better Luck Next Time!" — still polished, no shame.
function BurstOverlay({
  prizeName,
  emoji,
  image,
  change,
  isJackpot,
}: {
  prizeName: string;
  emoji: string;
  image?: string;
  change: number;
  isJackpot: boolean;
}) {
  const won = change > 0;
  const ringDots = useMemo(
    () => Array.from({ length: 18 }, (_, i) => i),
    [],
  );

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="pointer-events-none absolute inset-0 z-[20] flex items-center justify-center"
    >
      {/* Radiating burst rays — only on a win */}
      {won && (
        <motion.div
          aria-hidden
          initial={{ opacity: 0, scale: 0.5, rotate: 0 }}
          animate={{ opacity: [0, 0.55, 0.35], scale: [0.5, 1.4, 1.15], rotate: 360 }}
          transition={{ duration: 6, ease: "linear", repeat: Infinity }}
          className="absolute h-[480px] w-[480px] sm:h-[640px] sm:w-[640px]"
          style={{
            background:
              "conic-gradient(from 0deg, rgba(255,216,92,0.0) 0deg, rgba(255,216,92,0.55) 12deg, rgba(255,216,92,0.0) 24deg, rgba(255,64,129,0.0) 36deg, rgba(255,64,129,0.45) 48deg, rgba(255,64,129,0.0) 60deg, rgba(19,194,194,0.0) 72deg, rgba(19,194,194,0.4) 84deg, rgba(19,194,194,0.0) 96deg)",
            filter: "blur(2px)",
            maskImage:
              "radial-gradient(circle, black 30%, transparent 75%)",
            WebkitMaskImage:
              "radial-gradient(circle, black 30%, transparent 75%)",
          }}
        />
      )}

      {/* Particle ring — shoots outward when burst appears */}
      {won && (
        <div className="absolute h-1 w-1">
          {ringDots.map((i) => {
            const angle = (i / ringDots.length) * 360;
            const distance = 180 + (i % 2) * 40;
            const rad = (angle * Math.PI) / 180;
            const dx = Math.cos(rad) * distance;
            const dy = Math.sin(rad) * distance;
            return (
              <motion.span
                key={i}
                initial={{ x: 0, y: 0, opacity: 0, scale: 0.5 }}
                animate={{
                  x: dx,
                  y: dy,
                  opacity: [0, 1, 0],
                  scale: [0.5, 1.2, 0.8],
                }}
                transition={{
                  duration: 1.6,
                  delay: 0.1 + (i % 3) * 0.05,
                  ease: "easeOut",
                }}
                className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{
                  background:
                    i % 3 === 0 ? "#FFD85C" : i % 3 === 1 ? "#FF4081" : "#13C2C2",
                  boxShadow: `0 0 10px ${i % 3 === 0 ? "#FFD85C" : i % 3 === 1 ? "#FF4081" : "#13C2C2"}`,
                }}
              />
            );
          })}
        </div>
      )}

      {/* CENTER MESSAGE — zooms from box into the middle of the interface */}
      <motion.div
        initial={{ scale: 0.18, y: 60, opacity: 0, rotate: -8 }}
        animate={{
          scale: [0.18, 1.35, 1, 1.05, 1],
          y: [60, -10, 0, 0, 0],
          opacity: [0, 1, 1, 1, 1],
          rotate: [-8, 4, 0, 0, 0],
        }}
        transition={{
          duration: 1.1,
          times: [0, 0.45, 0.7, 0.85, 1],
          ease: [0.2, 0.8, 0.3, 1.05],
        }}
        className="relative flex flex-col items-center gap-3 text-center"
      >
        {won ? (
          <>
            {/* Headline label */}
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5 }}
              className="flex items-center gap-2 rounded-full border border-[#FFD85C]/50 bg-black/40 px-3 py-1 text-[10px] font-bold uppercase tracking-[3px] text-[#FFD85C] backdrop-blur sm:text-xs"
            >
              {isJackpot ? (
                <>
                  <Crown className="h-3.5 w-3.5" />
                  JACKPOT WIN
                </>
              ) : (
                <>
                  <PartyPopper className="h-3.5 w-3.5" />
                  YOU WON
                </>
              )}
            </motion.div>

            {/* MASSIVE prize text */}
            <motion.div
              animate={{
                textShadow: [
                  "0 0 20px rgba(255,216,92,0.6), 0 0 40px rgba(255,64,129,0.4)",
                  "0 0 36px rgba(255,216,92,0.95), 0 0 70px rgba(255,64,129,0.65)",
                  "0 0 20px rgba(255,216,92,0.6), 0 0 40px rgba(255,64,129,0.4)",
                ],
              }}
              transition={{ duration: 1.6, repeat: Infinity }}
              className="text-5xl font-extrabold leading-none tracking-tight text-gradient-gold drop-shadow-[0_4px_18px_rgba(0,0,0,0.6)] sm:text-7xl"
              style={{ WebkitTextStroke: "1px rgba(255,255,255,0.15)" }}
            >
              +{change} PTS
            </motion.div>

            {/* Prize image + name */}
            <motion.div
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.6, type: "spring", stiffness: 200 }}
              className="flex items-center gap-3"
            >
              {image ? (
                <img
                  src={image}
                  alt=""
                  className="h-12 w-12 rounded-full object-cover ring-4 ring-[#FFD85C]"
                  style={{
                    boxShadow:
                      "0 0 25px rgba(255,216,92,0.8), 0 0 50px rgba(255,64,129,0.4)",
                  }}
                />
              ) : (
                <span className="text-4xl drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]">
                  {emoji}
                </span>
              )}
              <span className="text-xl font-extrabold tracking-wide text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.7)] sm:text-2xl">
                {prizeName}
              </span>
            </motion.div>

            {isJackpot && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.85 }}
                className="rounded-full bg-[#FF4081] px-4 py-1 text-sm font-extrabold text-white shadow-[0_6px_20px_rgba(255,64,129,0.6)]"
              >
                +20 BONUS POINTS!
              </motion.div>
            )}
          </>
        ) : (
          <>
            {/* No-prize: still polished, encouraging */}
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.45 }}
              className="rounded-full border border-white/20 bg-black/40 px-3 py-1 text-[10px] font-bold uppercase tracking-[3px] text-white/70 backdrop-blur sm:text-xs"
            >
              NO PRIZE THIS TIME
            </motion.div>

            <motion.div
              animate={{
                textShadow: [
                  "0 0 18px rgba(255,255,255,0.25)",
                  "0 0 28px rgba(255,255,255,0.45)",
                  "0 0 18px rgba(255,255,255,0.25)",
                ],
              }}
              transition={{ duration: 2.2, repeat: Infinity }}
              className="bg-gradient-to-br from-white via-white/80 to-white/50 bg-clip-text text-4xl font-extrabold leading-none tracking-tight text-transparent drop-shadow-[0_4px_18px_rgba(0,0,0,0.6)] sm:text-6xl"
            >
              BETTER LUCK
            </motion.div>
            <div className="text-base font-bold text-white/80 sm:text-xl">
              Try again — fortune favors the brave.
            </div>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}

function BackgroundSparkles() {
  const dots = useMemo(
    () =>
      Array.from({ length: 30 }, () => ({
        left: Math.random() * 100,
        top: Math.random() * 100,
        delay: Math.random() * 3,
        size: 1 + Math.random() * 2,
      })),
    [],
  );
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {dots.map((d, i) => (
        <motion.span
          key={i}
          className="absolute rounded-full bg-[#FFD85C]"
          style={{
            left: `${d.left}%`,
            top: `${d.top}%`,
            width: `${d.size}px`,
            height: `${d.size}px`,
            boxShadow: "0 0 8px #FFD85C",
          }}
          animate={{ opacity: [0, 1, 0], scale: [0.6, 1.2, 0.6] }}
          transition={{
            duration: 3 + Math.random() * 2,
            repeat: Infinity,
            delay: d.delay,
          }}
        />
      ))}
    </div>
  );
}

interface RevealData {
  name: string;
  emoji: string;
  image?: string;
  change: number;
  isJackpot: boolean;
}

function ChestCard({
  slot,
  disabled,
  picked,
  fading,
  opening,
  loading,
  reveal,
  onPick,
}: {
  slot: number;
  disabled: boolean;
  picked: boolean;
  fading: boolean;
  opening: boolean;
  loading: boolean;
  reveal: RevealData | null;
  onPick: () => void;
}) {
  // Idle state: bob + sway with slot-dependent phase so they feel alive.
  const phase = slot * 0.4;

  const variantAnimate = fading
    ? { opacity: 0.15, y: 20, scale: 0.85, rotateY: 0 }
    : opening
    ? { y: -28, scale: 1.18, rotateY: 0 }
    : picked
    ? { y: -16, scale: 1.08, rotateY: 0 }
    : {
        y: [0, -12, 0, -6, 0],
        rotateY: [-6, 6, -6, 4, -6],
        scale: 1,
      };

  return (
    <motion.button
      type="button"
      onClick={onPick}
      disabled={disabled}
      initial={{ opacity: 0, y: 60, scale: 0.7 }}
      animate={{ opacity: 1, ...variantAnimate }}
      transition={
        fading
          ? { duration: 0.5, ease: "easeOut" }
          : opening || picked
          ? { type: "spring", stiffness: 220, damping: 18 }
          : {
              y: { duration: 4, repeat: Infinity, ease: "easeInOut", delay: phase },
              rotateY: { duration: 5, repeat: Infinity, ease: "easeInOut", delay: phase },
            }
      }
      whileHover={
        disabled
          ? undefined
          : { scale: 1.07, y: -8, transition: { duration: 0.18 } }
      }
      whileTap={disabled ? undefined : { scale: 0.96 }}
      style={{
        perspective: "800px",
        transformStyle: "preserve-3d",
      }}
      className="relative h-44 w-32 cursor-pointer rounded-xl outline-none disabled:cursor-default sm:h-52 sm:w-40"
      data-testid={`mystery-chest-${slot}`}
    >
      {/* Pulsing halo behind chest */}
      <motion.div
        className="absolute -inset-3 rounded-2xl blur-2xl"
        style={{
          background:
            "radial-gradient(circle, rgba(255,216,92,0.55) 0%, rgba(255,64,129,0.3) 50%, transparent 75%)",
        }}
        animate={{
          opacity: opening ? [0.6, 1, 0.8] : [0.35, 0.7, 0.35],
          scale: opening ? [1, 1.4, 1.2] : [1, 1.08, 1],
        }}
        transition={{
          duration: opening ? 1.2 : 2.5,
          repeat: Infinity,
          delay: phase,
        }}
      />

      {/* Orbiting sparkles */}
      {!fading && (
        <>
          <Sparkle x={5} y={15} delay={phase} />
          <Sparkle x={88} y={20} delay={phase + 0.5} />
          <Sparkle x={70} y={85} delay={phase + 1} />
          <Sparkle x={10} y={75} delay={phase + 1.5} />
        </>
      )}

      {/* Chest body */}
      <div className="absolute inset-x-0 bottom-0 flex h-[72%] items-end justify-center">
        {/* Base */}
        <div
          className="relative h-full w-full rounded-b-md rounded-t-sm"
          style={{
            background:
              "linear-gradient(160deg, #6b3a14 0%, #4a2509 55%, #2c1505 100%)",
            boxShadow:
              "inset 0 -8px 14px rgba(0,0,0,0.6), inset 0 6px 10px rgba(255,170,80,0.2), 0 12px 24px rgba(0,0,0,0.5)",
            border: "2px solid #2c1505",
          }}
        >
          {/* Wood grain hint */}
          <div
            className="pointer-events-none absolute inset-1 rounded-sm opacity-40"
            style={{
              background:
                "repeating-linear-gradient(90deg, transparent 0 7px, rgba(0,0,0,0.18) 7px 8px)",
            }}
          />
          {/* Gold band horizontal */}
          <div
            className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2"
            style={{
              background:
                "linear-gradient(180deg, #FFE17A 0%, #FFD85C 35%, #B8860B 75%, #8B6508 100%)",
              boxShadow:
                "0 1px 3px rgba(0,0,0,0.5), 0 0 6px rgba(255,216,92,0.5)",
            }}
          />
          {/* Gold corner studs */}
          {[
            "left-1 top-1",
            "right-1 top-1",
            "left-1 bottom-1",
            "right-1 bottom-1",
          ].map((c) => (
            <div
              key={c}
              className={`absolute h-2 w-2 rounded-full ${c}`}
              style={{
                background:
                  "radial-gradient(circle at 30% 30%, #FFE17A, #B8860B 70%)",
                boxShadow: "0 0 4px rgba(255,216,92,0.7)",
              }}
            />
          ))}

          {/* Inside reveal — light beam + prize */}
          {reveal && (
            <motion.div
              initial={{ opacity: 0, y: 30, scale: 0.5 }}
              animate={{ opacity: 1, y: -42, scale: 1.1 }}
              transition={{
                delay: 0.35,
                type: "spring",
                stiffness: 180,
                damping: 14,
              }}
              className="absolute inset-x-0 top-0 z-10 flex flex-col items-center justify-center pointer-events-none"
            >
              {/* Light beam */}
              <motion.div
                className="absolute -top-20 h-32 w-20 -translate-y-2"
                initial={{ opacity: 0, scaleY: 0.2 }}
                animate={{ opacity: [0, 1, 0.7], scaleY: [0.2, 1, 1] }}
                transition={{ duration: 1, delay: 0.2 }}
                style={{
                  background:
                    "linear-gradient(180deg, transparent, rgba(255,216,92,0.85), rgba(255,255,255,0.95), rgba(255,216,92,0.85), transparent)",
                  filter: "blur(2px)",
                  transformOrigin: "bottom center",
                  clipPath: "polygon(20% 100%, 80% 100%, 100% 0%, 0% 0%)",
                }}
              />
              {/* Prize artwork */}
              <div
                className="relative flex h-16 w-16 items-center justify-center rounded-full ring-4 ring-[#FFD85C]/80"
                style={{
                  background:
                    "radial-gradient(circle at 30% 30%, #FFE17A, #FFD85C 60%, #FF4081)",
                  boxShadow:
                    "0 0 25px rgba(255,216,92,0.95), 0 0 50px rgba(255,64,129,0.5)",
                }}
              >
                {reveal.image ? (
                  <img
                    src={reveal.image}
                    alt=""
                    className="h-12 w-12 rounded-full object-cover"
                  />
                ) : (
                  <span className="text-3xl drop-shadow-lg">{reveal.emoji}</span>
                )}
                {reveal.isJackpot && (
                  <Crown className="absolute -right-1 -top-2 h-5 w-5 text-[#FFD85C] drop-shadow-[0_0_6px_rgba(255,216,92,1)]" />
                )}
              </div>
            </motion.div>
          )}
        </div>
      </div>

      {/* Chest LID — animates open */}
      <motion.div
        className="absolute inset-x-0 top-0 flex h-[36%] origin-bottom items-center justify-center"
        animate={
          opening
            ? { rotateX: -110, y: -2 }
            : loading
            ? { rotateX: [-2, 4, -2] }
            : { rotateX: 0 }
        }
        transition={
          opening
            ? { duration: 0.7, ease: [0.25, 1.6, 0.5, 1], delay: 0.15 }
            : loading
            ? { duration: 0.18, repeat: Infinity, ease: "easeInOut" }
            : { duration: 0.3 }
        }
        style={{
          transformStyle: "preserve-3d",
        }}
      >
        <div
          className="relative h-full w-full rounded-t-2xl"
          style={{
            background:
              "linear-gradient(180deg, #7a4419 0%, #5b2f0e 60%, #3a1d05 100%)",
            boxShadow:
              "inset 0 6px 14px rgba(255,170,80,0.3), inset 0 -3px 8px rgba(0,0,0,0.5), 0 6px 14px rgba(0,0,0,0.4)",
            border: "2px solid #2c1505",
            borderBottomWidth: "0",
          }}
        >
          {/* Top gold trim */}
          <div
            className="absolute inset-x-0 bottom-0 h-1.5"
            style={{
              background:
                "linear-gradient(180deg, #FFE17A 0%, #B8860B 100%)",
              boxShadow: "0 0 5px rgba(255,216,92,0.6)",
            }}
          />
          {/* Lock plate (centered, on the front of the lid where it meets base) */}
          <div className="absolute -bottom-3 left-1/2 -translate-x-1/2">
            <div
              className="flex h-7 w-6 items-center justify-center rounded-md border-2"
              style={{
                background:
                  "linear-gradient(180deg, #FFE17A 0%, #FFD85C 50%, #8B6508 100%)",
                borderColor: "#5C4203",
                boxShadow:
                  "0 2px 5px rgba(0,0,0,0.5), 0 0 6px rgba(255,216,92,0.55)",
              }}
            >
              <div className="h-2 w-2 rounded-full bg-[#0B0520]" />
            </div>
          </div>
          {/* Question mark on closed lid */}
          {!opening && !reveal && (
            <motion.div
              animate={{ opacity: [0.55, 1, 0.55] }}
              transition={{ duration: 2, repeat: Infinity, delay: phase }}
              className="absolute inset-0 flex items-center justify-center"
            >
              <span
                className="text-2xl font-extrabold text-[#FFD85C] drop-shadow-[0_2px_4px_rgba(0,0,0,0.6)]"
                style={{ filter: "drop-shadow(0 0 8px rgba(255,216,92,0.6))" }}
              >
                ?
              </span>
            </motion.div>
          )}
        </div>
      </motion.div>

      {/* Tap hint when idle */}
      {!disabled && !picked && (
        <motion.div
          animate={{ y: [0, -4, 0], opacity: [0.7, 1, 0.7] }}
          transition={{ duration: 1.4, repeat: Infinity, delay: phase }}
          className="absolute -bottom-7 left-1/2 -translate-x-1/2 text-[10px] font-bold uppercase tracking-wider text-white/70"
        >
          <span className="flex items-center gap-1">
            <ArrowUp className="h-3 w-3" />
            tap
          </span>
        </motion.div>
      )}

      {/* Loading shimmer over picked chest */}
      {loading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-[#FFD85C] drop-shadow-[0_0_8px_rgba(255,216,92,0.9)]" />
        </div>
      )}

      {/* Prize name + change after reveal */}
      {reveal && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.95 }}
          className="absolute inset-x-0 -bottom-12 text-center"
        >
          <div className="text-xs font-extrabold text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.7)]">
            {reveal.name}
          </div>
          {reveal.change > 0 && (
            <div className="mt-0.5 inline-block rounded-full bg-[#13C2C2]/20 px-2 py-0.5 text-[10px] font-bold text-[#13C2C2]">
              +{reveal.change} pts
            </div>
          )}
        </motion.div>
      )}
    </motion.button>
  );
}

function Sparkle({ x, y, delay }: { x: number; y: number; delay: number }) {
  return (
    <motion.span
      className="pointer-events-none absolute h-1.5 w-1.5 rounded-full bg-[#FFE17A]"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        boxShadow: "0 0 6px #FFE17A",
      }}
      animate={{
        opacity: [0, 1, 0],
        scale: [0.6, 1.4, 0.6],
      }}
      transition={{
        duration: 2,
        repeat: Infinity,
        delay,
      }}
    />
  );
}
