import { type ReactNode } from "react";
import { Loader2 } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { Badge } from "./Badge";
import {
  statusMeta,
  TONE_CLASSES,
  type Tone,
} from "@/lib/statusMeta";

/** The ONE status badge for the whole app. Every status pill (experiment,
 *  stage, task, run, job, idea, repo, paper) renders through this so the
 *  same status always has the same label + color everywhere. */
export function StatusBadge({
  status,
  className,
  /** Override the label (e.g. backend-provided phase-view hydration). */
  label,
}: {
  status: string | null | undefined;
  className?: string;
  label?: string;
}) {
  const m = statusMeta(status);
  const t = TONE_CLASSES[m.tone];
  return (
    <Badge className={cn("gap-1 whitespace-nowrap", t.soft, className)}>
      {m.spinning && <Loader2 className="h-3 w-3 animate-spin" />}
      {label ?? m.label}
    </Badge>
  );
}

/** Semantic badge for things that aren't a backend status but still need a
 *  tone (backend health, venue-verified, repo source kind, key-configured). */
export function ToneBadge({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Badge className={cn("whitespace-nowrap", TONE_CLASSES[tone].soft, className)}>
      {children}
    </Badge>
  );
}
