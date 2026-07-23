import { useState, useRef, useEffect, useCallback, type ReactNode, type HTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

interface TooltipProps {
  /** Tooltip body — short text. Keep ≤ 24 chars / 2 short lines. */
  content: ReactNode;
  /** Element the tooltip anchors to. */
  children: ReactNode;
  /** Side the tooltip appears on. */
  side?: "top" | "bottom" | "left" | "right";
  /** Align relative to the anchor. */
  align?: "start" | "center" | "end";
  /** Open delay (ms). Default 250ms — fast enough to feel responsive, slow
   *  enough to not flash when the cursor is just passing through. */
  delay?: number;
  /** Disabled state — render children without tooltip behavior. */
  disabled?: boolean;
  /** Additional className for the tooltip bubble. */
  className?: string;
}

const GAP = 6;
const VIEW_PAD = 8;

/**
 * Hover tooltip. Rendered via a portal to `document.body` so the bubble
 * escapes the host's stacking context — the sidebar uses `backdrop-filter`
 * (via the `glass` utility) which creates a stacking context, and any
 * `z-index` set inside it is bounded by that context. Without the portal
 * the tooltip would be painted BELOW whatever sits in the main content
 * area (the `BackendHealthBanner` in our case), which looks like the
 * tooltip is "not on top".
 *
 * The portal also lets the tooltip overflow sidebar boundaries freely
 * (e.g. a long description extending past the right edge) without being
 * clipped by `overflow: hidden` on an ancestor.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
  delay = 250,
  disabled = false,
  className,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const bubbleRef = useRef<HTMLSpanElement | null>(null);
  const timer = useRef<number | null>(null);
  const sideRef = useRef(side);
  const alignRef = useRef(align);
  sideRef.current = side;
  alignRef.current = align;

  const updatePos = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const s = sideRef.current;
    const a = alignRef.current;

    // Center of the rect: left + width/2 (NOT (left + width) / 2).
    let top =
      s === "bottom" ? r.bottom + GAP
      : s === "top" ? r.top - GAP
      : r.top + r.height / 2;
    let left =
      s === "right" ? r.right + GAP
      : s === "left" ? r.left - GAP
      : r.left + r.width / 2;

    // Clamp the centering axis so long labels stay on-screen (no side flip —
    // transform is tied to the requested side).
    const bubble = bubbleRef.current;
    if (bubble) {
      const br = bubble.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      if (s === "top" || s === "bottom") {
        if (a === "start") {
          left = Math.min(Math.max(left, VIEW_PAD), vw - br.width - VIEW_PAD);
        } else if (a === "end") {
          left = Math.min(Math.max(left, br.width + VIEW_PAD), vw - VIEW_PAD);
        } else {
          const half = br.width / 2;
          left = Math.min(Math.max(left, half + VIEW_PAD), vw - half - VIEW_PAD);
        }
      } else {
        const half = br.height / 2;
        top = Math.min(Math.max(top, half + VIEW_PAD), vh - half - VIEW_PAD);
      }
    }

    setPos({ top, left });
  }, []);

  const show = () => {
    if (disabled) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      updatePos();
      setOpen(true);
    }, delay);
  };
  const hide = () => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    // Re-measure once the bubble is mounted so clamp uses real size.
    updatePos();
    const onReposition = () => updatePos();
    window.addEventListener("scroll", onReposition, true);
    window.addEventListener("resize", onReposition);
    return () => {
      window.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
    };
  }, [open, updatePos]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const bubble = open && pos ? (
    <span
      ref={bubbleRef}
      role="tooltip"
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        transform: transformFor(side, align),
      }}
      className={cn(
        "pointer-events-none z-tooltip whitespace-nowrap rounded-md",
        "bg-foreground/95 text-background text-xs font-medium px-2 py-1 shadow-medium",
        "animate-fade-in",
        className,
      )}
    >
      {content}
    </span>
  ) : null;

  return (
    <span
      ref={anchorRef}
      className="inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {bubble && createPortal(bubble, document.body)}
    </span>
  );
}

/** Translate (50% / 100%) to apply so the bubble centers/edges on the anchor.
 *  Combined with the viewport coords above, the math is:
 *    top:    bottom → translateY(0)    | top → translateY(-100%)
 *            left/right → translateY(-50%)
 *    left:   right → translateX(0)     | left → translateX(-100%)
 *            top/bottom → translateX(-50%) (center) or 0/-100% (start/end)
 */
function transformFor(side: NonNullable<TooltipProps["side"]>, align: NonNullable<TooltipProps["align"]>): string {
  const ty = side === "top" ? "-100%" : side === "bottom" ? "0" : "-50%";
  const tx =
    side === "left" ? "-100%" :
    side === "right" ? "0" :
    align === "start" ? "0" : align === "end" ? "-100%" : "-50%";
  return `translate(${tx}, ${ty})`;
}

/** Convenience wrapper for icon-only buttons that need a tooltip with optional
 *  keyboard shortcut hint, e.g. `<ShortcutTooltip content="保存" shortcut="⌘S">`. */
export function ShortcutTooltip({
  content,
  shortcut,
  children,
  ...rest
}: TooltipProps & { shortcut?: string }) {
  return (
    <Tooltip
      content={
        shortcut ? (
          <span className="inline-flex items-center gap-1.5">
            <span>{content}</span>
            <span className="opacity-70 font-mono text-[10px]">{shortcut}</span>
          </span>
        ) : (
          content
        )
      }
      {...rest}
    >
      {children}
    </Tooltip>
  );
}

/** Span wrapper used when a tooltip child cannot accept a ref directly. */
export const TooltipAnchor = (props: HTMLAttributes<HTMLSpanElement>) => (
  <span className="inline-flex" {...props} />
);
