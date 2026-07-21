import { Link, useOutletContext } from "react-router-dom";
import { BookOpen, Download } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, type Project } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";

export default function ProjectOverview() {
  const { project } = useOutletContext<{ project: Project }>();
  const { data: papers, isLoading } = useQuery({
    queryKey: ["papers", project.id],
    queryFn: () => api.listPapers(project.id),
  });

  const downloaded = papers?.filter((p) => p.downloaded) ?? [];

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-5">
      <Card className="p-4">
        <div className="text-sm text-muted-foreground">研究方向</div>
        <div className="mt-1">{project.research_direction || "(未设定)"}</div>
        <div className="mt-3 text-xs text-muted-foreground font-mono break-all">
          {project.root_path}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <BookOpen className="h-4 w-4" /> 文献总数
          </div>
          {isLoading
            ? <Skeleton className="h-8 w-16 mt-1.5" />
            : <div className="text-3xl font-semibold mt-1 tabular-nums">{papers?.length ?? 0}</div>}
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Download className="h-4 w-4" /> 已下载
          </div>
          {isLoading
            ? <Skeleton className="h-8 w-16 mt-1.5" />
            : <div className="text-3xl font-semibold mt-1 tabular-nums">{downloaded.length}</div>}
        </Card>
      </div>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-medium">最近下载</h3>
          <Link to={`/projects/${project.id}/literature`}>
            <Button variant="outline" size="sm">去文献库</Button>
          </Link>
        </div>
        {downloaded.length === 0 ? (
          <div className="text-sm text-muted-foreground">还没有下载论文。</div>
        ) : (
          <ul className="divide-y divide-border">
            {downloaded.slice(0, 5).map((p) => (
              <li key={p.id} className="py-2">
                <Link to={`/projects/${project.id}/papers/${p.id}`} className="hover:underline">
                  <div className="text-sm font-medium line-clamp-1">{p.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {[p.year, p.venue].filter(Boolean).join(" · ")}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
