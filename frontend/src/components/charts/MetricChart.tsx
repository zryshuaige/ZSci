import ReactECharts from "./EChart";
import { useMemo, useState } from "react";
import type { Metric } from "@/lib/api";
import { CHART_AXIS, CHART_GRID, CHART_SERIES } from "@/lib/chartTokens";

/** Multi-series metric line chart (one series per metric_name) with a log/linear
 * toggle. Replaces the hand-rolled SVG chart so we get tooltip, dataZoom, and
 * axis zoom for free. design.md §166 recommends ECharts/Plotly for experiment
 * curves. */
export function MetricChart({ metrics }: { metrics: Metric[] }) {
  const [logScale, setLogScale] = useState(false);
  const allPositive = metrics.every((m) => m.metric_value > 0);
  const useLog = logScale && allPositive;

  // Memoize the option so a parent re-render (e.g. the 2s runs refetchInterval)
  // doesn't rebuild it and, with notMerge, blow away the user's dataZoom/pan.
  const option = useMemo(() => {
    const byName: Record<string, { step: number; v: number }[]> = {};
    for (const m of metrics) {
      (byName[m.metric_name] ||= []).push({ step: m.step, v: m.metric_value });
    }
    const series = Object.keys(byName).map((n) => ({
      name: n,
      type: "line" as const,
      smooth: true,
      showSymbol: false,
      data: byName[n].map((p) => [p.step, p.v]),
    }));
    return {
      grid: { left: 56, right: 16, top: 16, bottom: 40 },
      tooltip: { trigger: "axis" },
      legend: { bottom: 0, type: "scroll" as const, textStyle: { fontSize: 10, color: CHART_AXIS } },
      xAxis: {
        type: "value" as const,
        name: "step",
        nameTextStyle: { fontSize: 10, color: CHART_AXIS },
        axisLabel: { fontSize: 10, color: CHART_AXIS },
      },
      yAxis: {
        type: useLog ? "log" : ("value" as const),
        axisLabel: { fontSize: 10, color: CHART_AXIS },
        splitLine: { lineStyle: { color: CHART_GRID } },
      },
      dataZoom: [{ type: "inside" }, { type: "slider", height: 14, bottom: 22 }],
      color: CHART_SERIES,
      series,
    };
  }, [metrics, useLog]);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs text-muted-foreground">指标曲线({metrics.length} 点)</div>
        <button
          className="text-xs px-2 py-0.5 rounded border border-border hover:bg-muted disabled:opacity-40"
          onClick={() => setLogScale((s) => !s)}
          disabled={!allPositive}
          title={allPositive ? "切换对数坐标" : "含非正值，无法使用对数坐标"}
        >
          {useLog ? "线性" : "对数"}
        </button>
      </div>
      <ReactECharts option={option} style={{ height: 240, width: "100%" }} />
    </div>
  );
}

/** Overlay multiple runs' metric curves so runs can be compared visually. Each
 * run contributes one series per metric_name (named `runId · metric`). */
export function CompareChart({ runsMetrics }: { runsMetrics: { runId: string; metrics: Metric[] }[] }) {
  const [logScale, setLogScale] = useState(false);
  const allPositive = runsMetrics.every((rm) => rm.metrics.every((m) => m.metric_value > 0));
  const useLog = logScale && allPositive;
  const shortId = (id: string) => id.slice(0, 8);

  const { option, seriesCount } = useMemo(() => {
    const series: object[] = [];
    for (const rm of runsMetrics) {
      const byName: Record<string, { step: number; v: number }[]> = {};
      for (const m of rm.metrics) (byName[m.metric_name] ||= []).push({ step: m.step, v: m.metric_value });
      for (const [name, pts] of Object.entries(byName)) {
        series.push({
          name: `${shortId(rm.runId)} · ${name}`,
          type: "line",
          smooth: true,
          showSymbol: false,
          data: pts.map((p) => [p.step, p.v]),
        });
      }
    }
    return {
      seriesCount: series.length,
      option: {
        grid: { left: 56, right: 16, top: 16, bottom: 48 },
        tooltip: { trigger: "axis" },
        legend: { bottom: 0, type: "scroll", textStyle: { fontSize: 10, color: CHART_AXIS } },
        xAxis: {
          type: "value",
          name: "step",
          nameTextStyle: { fontSize: 10, color: CHART_AXIS },
          axisLabel: { fontSize: 10, color: CHART_AXIS },
        },
        yAxis: {
          type: useLog ? "log" : "value",
          axisLabel: { fontSize: 10, color: CHART_AXIS },
          splitLine: { lineStyle: { color: CHART_GRID } },
        },
        dataZoom: [{ type: "inside" }, { type: "slider", height: 14, bottom: 30 }],
        color: CHART_SERIES,
        series,
      },
    };
  }, [runsMetrics, useLog]);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs text-muted-foreground">多 run 叠加</div>
        <button
          className="text-xs px-2 py-0.5 rounded border border-border hover:bg-muted disabled:opacity-40"
          onClick={() => setLogScale((s) => !s)}
          disabled={!allPositive || runsMetrics.length === 0}
          title={allPositive ? "切换对数坐标" : "含非正值，无法使用对数坐标"}
        >
          {useLog ? "线性" : "对数"}
        </button>
      </div>
      {seriesCount > 0 ? (
        <ReactECharts option={option} style={{ height: 260, width: "100%" }} />
      ) : (
        <div className="text-xs text-muted-foreground py-8 text-center">所选 run 暂无指标</div>
      )}
    </div>
  );
}
