/**
 * Front-end label table for the 5-phase workflow.
 *
 * Iteration 4 — single source of truth, hydrated from the backend's
 * `/api/v1/experiments/phase-view` endpoint. The backend owns the
 * canonical copy in `app/experiments/states.py:STAGE_USER_VIEW`,
 * `EXPERIMENT_STATUS_ZH`, and `STAGE_STATUS_ZH` — the front-end
 * hydrates once per session and caches the response in localStorage
 * so the page never has a divergent label table from the backend.
 *
 * Until hydration completes, the `STAGE_LABELS_FALLBACK` table below
 * ships with the bundle so the first render uses sensible Chinese
 * labels (avoids showing raw `phase_0_scope` / `waiting_for_user`
 * enum keys during the hydration window).
 */

import { useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Type definitions matching the backend PhaseViewOut schema
// ---------------------------------------------------------------------------

export type PhaseKey =
  | "phase_0_scope"
  | "phase_1_plan"
  | "phase_2_build"
  | "phase_3_run"
  | "phase_4_report";

export interface PhaseViewItem {
  key: PhaseKey;
  name: string;
  summary: string;
  icon: string;
}

export interface PhaseView {
  phases: PhaseViewItem[];
  experiment_status_zh: Record<string, string>;
  stage_status_zh: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Fallback label table — shipped with the bundle, hydrated over
// ---------------------------------------------------------------------------

export const STAGE_LABELS_FALLBACK: Record<PhaseKey, { name: string; summary: string; icon: string }> = {
  phase_0_scope:  { name: "研究目标确认", summary: "明确本轮研究要解决的问题,并选择合适的参考基准。", icon: "Target" },
  phase_1_plan:   { name: "实验方案设计", summary: "制定首轮实验方法、对照方式和验证目标。", icon: "Compass" },
  phase_2_build:  { name: "实验代码准备", summary: "生成并检查可复现的实验代码与环境。", icon: "Code2" },
  phase_3_run:    { name: "首轮实验运行", summary: "执行实验并记录关键结果。", icon: "PlayCircle" },
  phase_4_report: { name: "结果分析与建议", summary: "分析结果并整理下一步研究建议。", icon: "FileText" },
};

export const EXPERIMENT_STATUS_LABELS_FALLBACK: Record<string, string> = {
  draft:        "草稿",
  running:      "正在进行",
  paused:       "已暂停",
  waiting_user: "等待你的确认",
  completed:    "已完成",
  failed:       "需要处理",
  archived:     "已归档",
};

export const STAGE_STATUS_LABELS_FALLBACK: Record<string, string> = {
  not_started:      "尚未开始",
  draft:            "草稿",
  waiting_for_user: "等待你的确认",
  approved:         "已通过",
  running:          "正在进行",
  paused:           "已暂停",
  completed:        "已完成",
  failed:           "需要处理",
  needs_revision:   "需要修改",
  skipped:          "已跳过",
  outdated:         "需要重新验证",
  archived:         "已归档",
};

// ---------------------------------------------------------------------------
// Cache key + fetch helper
// ---------------------------------------------------------------------------

const CACHE_KEY = "zsci.phase-view.v1";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — labels rarely change

interface CachedPhaseView {
  data: PhaseView;
  fetchedAt: number;
}

/**
 * Fetch and cache the phase-view document. Returns the live data when
 * available, otherwise the cached copy, otherwise the bundled fallback.
 *
 * The function is safe to call from anywhere; it caches in localStorage
 * so subsequent renders don't refetch.
 */
export async function fetchPhaseView(apiFetch: <T>(path: string, init?: RequestInit) => Promise<T>): Promise<PhaseView> {
  // Try cache first.
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as CachedPhaseView;
        if (Date.now() - parsed.fetchedAt < CACHE_TTL_MS) {
          return parsed.data;
        }
      }
    } catch {
      // localStorage unavailable / parse failed — fall through to fetch.
    }
  }
  try {
    const data = await apiFetch<PhaseView>("/api/v1/experiments/phase-view");
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(
          CACHE_KEY,
          JSON.stringify({ data, fetchedAt: Date.now() } satisfies CachedPhaseView),
        );
      } catch {
        // localStorage write quota — non-fatal.
      }
    }
    return data;
  } catch {
    // Network failure — return fallback so the UI always has labels.
    return {
      phases: Object.entries(STAGE_LABELS_FALLBACK).map(([key, v]) => ({
        key: key as PhaseKey,
        name: v.name,
        summary: v.summary,
        icon: v.icon,
      })),
      experiment_status_zh: EXPERIMENT_STATUS_LABELS_FALLBACK,
      stage_status_zh: STAGE_STATUS_LABELS_FALLBACK,
    };
  }
}

