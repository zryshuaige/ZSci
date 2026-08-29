/**
 * 按需注册的 ECharts 入口 —— 全站唯一的 echarts 挂载点。
 *
 * 此前 `echarts-for-react` 全量引入 echarts（bundle ~1MB）。这里改用
 * echarts/core + 仅注册实际用到的渲染器/图表/组件，配合 ReactECharts
 * 的 echarts prop 注入，产物体积显著下降且功能不变。
 */
import * as echarts from "echarts/core";
import { LineChart, BarChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import ReactEChartsCore from "echarts-for-react/lib/core";

echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  CanvasRenderer,
]);

/** 与 echarts-for-react 的默认导出同形，但基于按需注册的 core。 */
export default function EChart(props: React.ComponentProps<typeof ReactEChartsCore>) {
  return <ReactEChartsCore echarts={echarts} {...props} />;
}
