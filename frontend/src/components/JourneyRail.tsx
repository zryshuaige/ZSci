import { memo } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQueries } from "@tanstack/react-query";
import { api, qk } from "@/api";
import { cn } from "@/lib/cn";
import { getIcon, type LucideIcon } from "@/components/ui/icons";
import { Tooltip } from "@/components/ui/Tooltip";
import { Spinner } from "@/components/ui/Dialog";

/**
 * JourneyRail — 侧栏「旅程轨道」：把研究旅程（概览→文献→想法→实验→写作→助手）
 * 变成一级导航。每个阶段节点自带：
 *   - 状态点   ✓ 已有内容 / ● 旅程当前站（pulse）/ ○ 未开始
 *   - 计数徽标 数据来自与页面共享的 query 缓存（访问过概览即为免费）
 *   - 活动微标 ⟳ 有运行中实验 / ⚠ 有等待确认的实验（来自 experiments 列表
 *              的 overall_status，不额外轮询）
 *   - 子节点   原 8 个平级 Tab 归组为 文献 / 实验 两组，展开即达
 *   - 激活竖线 当前路由对应的节点左侧高亮指示
 *
 * 数据策略：一次 useQueries 拉 4 个列表（与 ProjectOverview / 旧 JourneyNav
 * 完全同 key），节点组件 memo —— 侧栏不会因为页面轮询而重渲染。
 */

interface RailChild {
  to: string;
  label: string;
  match: (path: string) => boolean;
  badge?: string | number;
}

interface RailNode {
  key: string;
  label: string;
  icon: string; // ICON_REGISTRY key → getIcon()
  to: string;
  match: (path: string) => boolean;
  count: number;
  running?: boolean; // ⟳ 运行中实验
  attention?: boolean; // ⚠ 等待确认
  children?: RailChild[];
}

function RailNodeRow({ node, collapsed }: { node: RailNode; collapsed: boolean }) {
  const Icon = getIcon(node.icon);
  const done = node.count > 0;

  const row = (
    <Link
      to={node.to}
      className={cn(
        "group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors duration-sm ease-out active:scale-[0.98]",
        "hover:bg-white/[0.06]",
        collapsed && "justify-center px-0",
      )}
    >
      {/* 激活竖线 */}
      <span
        className={cn(
          "absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-full bg-primary transition-all duration-md",
          node.match(location.pathname) ? "h-5 opacity-100" : "h-0 opacity-0",
        )}
      />
      <span className="relative shrink-0">
        <Icon className={cn("h-4 w-4", node.match(location.pathname) ? "text-primary" : "text-sidebar-muted group-hover:text-white")} />
        {/* 状态点叠加在图标右下 */}
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-[#182136]",
            done ? "bg-primary" : "bg-white/25",
          )}
        />
      </span>
      {!collapsed && (
        <>
          <span
            className={cn(
              "flex-1 truncate",
              node.match(location.pathname)
                ? "text-white font-medium"
                : done
                  ? "text-sidebar-foreground"
                  : "text-sidebar-muted",
            )}
          >
            {node.label}
          </span>
          {node.running && <PulseDot label="运行中" tone="primary" />}
          {node.attention && <PulseDot label="待确认" tone="amber" />}
          {node.count > 0 && (
            <span className="text-[11px] tabular-nums text-sidebar-muted">{node.count}</span>
          )}
        </>
      )}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip content={`${node.label}${node.count ? ` (${node.count})` : ""}`} side="right">
        {row}
      </Tooltip>
    );
  }
  return row;
}

/** 活动微标：实心小圆 + hover tooltip。 */
function PulseDot({ label, tone }: { label: string; tone: "primary" | "amber" }) {
  return (
    <Tooltip content={label} side="right">
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full shrink-0",
          tone === "primary" ? "bg-primary animate-pulse" : "bg-amber-500",
        )}
      />
    </Tooltip>
  );
}

const MemoNodeRow = memo(RailNodeRow);
const MemoChildLink = memo(function RailChildLink({ child }: { child: RailChild }) {
  const active = child.match(location.pathname);
  return (
    <Link
      to={child.to}
      className={cn(
        "block rounded-md py-1.5 pl-10 pr-2 text-[13px] transition-colors duration-sm ease-out truncate",
        active
          ? "text-white font-medium bg-white/[0.08]"
          : "text-sidebar-muted hover:text-white hover:bg-white/[0.05]",
      )}
    >
      {child.label}
      {child.badge != null && (
        <span className="float-right text-[11px] tabular-nums opacity-70">{child.badge}</span>
      )}
    </Link>
  );
});

