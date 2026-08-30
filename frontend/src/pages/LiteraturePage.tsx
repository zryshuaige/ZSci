import { useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search,
  SearchX,
  Download,
  FileText,
  ExternalLink,
  Sparkles,
  FolderInput,
  BookOpen,
  ArrowRight,
} from "@/components/ui/icons";
import { api, qk, type CandidatePaper, type Project } from "@/api";
import { useToastMutation } from "@/lib/hooks/useToastMutation";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { ToneBadge } from "@/components/ui/StatusBadge";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Modal } from "@/components/ui/Modal";
import { ListSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";

export default function LiteraturePage() {
  const { project } = useOutletContext<{ project: Project }>();
  // 已收藏计数：与论文库共享缓存（下载成功后 invalidate 即时更新）。
  const { data: ownedPapers = [] } = useQuery({
    queryKey: qk.papers.byProject(project.id),
    queryFn: () => api.listPapers(project.id),
  });
  const ownedCount = ownedPapers.filter((p) => p.downloaded).length;
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [topOnly, setTopOnly] = useState(true);
  const [results, setResults] = useState<CandidatePaper[]>([]);
  // `searched` separates "还没搜索"(初始引导)from "搜过但 0 结果"(给换词建议)。
  const [searched, setSearched] = useState(false);
  const [recommendations, setRecommendations] = useState<CandidatePaper[]>([]);
  const [pending, setPending] = useState<CandidatePaper | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importPaths, setImportPaths] = useState("");

  // topOnly 走 mutation 变量而不是闭包:「取消顶会筛选并重搜」按钮在同一帧里
  // setTopOnly(false) + mutate(),闭包里的 topOnly 还是旧值。
  const searchMutation = useToastMutation({
    mutationFn: (opts: { topOnly?: boolean }) =>
      api.searchLiterature(project.id, {
        query: query.trim(),
        sources: ["openalex", "arxiv"],
        limit: 60,
        top_venues_only: opts.topOnly ?? topOnly,
      }),
    onSuccess: (data) => {
      setResults(data.papers);
      setSearched(true);
    },
  });

  // Recommendations: rank the literature pool by TF-IDF similarity to the
  // project's interest profile (research direction + downloaded papers).
  const recommendMutation = useToastMutation({
    mutationFn: () => api.recommendLiterature(project.id),
    onSuccess: (data) => setRecommendations(data.papers),
  });

  const downloadMutation = useToastMutation({
    mutationFn: (c: CandidatePaper) =>
      api.downloadPaper(project.id, { ...c, confirmed: true }),
    successMessage: "论文已下载到本地",
    onSuccess: (_data, candidate) => {
      // H3: use the candidate from the mutation variable instead of the stale
      // `pending` closure from render time.
      qc.invalidateQueries({ queryKey: qk.papers.byProject(project.id) });
      qc.invalidateQueries({ queryKey: qk.projects.one(project.id) });
      const markDownloaded = (p: CandidatePaper) =>
        p.paper_id === candidate.paper_id ? { ...p, is_downloaded: true } : p;
      setResults((prev) => prev.map(markDownloaded));
      setRecommendations((prev) => prev.map(markDownloaded));
      setPending(null);
    },
  });

  // 本地导入:后端按安全白名单只接受 下载/桌面/文档 目录下的 PDF(C7)。
  const importMutation = useToastMutation({
    mutationFn: (paths: string[]) => api.importLocalPapers(project.id, paths),
    successMessage: (data) => `已导入 ${data.imported} 篇论文`,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.papers.byProject(project.id) });
      setImportOpen(false);
      setImportPaths("");
    },
  });

  const importPathList = importPaths
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const runSearch = () => {
    if (query.trim()) searchMutation.mutate({});
  };

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-5">
      <PageHeader title="文献库" subtitle="检索、导入并管理项目论文" />

      <Card className="p-4">
        <div className="flex gap-2">
          <Input
            placeholder="搜索研究方向，例如 parameter efficient fine-tuning for VLMs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSearch()}
          />
          <Button
            className="shrink-0 whitespace-nowrap"
            onClick={runSearch}
            loading={searchMutation.isPending}
            disabled={!query.trim()}
          >
            <Search className="h-4 w-4" />
            搜索
          </Button>
        </div>
        <div className="flex items-center justify-between gap-2 mt-2 flex-wrap">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={topOnly} onChange={(e) => setTopOnly(e.target.checked)} />
            仅显示已验证顶会(CVPR/ICML/NeurIPS/AAAI/ACL 等)
          </label>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setImportOpen(true)}
              title="把本机已有的 PDF 导入项目文献库"
            >
              <FolderInput className="h-4 w-4" />
              导入本地论文
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => recommendMutation.mutate()}
              loading={recommendMutation.isPending}
              title="基于本项目研究方向与已下载论文，按相似度推荐最相关的论文"
            >
              <Sparkles className="h-4 w-4" />
              智能推荐相似论文
            </Button>
          </div>
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

      {/* 已收藏分区入口：下载完成的论文不会留在搜索结果里，这里给出
          「去哪找它们」的持久出口，避免「下载完就消失」的困惑。 */}
      {ownedCount > 0 && (
        <Link
          to={`/projects/${project.id}/papers`}
          className="flex items-center justify-between rounded-lg border border-border/60 bg-card px-4 py-3 hover:border-primary/25 hover:shadow-soft transition-all duration-sm"
        >
          <span className="flex items-center gap-2.5 text-sm">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-blue-50 text-blue-600">
              <BookOpen className="h-3.5 w-3.5" />
            </span>
            本项目已收藏 <b className="tabular-nums">{ownedCount}</b> 篇论文
          </span>
          <span className="text-xs text-primary flex items-center gap-1">
            去论文库阅读 <ArrowRight className="h-3.5 w-3.5" />
          </span>
        </Link>
      )}

      {/* 结果区三态:搜索中出骨架行;搜过但 0 结果给「换关键词/换源」专属
          空态;还没搜索时给初始引导。 */}
      {searchMutation.isPending ? (
        <ListSkeleton rows={4} />
      ) : searched && results.length === 0 ? (
        <EmptyState
          icon={<SearchX className="h-10 w-10" />}
          title="没有找到相关论文"
          subtitle={
            topOnly
              ? "试试更换关键词(英文术语命中率更高),或取消「仅显示已验证顶会」后重新搜索。"
              : "试试更换关键词(英文术语命中率更高),或缩短/改写检索词。"
          }
          action={
            topOnly ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setTopOnly(false);
                  searchMutation.mutate({ topOnly: false });
                }}
              >
                取消顶会筛选并重新搜索
              </Button>
            ) : undefined
          }
        />
      ) : !searched ? (
        <EmptyState
          icon={<Search className="h-10 w-10" />}
          title="输入关键词开始检索"
          subtitle="检索 OpenAlex 与 arXiv 的论文元数据；也可以直接把本机已有的 PDF 导入文献库。"
        />
      ) : (
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
      )}

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

      {/* 导入本地 PDF:Modal 表单(Enter 提交、Esc 关闭)。路径为空时禁用
          提交并给出提示,而不是点了没反应。 */}
      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="导入本地论文"
        busy={importMutation.isPending}
        onSubmit={() => {
          if (importPathList.length > 0) importMutation.mutate(importPathList);
        }}
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => setImportOpen(false)}
              disabled={importMutation.isPending}
            >
              取消
            </Button>
            <Button
              type="submit"
              loading={importMutation.isPending}
              disabled={importPathList.length === 0}
            >
              导入
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <Textarea
            rows={4}
            className="font-mono text-xs"
            placeholder={"每行一个 PDF 文件的完整路径，例如：\nC:\\Users\\you\\Downloads\\paper.pdf"}
            value={importPaths}
            onChange={(e) => setImportPaths(e.target.value)}
          />
          {importPathList.length === 0 ? (
            <div className="text-xs text-muted-foreground">请至少填写一个文件路径。</div>
          ) : (
            <div className="text-xs text-muted-foreground">将导入 {importPathList.length} 个文件。</div>
          )}
          <p className="text-xs text-muted-foreground">
            出于安全限制,仅支持导入「下载 / 桌面 / 文档」目录下的 PDF 文件。
          </p>
        </div>
      </Modal>
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
          <div className="text-xs text-muted-foreground mt-0.5">
            {c.authors.slice(0, 3).join(", ")}
            {c.authors.length > 3 ? " et al." : ""}
          </div>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {recommend && similarityPct != null && (
              <Badge className="bg-primary/10 text-primary" title="与本项目的文本相似度">
                相似度 {similarityPct}%
              </Badge>
            )}
            {c.year && <Badge className="bg-muted/70 text-[11px] tabular-nums">{c.year}</Badge>}
            {c.venue && (
              <Badge className="bg-muted/70 text-[11px] max-w-[10rem] truncate">{c.venue}</Badge>
            )}
            {c.venue_verified && (
              <ToneBadge tone="blue">已验证顶会</ToneBadge>
            )}
            {c.cited_by_count != null && (
              <Badge className="bg-muted/70 text-[11px] tabular-nums">引用 {c.cited_by_count}</Badge>
            )}
            <Badge className="bg-muted/70 text-[11px] max-w-[10rem] truncate">{c.source}</Badge>
            {c.arxiv_id && <Badge className="bg-muted/70 text-[11px]">arXiv:{c.arxiv_id}</Badge>}
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
