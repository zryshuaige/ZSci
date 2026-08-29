import { useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, qk, type Project } from "@/api";
import { FlaskConical, Settings, PanelLeftClose, PanelLeftOpen, FolderOpen, ChevronDown } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/Tooltip";
import { ErrorToastHost } from "@/components/ui/ErrorToast";
import WorkflowStatus from "./WorkflowStatus";
import BackendHealthBanner from "./BackendHealthBanner";
import JourneyRail from "./JourneyRail";

/** 从当前路径提取项目 id：/projects/:id/* 与 /explore/:id/*（流程页挂在
 *  项目框架内，同样拥有旅程轨道）。 */
function useCurrentProjectId(): string | null {
  const location = useLocation();
  const m =
    location.pathname.match(/^\/projects\/([^/]+)/) ??
    location.pathname.match(/^\/explore\/([^/]+)/);
  return m?.[1] ?? null;
}

export default function Layout() {
  const location = useLocation();
  const isProjects = location.pathname === "/" || location.pathname.startsWith("/projects/");
  const isSettings = location.pathname.startsWith("/settings");
  const projectId = useCurrentProjectId();
  // Collapsible global sidebar. Persisted in localStorage so the choice
  // survives reloads. Collapsed state shows icons only (w-14) to reclaim
  // horizontal space on narrow windows.
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("zsci:sidebar") === "collapsed",
  );
  const toggle = () => {
    setCollapsed((v) => {
      const next = !v;
      localStorage.setItem("zsci:sidebar", next ? "collapsed" : "expanded");
      return next;
    });
  };

  return (
    <div className="flex h-full">
      <aside
        className={cn(
          "shrink-0 border-r border-border/60 bg-sidebar text-sidebar-foreground flex flex-col transition-[width] duration-md ease-out z-chrome",
          collapsed ? "w-14" : "w-60",
        )}
      >
        <div className={cn("flex items-center h-14 border-b border-border/60", collapsed ? "justify-center px-2" : "gap-2 px-4")}>
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-indigo-500 text-white shadow-md shrink-0">
            <FlaskConical className="h-4 w-4" />
          </span>
          {!collapsed && <span className="font-semibold tracking-tight">Z-Sci</span>}
        </div>
        <nav className="p-2 space-y-1 text-sm">
          <NavLink
            to="/"
            active={isProjects}
            collapsed={collapsed}
            icon={<FolderOpen className="h-4 w-4" />}
            label="研究项目"
            description="所有研究项目"
          />
          <NavLink
            to="/settings"
            active={isSettings}
            collapsed={collapsed}
            icon={<Settings className="h-4 w-4" />}
            label="设置"
            description="模型与系统设置"
          />
        </nav>
        {/* 项目切换器 + 旅程轨道：只在项目上下文渲染。轨道数据与页面共享
            query 缓存，无独立轮询。 */}
        {projectId && (
          <div className={cn("border-b border-border/60", collapsed && "py-2")}>
            {!collapsed && <ProjectSwitcher currentId={projectId} />}
          </div>
        )}
        {projectId && (
          <div className={cn("min-h-0 overflow-y-auto", projectId && "shrink-0 max-h-[46%]", collapsed && "py-2")}>
            <JourneyRail projectId={projectId} collapsed={collapsed} />
          </div>
        )}
        {/* Global workflow status: lists every running task/run across all
            projects so navigating away from a workflow doesn't lose it. Click
            an item to jump back to its page. */}
        <div className={cn("flex-1 min-h-0 overflow-y-auto", collapsed && "py-2")}>
          <WorkflowStatus collapsed={collapsed} />
        </div>
        <Tooltip
          content={collapsed ? "展开侧栏" : "收起侧栏"}
          side="right"
          disabled={!collapsed}
        >
          <button
            onClick={toggle}
            className={cn(
              "flex items-center gap-2 p-3 text-xs text-sidebar-muted border-t border-white/[0.06] transition-colors duration-sm ease-out hover:text-white hover:bg-white/[0.06]",
              collapsed && "justify-center",
            )}
            aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
          >
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <><PanelLeftClose className="h-4 w-4" /> 收起</>}
          </button>
        </Tooltip>
      </aside>
      <main className="flex-1 min-h-0 overflow-auto flex flex-col">
        <BackendHealthBanner />
        {/* Route transition: fade-in on pathname change (sub-300ms, GPU-only).
            `h-full` so full-bleed pages (PDF reader, Writing) that use h-full
            resolve a concrete height instead of collapsing to content. */}
        <div key={location.pathname} className="flex-1 min-h-0 animate-fade-in">
          <Outlet />
        </div>
        {/* Phase A: global friendly-error toast host. Listens to the
            showFriendlyError queue from useFriendlyError.ts. Mounted once
            here so every page automatically gets toasts when its mutations
            call showFriendlyError. */}
        <ErrorToastHost />
      </main>
    </div>
  );
}

