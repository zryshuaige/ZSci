import { useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { FlaskConical, Settings, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/cn";
import WorkflowStatus from "./WorkflowStatus";

export default function Layout() {
  const location = useLocation();
  const isProjects = location.pathname === "/" || location.pathname.startsWith("/projects/");
  const isSettings = location.pathname.startsWith("/settings");
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
          "shrink-0 border-r border-border/60 glass flex flex-col transition-[width] duration-md ease-out",
          collapsed ? "w-14" : "w-56",
        )}
      >
        <div className={cn("flex items-center h-14 border-b border-border/60", collapsed ? "justify-center px-2" : "gap-2 px-4")}>
          <FlaskConical className="h-5 w-5 text-primary shrink-0" />
          {!collapsed && <span className="font-semibold tracking-tight">Z-Sci</span>}
        </div>
        <nav className="p-2 space-y-1 text-sm">
          <NavLink to="/" active={isProjects} collapsed={collapsed} icon="🗂️" label="项目" />
          <NavLink to="/settings" active={isSettings} collapsed={collapsed} icon={<Settings className="h-4 w-4" />} label="设置" />
        </nav>
        {/* Global workflow status: lists every running task/run across all
            projects so navigating away from a workflow doesn't lose it. Click
            an item to jump back to its page. */}
        <div className={cn("flex-1 min-h-0 overflow-y-auto", collapsed && "py-2")}>
          <WorkflowStatus collapsed={collapsed} />
        </div>
        <button
          onClick={toggle}
          className={cn(
            "flex items-center gap-2 p-3 text-xs text-muted-foreground border-t border-border/60 transition-colors duration-sm ease-out hover:text-foreground",
            collapsed && "justify-center",
          )}
          title={collapsed ? "展开侧栏" : "收起侧栏"}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <><PanelLeftClose className="h-4 w-4" /> 收起</>}
        </button>
      </aside>
      <main className="flex-1 min-h-0 overflow-auto">
        {/* Route transition: fade-in on pathname change (sub-300ms, GPU-only).
            `h-full` so full-bleed pages (PDF reader, Writing) that use h-full
            resolve a concrete height instead of collapsing to content. */}
        <div key={location.pathname} className="h-full animate-fade-in">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function NavLink({
  to,
  active,
  collapsed,
  icon,
  label,
}: {
  to: string;
  active: boolean;
  collapsed: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      to={to}
      title={collapsed ? label : undefined}
      className={cn(
        "flex items-center rounded-md transition-colors duration-sm ease-out hover:bg-muted active:scale-[0.97]",
        collapsed ? "justify-center h-9 w-9 mx-auto" : "gap-2 px-3 py-2",
        active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <span className="shrink-0 flex items-center justify-center">{icon}</span>
      {!collapsed && label}
    </Link>
  );
}
