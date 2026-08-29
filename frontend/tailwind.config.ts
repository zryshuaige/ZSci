import type { Config } from "tailwindcss";

/* 「精密仪器」设计 token —— 颜色全部引用 index.css :root 中的 CSS 变量。
   铁律:变量值必须是裸 `H S% L%` 三元组(绝不能写 hex),否则所有
   `bg-primary/5`、`border-border/60` 透明度修饰符会静默失效。 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border) / <alpha-value>)",
        input: "hsl(var(--input) / <alpha-value>)",
        ring: "hsl(var(--ring) / <alpha-value>)",
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        muted: {
          DEFAULT: "hsl(var(--muted) / <alpha-value>)",
          foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
        },
        primary: {
          DEFAULT: "hsl(var(--primary) / <alpha-value>)",
          foreground: "hsl(var(--primary-foreground) / <alpha-value>)",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },
        card: {
          DEFAULT: "hsl(var(--card) / <alpha-value>)",
          foreground: "hsl(var(--card-foreground) / <alpha-value>)",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar) / <alpha-value>)",
          foreground: "hsl(var(--sidebar-foreground) / <alpha-value>)",
          muted: "hsl(var(--sidebar-muted) / <alpha-value>)",
        },
      },
      /* 仪器感 = 更利落的角:控件 rounded-md(6px),卡 rounded-lg(8px) */
      borderRadius: {
        lg: "0.5rem",
        md: "0.375rem",
        sm: "0.25rem",
        xl: "0.625rem",
        "2xl": "0.875rem",
      },
      /* 数据/日志等宽字族(Win11 自带 Cascadia Mono) */
      fontFamily: {
        mono: [
          "ui-monospace",
          "SF Mono",
          "Cascadia Mono",
          "Consolas",
          "Menlo",
          "monospace",
        ],
      },
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
      /* 冷调分层阴影:发丝边承担 90% 分层,阴影只留给浮层。 */
      boxShadow: {
        soft: "0 1px 2px rgba(16, 24, 40, 0.04), 0 1px 3px rgba(16, 24, 40, 0.06)",
        medium: "0 2px 6px rgba(16, 24, 40, 0.05), 0 8px 24px rgba(16, 24, 40, 0.08)",
        float: "0 12px 32px rgba(16, 24, 40, 0.14)",
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
