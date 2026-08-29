/**
 * 全站唯一图标入口。
 *
 * 规范（见重构方案 §图标系统）：
 * - 页面/组件一律 `import { X } from "@/components/ui/icons"`，禁止直接
 *   import "lucide-react"（仅本文件例外）——保证未来换库/审计只动这里。
 * - 尺寸约定：行内/按钮内 `h-4 w-4`；页面头与空态主体 `h-5 w-5`；
 *   主 CTA 内图标 14px（h-3.5 w-3.5）左置。
 * - 图标按钮必须带 `aria-label`；纯装饰图标依赖下方默认 `aria-hidden`
 *   语义（lucide 输出 svg，无文本角色，无需额外处理）。
 * - 后端下发的图标名（STAGE_USER_VIEW.icon 等）必须走 `getStageIcon`
 *   白名单校验，未知名回落 Circle 并告警，禁止静默渲染错图。
 *
 * tree-shaking：仅具名 re-export，lucide-react 的 ESM 结构保证未引用
 * 图标不进产物。禁止 `import * as`（ESLint no-restricted-imports 守护）。
 */
export {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Award,
  BarChart3,
  BookOpen,
  Bot,
  Check,
  CheckCircle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleDashed,
  ClipboardList,
  Clock,
  Code2,
  Compass,
  Database,
  Download,
  ExternalLink,
  Eye,
  FileCode,
  FileText,
  FlaskConical,
  FolderInput,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Github,
  Home,
  Hourglass,
  Info,
  Languages,
  Lightbulb,
  ListChecks,
  Loader2,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  PenLine,
  Pencil,
  PencilLine,
  Play,
  PlayCircle,
  PlugZap,
  Plus,
  RefreshCcw,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Save,
  ScrollText,
  Search,
  SearchX,
  Settings,
  SkipForward,
  Sparkles,
  Square,
  Star,
  Target,
  Trash2,
  TrendingUp,
  X,
  XCircle,
} from "lucide-react";

export type { LucideIcon } from "lucide-react";

import {
  AlertTriangle,
  BookOpen,
  Bot,
  Circle,
  Code2,
  Compass,
  FileText,
  FlaskConical,
  Home,
  Lightbulb,
  PenLine,
  PlayCircle,
  Target,
  type LucideIcon,
} from "lucide-react";

/** 阶段/旅程图标的白名单注册表。key = 后端 STAGE_USER_VIEW.icon 名或
 *  前端语义名；值 = lucide 组件。新增合法名必须在这里登记。 */
const ICON_REGISTRY: Record<string, LucideIcon> = {
  // 后端 STAGE_USER_VIEW（/experiments/phase-view 下发）
  Target,
  Compass,
  Code2,
  PlayCircle,
  FileText,
  // 前端旅程/语义节点
  Overview: Home,
  BookOpen,
  Lightbulb,
  FlaskConical,
  PenLine,
  Bot,
  AlertTriangle,
  Circle,
};

/** 按名取图标；未知名回落 Circle 并在开发环境告警。 */
export function getIcon(name: string | undefined | null): LucideIcon {
  if (name) {
    const hit = ICON_REGISTRY[name];
    if (hit) return hit;
    if (import.meta.env.DEV) {
      console.warn(`[icons] unknown icon name "${name}", falling back to Circle`);
    }
  }
  return Circle;
}
