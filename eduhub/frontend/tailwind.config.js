/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ["./src/**/*.{js,jsx,ts,tsx}", "./public/index.html"],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",

        /* Aurora Spectrum — vibrant neon palette */
        "aurora-cyan":    "#00e0ff",
        "aurora-magenta": "#ff3da6",
        "aurora-violet":  "#9b5cff",
        "aurora-lime":    "#a3ff3a",
        "aurora-coral":   "#ff7a3a",
        "aurora-gold":    "#ffc94d",

        /* Classroom Library — Dark Academia palette (preserved verbatim) */
        ink:       "#0D0A14",
        walnut:    "#1A1420",
        mahogany:  "#221830",
        shelf:     "#5C3D1E",
        gold:      "#D4A843",
        emerald:   "#2D6A4F",
        magenta:   "#C2185B",
        parchment: "#F0E6C8",
        faded:     "#8B7355",
        conic:     "#FFD700",
        teal:      "#00BFA5",
      },
      fontFamily: {
        sans:    ["Figtree", "'Plus Jakarta Sans'", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["Outfit", "Figtree", "sans-serif"],
        khmer:   ["'Kantumruy Pro'", "'Noto Sans Khmer'", "Figtree", "sans-serif"],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        pulseGlow: {
          "0%,100%": { boxShadow: "0 0 0 0 rgba(0, 224, 255, 0.45)" },
          "50%":     { boxShadow: "0 0 0 8px rgba(0, 224, 255, 0)" },
        },
        pulseDot: {
          "0%,100%": { opacity: 1, transform: "scale(1)" },
          "50%":     { opacity: 0.45, transform: "scale(0.85)" },
        },
        bounceSoft: {
          "0%,100%": { transform: "translateY(0)" },
          "50%":     { transform: "translateY(-5px)" },
        },
        blink: {
          "0%,100%": { opacity: 1 },
          "50%":     { opacity: 0 },
        },
        heartbeat: {
          "0%,100%": { transform: "scale(1)", filter: "drop-shadow(0 0 6px rgba(255, 61, 166, 0.6))" },
          "50%":     { transform: "scale(1.28)", filter: "drop-shadow(0 0 14px rgba(255, 61, 166, 1))" },
        },
        shimmer: {
          "0%":   { backgroundPosition: "200% 0" },
          "100%": { backgroundPosition: "-200% 0" },
        },
        orbFloat: {
          "0%":   { transform: "translate(0, 0) scale(1)" },
          "100%": { transform: "translate(30px, 20px) scale(1.08)" },
        },
        aurora: {
          "0%,100%": { backgroundPosition: "0% 50%", filter: "hue-rotate(0deg)" },
          "50%":     { backgroundPosition: "100% 50%", filter: "hue-rotate(25deg)" },
        },
        iridescent: {
          "0%":   { backgroundPosition: "0% 50%" },
          "100%": { backgroundPosition: "200% 50%" },
        },
        conicSpin: {
          to: { transform: "rotate(360deg)" },
        },
        glowPulse: {
          "0%,100%": { opacity: 0.55 },
          "50%":     { opacity: 1 },
        },
        "accordion-down": { from: { height: "0" }, to: { height: "var(--radix-accordion-content-height)" } },
        "accordion-up":   { from: { height: "var(--radix-accordion-content-height)" }, to: { height: "0" } },

        /* Classroom Library keyframes */
        bookDrift: {
          "0%, 100%": { transform: "translateY(0) rotate(var(--r,0deg))" },
          "50%":      { transform: "translateY(-30px) rotate(var(--r,0deg))" },
        },
        dustFloat: {
          "0%":   { transform: "translateY(0) translateX(0)", opacity: "0" },
          "20%":  { opacity: "0.9" },
          "100%": { transform: "translateY(-120vh) translateX(40px)", opacity: "0" },
        },
        newPulse: {
          "0%, 100%": { boxShadow: "0 0 0 0 rgba(255,215,0,0.7), 0 0 14px rgba(255,215,0,0.5)" },
          "50%":      { boxShadow: "0 0 0 8px rgba(255,215,0,0), 0 0 24px rgba(255,215,0,0.8)" },
        },
        librarySparkle: {
          "0%, 100%": { opacity: "0", transform: "scale(0.5)" },
          "50%":      { opacity: "1", transform: "scale(1)" },
        },
        orbit: {
          "0%":   { transform: "rotate(0deg) translateX(14px) rotate(0deg)" },
          "100%": { transform: "rotate(360deg) translateX(14px) rotate(-360deg)" },
        },
        libraryShimmer: {
          "0%":   { transform: "translateX(-120%)" },
          "100%": { transform: "translateX(220%)" },
        },
      },
      animation: {
        "pulse-glow":   "pulseGlow 2.5s ease-in-out infinite",
        "pulse-dot":    "pulseDot 1.6s ease-in-out infinite",
        "bounce-soft":  "bounceSoft 2.5s ease-in-out infinite",
        blink:          "blink 0.9s steps(2) infinite",
        heartbeat:      "heartbeat 1.6s ease-in-out infinite",
        shimmer:        "shimmer 1.5s linear infinite",
        "glow-pulse":   "glowPulse 3.5s ease-in-out infinite",
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up":   "accordion-up 0.2s ease-out",
        /* Classroom Library animations */
        bookDrift: "bookDrift 8s ease-in-out infinite",
        dustFloat: "dustFloat linear infinite",
        newPulse:  "newPulse 1.8s ease-in-out infinite",
        sparkle:   "librarySparkle 1.4s ease-in-out infinite",
        orbit:     "orbit 4s linear infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
