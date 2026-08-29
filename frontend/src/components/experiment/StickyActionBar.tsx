/**
 * StickyActionBar — fixed bottom bar with the CTAs for the current variant.
 *
 * The bar renders only actions the parent has a real handler for. Actions
 * are semantic keys (not positional "secondary 1/2") so a label can never
 * silently drift from its behaviour: if a variant lists an action the
 * parent doesn't handle, TypeScript doesn't complain, so the parent must
 * handle every key in its variant's config — keep them in sync here.
 */

import { Pause, Play, X, Check, RefreshCw, FileText, Sparkles, Eye, ScrollText, PencilLine } from "@/components/ui/icons";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

export type Variant = "draft" | "running" | "waiting_user" | "completed" | "failed" | "paused";

export type ActionKey =
  | "launch"        // draft primary: start the workflow
  | "editQuestion"  // draft secondary: open the advanced drawer on the RQ editor
  | "scrollToLog"   // running primary: scroll the live event log into view
  | "approve"       // waiting_user primary
  | "editPlan"      // waiting_user secondary: open advanced drawer
  | "abort"         // waiting_user secondary: end this run (confirm first)
  | "viewResult"    // completed primary
  | "nextRound"     // completed secondary: fork / next iteration
  | "generateReport"// completed secondary: go to the writing page
  | "retry"         // failed primary: auto-fix and continue
  | "showReason"    // failed secondary: toggle the reason panel
  | "resume";       // paused primary: continue from the checkpoint

interface ActionDef {
  key: ActionKey;
  label: string;
  icon?: typeof Check;
  variant?: "default" | "destructive" | "outline";
}

const ACTIONS: Record<Variant, { tagline: string; primary: ActionDef; secondary: ActionDef[] }> = {
  draft: {
    tagline: "未启动",
    primary: { key: "launch", label: "启动实验", icon: Play },
    secondary: [{ key: "editQuestion", label: "编辑研究问题", icon: PencilLine }],
  },
  running: {
    tagline: "正在进行",
    primary: { key: "scrollToLog", label: "查看实时进展", icon: ScrollText },
    secondary: [],
  },
  waiting_user: {
    tagline: "等待你的确认",
    primary: { key: "approve", label: "确认并继续", icon: Check },
    secondary: [
      { key: "editPlan", label: "调整方案", icon: RefreshCw },
      { key: "abort", label: "结束本次", icon: X, variant: "outline" },
    ],
  },
  completed: {
    tagline: "本轮已完成",
    primary: { key: "viewResult", label: "查看研究结论", icon: Sparkles },
    secondary: [
      { key: "nextRound", label: "开始下一轮", icon: RefreshCw },
      { key: "generateReport", label: "生成报告", icon: FileText },
    ],
  },
  failed: {
    tagline: "需要处理",
    primary: { key: "retry", label: "自动修复并继续", icon: Sparkles },
    secondary: [{ key: "showReason", label: "查看详细原因", icon: Eye }],
  },
  paused: {
    tagline: "已暂停,进度已保存",
    primary: { key: "resume", label: "继续实验", icon: Play },
    secondary: [{ key: "editPlan", label: "查看阶段详情", icon: Eye }],
  },
};

interface StickyActionBarProps {
  variant: Variant;
  primaryPending?: boolean;
  onAction?: (key: ActionKey) => void;
  className?: string;
}

export function StickyActionBar({
  variant,
  primaryPending,
  onAction,
  className,
}: StickyActionBarProps) {
  // 操作入口唯一化：Hero 是每个状态的唯一完整操作面。
  // - waiting_user: 决策只在 CheckpointCard（两套措辞同屏会互相打架）
  // - draft: Hero 已含「填写研究问题并启动/启动实验」，首屏即可操作
  // - 其余状态: 底栏只保留主按钮作为滚动可达入口，次要动作全部
  //   收敛进 Hero（此前 failed/completed 的次要按钮与 Hero 完全重复）。
  if (variant === "waiting_user" || variant === "draft") return null;
  const config = ACTIONS[variant];
  return (
    <div
      className={cn(
        "sticky bottom-0 z-30 border-t border-border/60 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80",
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
          <Button
            variant={config.primary.variant ?? "default"}
            onClick={() => onAction?.(config.primary.key)}
            loading={primaryPending}
          >
            {!primaryPending && config.primary.icon && (
              <config.primary.icon className="mr-2 h-4 w-4" />
            )}
            {config.primary.label}
          </Button>
        </div>
      </div>
    </div>
  );
}
