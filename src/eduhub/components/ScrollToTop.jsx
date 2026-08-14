// ScrollToTop.jsx — floating scroll-to-top button shown above TelegramFab when scroll>300.
import { motion, AnimatePresence } from "framer-motion";
import { ArrowUp } from "lucide-react";
import { useScrollProgress } from "../hooks/useScrollProgress";

export default function ScrollToTop() {
  const progress = useScrollProgress();
  // useScrollProgress returns 0..1 ; we want raw scrollY > 300.
  const visible = typeof window !== "undefined" && window.scrollY > 300 && progress > 0.05;

  return (
    <AnimatePresence>
      {visible && (
        <motion.button
          key="scroll-top"
          initial={{ opacity: 0, scale: 0.6, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.6, y: 10 }}
          transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          aria-label="Scroll to top"
          data-testid="scroll-to-top-btn"
          className="fixed bottom-[148px] right-5 z-30 h-11 w-11 rounded-full border border-aurora-cyan/40 bg-black/60 backdrop-blur-md text-aurora-cyan hover:text-white hover:bg-aurora-violet/30 transition flex items-center justify-center shadow-[0_10px_30px_-8px_rgba(0,224,255,0.5)]"
        >
          <ArrowUp className="h-5 w-5" />
        </motion.button>
      )}
    </AnimatePresence>
  );
}