/** 项目切换器：当前项目名 + hover 下拉切换其他研究项目。 */
function ProjectSwitcher({ currentId }: { currentId: string }) {
  const navigate = useNavigate();
  const { data: projects } = useQuery({
    queryKey: qk.projects.all,
    queryFn: api.listProjects,
  });
  const { data: current } = useQuery({
    queryKey: qk.projects.one(currentId),
    queryFn: () => api.getProject(currentId),
  });
  const project: Project | undefined =
    current ?? projects?.find((p) => p.id === currentId);
  const others = (projects ?? []).filter((p) => p.id !== currentId);

  return (
    <div className="px-3 pt-3 pb-1">
      <p className="text-[11px] uppercase tracking-wide text-sidebar-muted mb-1 opacity-80">当前项目</p>
      <div className="relative group">
        <button
          className="w-full flex items-center gap-1.5 rounded-md bg-white/[0.08] px-2.5 py-1.5 text-sm font-medium text-white text-left"
          aria-label="切换研究项目"
          type="button"
        >
          <span className="truncate flex-1">{project?.name ?? "…"}</span>
          {others.length > 0 && <ChevronDown className="h-3.5 w-3.5 shrink-0 text-sidebar-muted" />}
        </button>
        {others.length > 0 && (
          <div className="absolute left-0 right-0 top-full mt-1 hidden group-hover:block z-dropdown rounded-md border border-white/10 bg-[#182136] shadow-float py-1">
            {others.map((p) => (
              <button
                key={p.id}
                type="button"
                className="w-full text-left px-2.5 py-1.5 text-sm text-sidebar-muted hover:text-white hover:bg-white/[0.06] truncate"
                onClick={() => navigate(`/projects/${p.id}`)}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface NavLinkProps {
  to: string;
  active: boolean;
  collapsed: boolean;
  icon: React.ReactNode;
  label: string;
  description?: string;
}

function NavLink({ to, active, collapsed, icon, label, description }: NavLinkProps) {
  // Show the rich tooltip on hover either way: when collapsed the icon alone
  // is meaningless, when expanded the description gives extra context (e.g.
  // "查看与管理所有研究项目") so first-time users don't need docs.
  const tooltipNode = (
    <Link
      to={to}
      className={cn(
        "flex items-center rounded-md transition-colors duration-sm ease-out active:scale-[0.97]",
        collapsed ? "justify-center h-9 w-9 mx-auto" : "gap-2 px-3 py-2",
        active
          ? "bg-white/[0.10] font-medium text-white shadow-sm"
          : "text-sidebar-muted hover:text-white hover:bg-white/[0.06]",
      )}
    >
      <span className="shrink-0 flex items-center justify-center">{icon}</span>
      {!collapsed && label}
    </Link>
  );
  return (
    <Tooltip
      content={description ?? label}
      side="right"
      disabled={!description}
    >
      {tooltipNode}
    </Tooltip>
  );
}
