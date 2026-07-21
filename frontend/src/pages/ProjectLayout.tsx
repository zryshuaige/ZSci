import { Link, Outlet, useParams, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Spinner } from "@/components/ui/Dialog";

export default function ProjectLayout() {
  const { projectId } = useParams<{ projectId: string }>();
  const location = useLocation();
  const { data: project, isLoading } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId!),
    enabled: !!projectId,
  });

  if (isLoading)
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  if (!project) return <div className="p-6">项目未找到</div>;

  const base = `/projects/${projectId}`;
  const items = [
    { to: base, label: "📊 概览", active: location.pathname === base },
    { to: `${base}/literature`, label: "📚 文献库", active: location.pathname.startsWith(`${base}/literature`) },
    { to: `${base}/papers`, label: "📄 PDF 阅读", active: location.pathname.startsWith(`${base}/papers`) },
    { to: `${base}/ideas`, label: "💡 研究想法", active: location.pathname.startsWith(`${base}/ideas`) },
    { to: `${base}/code`, label: "💻 代码", active: location.pathname.startsWith(`${base}/code`) },
    { to: `${base}/experiments`, label: "🧪 实验", active: location.pathname.startsWith(`${base}/experiments`) },
    { to: `${base}/writing`, label: "✍️ 写作", active: location.pathname.startsWith(`${base}/writing`) },
    { to: `${base}/agent`, label: "🤖 Agent 任务", active: location.pathname.startsWith(`${base}/agent`) },
  ];

  return (
    <div className="flex flex-col h-full">
      <header className="border-b border-border/60 glass-strong px-6 py-3 shrink-0">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <nav className="flex items-center gap-1 text-sm text-muted-foreground">
              <Link
                to="/"
                className="hover:text-foreground transition-colors duration-sm ease-out"
              >
                🗂️ 项目
              </Link>
              <ChevronRight className="h-3.5 w-3.5 opacity-60" />
              <span className="text-foreground font-medium truncate">{project.name}</span>
            </nav>
            {project.research_direction && (
              <p className="text-sm text-muted-foreground mt-0.5 line-clamp-1">{project.research_direction}</p>
            )}
          </div>
          <div className="text-sm text-muted-foreground shrink-0 ml-4">
            文献 {project.paper_count} · 已下载 {project.downloaded_count}
          </div>
        </div>
        <nav className="flex flex-wrap gap-2 mt-3 text-sm">
          {items.map((it) => (
            <Link
              key={it.to}
              to={it.to}
              className={cn(
                "px-3 py-1.5 rounded-full transition-[color,background-color] duration-sm ease-out hover:active:scale-[0.97]",
                it.active
                  ? "bg-primary text-primary-foreground font-medium"
                  : "bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground"
              )}
            >
              {it.label}
            </Link>
          ))}
        </nav>
      </header>
      {/* Content host. Pages fall into two shapes:
          - scrolling pages (Literature, Ideas, …) use `p-6` + natural height;
          - full-bleed pages (PDF reader, Writing) use `h-full` and manage
            their own scroll. `min-h-full` satisfies the scrolling pages while
            the flex child below still gets a concrete height for `h-full`. */}
      <div className="flex-1 min-h-0 overflow-auto">
        {/* Route transition: fade-in on sub-path change. */}
        <div key={location.pathname} className="h-full animate-fade-in">
          <Outlet context={{ project }} />
        </div>
      </div>
    </div>
  );
}
