import { Link, Outlet, useParams, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FolderOpen, SearchX } from "@/components/ui/icons";
import { api, qk } from "@/api";
import { Spinner } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";

/**
 * 项目框架：面包屑行 + 内容区。
 *
 * 导航已升级为侧栏 JourneyRail（旅程轨道）：原 8 个平级 Tab 与 JourneyNav
 * 旅程条全部移除，归组进轨道节点（文献：检索/已下载；实验：列表/代码仓库）。
 * 本 header 只保留位置感（面包屑 + 研究方向）。
 */
export default function ProjectLayout() {
  const { projectId } = useParams<{ projectId: string }>();
  const location = useLocation();
  const { data: project, isLoading } = useQuery({
    queryKey: qk.projects.one(projectId!),
    queryFn: () => api.getProject(projectId!),
    enabled: !!projectId,
  });

  if (isLoading)
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  if (!project)
    return (
      <div className="p-6">
        <EmptyState
          icon={<SearchX className="h-5 w-5" />}
          title="项目不存在或已被删除"
          subtitle="它可能已被删除，或链接已过期"
          action={
            <Link to="/">
              <Button variant="outline" size="sm">返回项目列表</Button>
            </Link>
          }
        />
      </div>
    );

  return (
    <div className="flex flex-col h-full">
      <header className="relative z-chrome bg-background border-b border-border/60 px-6 py-2.5 shrink-0">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <nav className="flex items-center gap-1 text-sm text-muted-foreground">
              <Link
                to="/"
                className="inline-flex items-center gap-1 hover:text-foreground transition-colors duration-sm ease-out"
              >
                <FolderOpen className="h-3.5 w-3.5" /> 研究项目
              </Link>
              <ChevronRight className="h-3.5 w-3.5 opacity-60" />
              <span className="text-foreground font-medium truncate">{project.name}</span>
            </nav>
            {project.research_direction && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{project.research_direction}</p>
            )}
          </div>
        </div>
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
