/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        // Deep-space base
        void: "#05060f",
        abyss: "#0a0c1c",
        // Aurora accents
        aurora: {
          violet: "#8b5cf6",
          indigo: "#6366f1",
          cyan: "#22d3ee",
          teal: "#2dd4bf",
          magenta: "#f472b6",
        },
        ink: "#e7e9f5",
        dim: "#9aa2c0",
        faint: "#5d6484",
        // Legacy aliases (kept so nothing breaks)
        dcBg: "#05060f",
        dcCard: "rgba(255,255,255,0.04)",
        dcAccent: "#8b5cf6",
        dcText: "#e7e9f5",
        dcMuted: "#9aa2c0",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "Avenir", "Helvetica", "Arial", "sans-serif"],
        display: ["Space Grotesk", "Inter", "system-ui", "sans-serif"],
      },
      fontSize: {
        mega: ["clamp(2.75rem, 7vw, 5.5rem)", { lineHeight: "1.02", letterSpacing: "-0.03em" }],
        giant: ["clamp(2rem, 4.5vw, 3.25rem)", { lineHeight: "1.08", letterSpacing: "-0.02em" }],
      },
      boxShadow: {
        glass: "0 8px 40px rgba(3, 4, 12, 0.55), inset 0 1px 0 rgba(255,255,255,0.06)",
        glow: "0 0 40px rgba(139, 92, 246, 0.25)",
        "glow-cyan": "0 0 40px rgba(34, 211, 238, 0.18)",
      },
      keyframes: {
        "spin-slow": {
          from: { transform: "rotate(0deg)" },
          to: { transform: "rotate(360deg)" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "fade-up": {
          from: { opacity: "0", transform: "translateY(24px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        drift: {
          "0%, 100%": { transform: "translate(0, 0) scale(1)" },
          "33%": { transform: "translate(4%, -6%) scale(1.08)" },
          "66%": { transform: "translate(-5%, 4%) scale(0.95)" },
        },
        "drift-alt": {
          "0%, 100%": { transform: "translate(0, 0) scale(1)" },
          "40%": { transform: "translate(-6%, 5%) scale(1.1)" },
          "70%": { transform: "translate(5%, -4%) scale(0.92)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% center" },
          "100%": { backgroundPosition: "200% center" },
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.55" },
        },
        "eq-bounce": {
          "0%, 100%": { transform: "scaleY(0.35)" },
          "50%": { transform: "scaleY(1)" },
        },
      },
      animation: {
        "spin-slow": "spin-slow 1s linear infinite",
        "fade-in": "fade-in 0.4s ease-out",
        "fade-up": "fade-up 0.7s cubic-bezier(0.22, 1, 0.36, 1) both",
        drift: "drift 26s ease-in-out infinite",
        "drift-alt": "drift-alt 32s ease-in-out infinite",
        shimmer: "shimmer 3.2s linear infinite",
        "pulse-soft": "pulse-soft 2.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
