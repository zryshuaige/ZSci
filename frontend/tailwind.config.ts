import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(240 6% 90%)",
        input: "hsl(240 6% 90%)",
        ring: "hsl(222 47% 50%)",
        background: "hsl(0 0% 100%)",
        foreground: "hsl(240 10% 12%)",
        muted: { DEFAULT: "hsl(240 5% 96%)", foreground: "hsl(240 4% 46%)" },
        primary: { DEFAULT: "hsl(222 47% 30%)", foreground: "hsl(0 0% 100%)" },
        accent: { DEFAULT: "hsl(217 91% 60%)", foreground: "hsl(0 0% 100%)" },
        destructive: { DEFAULT: "hsl(0 72% 51%)", foreground: "hsl(0 0% 100%)" },
        card: { DEFAULT: "hsl(0 0% 100%)", foreground: "hsl(240 10% 12%)" },
      },
      borderRadius: { lg: "0.5rem", md: "0.375rem", sm: "0.25rem" },
      /* Motion tokens — strong custom curves, never bare ease-in on UI.
         Source: apple-design / improve-animations STANDARDS. */
      transitionTimingFunction: {
        out: "cubic-bezier(0.23, 1, 0.32, 1)",
        "in-out": "cubic-bezier(0.77, 0, 0.175, 1)",
        drawer: "cubic-bezier(0.32, 0.72, 0, 1)",
      },
      transitionDuration: {
        press: "160ms",
        sm: "200ms",
        md: "250ms",
        lg: "300ms",
      },
      /* Z-index tokens — fixed semantic ladder so floating UI never collides.
         chrome = persistent app chrome (sidebar, header) →
         floating = hover tooltips, popovers (above chrome) →
         dropdown = menus attached to buttons (above floating) →
         modal = dialogs, drawer overlays (above dropdown) →
         toast = transient notifications (above modal). */
      zIndex: {
        chrome: "20",
        floating: "30",
        dropdown: "40",
        tooltip: "55",
        modal: "50",
        toast: "60",
      },
      /* Softer, layered shadows for depth without harshness. */
      boxShadow: {
        soft: "0 1px 2px rgba(0,0,0,0.04), 0 1px 3px rgba(0,0,0,0.05)",
        medium: "0 4px 12px rgba(0,0,0,0.08)",
        float: "0 8px 24px rgba(0,0,0,0.10)",
      },
      keyframes: {
        "zsci-fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "zsci-slide-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "zsci-pop": {
          from: { opacity: "0", transform: "scale(0.96)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        "zsci-caret": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
        "zsci-shimmer": {
          from: { transform: "translateX(-100%)" },
          to: { transform: "translateX(100%)" },
        },
      },
      animation: {
        "fade-in": "zsci-fade-in 250ms cubic-bezier(0.23,1,0.32,1) both",
        "slide-up": "zsci-slide-up 250ms cubic-bezier(0.23,1,0.32,1) both",
        pop: "zsci-pop 250ms cubic-bezier(0.23,1,0.32,1) both",
        caret: "zsci-caret 1s steps(1) infinite",
        shimmer: "zsci-shimmer 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
