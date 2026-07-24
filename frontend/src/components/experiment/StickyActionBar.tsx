/**
 * StickyActionBar — fixed bottom bar with the 1-primary + 2-secondary
 * CTAs for the current variant.
 *
 * Iteration 4: replaces the inline button cluster at the bottom of
 * the page so the most important action is always reachable without
 * scrolling, regardless of which stage the experiment is in.
 *
 * Variant → actions:
 *   - draft:        [启动实验]                    [查看设置] [查看历史]
 *   - running:      [查看进展]                    [暂停] [取消]
 *   - waiting_user: [确认并继续]                  [调整方案] [结束本次]
 *   - completed:    [查看研究结论]                [开始下一轮] [生成报告]
 *   - failed:       [自动修复并继续]              [查看详细原因] [暂停并保存]
 *
 * The bar sticks to the bottom of the viewport (`sticky bottom-0`)
 * with a backdrop-blur so content scrolling under it stays legible.
 */

import { Pause, Play, X, Check, RefreshCw, FileText, Sparkles, Eye } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

type Variant = "draft" | "running" | "waiting_user" | "completed" | "failed";

interface StickyActionBarProps {
  variant: Variant;
  /** True when the primary action is in flight. */
  primaryPending?: boolean;
  onPrimary?: () => void;
  onSecondary?: (which: 1 | 2) => void;
  className?: string;
}

export function StickyActionBar({
  variant,
  primaryPending,
  onPrimary,
  onSecondary,
  className,
}: StickyActionBarProps) {
  const config = ACTIONS[variant];
  return (
    <div
      className={cn(
        "sticky bottom-0 z-30 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80",
        "px-4 py-3 md:px-6",
        className,
      )}
      role="region"
      aria-label="实验操作"
    >
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-2">
        <div className="hidden md:block text-xs text-muted-foreground">
          {config.tagline}
        </div>
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          {config.secondary.map((s, i) => (
            <Button
              key={i}
              variant="outline"
              onClick={() => onSecondary?.((i + 1) as 1 | 2)}
            >
              {s.icon && <s.icon className="mr-2 h-4 w-4" />}
              {s.label}
            </Button>
          ))}
          <Button
            variant={config.primaryVariant}
            onClick={onPrimary}
            disabled={primaryPending}
          >
            {config.primaryIcon && <config.primaryIcon className="mr-2 h-4 w-4" />}
            {config.primaryLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant configurations — central place to edit primary + secondary copy
// ---------------------------------------------------------------------------

const ACTIONS: Record<
  Variant,
  {
    tagline: string;
    primaryLabel: string;
    primaryIcon?: typeof Check;
    primaryVariant: "default" | "destructive" | "outline";
    secondary: Array<{ label: string; icon?: typeof Check }>;
  }
> = {
  draft: {
    tagline: "未启动",
    primaryLabel: "启动实验",
    primaryIcon: Play,
    primaryVariant: "default",
    secondary: [
      { label: "查看设置", icon: Eye },
      { label: "查看历史", icon: FileText },
    ],
  },
  running: {
    tagline: "正在进行",
    primaryLabel: "查看进展",
    primaryIcon: Eye,
    primaryVariant: "default",
    secondary: [
      { label: "暂停", icon: Pause },
      { label: "取消", icon: X },
    ],
  },
  waiting_user: {
    tagline: "等待你的确认",
    primaryLabel: "确认并继续",
    primaryIcon: Check,
    primaryVariant: "default",
    secondary: [
      { label: "调整方案", icon: RefreshCw },
      { label: "结束本次", icon: X },
    ],
  },
  completed: {
    tagline: "本轮已完成",
    primaryLabel: "查看研究结论",
    primaryIcon: Sparkles,
    primaryVariant: "default",
    secondary: [
      { label: "开始下一轮", icon: RefreshCw },
      { label: "生成报告", icon: FileText },
    ],
  },
  failed: {
    tagline: "需要处理",
    primaryLabel: "自动修复并继续",
    primaryIcon: Sparkles,
    primaryVariant: "default",
    secondary: [
      { label: "查看详细原因", icon: Eye },
      { label: "暂停并保存", icon: Pause },
    ],
  },
};