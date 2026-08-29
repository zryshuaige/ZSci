// Phase B: 单个研究方向候选卡(候选对比屏的基础组件)。
//
// Renders one MultiIdeaCandidate. The card supports:
//   - "选用此方向" 主操作按钮(selected=true 时变成已选状态)
//   - "查看研究依据" 折叠:targets / baseline_methods / key_differences /
//     evidence_paper_ids
//   - 三色 ★(feasibility / novelty)+ 预计天数 + 资源量
//   - 顶部"综合评估优先"角标(仅 recommended=true 时,措辞从 "AI 推荐" 改)

import { useState } from "react";
import { ChevronDown, ChevronUp, Star, Award, Check } from "@/components/ui/icons";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import type { MultiIdeaCandidate } from "@/lib/api";

interface MultiIdeaCardProps {
  candidate: MultiIdeaCandidate;
  selected: boolean;
  onSelect: () => void;
  busy?: boolean;
}

/** Render 1-3 stars; clamp inputs defensively. */
function Stars({ value }: { value: number }) {
  const v = Math.max(1, Math.min(3, value | 0));
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${v} 星`}>
      {[1, 2, 3].map((i) => (
        <Star
          key={i}
          className={cn(
            "h-3.5 w-3.5",
            i <= v ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40",
          )}
        />
      ))}
    </span>
  );
}

function costLabel(c: string): string {
  if (c === "low") return "算力需求较低";
  if (c === "high") return "算力需求较高";
  return "中等算力需求";
}

export function MultiIdeaCard({
  candidate,
  selected,
  onSelect,
  busy,
}: MultiIdeaCardProps) {
  const [open, setOpen] = useState(false);
  const hasEvidence =
    candidate.targets.length > 0 ||
    candidate.baseline_methods.length > 0 ||
    candidate.key_differences.length > 0 ||
    candidate.evidence_paper_ids.length > 0;

  return (
    <Card
      className={cn(
        "p-5 transition-shadow",
        selected ? "ring-2 ring-primary shadow-soft" : "hover-lift",
      )}
    >
      {/* Header: title + 综合评估优先 角标 */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className="text-base font-semibold leading-snug">{candidate.name}</h3>
        {candidate.recommended && (
          <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
            <Award className="h-3 w-3" />
            综合评估优先
          </span>
        )}
      </div>

      {/* 一句话 + 假设 */}
      {candidate.one_liner && (
        <p className="text-sm text-foreground leading-relaxed">
          {candidate.one_liner}
        </p>
      )}
      {candidate.hypothesis && (
        <p className="mt-2 text-xs text-muted-foreground leading-relaxed line-clamp-3">
          <span className="font-medium">研究问题:</span>
          {candidate.hypothesis}
        </p>
      )}

      {/* 三色 ★ + 预计天数 */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span>可行性</span>
          <Stars value={candidate.feasibility} />
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span>创新性</span>
          <Stars value={candidate.novelty} />
        </span>
        <span>{costLabel(candidate.est_cost)}</span>
        <span>首轮预计 {candidate.est_days} 天</span>
      </div>

      {/* 折叠:研究依据 */}
      {hasEvidence && (
        <div className="mt-3">
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-primary hover:underline"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {open ? "收起研究依据" : "查看研究依据"}
          </button>
          {open && (
            <div className="mt-2 space-y-2 rounded-md bg-muted/40 p-3 text-xs leading-relaxed">
              {candidate.targets.length > 0 && (
                <div>
                  <div className="text-[11px] font-medium text-muted-foreground mb-0.5">适用研究目标</div>
                  <div className="text-foreground/90">{candidate.targets.join("、")}</div>
                </div>
              )}
              {candidate.baseline_methods.length > 0 && (
                <div>
                  <div className="text-[11px] font-medium text-muted-foreground mb-0.5">可对照的已有方法</div>
                  <div className="text-foreground/90">{candidate.baseline_methods.join("、")}</div>
                </div>
              )}
              {candidate.key_differences.length > 0 && (
                <div>
                  <div className="text-[11px] font-medium text-muted-foreground mb-0.5">与已有方法的核心差异</div>
                  <div className="text-foreground/90">{candidate.key_differences.join("、")}</div>
                </div>
              )}
              {candidate.evidence_paper_ids.length > 0 && (
                <div>
                  <div className="text-[11px] font-medium text-muted-foreground mb-0.5">相关文献</div>
                  <div className="text-foreground/90 font-mono break-all">
                    {candidate.evidence_paper_ids.join(", ")}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 主 CTA */}
      <div className="mt-4 flex items-center gap-2">
        <Button
          size="sm"
          onClick={onSelect}
          disabled={busy}
          variant={selected ? "outline" : undefined}
        >
          {selected ? (
            <>
              <Check className="h-4 w-4" />
              已选用
            </>
          ) : (
            "选用此方向"
          )}
        </Button>
      </div>
    </Card>
  );
}
