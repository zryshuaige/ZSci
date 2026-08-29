import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import { api, qk } from "@/api";
import PdfReader from "@/components/pdf/PdfReader";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { Card } from "@/components/ui/Card";
import { StatusBadge, ToneBadge } from "@/components/ui/StatusBadge";
import { Spinner } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { AlertTriangle } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { useToastMutation } from "@/lib/hooks/useToastMutation";

type Tab = "translate" | "note" | "metadata";

export default function PaperReaderPage() {
  const { paperId } = useParams<{ paperId: string }>();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("translate");
  // H4: null = "not edited yet, fall back to saved content"; "" = explicitly
  // cleared. Previously `noteDraft || readingNote.content` made it impossible
  // to clear the note because `""` fell back to the saved content.
  const [noteDraft, setNoteDraft] = useState<string | null>(null);

  const { data: paper, isLoading } = useQuery({
    queryKey: qk.papers.one(paperId!),
    queryFn: () => api.getPaper(paperId!),
    enabled: !!paperId,
  });
  const { data: annotations = [] } = useQuery({
    queryKey: qk.papers.annotations(paperId!),
    queryFn: () => api.listAnnotations(paperId!),
    enabled: !!paperId,
  });
  const { data: translations = [] } = useQuery({
    queryKey: qk.papers.translations(paperId!),
    queryFn: () => api.listTranslations(paperId!),
    enabled: !!paperId,
  });
  const { data: readingNote } = useQuery({
    queryKey: qk.papers.readingNote(paperId!),
    queryFn: () => api.getReadingNote(paperId!),
    enabled: !!paperId,
  });

  // 交互契约:每个 mutation 都必须有反馈 —— useToastMutation 默认
  // onError→友好错误 toast,successMessage→成功 toast,不允许静默失败。
  const translateMutation = useToastMutation({
    mutationFn: (args: { text: string; page: number }) =>
      api.translate(paperId!, { text: args.text, page: args.page }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.papers.translations(paperId!) }),
  });

  const deleteTranslationMutation = useToastMutation({
    mutationFn: (id: string) => api.deleteTranslation(id),
    successMessage: "已删除翻译",
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.papers.translations(paperId!) }),
  });

  const deleteAnnotationMutation = useToastMutation({
    mutationFn: (id: string) => api.deleteAnnotation(id),
    successMessage: "已删除批注",
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.papers.annotations(paperId!) }),
  });

  const addNoteMutation = useToastMutation({
    mutationFn: (args: { text: string; page: number; rects_json: string | null }) =>
      api.createAnnotation(paperId!, {
        page_number: args.page,
        selected_text: args.text,
        rects_json: args.rects_json,
        kind: "note",
        comment: "",
      }),
    successMessage: "已加入笔记",
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.papers.annotations(paperId!) }),
  });

  const parseMutation = useToastMutation({
    mutationFn: () => api.parsePaper(paperId!),
    successMessage: (r) => `解析完成,共 ${r.pages} 页`,
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.papers.one(paperId!) }),
  });

  const genNoteMutation = useToastMutation({
    mutationFn: () => api.generateReadingNote(paperId!),
    successMessage: "阅读笔记已生成",
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.papers.readingNote(paperId!) }),
  });

  const saveNoteMutation = useToastMutation({
    mutationFn: (content: string) => api.updateReadingNote(paperId!, content),
    successMessage: "笔记已保存",
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.papers.readingNote(paperId!) }),
  });

  if (isLoading) return <div className="p-6"><Spinner /></div>;
  if (!paper)
    return (
      <div className="p-6">
        <EmptyState
          icon={<AlertTriangle className="h-5 w-5" />}
          title="论文未找到"
          subtitle="它可能已被删除，或链接已过期"
        />
      </div>
    );
  if (!paper.downloaded || !paper.local_pdf_path)
    return (
      <div className="p-6">
        <EmptyState
          icon={<AlertTriangle className="h-5 w-5" />}
          title="该论文尚未下载到本地"
          subtitle="请回到文献检索页完成下载确认后，再来阅读"
        />
      </div>
    );

  return (
    <div className="flex flex-col h-full">
      <div className="h-11 shrink-0 border-b border-border/60 bg-card px-4 flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold line-clamp-1">{paper.title}</div>
          <div className="text-xs text-muted-foreground flex items-center gap-1 flex-wrap">
            <span>{[paper.year, paper.venue].filter(Boolean).join(" · ")}</span>
            <span>·</span>
            <StatusBadge status={paper.parse_status ?? "none"} />
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => parseMutation.mutate()}
          loading={parseMutation.isPending}
        >
          重新解析
        </Button>
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0">
          <PdfReader
            paperId={paperId!}
            pdfUrl={api.paperPdfUrl(paperId!)}
            annotations={annotations}
            onTranslate={(text, page) => {
              setTab("translate");
              translateMutation.mutate({ text, page });
            }}
            onAddNote={(text, page, rects_json) => {
              setTab("note");
              addNoteMutation.mutate({ text, page, rects_json });
            }}
          />
        </div>

        {/* Right panel */}
        <aside className="w-96 shrink-0 border-l border-border bg-card flex flex-col">
          <div className="flex border-b border-border text-sm">
            {(["translate", "note", "metadata"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "flex-1 py-2",
                  tab === t ? "border-b-2 border-primary font-medium" : "text-muted-foreground"
                )}
              >
                {t === "translate" ? "翻译" : t === "note" ? "笔记" : "元数据"}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-auto p-3 space-y-3">
            {tab === "translate" && (
              <>
                {translateMutation.isPending && <Spinner />}
                {translations.length === 0 && !translateMutation.isPending && (
                  <p className="text-sm text-muted-foreground">
                    选中论文中的段落,点击"翻译为中文"。翻译结果会保存到这里。
                  </p>
                )}
                {translations.map((t) => (
                  <Card key={t.id} className="p-3 text-sm space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs text-muted-foreground">第 {t.page ?? "?"} 页 · {t.model}</div>
                      <button
                        className="text-xs text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                        title="删除该翻译"
                        onClick={() => deleteTranslationMutation.mutate(t.id)}
                        disabled={deleteTranslationMutation.isPending}
                      >
                        删除
                      </button>
                    </div>
                    <div className="text-muted-foreground line-clamp-3">{t.original_text}</div>
                    <div className="border-t border-border pt-2">{t.translated_text}</div>
                  </Card>
                ))}
              </>
            )}

            {tab === "note" && (
              <>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => genNoteMutation.mutate()}
                    loading={genNoteMutation.isPending}
                    disabled={paper.parse_status !== "success"}
                  >
                    生成阅读笔记
                  </Button>
                </div>
                {paper.parse_status !== "success" && (
                  <p className="text-xs text-muted-foreground">
                    需先解析 PDF(点击右上"重新解析")才能生成笔记。
                  </p>
                )}
                {/* M18: distinguish loading from "no note" so users don't see
                    "还没有阅读笔记" briefly during initial fetch. */}
                {readingNote === undefined ? (
                  <Spinner />
                ) : readingNote ? (
                  <div className="space-y-2">
                    <Textarea
                      rows={8}
                      value={noteDraft ?? readingNote.content}
                      onChange={(e) => setNoteDraft(e.target.value)}
                      className="font-mono text-xs"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => saveNoteMutation.mutate(noteDraft ?? readingNote.content)}
                      loading={saveNoteMutation.isPending}
                    >
                      保存修改
                    </Button>
                    {/* M6: preview the draft (if any), not just the saved content. */}
                    <div className="prose prose-sm max-w-none">
                      <ReactMarkdown>{noteDraft ?? readingNote.content}</ReactMarkdown>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    还没有阅读笔记。点击"生成阅读笔记",Agent 会基于已抽取的论文文本生成带页码证据的结构化笔记。
                  </p>
                )}

                <div className="pt-3 border-t border-border">
                  <div className="text-xs text-muted-foreground mb-1">高亮批注</div>
                  {annotations.filter((a) => a.kind === "note").length === 0 ? (
                    <p className="text-xs text-muted-foreground">选中段落后点击"加入笔记"。</p>
                  ) : (
                    annotations
                      .filter((a) => a.kind === "note")
                      .map((a) => (
                        <Card key={a.id} className="p-2 mb-1 text-xs">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-muted-foreground">第 {a.page_number} 页</div>
                              <div className="line-clamp-2">{a.selected_text}</div>
                            </div>
                            <button
                              className="text-muted-foreground hover:text-destructive transition-colors shrink-0 disabled:opacity-50"
                              title="删除该批注"
                              onClick={() => deleteAnnotationMutation.mutate(a.id)}
                              disabled={deleteAnnotationMutation.isPending}
                            >
                              ✕
                            </button>
                          </div>
                        </Card>
                      ))
                  )}
                </div>
              </>
            )}

            {tab === "metadata" && (
              <Card className="p-3 text-sm space-y-1">
                <div className="font-medium">{paper.title}</div>
                <div className="text-muted-foreground">{(paper.authors || []).join(", ")}</div>
                <Row k="年份" v={paper.year} />
                <Row k="会议" v={paper.venue} />
                {paper.venue_verified && <ToneBadge tone="blue">已验证顶会</ToneBadge>}
                <Row k="DOI" v={paper.doi} />
                <Row k="arXiv" v={paper.arxiv_id} />
                <Row k="来源" v={paper.source} />
                <Row k="本地路径" v={paper.local_pdf_path} />
              </Card>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string | number | null | undefined }) {
  if (!v) return null;
  return (
    <div className="flex gap-2 text-xs">
      <span className="text-muted-foreground w-16 shrink-0">{k}</span>
      <span className="break-all">{v}</span>
    </div>
  );
}
