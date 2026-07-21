import { type ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Apple-style empty state: a large muted icon, a concise title, and an
    optional subtitle + action. Used wherever a list/page has no content yet
    so every empty surface reads the same. Animates in with a gentle pop. */
export function EmptyState({
  icon,
  title,
  subtitle,
  action,
  className,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("text-center text-muted-foreground py-12 animate-pop", className)}>
      <div className="flex justify-center mb-3 opacity-40">{icon}</div>
      <div className="text-sm text-foreground/80 font-medium">{title}</div>
      {subtitle && <div className="text-xs mt-1.5 leading-relaxed">{subtitle}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
