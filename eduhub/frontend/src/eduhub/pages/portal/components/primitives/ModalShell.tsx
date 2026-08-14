import { AnimatePresence, motion } from "framer-motion";
import { X, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { useReducedMotion } from "../../hooks/useReducedMotion";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Title appears in the coloured header. */
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  /** Backdrop click + close button work; disable both for hard-gates. */
  dismissible?: boolean;
  /** Override the header background colour (defaults to accent). */
  headerColor?: string;
  /** Max width — Tailwind class like 'max-w-lg'. */
  maxWidth?: string;
  children: ReactNode;
  testId?: string;
}

export function ModalShell({
  open,
  onClose,
  title,
  subtitle,
  icon: Icon,
  dismissible = true,
  headerColor,
  maxWidth = "max-w-lg",
  children,
  testId,
}: Props) {
  const reduced = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (dismissible && e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, dismissible]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.2 }}
          onClick={dismissible ? onClose : undefined}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[color:var(--color-ink)]/60 backdrop-blur-sm"
          data-testid={testId}
        >
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.96 }}
            transition={
              reduced
                ? { duration: 0 }
                : { type: "spring", damping: 22, stiffness: 220 }
            }
            onClick={(e) => e.stopPropagation()}
            className={`relative w-full ${maxWidth} max-h-[90vh] flex flex-col overflow-hidden rounded-[24px] border border-[color:var(--color-line-strong)] bg-[color:var(--color-surface)] ink-shadow-lg`}
          >
            <div
              className="flex items-center gap-3 px-6 py-5 text-[color:var(--color-surface)]"
              style={{
                background: headerColor ?? "var(--color-accent)",
              }}
            >
              {Icon && (
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 backdrop-blur">
                  <Icon className="h-5 w-5" />
                </div>
              )}
              <div className="flex-1">
                <h3 className="display text-lg font-bold leading-tight">{title}</h3>
                {subtitle && (
                  <p className="text-sm opacity-85 mt-0.5">{subtitle}</p>
                )}
              </div>
              {dismissible && (
                <button
                  onClick={onClose}
                  aria-label="Close"
                  data-testid="modal-close-btn"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 hover:bg-white/25 transition"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <div className="overflow-y-auto">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
