// Phase B: 研究问题概述卡 — 把"AI 理解"改写为研究问题概述,把"改一下"改
// 为"修改描述",去工程/AI 拟人化措辞,统一为科研语境。

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { ClipboardList, Pencil, Check } from "lucide-react";

interface AIUnderstandingCardProps {
  original: string;
  /** A short, 1-3 sentence summary of the research problem.
   *  Derived from the leading candidate's hypothesis. */
  understanding: string;
  /** Optional sub-fields shown as labelled chips. */
  background?: string | null;
  goal?: string | null;
  familiarity?: string | null;
  /** When true the user has clicked "修改描述"; surface the editor and let
   *  them tweak the original idea inline. The page handles regen on confirm. */
  revising: boolean;
  revisedText: string;
  onRevisedTextChange: (next: string) => void;
  busy: boolean;
  onAccept: () => void;
  onRevise: () => void;
  onSaveRevision: () => void;
  onCancelRevision: () => void;
}

/** Visual chip variant — we never load lucide icons for these labels because
 *  they only need plain text in muted colour; saves a small bundle. */
function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </span>
  );
}

export function AIUnderstandingCard({
  original,
  understanding,
  background,
  goal,
  familiarity,
  revising,
  revisedText,
  onRevisedTextChange,
  busy,
  onAccept,
  onRevise,
  onSaveRevision,
  onCancelRevision,
}: AIUnderstandingCardProps) {
  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-center gap-2">
        <ClipboardList className="h-4 w-4 text-primary" />
        <h3 className="text-base font-semibold">研究问题概述</h3>
      </div>

      {/* Original idea echo — keep this section small so the summary
          remains the dominant element on the card. */}
      <div className="rounded-md bg-muted/40 p-3 space-y-1">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
          你的描述
        </div>
        <div className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
          {original}
        </div>
      </div>

      {/* Research-problem summary + optional chips */}
      <div className="space-y-2">
        <div className="text-sm leading-relaxed text-foreground">
          {understanding}
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          {background && <Chip label="背景" value={background} />}
          {goal && <Chip label="关注目标" value={goal} />}
          {familiarity && <Chip label="相关研究现状" value={familiarity} />}
        </div>
      </div>

      {revising ? (
        <div className="space-y-2 rounded-md border border-border bg-card p-3">
          <div className="text-xs text-muted-foreground">
            修改研究问题描述。保存后会重新生成候选方向。
          </div>
          <Textarea
            rows={4}
            value={revisedText}
            onChange={(e) => onRevisedTextChange(e.target.value)}
            placeholder="例如:其实我更想关注的是医疗影像方向,而不是问答……"
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onCancelRevision} disabled={busy}>
              取消
            </Button>
            <Button size="sm" onClick={onSaveRevision} disabled={busy}>
              {busy ? "重新生成中…" : "保存并重新生成"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 pt-2 border-t border-border/60">
          <Button onClick={onAccept} disabled={busy}>
            <Check className="h-4 w-4" />
            概述准确,继续
          </Button>
          <Button variant="outline" onClick={onRevise} disabled={busy}>
            <Pencil className="h-4 w-4" />
            修改描述
          </Button>
        </div>
      )}
    </Card>
  );
}

/** Derive a short research-problem summary from the leading candidate.
 *  Pure function so unit tests don't need to render. */
export function summariseCandidate(
  candidate: {
    hypothesis: string;
    motivation: string;
    one_liner?: string;
  } | null | undefined,
): { understanding: string; goal: string | null; familiarity: string | null } {
  if (!candidate) {
    return {
      understanding:
        "系统已记录你描述的研究方向,接下来会据此整理若干差异化的候选方向供你挑选。",
      goal: null,
      familiarity: null,
    };
  }
  const sentence =
    candidate.one_liner ||
    candidate.hypothesis ||
    candidate.motivation ||
    "";
  // Clamp the summary to ≤ 3 sentences. Most LLMs return 2 already.
  const trimmed =
    sentence
      .split(/[。！？!?]/)
      .filter(Boolean)
      .slice(0, 3)
      .join("。") + "。";
  return {
    understanding:
      trimmed || "系统将基于你描述的方向生成若干候选研究方向。",
    goal: null,
    familiarity: null,
  };
}