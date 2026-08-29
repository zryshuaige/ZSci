import { cn } from "@/lib/cn";
import { Check } from "@/components/ui/icons";

/**
 * WizardBar — 探索流程顶部向导条：梳理问题 → 选定方向 → 计划确认 → 验证结果。
 *
 * 流程 4 页（explore/new、explore/ideas、preview、result）挂在项目框架内，
 * 本条始终可见：用户任何时候都知道自己在第几步、离终点多远。已完成步骤
 * 可点击回退（回退是安全的：候选已落库为 idea 行，回退不重跑 LLM）。
 */

export const WIZARD_STEPS = [
  { key: "new", label: "梳理问题" },
  { key: "ideas", label: "选定方向" },
  { key: "preview", label: "计划确认" },
  { key: "result", label: "验证结果" },
] as const;

export default function WizardBar({
  projectId,
  current,
}: {
  projectId: string;
  /** 1-4，对应 WIZARD_STEPS 索引+1 */
  current: number;
}) {
  return (
    <nav
      aria-label="探索流程"
      className="flex items-center gap-1.5 text-[13px] rounded-lg border border-border/60 bg-card px-3 py-2"
    >
      <span className="text-muted-foreground mr-1.5 shrink-0">
        第 {current}/{WIZARD_STEPS.length} 步
      </span>
      {WIZARD_STEPS.map((s, i) => {
        const idx = i + 1;
        const done = idx < current;
        const active = idx === current;
        return (
          <span key={s.key} className="flex items-center gap-1.5 min-w-0">
            {i > 0 && <span className="h-px w-4 bg-border shrink-0" aria-hidden />}
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 whitespace-nowrap",
                active && "bg-primary/10 text-primary font-medium",
                done && "text-muted-foreground",
                !active && !done && "text-muted-foreground/60",
              )}
            >
              {done ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <span
                  className={cn(
                    "inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-[10px] font-medium",
                    active ? "bg-primary text-primary-foreground" : "bg-border text-muted-foreground",
                  )}
                >
                  {idx}
                </span>
              )}
              {s.label}
            </span>
          </span>
        );
      })}
    </nav>
  );
}
