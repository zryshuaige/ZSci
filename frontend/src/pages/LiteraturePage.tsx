import { useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Search, Download, FileText, ExternalLink, Sparkles } from "lucide-react";
import { api, type CandidatePaper, type Project } from "@/lib/api";
import { showFriendlyError } from "@/lib/useFriendlyError";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog, Spinner } from "@/components/ui/Dialog";

export default function LiteraturePage() {
  const { project } = useOutletContext<{ project: Project }>();
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [topOnly, setTopOnly] = useState(true);
  const [results, setResults] = useState<CandidatePaper[]>([]);
  const [recommendations, setRecommendations] = useState<CandidatePaper[]>([]);
  const [pending, setPending] = useState<CandidatePaper | null>(null);

  const searchMutation = useMutation({
    mutationFn: () =>
      api.searchLiterature(project.id, {
        query,
        sources: ["openalex", "arxiv"],
        limit: 60,
        top_venues_only: topOnly,
      }),
    onSuccess: (data) => setResults(data.papers),
    onError: (err) => showFriendlyError(err),
  });

  // Recommendations: rank the literature pool by TF-IDF similarity to the
  // project's interest profile (research direction + downloaded papers).
  const recommendMutation = useMutation({
    mutationFn: () => api.recommendLiterature(project.id),
    onSuccess: (data) => setRecommendations(data.papers),
    onError: (err) => showFriendlyError(err),
  });

  const downloadMutation = useMutation({
    mutationFn: (c: CandidatePaper) =>
      api.downloadPaper(project.id, { ...c, confirmed: true }),
    onError: (err) => showFriendlyError(err),
    onSuccess: (_data, candidate) => {
      // H3: use the candidate from the mutation variable instead of the stale
      // `pending` closure from render time.
      qc.invalidateQueries({ queryKey: ["papers", project.id] });
      qc.invalidateQueries({ queryKey: ["project", project.id] });
      const markDownloaded = (p: CandidatePaper) =>
        p.paper_id === candidate.paper_id ? { ...p, is_downloaded: true } : p;
      setResults((prev) => prev.map(markDownloaded));
      setRecommendations((prev) => prev.map(markDownloaded));
      setPending(null);
    },
  });

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-5">
      <h1 className="text-xl font-semibold tracking-tight">文献库</h1>

      <Card className="p-4">
        <div className="flex gap-2">
          <Input
            placeholder="搜索研究方向,例如:parameter efficient fine-tuning for VLMs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && query && searchMutation.mutate()}
          />
          <Button
            className="shrink-0 whitespace-nowrap"
            onClick={() => query && searchMutation.mutate()}
            disabled={searchMutation.isPending}
          >
            <Search className="h-4 w-4" />
            {searchMutation.isPending ? "搜索中…" : "搜索"}
          </Button>
        </div>
        <div className="flex items-center justify-between gap-2 mt-2 flex-wrap">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={topOnly} onChange={(e) => setTopOnly(e.target.checked)} />
            仅显示已验证顶会(CVPR/ICML/NeurIPS/AAAI/ACL 等)
          </label>
          <Button
            variant="outline"
            size="sm"
            onClick={() => recommendMutation.mutate()}
            disabled={recommendMutation.isPending}
            title="基于本项目研究方向与已下载论文,按相似度推荐最相关的论文"
          >
            <Sparkles className="h-4 w-4" />
            {recommendMutation.isPending ? "推荐中…" : "智能推荐相似论文"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          只检索元数据,不自动下载。选择论文后需确认才会下载到本地项目目录。
          「智能推荐」会按研究方向与已下载论文的文本相似度,给出几篇最相关的论文。
        </p>
      </Card>

      {recommendations.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h2 className="font-medium text-sm">为你推荐 · 按相似度排序</h2>
          </div>
          {recommendations.map((c) => (
            <PaperRow
              key={c.paper_id}
              c={c}
              projectId={project.id}
              onDownload={() => setPending(c)}
              recommend
            />
          ))}
        </div>
      )}

      {searchMutation.isPending && <Spinner />}

      <div className="space-y-2">
        {results.map((c) => (
          <PaperRow
            key={c.paper_id}
            c={c}
            projectId={project.id}
            onDownload={() => setPending(c)}
          />
        ))}
      </div>

      <ConfirmDialog
        open={!!pending}
        title="下载确认"
        busy={downloadMutation.isPending}
        description={
          pending && (
            <div className="space-y-1 text-sm">
              <div className="font-medium text-foreground line-clamp-2">{pending.title}</div>
              <div>来源:{pending.source}{pending.venue ? ` · ${pending.venue}` : ""}</div>
              <div className="text-xs break-all">PDF:{pending.pdf_url || "(无 URL)"}</div>
              <div className="text-xs">
                将下载到项目目录 literature/papers/{pending.paper_id}/,并自动抽取文本与 BibTeX。
              </div>
            </div>
          )
        }
        confirmLabel="确认下载"
        onCancel={() => setPending(null)}
        onConfirm={() => pending && downloadMutation.mutate(pending)}
      />
    </div>
  );
}

/** A single literature row. `recommend` shows the similarity badge. */
function PaperRow({
  c,
  projectId,
  onDownload,
  recommend = false,
}: {
  c: CandidatePaper;
  projectId: string;
  onDownload: () => void;
  recommend?: boolean;
}) {
  const similarityPct =
    c.similarity != null ? Math.max(0, Math.min(100, Math.round(c.similarity * 100))) : null;
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-medium leading-snug">{c.title}</div>
          <div className="text-sm text-muted-foreground mt-0.5">
            {c.authors.slice(0, 3).join(", ")}
            {c.authors.length > 3 ? " et al." : ""}
          </div>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {recommend && similarityPct != null && (
              <Badge className="bg-primary/10 text-primary" title="与本项目的文本相似度">
                相似度 {similarityPct}%
              </Badge>
            )}
            {[c.year, c.venue].filter(Boolean).map((x, i) => (
              <Badge key={i} className="bg-muted">
                {x}
              </Badge>
            ))}
            {c.venue_verified && (
              <Badge className="bg-accent text-accent-foreground">已验证顶会</Badge>
            )}
            {c.cited_by_count != null && (
              <Badge className="bg-muted">引用 {c.cited_by_count}</Badge>
            )}
            <Badge className="bg-muted">{c.source}</Badge>
            {c.arxiv_id && <Badge className="bg-muted">arXiv:{c.arxiv_id}</Badge>}
          </div>
          {c.abstract && (
            <p className="text-sm text-muted-foreground mt-2 line-clamp-3">{c.abstract}</p>
          )}
        </div>
        <div className="flex flex-col gap-2 shrink-0">
          {c.is_downloaded ? (
            <Link to={`/projects/${projectId}/papers/${c.paper_id}`}>
              <Button variant="outline" size="sm">
                <FileText className="h-4 w-4" /> 本地阅读
              </Button>
            </Link>
          ) : (
            <Button size="sm" disabled={!c.pdf_url} onClick={onDownload}>
              <Download className="h-4 w-4" /> 下载 PDF
            </Button>
          )}
          {c.source_url && (
            <a href={c.source_url} target="_blank" rel="noreferrer">
              <Button variant="ghost" size="sm">
                <ExternalLink className="h-4 w-4" /> 来源
              </Button>
            </a>
          )}
        </div>
      </div>
    </Card>
  );
}
