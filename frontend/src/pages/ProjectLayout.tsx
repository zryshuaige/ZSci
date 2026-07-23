import { Link, Outlet, useParams, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, BarChart3, BookOpen, FileText, Lightbulb, Code2, FlaskConical, PenLine, Bot } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Spinner } from "@/components/ui/Dialog";
import { Tooltip } from "@/components/ui/Tooltip";

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
    { to: base, label: "概览", icon: BarChart3, desc: "项目总览与进度", active: location.pathname === base },
    { to: `${base}/literature`, label: "文献库", icon: BookOpen, desc: "检索与管理论文", active: location.pathname.startsWith(`${base}/literature`) },
    { to: `${base}/papers`, label: "PDF 阅读", icon: FileText, desc: "阅读与批注 PDF", active: location.pathname.startsWith(`${base}/papers`) },
    { to: `${base}/ideas`, label: "研究想法", icon: Lightbulb, desc: "假设与研究灵感", active: location.pathname.startsWith(`${base}/ideas`) },
    { to: `${base}/code`, label: "代码", icon: Code2, desc: "相关代码仓库", active: location.pathname.startsWith(`${base}/code`) },
    { to: `${base}/experiments`, label: "实验", icon: FlaskConical, desc: "创建、运行与对比实验", active: location.pathname.startsWith(`${base}/experiments`) },
    { to: `${base}/writing`, label: "写作", icon: PenLine, desc: "论文与报告写作", active: location.pathname.startsWith(`${base}/writing`) },
    { to: `${base}/agent`, label: "研究助手", icon: Bot, desc: "智能分析与生成任务", active: location.pathname.startsWith(`${base}/agent`) },
  ];

  return (
    <div className="flex flex-col h-full">
      <header className="relative z-chrome border-b border-border/60 glass-strong px-6 py-3 shrink-0">
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
        <nav className="flex flex-wrap gap-1.5 mt-3 text-sm">
          {items.map((it) => {
            const Icon = it.icon;
            return (
              <Tooltip key={it.to} content={it.desc} side="bottom">
                <Link
                  to={it.to}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-[color,background-color] duration-sm ease-out active:scale-[0.97]",
                    it.active
                      ? "bg-primary text-primary-foreground font-medium"
                      : "bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {it.label}
                </Link>
              </Tooltip>
            );
          })}
        </nav>
      </header>
      {/* Content host. Pages fall into two shapes:
          - scrolling pages (Literature, Ideas, …) use `p-6` + natural height;
          - full-bleed pages (PDF reader, Writing) use `h-full` and manage
            their own scroll. `min-h-full` satisfies the scrolling pages while
            the flex child below still gets a concrete height for `h-full`.
          `relative z-0` so cards inside pages that use `hover-lift` or
          `animate-slide-up` (transform creates a stacking context) don't
          paint over the header above. */}
      <div className="relative z-0 flex-1 min-h-0 overflow-auto">
        {/* Route transition: fade-in on sub-path change. */}
        <div key={location.pathname} className="h-full animate-fade-in">
          <Outlet context={{ project }} />
        </div>
      </div>
    </div>
  );
}

