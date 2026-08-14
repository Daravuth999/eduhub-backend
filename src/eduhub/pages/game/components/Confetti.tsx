import { useEffect, useState } from "react";

const COLORS = ["#FFD85C", "#FF4081", "#13C2C2", "#FFA502", "#5F27CD", "#1DD1A1"];

interface Piece {
  id: number;
  left: number;
  size: number;
  color: string;
  duration: number;
  delay: number;
}

export function Confetti({ active, count = 150 }: { active: boolean; count?: number }) {
  const [pieces, setPieces] = useState<Piece[]>([]);

  useEffect(() => {
    if (!active) {
      setPieces([]);
      return;
    }
    const next: Piece[] = Array.from({ length: count }, (_, i) => ({
      id: Date.now() + i,
      left: Math.random() * 100,
      size: Math.random() * 12 + 6,
      color: COLORS[i % COLORS.length],
      duration: Math.random() * 3 + 2,
      delay: Math.random() * 2,
    }));
    setPieces(next);

    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate?.([100, 50, 100, 50, 100]);
    }

    const t = setTimeout(() => setPieces([]), 7000);
    return () => clearTimeout(t);
  }, [active, count]);

  if (pieces.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-[999] overflow-hidden">
      {pieces.map((p) => (
        <span
          key={p.id}
          className="confetti-piece"
          style={{
            left: `${p.left}vw`,
            width: `${p.size}px`,
            height: `${p.size}px`,
            backgroundColor: p.color,
            animationDuration: `${p.duration}s`,
            animationDelay: `${p.delay}s`,
          }}
        />
      ))}
    </div>
  );
}
