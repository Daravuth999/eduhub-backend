import React from "react";
import { motion } from "framer-motion";
import { Sparkles } from "lucide-react";

export default function Hero({ title, khmerWelcome, subtitle, instructorName }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, ease: [0.25, 0.8, 0.25, 1] }}
      className="border-conic relative overflow-hidden rounded-[20px] p-4 sm:p-6 mb-3 sm:mb-4 shadow-[0_18px_50px_rgba(155,92,255,0.22),0_0_0_1px_rgba(255,255,255,0.04)]"
      style={{
        background:
          "radial-gradient(ellipse 80% 100% at 0% 0%, rgba(0, 224, 255, 0.22) 0%, transparent 55%), radial-gradient(ellipse 80% 100% at 100% 100%, rgba(255, 61, 166, 0.25) 0%, transparent 55%), linear-gradient(135deg, #1a0a3e 0%, #2a0a5e 50%, #0a1f4a 100%)",
      }}
      data-testid="hero"
    >
      <div className="absolute -right-16 -top-16 w-[280px] h-[280px] rounded-full bg-aurora-cyan/15 blur-2xl" />
      <div className="absolute right-20 -bottom-20 w-[200px] h-[200px] rounded-full bg-aurora-magenta/15 blur-2xl" />
      <div className="absolute -left-10 bottom-0 w-[160px] h-[160px] rounded-full bg-aurora-violet/20 blur-2xl" />

      <motion.div
        className="absolute left-0 right-0 bottom-0 h-[2px]"
        style={{ background: "linear-gradient(90deg, transparent, #00e0ff, #9b5cff, #ff3da6, #ffc94d, transparent)" }}
        initial={{ x: "-100%" }}
        animate={{ x: "100%" }}
        transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
      />

      <div className="relative">
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05, duration: 0.4 }}
          className="inline-flex items-center gap-1.5 text-[0.68rem] font-bold tracking-[0.14em] uppercase mb-2 px-2.5 py-1 rounded-full bg-white/[0.06] border border-white/[0.12] backdrop-blur-sm"
        >
          <Sparkles className="w-3 h-3 text-aurora-gold drop-shadow-[0_0_6px_rgba(255,201,77,0.8)]" />
          <span className="text-iridescent">Academic Learning Portal</span>
        </motion.div>

        <motion.h1
          className="font-display font-extrabold leading-[1.05] tracking-tight mb-1.5 text-[clamp(1.45rem,5.5vw,2.5rem)] text-iridescent"
          initial="hidden"
          animate="show"
          variants={{ hidden: {}, show: { transition: { staggerChildren: 0.022, delayChildren: 0.08 } } }}
          data-testid="hero-title"
        >
          {title.split("").map((c, i) => (
            <motion.span
              key={i}
              variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}
              transition={{ duration: 0.22, ease: [0.25, 0.8, 0.25, 1] }}
              className="inline-block whitespace-pre"
            >
              {c}
            </motion.span>
          ))}
        </motion.h1>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.4 }}
          className="font-khmer text-[clamp(1rem,3vw,1.45rem)] mb-3 bg-gradient-to-r from-aurora-cyan via-white to-aurora-magenta bg-clip-text text-transparent drop-shadow-[0_0_18px_rgba(0,224,255,0.25)]"
          data-testid="hero-khmer"
        >
          {khmerWelcome}
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.65, duration: 0.4 }}
          className="text-[0.85rem] text-white/70 flex flex-wrap items-center gap-x-1.5 gap-y-1"
        >
          <span className="inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-aurora-cyan shadow-[0_0_8px_rgba(0,224,255,1)]" />
            {subtitle}
          </span>
          <span className="text-white/30">·</span>
          <span>
            Instructor:{" "}
            <strong className="text-white font-semibold bg-gradient-to-r from-aurora-gold to-aurora-coral bg-clip-text text-transparent">
              {instructorName}
            </strong>
          </span>
        </motion.div>
      </div>
    </motion.section>
  );
}
