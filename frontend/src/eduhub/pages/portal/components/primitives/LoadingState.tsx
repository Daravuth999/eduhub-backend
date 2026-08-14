import { Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";

interface Props {
  label?: string;
  className?: string;
  variant?: "row" | "block";
}

export function LoadingState({ label, className, variant = "row" }: Props) {
  if (variant === "block") {
    return (
      <div
        className={cn(
          "flex h-full w-full items-center justify-center text-[color:var(--color-ink-soft)] py-8",
          className,
        )}
      >
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        <span className="text-sm">{label ?? "Loading…"}</span>
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex items-center gap-2 text-sm text-[color:var(--color-ink-soft)]",
        className,
      )}
    >
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

/**
 * Skeleton placeholders that mimic content shape — used for chart, comments.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "rounded-md bg-[color:var(--color-line)]/70 animate-pulse",
        className,
      )}
    />
  );
}
