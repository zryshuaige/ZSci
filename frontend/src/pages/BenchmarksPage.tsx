import { useOutletContext } from "react-router-dom";
import type { Project } from "@/api";
import { PageHeader } from "@/components/ui/PageHeader";
import BenchmarksPanel from "@/components/BenchmarksPanel";

/**
 * 数据集基准页 —— 从实验工作台拆出的独立主业。
 *
 * 此前 BenchmarksPanel（搜索/入库/分组/关联实验的完整子系统）被塞在实验
 * 工作台左侧窄栏，需要用副标题文字解释布局。现在它拥有独立页面与旅程
 * 轨道入口（实验 → 数据集基准），实验工作台回归单一职责：实验列表。
 */
export default function BenchmarksPage() {
  const { project } = useOutletContext<{ project: Project }>();
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 px-6 pt-6 pb-3">
        <PageHeader
          title="数据集与基准"
          subtitle="搜索 HuggingFace 数据集与基准任务，确认后加入项目，并可关联到具体实验供自主实验选用。搜索结果默认不入库。"
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6">
        <BenchmarksPanel projectId={project.id} />
      </div>
    </div>
  );
}
