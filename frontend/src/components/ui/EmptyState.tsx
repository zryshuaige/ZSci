import { type ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Apple-style empty state: a large muted icon, a concise title, and an
    optional subtitle + action. Used wherever a list/page has no content yet
    so every empty surface reads the same. Animates in with a gentle pop.

    Variants:
      - "page" (default): centered, generous padding, large icon — for empty
        pages or major list sections.
      - "inline": left-aligned, compact, smaller icon — for empty sub-sections
        inside a complex page (e.g. "no tags yet" inside a settings card). */
export function EmptyState({
  icon,
  title,
  subtitle,
  action,
  variant = "page",
  className,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  variant?: "page" | "inline";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "text-center text-muted-foreground animate-pop",
        variant === "page" ? "py-12" : "py-6",
        className,
      )}
    >
      <div
        className={cn(
          "flex justify-center mb-3 opacity-40",
          variant === "inline" && "mb-2",
        )}
      >
        {icon}
      </div>
      <div className={cn("text-sm text-foreground/80 font-medium", variant === "inline" && "text-xs")}>
        {title}
      </div>
      {subtitle && (
        <div className={cn("text-xs mt-1.5 leading-relaxed", variant === "inline" && "text-[11px] mt-1")}>
          {subtitle}
        </div>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