// ---------------------------------------------------------------------------
// React hook — caches in state, refetches on mount
// ---------------------------------------------------------------------------

export function usePhaseView(apiFetch?: <T>(path: string, init?: RequestInit) => Promise<T>): PhaseView {
  const [view, setView] = useState<PhaseView>(() => ({
    phases: Object.entries(STAGE_LABELS_FALLBACK).map(([key, v]) => ({
      key: key as PhaseKey,
      name: v.name,
      summary: v.summary,
      icon: v.icon,
    })),
    experiment_status_zh: EXPERIMENT_STATUS_LABELS_FALLBACK,
    stage_status_zh: STAGE_STATUS_LABELS_FALLBACK,
  }));
  useEffect(() => {
    let cancelled = false;
    // When apiFetch is omitted, use the global `fetch` and prepend the
    // /api/v1 base. This lets non-QueryClient callers (e.g. legacy
    // pages) hydrate the labels without wiring the React Query client.
    const fetcher: <T>(path: string, init?: RequestInit) => Promise<T> =
      apiFetch ?? (async <T,>(path: string, init?: RequestInit) => {
        const resp = await fetch(`/api/v1${path}`, {
          ...init,
          headers: { "Content-Type": "application/json", ...(init?.headers as Record<string, string> | undefined) },
        });
        if (!resp.ok) throw new Error(`${resp.status}`);
        return (await resp.json()) as T;
      });
    fetchPhaseView(fetcher).then((v) => {
      if (!cancelled) setView(v);
    });
    return () => {
      cancelled = true;
    };
    // apiFetch is intentionally omitted from deps: it's a stable
    // closure over the query client + base URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return view;
}

// ---------------------------------------------------------------------------
// Lookup helpers (always return a Chinese label, never the raw enum)
// ---------------------------------------------------------------------------

/** Look up the friendly Chinese label for an experiment status. Falls
 *  back to the raw enum if no label is registered (defensive — should
 *  never happen with a current backend). */
export function experimentStatusLabel(
  view: PhaseView,
  status: string | null | undefined,
): string {
  if (!status) return "";
  return view.experiment_status_zh[status] || EXPERIMENT_STATUS_LABELS_FALLBACK[status] || status;
}

/** Look up the friendly Chinese label for a stage status. */
export function stageStatusLabel(
  view: PhaseView,
  status: string | null | undefined,
): string {
  if (!status) return "";
  return view.stage_status_zh[status] || STAGE_STATUS_LABELS_FALLBACK[status] || status;
}

/** Look up the friendly Chinese name + summary for a phase key. */
export function phaseLabel(view: PhaseView, key: PhaseKey | string | null | undefined): {
  name: string;
  summary: string;
  icon: string;
} {
  const fallback = STAGE_LABELS_FALLBACK[key as PhaseKey];
  const hit = view.phases.find((p) => p.key === key);
  return hit
    ? { name: hit.name, summary: hit.summary, icon: hit.icon }
    : fallback || { name: String(key ?? ""), summary: "", icon: "Circle" };
}