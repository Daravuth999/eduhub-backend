import { type ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * Horizontal scroll-snap container.
 * Used for criterion cards on mobile, recent transfers, etc.
 */
export function ScrollShelf({
  children,
  className,
  ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      role="region"
      aria-label={ariaLabel}
      className={cn(
        "snap-shelf no-scrollbar flex gap-3 overflow-x-auto px-4 -mx-4 pb-2",
        className,
      )}
    >
      {children}
    </div>
  );
}