export default function JourneyRail({
  projectId,
  collapsed,
}: {
  projectId: string;
  collapsed: boolean;
}) {
  const location = useLocation();
  const base = `/projects/${projectId}`;

  // 与 ProjectOverview 完全同 key 的 4 个列表 query（缓存共享）。
  const results = useQueries({
    queries: [
      { queryKey: qk.papers.byProject(projectId), queryFn: () => api.listPapers(projectId) },
      { queryKey: qk.ideas.byProject(projectId), queryFn: () => api.listIdeas(projectId) },
      { queryKey: qk.experiments.byProject(projectId), queryFn: () => api.listExperiments(projectId) },
      { queryKey: qk.writing.files(projectId), queryFn: () => api.listWritingFiles(projectId) },
    ],
  });

  const loading = results.some((r) => r.isLoading);
  const paperCount = results[0].data?.length ?? 0;
  const ideaCount = results[1].data?.length ?? 0;
  const exps = results[2].data ?? [];
  const writingCount = results[3].data?.files.length ?? 0;
  const expRunning = exps.some((e: { overall_status?: string }) => e.overall_status === "running");
  const expAttention = exps.some(
    (e: { overall_status?: string }) => e.overall_status === "waiting_user",
  );

  if (loading && collapsed) {
    // 折叠态无空间放骨架，静默即可；展开态由下方 Spinner 提示。
    return <div className="p-2" />;
  }
  if (loading) {
    return (
      <div className="flex justify-center py-6 text-sidebar-muted">
        <Spinner />
      </div>
    );
  }

  const nodes: RailNode[] = [
    {
      key: "overview",
      label: "概览",
      icon: "Overview",
      to: base,
      count: 1, // 概览恒为「可达」——不算旅程进度
      match: (p) => p === base,
    },
    {
      key: "literature",
      label: "文献",
      icon: "BookOpen",
      to: `${base}/literature`,
      count: paperCount,
      match: (p) => p.startsWith(`${base}/literature`) || p.startsWith(`${base}/papers`),
      children: [
        { to: `${base}/literature`, label: "检索文献", match: (p) => p.startsWith(`${base}/literature`) },
        { to: `${base}/papers`, label: "已下载", match: (p) => p.startsWith(`${base}/papers`), badge: paperCount || undefined },
      ],
    },
    {
      key: "ideas",
      label: "想法",
      icon: "Lightbulb",
      to: `${base}/ideas`,
      count: ideaCount,
      match: (p) => p.startsWith(`${base}/ideas`),
    },
    {
      key: "experiments",
      label: "实验",
      icon: "FlaskConical",
      to: `${base}/experiments`,
      count: exps.length,
      running: expRunning,
      attention: expAttention,
      match: (p) =>
        p.startsWith(`${base}/experiments`) ||
        p.startsWith(`${base}/code`) ||
        p.startsWith(`${base}/benchmarks`) ||
        p.startsWith(`${base}/explore`) ||
        /\/experiments\/[^/]+\/(preview|result)$/.test(p),
      children: [
        { to: `${base}/experiments`, label: "实验列表", match: (p) => p.startsWith(`${base}/experiments`) },
        { to: `${base}/benchmarks`, label: "数据集基准", match: (p) => p.startsWith(`${base}/benchmarks`) },
        { to: `${base}/code`, label: "代码仓库", match: (p) => p.startsWith(`${base}/code`) },
      ],
    },
    {
      key: "writing",
      label: "写作",
      icon: "PenLine",
      to: `${base}/writing`,
      count: writingCount,
      match: (p) => p.startsWith(`${base}/writing`),
    },
    {
      key: "agent",
      label: "助手",
      icon: "Bot",
      to: `${base}/agent`,
      count: 0,
      match: (p) => p.startsWith(`${base}/agent`),
    },
  ];

  // 旅程当前站：第一个有内容的进展指标（文献→想法→实验→写作 中第一个 0 计数）。
  const journey = [nodes[1], nodes[2], nodes[3], nodes[4]];
  const currentKey = journey.find((n) => n.count === 0)?.key;

  return (
    <nav aria-label="研究旅程" className="px-1.5 py-2 space-y-0.5">
      {nodes.map((n) => (
        <div key={n.key}>
          <MemoNodeRow
            node={{
              ...n,
              // 概览节点无进度语义，不显示计数徽标
              count: n.key === "overview" ? 0 : n.count,
            }}
            collapsed={collapsed}
          />
          {!collapsed &&
            n.children?.some((c) => c.match(location.pathname)) &&
            n.children.map((c) => <MemoChildLink key={c.to} child={c} />)}
        </div>
      ))}
      {/* 旅程当前站：只有展开态显示这一行提示，告诉用户「下一步去哪」。 */}
      {!collapsed && currentKey && currentKey !== "agent" && (
        <p className="px-2.5 pt-2 text-[11px] leading-4 text-sidebar-muted">
          下一步：
          <Link
            to={journey.find((n) => n.key === currentKey)!.to}
            className="text-primary hover:underline"
          >
            {journey.find((n) => n.key === currentKey)!.label}
          </Link>
        </p>
      )}
    </nav>
  );
}

export type { RailNode, LucideIcon };
