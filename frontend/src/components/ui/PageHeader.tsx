import { type ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

/** Shared page header — kills the copy-pasted
 *  `h1 text-xl font-semibold tracking-tight` block across pages.
 *  Title + optional subtitle on the left, action controls on the right.
 *  Spacing (px/pt/pb) belongs to the page's own wrapper, not here. */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}
