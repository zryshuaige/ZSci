// 内部事件消息 → 用户可读文案（全站共用）。
//
// 后端 AgentTaskEvent.message 里历史数据带内部代码（phase_0_scope、
// "checkpoint:" 前缀、"下游 outdated" 等），已入库的行无法重写，所以
// 前端渲染前统一过一遍这里。orchestrator 现在已直出人话，本工具主要
// 兜底历史数据；侧栏状态卡、实验工作日志、助手页进度记录共用。

/** 5 个实验阶段的内部键 → 中文名（与后端 STAGE_NAME_ZH 对齐）。 */
export const STAGE_KEY_ZH: Record<string, string> = {
  phase_0_scope: "需求与基准",
  phase_1_plan: "方案设计",
  phase_2_build: "代码与自检",
  phase_3_run: "运行实验",
  phase_4_report: "分析与报告",
};

export function stageKeyZh(key: string | null | undefined): string {
  if (!key) return "";
  return STAGE_KEY_ZH[key] ?? key;
}

export function humanizeEventMessage(msg: string | null | undefined): string {
  if (!msg) return "";
  let out = msg;
  // 1. 内部阶段键 → 中文名（后续句式改写依赖这一步先落地）
  out = out.replace(/phase_[0-9a-z_]+/g, (m) => STAGE_KEY_ZH[m] ?? m);
  // 2. 历史消息的固定句式 → 人话；完整句式优先于前缀剥离
  out = out
    .replace(/5 阶段交互式实验开始/, "自动化实验已启动（共 5 个阶段）")
    .replace(
      /^决策\s+(\S+?)[:：]\s*(.+?)\s*→\s*(继续下一阶段|停止实验)$/,
      (_m, dec: string, stage: string, tail: string) => {
        const verb =
          dec === "approve" ? "确认通过" : dec === "edit" ? "要求修改"
          : dec === "skip" ? "选择跳过" : dec === "abort" ? "选择结束" : dec;
        return `你${verb}了「${stage}」,${tail === "继续下一阶段" ? "流程继续进入下一阶段" : "实验到此停止"}`;
      },
    )
    .replace(/^checkpoint:\s*(.+?)\s*等待用户决策$/, "「$1」已完成,等待你的确认")
    .replace(/^checkpoint:\s*/, "等待你的确认:")
    .replace(/^optional checkpoint:\s*(.+)$/, "「$1」已完成（无需确认,自动继续）")
    .replace(/^恢复等待决策:\s*(.+)$/, "继续等待你的确认:「$1」")
    .replace(/^阶段:\s*/, "开始执行:")
    .replace(/^阶段\s*(.+?)\s*完成[:：]\s*(.+)$/, "$2 已完成")
    .replace(
      /下游\s*(\S+)\s*因\s*(\S+)\s*跳过而被标记为\s*outdated/,
      "你跳过了「$2」,后续的「$1」需要重做",
    );
  // 3. 括号内与正文重复的中文名去重:「需求与基准 (需求与基准)」→「需求与基准」
  out = out.replace(/^(.+?)\s*[（(]([^（）()]*)[)）]\s*$/, (m, head: string, inner: string) =>
    head.includes(inner) ? head : m,
  );
  return out;
}
