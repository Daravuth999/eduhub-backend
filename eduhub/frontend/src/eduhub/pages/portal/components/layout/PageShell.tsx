import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

interface Props {
  children: ReactNode;
  className?: string;
}

/** Unified width + horizontal padding for all dashboard content. */
export function PageShell({ children, className }: Props) {
  return (
    <main
      className={cn(
        "relative z-10 max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8",
        "space-y-6 sm:space-y-7",
        className,
      )}
    >
      {children}
    </main>
  );
}
