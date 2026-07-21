import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import { api } from "@/lib/api";
import PdfReader from "@/components/pdf/PdfReader";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Dialog";
import { cn } from "@/lib/cn";

type Tab = "translate" | "note" | "metadata";

export default function PaperReaderPage() {
  const { paperId } = useParams<{ paperId: string }>();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("translate");
  const [translating, setTranslating] = useState(false);
  // H4: null = "not edited yet, fall back to saved content"; "" = explicitly
  // cleared. Previously `noteDraft || readingNote.content` made it impossible
  // to clear the note because `""` fell back to the saved content.
  const [noteDraft, setNoteDraft] = useState<string | null>(null);

  const { data: paper, isLoading } = useQuery({
    queryKey: ["paper", paperId],
    queryFn: () => api.getPaper(paperId!),
    enabled: !!paperId,
  });
  const { data: annotations = [] } = useQuery({
    queryKey: ["annotations", paperId],
    queryFn: () => api.listAnnotations(paperId!),
    enabled: !!paperId,
  });
  const { data: translations = [] } = useQuery({
    queryKey: ["translations", paperId],
    queryFn: () => api.listTranslations(paperId!),
    enabled: !!paperId,
  });
  const { data: readingNote } = useQuery({
    queryKey: ["reading-note", paperId],
    queryFn: () => api.getReadingNote(paperId!),
    enabled: !!paperId,
  });

  const translateMutation = useMutation({
    mutationFn: (args: { text: string; page: number }) =>
      api.translate(paperId!, { text: args.text, page: args.page }),
    onMutate: () => setTranslating(true),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["translations", paperId] }),
    onSettled: () => setTranslating(false),
  });

  const deleteTranslationMutation = useMutation({
    mutationFn: (id: string) => api.deleteTranslation(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["translations", paperId] }),
  });

  const deleteAnnotationMutation = useMutation({
    mutationFn: (id: string) => api.deleteAnnotation(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["annotations", paperId] }),
  });

  const addNoteMutation = useMutation({
    mutationFn: (args: { text: string; page: number; rects_json: string | null }) =>
      api.createAnnotation(paperId!, {
        page_number: args.page,
        selected_text: args.text,
        rects_json: args.rects_json,
        kind: "note",
        comment: "",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["annotations", paperId] }),
  });

  const parseMutation = useMutation({
    mutationFn: () => api.parsePaper(paperId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["paper", paperId] }),
  });

  const genNoteMutation = useMutation({
    mutationFn: () => api.generateReadingNote(paperId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reading-note", paperId] }),
  });

  const saveNoteMutation = useMutation({
    mutationFn: (content: string) => api.updateReadingNote(paperId!, content),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reading-note", paperId] }),
  });

  if (isLoading) return <div className="p-6"><Spinner /></div>;
  if (!paper) return <div className="p-6">论文未找到。</div>;
  if (!paper.downloaded || !paper.local_pdf_path)
    return <div className="p-6">该论文尚未下载到本地。</div>;

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border bg-card px-4 py-2 flex items-center gap-3 shrink-0">
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm line-clamp-1">{paper.title}</div>
          <div className="text-xs text-muted-foreground">
            {[paper.year, paper.venue].filter(Boolean).join(" · ")} · 解析状态:{paper.parse_status || "未解析"}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => parseMutation.mutate()}
          disabled={parseMutation.isPending}
        >
          {parseMutation.isPending ? "解析中…" : "重新解析"}
        </Button>
        {/* M9: surface parse errors instead of silently reverting the label. */}
        {parseMutation.isError && (
          <span className="text-xs text-destructive ml-2">
            解析失败:{(parseMutation.error as Error).message}
          </span>
        )}
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
                {translating && <Spinner />}
                {translations.length === 0 && !translating && (
                  <p className="text-sm text-muted-foreground">
                    选中论文中的段落,点击"翻译为中文"。翻译结果会保存到这里。
                  </p>
                )}
                {translations.map((t) => (
                  <Card key={t.id} className="p-3 text-sm space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs text-muted-foreground">第 {t.page ?? "?"} 页 · {t.model}</div>
                      <button
                        className="text-xs text-muted-foreground hover:text-destructive transition-colors"
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
                    disabled={genNoteMutation.isPending || paper.parse_status !== "success"}
                  >
                    {genNoteMutation.isPending ? "生成中…" : "生成阅读笔记"}
                  </Button>
                  {genNoteMutation.isError && (
                    <span className="text-xs text-destructive">
                      {(genNoteMutation.error as Error).message}
                    </span>
                  )}
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
                      disabled={saveNoteMutation.isPending}
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
                              className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
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
                <div className="text-muted-foreground">{paper.authors.join(", ")}</div>
                <Row k="年份" v={paper.year} />
                <Row k="会议" v={paper.venue} />
                {paper.venue_verified && <Badge className="bg-accent text-accent-foreground">已验证顶会</Badge>}
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
