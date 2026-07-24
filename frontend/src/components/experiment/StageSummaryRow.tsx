/**
 * StageSummaryRow — collapsible details under the CurrentStageHero.
 *
 * Iteration 4: when the user wants more detail about the current
 * stage (output artifacts, recent events, risk notes), they expand
 * this row instead of being forced to scroll through 11 stacked
 * cards. Defaults to collapsed so the page stays minimal.
 *
 * The component is dumb — it only renders whatever the parent passes
 * in. The detail page is responsible for fetching the underlying
 * data (preview-plan / next-steps / agent task events).
 */

import { useState } from "react";
import { ChevronDown, ChevronUp, ListChecks } from "lucide-react";
import { cn } from "@/lib/cn";
import { Card } from "@/components/ui/Card";

interface StageSummaryRowProps {
  /** Bulleted list of "what was confirmed" items, e.g. "首轮评测基准已确定". */
  confirmedItems?: string[];
  /** One-line headline about the current artifact (plan summary / analysis summary). */
  artifactHeadline?: string | null;
  /** Optional known-risks list. */
  risks?: string[];
  /** Recent events (already formatted by the parent). */
  recentEvents?: Array<{ id: string; at: string; message: string; kind?: string }>;
  /** When true, the section is open by default. */
  defaultOpen?: boolean;
  className?: string;
}

export function StageSummaryRow({
  confirmedItems = [],
  artifactHeadline,
  risks = [],
  recentEvents = [],
  defaultOpen = false,
  className,
}: StageSummaryRowProps) {
  const [open, setOpen] = useState(defaultOpen);
  const hasContent =
    confirmedItems.length > 0 || !!artifactHeadline || risks.length > 0 || recentEvents.length > 0;
  if (!hasContent) return null;
  return (
    <Card className={cn("p-4", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          <ListChecks className="h-4 w-4 text-muted-foreground" />
          本阶段已确认内容
        </span>
        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          {confirmedItems.length > 0 && (
            <ul className="space-y-1.5 text-sm text-foreground/90">
              {confirmedItems.map((it, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-green-600">✓</span>
                  <span>{it}</span>
                </li>
              ))}
            </ul>
          )}
          {artifactHeadline && (
            <p className="text-xs text-muted-foreground">{artifactHeadline}</p>
          )}
          {risks.length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">
                已知风险
              </div>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {risks.map((r, i) => (
                  <li key={i}>• {r}</li>
                ))}
              </ul>
            </div>
          )}
          {recentEvents.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                最近事件({recentEvents.length})
              </summary>
              <ul className="mt-2 space-y-1 text-xs">
                {recentEvents.slice(0, 5).map((e) => (
                  <li key={e.id} className="flex gap-2">
                    <span className="text-muted-foreground/70">{e.at}</span>
                    <span>{e.message}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}