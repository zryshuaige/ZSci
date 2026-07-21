# Z-Sci Agent：本地计算机科研智能体项目设计方案

> **版本**：v1.1  
> **部署模式**：本地单机优先，可选局域网部署  
> **Agent 模式**：以调用外部/本地兼容 API 为主，不要求本地部署大模型  
> **目标用户**：计算机科学研究生、科研工程师、实验室研究团队  
> **核心目标**：围绕一个研究方向，完成论文检索、选择性下载、本地阅读、研究思路整理、实验创建与运行、结果分析、LaTeX 写作的科研闭环。

---

## 1. 项目目标

用户输入一个研究方向，例如：

```text
面向视觉语言模型的参数高效微调与鲁棒性研究
```

系统创建一个独立科研项目，并在本地工作区中生成完整目录。之后用户可以：

1. 搜索该方向的顶会/顶刊论文；
2. 浏览论文元数据、摘要、会议、年份、作者、代码链接；
3. **由用户主动选择某篇论文下载到本地项目目录**；
4. 已下载的论文可以直接在系统中浏览 PDF；
5. 对 PDF 进行翻译、批注、摘录、问答、生成阅读笔记；
6. 基于本地下载的论文和用户选择的论文，归纳近年研究路线；
7. 在“实验设计”中输入实验想法；
8. 由 Agent 参考论文、优先参考官方代码仓库，生成实验代码设计方案；
9. 用户确认后，在本地生成 Python 实验项目目录；
10. 管理 Python 环境、依赖、训练命令、日志、指标、图表、模型权重；
11. 基于已下载论文和真实实验结果辅助撰写 LaTeX 论文。

---

# 2. 产品原则

## 2.1 本地优先

以下内容默认保存在用户电脑本地：

- 项目目录；
- 用户下载的 PDF；
- 文献笔记；
- 实验代码；
- 实验日志；
- 模型权重；
- 训练曲线；
- LaTeX 论文；
- 数据集 manifest；
- 项目数据库；
- Agent 的任务审计记录。

系统不应默认上传用户的论文、代码、实验结果或数据集。

---

## 2.2 用户选择后再下载论文

文献搜索阶段只获取元数据，不自动批量下载 PDF。

用户在文献列表中点击：

```text
下载 PDF
```

后，系统才将该论文下载到当前项目目录。

下载后的论文路径示例：

```text
projects/
└── vlm-efficient-finetuning/
    └── literature/
        └── papers/
            └── paper_cvpr_2024_xxx/
                ├── paper.pdf
                ├── metadata.json
                ├── paper.bib
                ├── extracted_text.json
                ├── reading_note.md
                └── annotations.json
```

下载完成后，用户可直接在前端 PDF 阅读器中浏览，无需再次上传。

---

## 2.3 Agent 不伪造科研事实

系统必须区分四类信息：

| 类型 | 含义 |
|---|---|
| 事实 | 来自论文、代码仓库、实验日志、数据集说明等明确来源 |
| 推断 | Agent 根据多个事实得出的合理分析 |
| 假设 | 尚未被验证的研究想法 |
| 待验证 | 需要阅读论文、运行实验或检索资料才能确认的内容 |

禁止 Agent：

- 编造论文；
- 编造 DOI；
- 编造作者；
- 编造官方代码链接；
- 编造实验指标；
- 编造模型训练结果；
- 将推测写成论文事实；
- 将未运行的代码描述为“已经验证”。

---

# 3. 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│                         前端 Web / Desktop                   │
│ React + TypeScript + Vite + Tailwind + PDF.js                │
│                                                             │
│ 项目管理 / 文献检索 / PDF阅读 / 实验 / 写作 / Agent任务中心  │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP / WebSocket / SSE
┌──────────────────────────────▼──────────────────────────────┐
│                        后端 API 服务                         │
│ FastAPI + Pydantic + SQLAlchemy                              │
│                                                             │
│ 项目服务 / 文献服务 / PDF服务 / 实验服务 / 文件服务 / Agent  │
└───────────────┬──────────────────────┬──────────────────────┘
                │                      │
                │                      │
┌───────────────▼──────────────┐ ┌─────▼─────────────────────┐
│        本地数据库             │ │        本地文件系统        │
│ SQLite / PostgreSQL           │ │ 项目目录 / PDF / 实验代码 │
│ 项目、文献、实验、任务、审计  │ │ 日志 / 模型 / 图表 / LaTeX│
└───────────────┬──────────────┘ └───────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────────┐
│                    Agent 编排层                               │
│ LangChain + LangGraph + Pydantic Structured Output           │
│                                                              │
│ Literature Agent / Research Agent / Code Agent / Writing Agent│
└───────────────┬──────────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────────┐
│              外部 API / 本地模型兼容 API                      │
│ OpenAI-compatible API / Claude API / Gemini API / DeepSeek   │
│ OpenAlex / Semantic Scholar / Crossref / arXiv / GitHub API  │
└──────────────────────────────────────────────────────────────┘
```

---

# 4. 推荐技术栈

## 4.1 前端技术栈

| 模块 | 推荐技术 | 说明 |
|---|---|---|
| 前端框架 | React + TypeScript | 主应用框架 |
| 构建工具 | Vite | 本地开发和构建速度快 |
| UI 组件 | Tailwind CSS + shadcn/ui | 适合构建科研工作台 |
| 状态管理 | Zustand | 项目状态、任务状态、UI 状态 |
| 请求缓存 | TanStack Query | API 请求、缓存、轮询 |
| PDF 阅读 | PDF.js | PDF 渲染、页面导航、文本选择 |
| 代码编辑器 | Monaco Editor | Python、LaTeX、YAML 编辑 |
| 图表 | ECharts / Plotly | 实验曲线、柱状图、散点图 |
| 流程图 | React Flow | 研究问题、论文、实验关系图 |
| 富文本/Markdown | Milkdown / TipTap / Markdown Editor | 笔记、研究计划、综述草稿 |
| 桌面端可选 | Tauri 2 | 将本地 Web 系统打包为桌面应用 |

建议首期以浏览器访问本地服务为主：

```text
http://127.0.0.1:8000
```

后续可通过 Tauri 封装为桌面软件。

---

## 4.2 后端技术栈

| 模块 | 推荐技术 | 说明 |
|---|---|---|
| Web API | FastAPI | Python 异步 API 框架 |
| 数据校验 | Pydantic v2 | 请求、任务、Agent 输出校验 |
| ORM | SQLAlchemy 2 | SQLite/PostgreSQL 数据访问 |
| 数据迁移 | Alembic | 数据库版本管理 |
| 本地数据库 | SQLite WAL | MVP 单用户本地部署 |
| 团队数据库 | PostgreSQL | 后续多用户/局域网模式 |
| 异步任务 | Dramatiq / Celery / 自研任务队列 | 论文解析、Agent、实验运行 |
| 实时日志 | WebSocket / Server-Sent Events | 训练日志、任务状态流 |
| 文件哈希 | SHA-256 | PDF、实验产物、文件变更追踪 |
| PDF 解析 | PyMuPDF | PDF 页面、文本、图片抽取 |
| 学术 PDF 解析 | GROBID（可选） | 论文标题、作者、章节、参考文献结构化 |
| 向量索引 | LanceDB / Qdrant Local | 本地论文、笔记、代码语义检索 |
| 关键词检索 | SQLite FTS5 / Tantivy | 本地全文检索 |
| 实验追踪 | MLflow Local + TensorBoard | 指标、参数、模型和产物管理 |

---

## 4.3 Agent 技术栈

本项目建议明确采用：

```text
LangChain + LangGraph + Pydantic + FastAPI
```

### 组件职责

| 技术 | 用途 |
|---|---|
| LangChain | 模型调用、Prompt 管理、Tool 封装、文档处理 |
| LangGraph | 多步骤 Agent 工作流、状态机、人工审批节点、重试 |
| Pydantic | Agent 输入输出 JSON Schema 约束 |
| LiteLLM | 统一调用不同模型 API，可选 |
| LangSmith | 可选，用于开发阶段调试 Agent；默认不上传用户私有数据 |
| FastAPI | 将 Agent 能力暴露为后端 API |
| SQLite/PostgreSQL | 保存 Agent 任务、审批、工具调用、结果 |
| LanceDB/Qdrant | 本地 RAG 文献和笔记检索 |

---

## 4.4 模型调用策略

首期以 API 调用为主。

支持的模型供应方式：

```text
1. OpenAI API
2. Anthropic Claude API
3. Google Gemini API
4. DeepSeek API
5. 通义千问 API
6. 智谱 API
7. 本地 Ollama API
8. 本地 vLLM OpenAI-compatible API
9. LM Studio OpenAI-compatible API
```

统一通过模型网关配置：

```yaml
models:
  default_chat:
    provider: openai_compatible
    model: deepseek-chat
    base_url: https://api.example.com/v1
    api_key_env: RESEARCH_AGENT_API_KEY

  embedding:
    provider: local_or_api
    model: bge-m3
```

系统不应把 API Key 写入项目目录、数据库明文或 Agent Prompt。

推荐保存到：

```text
系统 Keychain
或
用户本地 .env 文件
```

---

# 5. 本地工作区与项目目录设计

## 5.1 工作区目录

```text
ResearchAgentWorkspace/
├── .research-agent/
│   ├── app.db
│   ├── config.yaml
│   ├── logs/
│   ├── cache/
│   ├── vector_store/
│   └── models/
│
└── projects/
    ├── vlm-efficient-finetuning/
    ├── graph-neural-network-reasoning/
    └── llm-agent-evaluation/
```

---

## 5.2 单个项目目录

```text
<project-slug>/
├── project.yaml
├── README.md
├── .gitignore
│
├── .research-agent/
│   ├── project.db
│   ├── audit/
│   ├── task_logs/
│   ├── prompts/
│   ├── manifests/
│   └── indexes/
│
├── literature/
│   ├── papers/
│   │   ├── paper_0001/
│   │   │   ├── paper.pdf
│   │   │   ├── metadata.json
│   │   │   ├── paper.bib
│   │   │   ├── extracted_text.json
│   │   │   ├── reading_note.md
│   │   │   ├── annotations.json
│   │   │   └── figures/
│   │   │
│   │   └── paper_0002/
│   │
│   ├── collections/
│   │   ├── must_read.md
│   │   ├── baselines.md
│   │   ├── related_work.md
│   │   └── rejected.md
│   │
│   ├── bib/
│   │   └── references.bib
│   │
│   └── search_history/
│
├── ideas/
│   ├── backlog/
│   ├── hypotheses/
│   ├── decisions/
│   └── research_map.md
│
├── experiments/
│   ├── templates/
│   ├── exp_001_baseline/
│   │   ├── README.md
│   │   ├── pyproject.toml
│   │   ├── uv.lock
│   │   ├── src/
│   │   ├── configs/
│   │   ├── scripts/
│   │   ├── tests/
│   │   ├── outputs/
│   │   └── runs/
│   │
│   └── exp_002_new_method/
│
├── datasets/
│   ├── manifests/
│   ├── links/
│   └── README.md
│
├── writing/
│   ├── paper/
│   │   ├── main.tex
│   │   ├── sections/
│   │   ├── figures/
│   │   ├── tables/
│   │   ├── references.bib
│   │   └── output/
│   │
│   ├── related_work/
│   └── reports/
│
└── assets/
```

---

## 5.3 `project.yaml` 示例

```yaml
schema_version: 1

project:
  id: prj_001
  name: "VLM Efficient Fine-tuning"
  slug: "vlm-efficient-finetuning"
  research_direction: "视觉语言模型的高效微调、迁移能力与鲁棒性"
  created_at: "2025-01-01T00:00:00Z"

models:
  default_chat_model: "deepseek-chat"
  default_embedding_model: "bge-m3"

literature:
  preferred_venues:
    - CVPR
    - ICCV
    - ECCV
    - NeurIPS
    - ICML
    - ICLR
    - AAAI
    - ACL
  year_range:
    start: 2021
    end: 2025

experiments:
  default_environment: "py311_torch24_cu121"
  default_template: "pytorch_hydra"

policies:
  allow_network_search: true
  require_download_approval: true
  require_shell_approval: true
  require_dependency_install_approval: true
  require_file_overwrite_approval: true
```

---

# 6. 文献检索与下载设计

## 6.1 文献数据来源

建议通过合法公开 API 获取论文元数据。

| 数据源 | 用途 |
|---|---|
| OpenAlex API | 论文元数据、作者、引用、开放获取信息 |
| Semantic Scholar API | 论文、引用关系、摘要、相关论文 |
| Crossref API | DOI 和出版元数据 |
| arXiv API | 预印本搜索和 arXiv 标识 |
| CVF Open Access | CVPR、ICCV、WACV 等视觉会议论文 |
| OpenReview | ICLR、NeurIPS 等公开评审论文 |
| ACL Anthology | ACL、EMNLP、NAACL 等 NLP 会议 |
| GitHub API | 论文相关代码仓库搜索 |
| 用户导入 BibTeX | 用户已有文献库导入 |
| 用户导入 PDF | 本地已有论文导入 |

---

## 6.2 顶会/顶刊配置

维护一个可版本化文件：

```text
venue_registry.yaml
```

示例：

```yaml
venues:
  - id: cvpr
    name: CVPR
    aliases:
      - IEEE/CVF Conference on Computer Vision and Pattern Recognition
    field: computer_vision
    level: top_conference

  - id: icml
    name: ICML
    aliases:
      - International Conference on Machine Learning
    field: machine_learning
    level: top_conference

  - id: aaai
    name: AAAI
    aliases:
      - AAAI Conference on Artificial Intelligence
    field: artificial_intelligence
    level: top_conference
```

前端不应仅显示“顶会”标签，而应显示：

```text
已验证会议：CVPR 2024
验证来源：CVF Open Access / OpenAlex / 用户导入元数据
```

---

## 6.3 文献搜索流程

```text
用户输入研究方向
        ↓
生成检索关键词和同义词
        ↓
调用 OpenAlex / Semantic Scholar / arXiv 等 API
        ↓
合并、去重、规范化 DOI / arXiv ID / 标题
        ↓
根据年份、会议、相关性、引用信息排序
        ↓
前端展示论文列表
        ↓
用户选择某篇论文
        ↓
用户点击“下载 PDF”
        ↓
下载到当前项目 literature/papers/<paper_id>/
        ↓
抽取文本、构建本地索引、生成阅读卡
        ↓
PDF 可直接在系统中浏览
```

---

## 6.4 文献搜索结果 UI

每篇论文卡片显示：

```text
标题
作者
会议 / 期刊
年份
摘要
关键词
代码链接
PDF 来源
引用信息
相关性评分
是否已下载到本地
```

操作按钮：

```text
[查看详情]
[下载 PDF]
[加入阅读列表]
[查看代码]
[关联到想法]
[标记无关]
```

下载后，按钮变为：

```text
[本地阅读]
[打开文件目录]
[重新解析]
[删除本地副本]
```

---

## 6.5 PDF 下载策略

系统只在以下情况下载：

1. 用户点击“下载 PDF”；
2. 用户批量勾选论文后确认下载；
3. 用户主动导入本地 PDF；
4. 用户从已授权来源提供 PDF URL。

系统不自动下载：

- 全部搜索结果；
- 全部顶会论文；
- 用户未选中的 PDF；
- 需要绕过访问控制的 PDF；
- 来源不明或版权状态不明确的文件。

下载前显示：

```text
论文标题：
PDF 来源：
目标目录：
文件大小：
许可证/开放获取状态：
是否保存原始下载地址：
```

---

# 7. PDF 本地阅读与翻译设计

## 7.1 PDF 阅读器功能

已下载到本地目录中的 PDF 可以直接在前端中打开。

功能包括：

- PDF 页面预览；
- 缩略图；
- 页面跳转；
- 搜索 PDF 文本；
- 目录导航；
- 文字选择；
- 高亮；
- 批注；
- 笔记；
- 段落翻译；
- 页级问答；
- 引用到研究笔记；
- 引用到 LaTeX 草稿。

---

## 7.2 PDF 页面布局

```text
┌──────────────┬───────────────────────────────────┬──────────────────┐
│ 左侧栏       │ 中间 PDF 阅读区                   │ 右侧栏           │
│              │                                   │                  │
│ 论文目录     │ PDF.js 页面预览                   │ 翻译             │
│ 页面缩略图   │ 文本选择、高亮、批注              │ 阅读笔记         │
│ 搜索结果     │                                   │ 论文问答         │
│ 引用列表     │                                   │ 元数据           │
└──────────────┴───────────────────────────────────┴──────────────────┘
```

---

## 7.3 翻译功能

用户选择论文中的一段内容后，可以点击：

```text
翻译为中文
解释公式
总结本段
加入笔记
作为实验依据
```

翻译记录格式：

```json
{
  "paper_id": "paper_0001",
  "page": 4,
  "original_text": "We propose ...",
  "translated_text": "我们提出……",
  "model": "deepseek-chat",
  "created_at": "2025-01-01T00:00:00Z"
}
```

翻译结果只作为辅助信息，原文始终保留。

---

# 8. Agent 架构设计

## 8.1 Agent 角色

系统不建议只使用一个万能 Agent，而是采用多个职责明确的 Agent。

| Agent | 职责 |
|---|---|
| Project Agent | 创建项目、初始化目录、维护项目状态 |
| Literature Agent | 搜索论文、去重、筛选、生成阅读列表 |
| PDF Reading Agent | 解析 PDF、生成阅读卡、回答论文问题 |
| Research Analyst Agent | 梳理研究趋势、构建方法分类、提出研究假设 |
| Code Retrieval Agent | 搜索 GitHub 代码、判断官方性、记录许可证 |
| Experiment Designer Agent | 设计基线、变量、消融、指标、实验计划 |
| Code Generation Agent | 基于论文和参考代码生成代码修改方案 |
| Experiment Monitor Agent | 分析日志、指标、异常、训练失败原因 |
| Writing Agent | 生成 LaTeX 提纲、综述、方法描述、实验表格 |
| Citation Reviewer Agent | 检查引用、实验数字、论文断言是否有证据 |

---

## 8.2 LangGraph 工作流

推荐使用 LangGraph 构建 Agent 状态图。

```text
用户请求
    ↓
Intent Router
    ↓
Planner
    ↓
选择 Skill / Agent
    ↓
工具调用
    ↓
Evidence Validator
    ↓
是否需要用户审批？
    ├── 是 → Approval Node → 用户确认 → 执行
    └── 否 → 直接执行
    ↓
保存结果、审计日志、文件变更
    ↓
返回前端
```

---

## 8.3 Agent 状态对象

```python
class ResearchAgentState(TypedDict):
    project_id: str
    user_id: str
    task_id: str

    user_request: str
    intent: str

    plan: list[dict]
    evidence_ids: list[str]

    selected_papers: list[str]
    selected_repositories: list[str]
    selected_experiments: list[str]

    pending_approvals: list[str]

    tool_results: list[dict]
    warnings: list[str]

    final_response: str
```

---

# 9. Skill 设计

每个 Skill 都必须具备：

```text
1. 输入 Schema
2. 输出 Schema
3. 权限要求
4. 是否需要用户审批
5. 可审计的工具调用记录
6. 失败重试策略
7. 证据来源要求
```

---

## 9.1 项目管理 Skills

### `project.create`

功能：

- 创建本地项目目录；
- 写入 `project.yaml`；
- 创建默认文献、实验、写作目录；
- 初始化 Git 仓库，可选；
- 创建数据库项目记录。

输入：

```json
{
  "name": "VLM Efficient Fine-tuning",
  "research_direction": "视觉语言模型高效微调",
  "workspace_path": "/workspace/projects",
  "template": "computer_science_default"
}
```

需要审批：

```text
是，因为需要写入本地文件系统。
```

---

### `project.open`

功能：

- 打开本地项目；
- 校验项目目录结构；
- 加载项目数据库；
- 检查项目配置；
- 扫描新添加的 PDF、实验、LaTeX 文件。

---

## 9.2 文献检索 Skills

### `literature.search`

功能：

- 根据研究方向生成检索词；
- 调用 OpenAlex、Semantic Scholar、arXiv 等 API；
- 支持会议、年份、领域、关键词筛选；
- 返回论文元数据；
- 不自动下载 PDF。

输入：

```json
{
  "project_id": "prj_001",
  "query": "parameter efficient fine tuning for vision language models",
  "years": [2022, 2025],
  "venues": ["CVPR", "ICML", "ICLR", "NeurIPS", "AAAI"],
  "limit": 100
}
```

输出：

```json
{
  "papers": [
    {
      "paper_id": "candidate_001",
      "title": "Example Paper",
      "authors": ["Author A", "Author B"],
      "year": 2024,
      "venue": "CVPR",
      "abstract": "...",
      "doi": null,
      "arxiv_id": "2401.00001",
      "pdf_url": "https://...",
      "source": "OpenAlex",
      "is_downloaded": false
    }
  ]
}
```

---

### `literature.download_pdf`

功能：

- 下载用户已选择的论文；
- 保存到项目本地目录；
- 生成 metadata；
- 生成 BibTeX；
- 触发 PDF 解析；
- 触发文本索引。

输入：

```json
{
  "project_id": "prj_001",
  "paper_id": "candidate_001",
  "pdf_url": "https://...",
  "target_folder": "literature/papers/paper_0001"
}
```

需要审批：

```text
是，需要下载文件并写入项目目录。
```

---

### `literature.import_local_pdf`

功能：

- 导入用户本地已有 PDF；
- 将 PDF 复制或移动到项目文献目录；
- 用户填写或自动检索标题、作者、年份；
- 生成 BibTeX；
- 建立本地阅读索引。

---

### `literature.deduplicate`

去重优先级：

```text
DOI > arXiv ID > Semantic Scholar Paper ID > 标题规范化匹配 > 作者年份相似度
```

---

## 9.3 PDF 阅读 Skills

### `pdf.parse`

功能：

- PDF 文本抽取；
- 页级文本保存；
- 章节识别；
- 图表图片提取；
- 参考文献识别；
- OCR 兜底；
- 保存解析质量状态。

输出：

```json
{
  "paper_id": "paper_0001",
  "pages": 14,
  "parse_status": "success",
  "sections": [
    {
      "title": "Introduction",
      "page_start": 1,
      "page_end": 2
    }
  ]
}
```

---

### `paper.generate_reading_note`

自动生成结构化阅读笔记：

```markdown
# Paper Reading Note

## 研究问题

## 核心贡献

## 方法概览

## 数据集与评估协议

## 主要实验结果

## 消融实验

## 局限性

## 可复现性信息

## 与当前项目的关系

## 可进一步验证的问题
```

所有内容必须附带论文页码或章节证据。

---

## 9.4 GitHub 代码检索 Skills

### `code.search_github`

功能：

- 根据论文标题、作者、项目名、关键词搜索 GitHub；
- 查找论文主页和作者主页；
- 判断是否为官方代码；
- 获取仓库许可证、commit、README、活跃度；
- 保存仓库元数据，不自动克隆。

官方性状态：

| 状态 | 含义 |
|---|---|
| official | 论文、作者主页或项目主页明确给出仓库链接 |
| author_affiliated | 仓库作者与论文作者高度匹配，但没有明确官方声明 |
| community | 社区复现实现 |
| unverified | 无法确认来源 |

---

### `code.clone_repository`

功能：

- 用户确认后 clone 指定仓库；
- 固定 commit SHA；
- 记录许可证；
- 保存原始 URL；
- 不自动执行安装脚本；
- 不自动执行仓库代码。

目录：

```text
experiments/
└── external_repos/
    └── official_repo_xxx/
        ├── .git/
        ├── README.md
        ├── LICENSE
        └── provenance.json
```

需要审批：

```text
是，需要联网和写入本地目录。
```

---

## 9.5 研究思路 Skills

### `research.trend_analysis`

输入：

- 用户选择的论文；
- 已下载并解析的论文；
- 年份范围；
- 当前研究方向。

输出：

```text
1. 时间线
2. 方法分类
3. 代表论文
4. 数据集与评估趋势
5. 主流技术路线
6. 已知局限
7. 研究空白
8. 候选实验方向
```

必须明确：

```text
事实：来自论文证据
推断：Agent 的综合判断
假设：尚未验证
```

---

### `research.generate_hypothesis`

输出模板：

```markdown
# 研究假设

## 假设名称

## 问题描述

## 动机

## 文献证据

## 反例与风险

## 最小可行实验

## 对照组

## 变量

## 评估指标

## 成功判据

## 失败判据

## 资源预算
```

---

## 9.6 实验设计 Skills

### `experiment.create_plan`

输入：

```json
{
  "idea_id": "idea_001",
  "selected_papers": ["paper_0001", "paper_0005"],
  "selected_repositories": ["repo_001"],
  "dataset": "CIFAR-100",
  "compute_budget": {
    "gpu_count": 1,
    "max_hours": 8,
    "max_vram_gb": 24
  }
}
```

输出必须包括：

```text
研究问题
假设
基线
新方法
消融实验
数据集
训练配置
评估协议
随机种子
资源预算
预期产物
风险
目录结构
文件修改计划
```

---

### `experiment.scaffold`

功能：

- 在本地创建实验目录；
- 创建 Python 项目；
- 创建配置文件；
- 创建测试；
- 创建 README；
- 创建日志目录；
- 创建 run manifest 模板；
- 不自动安装依赖；
- 不自动运行训练。

需要审批：

```text
是，需要写入本地实验目录。
```

---

### `experiment.run`

功能：

- 用户确认命令后执行训练；
- 创建独立 run 目录；
- 保存运行时配置；
- 保存环境信息；
- 流式保存 stdout/stderr；
- 保存指标；
- 支持停止；
- 支持恢复或重试。

需要审批：

```text
是，需要执行本地 Python 命令和占用计算资源。
```

---

# 10. 实验代码生成关键提示词

以下提示词是系统中最重要的约束之一。

```text
你是计算机科学实验实现助手。

任务是为当前研究假设设计或修改实验代码。

必须遵循以下流程：

1. 首先列出与当前实验最相关的论文。
2. 首先查找论文中明确提到的官方代码链接。
3. 若官方代码存在，必须优先阅读官方代码的：
   - README
   - requirements / pyproject.toml
   - 训练脚本
   - 配置文件
   - 数据预处理代码
   - 模型实现
   - 评估脚本
4. 若不存在官方代码，必须明确说明：
   “未找到可验证的官方代码，本方案参考社区实现或自行设计。”
5. 不能把未确认的仓库称为官方代码。
6. 在生成代码之前，先输出文件级实施计划：
   - 将创建哪些文件；
   - 将修改哪些文件；
   - 每个文件的职责；
   - 数据流；
   - 配置结构；
   - 测试方案；
   - 训练命令；
   - 风险点。
7. 只有在用户确认计划后，才允许生成代码 diff。
8. 不得捏造论文中的超参数、训练轮数、数据增强、指标或实验结果。
9. 不得将“代码预期效果”描述为“实验已验证效果”。
10. 所有实验必须包含：
    - baseline；
    - 随机种子；
    - 配置文件；
    - 日志；
    - 指标保存；
    - checkpoint；
    - 最小 smoke test；
    - 评估脚本。
```

---

# 11. Python 实验环境管理

## 11.1 推荐方案

推荐采用：

```text
uv + pyproject.toml + uv.lock
```

作为默认 Python 环境管理方式。

原因：

- 比 requirements.txt 更稳定；
- 支持锁定依赖；
- 支持指定 Python 版本；
- 适合本地科研实验；
- 比 Conda 更轻量；
- 易于复制环境。

兼容支持：

```text
Conda
venv
Poetry
Docker
Podman
```

---

## 11.2 环境目录设计

```text
experiments/
└── exp_001_baseline/
    ├── pyproject.toml
    ├── uv.lock
    ├── .python-version
    ├── src/
    ├── configs/
    ├── scripts/
    ├── tests/
    └── runs/
```

---

## 11.3 实验模板

默认推荐模板：

```text
PyTorch + Hydra + TensorBoard + MLflow
```

目录：

```text
exp_001_baseline/
├── pyproject.toml
├── README.md
├── src/
│   ├── train.py
│   ├── evaluate.py
│   ├── data/
│   ├── models/
│   ├── methods/
│   └── utils/
│
├── configs/
│   ├── base.yaml
│   ├── model/
│   ├── data/
│   ├── trainer/
│   └── experiment/
│
├── scripts/
│   ├── train.sh
│   ├── evaluate.sh
│   └── smoke_test.sh
│
├── tests/
│   ├── test_data.py
│   ├── test_model.py
│   └── test_smoke.py
│
└── runs/
```

---

## 11.4 每次运行必须记录

每个实验运行生成独立目录：

```text
runs/
└── 20250101_120000_run_a1b2c3/
    ├── run.json
    ├── config.resolved.yaml
    ├── stdout.log
    ├── stderr.log
    ├── metrics.jsonl
    ├── environment.txt
    ├── git_info.json
    ├── hardware.json
    ├── figures/
    ├── checkpoints/
    └── artifacts/
```

`run.json` 示例：

```json
{
  "run_id": "run_a1b2c3",
  "experiment_id": "exp_001",
  "command": [
    "uv",
    "run",
    "python",
    "-m",
    "src.train",
    "experiment=baseline"
  ],
  "seed": 42,
  "git_commit": "abc123",
  "python_version": "3.11",
  "torch_version": "2.4",
  "cuda_version": "12.1",
  "status": "running",
  "created_at": "2025-01-01T12:00:00Z"
}
```

---

# 12. 实验可视化设计

## 12.1 实验列表页面

显示：

- 实验名称；
- 关联研究假设；
- 基线论文；
- 代码来源；
- 当前状态；
- 最近运行；
- 最佳指标；
- 使用资源；
- 创建时间；
- Git commit。

---

## 12.2 运行监控页面

```text
┌───────────────────────────────────────────────────────────┐
│ Run 信息                                                   │
│ run_id / 命令 / GPU / 环境 / git commit / config          │
├───────────────────────────────┬───────────────────────────┤
│ 日志区域                      │ 资源监控                  │
│ stdout / stderr               │ GPU 利用率 / 显存 / CPU   │
├───────────────────────────────┼───────────────────────────┤
│ 指标曲线                      │ Artifact 列表             │
│ loss / accuracy / F1 / lr     │ 图片 / checkpoint / 表格  │
└───────────────────────────────┴───────────────────────────┘
```

---

## 12.3 实验对比功能

用户选择多个 run 后，系统显示：

| 指标 | Run A | Run B | Run C |
|---|---:|---:|---:|
| 验证集 Accuracy | 83.2 | 84.1 | 82.8 |
| 训练时间 | 4h | 4.2h | 3.8h |
| 显存峰值 | 18GB | 20GB | 16GB |
| 参数量 | 120M | 125M | 80M |

同时显示配置差异：

```text
Run A 与 Run B 的差异：
- learning_rate：1e-4 → 5e-5
- batch_size：32 → 16
- lora_rank：8 → 16
```

避免不同配置下的结果被误认为可直接比较。

---

# 13. 前端页面设计

## 13.1 主导航

```text
项目概览
文献库
PDF 阅读
研究想法
实验设计
实验运行
结果分析
论文写作
任务中心
设置
```

---

## 13.2 项目概览页

包含：

```text
研究方向
研究问题
当前阶段
文献数量
已下载论文数量
待阅读论文
实验数量
运行中任务
最近实验结果
待处理审批
下一步建议
```

研究图谱：

```text
论文 → 想法 → 假设 → 实验 → Run → 图表 → 论文段落
```

---

## 13.3 文献库页面

布局：

```text
┌─────────────────────────────────────────────────────┐
│ 搜索栏：关键词 / 年份 / 会议 / 领域 / 论文类型       │
├────────────────┬────────────────────────────────────┤
│ 筛选栏         │ 文献结果列表                        │
│                │                                    │
│ 年份           │ 标题 / 作者 / 摘要 / 会议 / 操作   │
│ 会议           │                                    │
│ 是否已下载     │ [查看] [下载 PDF] [代码] [收藏]    │
│ 标签           │                                    │
└────────────────┴────────────────────────────────────┘
```

---

## 13.4 PDF 阅读页面

已下载论文在文献库中点击：

```text
本地阅读
```

即可进入 PDF 阅读页面。

右侧面板：

```text
翻译
阅读笔记
论文问答
论文元数据
引用信息
关联实验
关联想法
```

---

## 13.5 实验设计页面

用户填写：

```text
实验名称：
研究问题：
研究假设：
参考论文：
参考代码：
数据集：
基线方法：
新方法：
对照变量：
评估指标：
计算资源预算：
```

点击：

```text
生成实验计划
```

Agent 返回：

```text
实验结构
文件结构
配置方案
数据流
训练命令
评估命令
最小测试
预期结果
风险
```

用户确认后才显示：

```text
创建本地实验目录
```

---

## 13.6 LaTeX 写作页面

布局：

```text
┌───────────────┬──────────────────────┬──────────────────┐
│ 文件目录      │ LaTeX 编辑器          │ PDF 预览         │
│               │                      │                  │
│ main.tex      │ 章节编辑              │ 编译结果         │
│ sections/     │ Agent 草稿建议        │ 编译错误         │
│ figures/      │ 引用插入              │                  │
│ tables/       │                      │                  │
└───────────────┴──────────────────────┴──────────────────┘
```

写作 Agent 只能引用：

- 已下载论文；
- 已验证 BibTeX；
- 已完成实验 run；
- 已生成 artifact；
- 用户笔记。

---

# 14. 数据库设计

## 14.1 核心表

### `projects`

```sql
projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    research_direction TEXT,
    root_path TEXT NOT NULL,
    status TEXT,
    created_at DATETIME,
    updated_at DATETIME
)
```

---

### `papers`

```sql
papers (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    abstract TEXT,
    year INTEGER,
    venue TEXT,
    doi TEXT,
    arxiv_id TEXT,
    source_url TEXT,
    pdf_url TEXT,
    local_pdf_path TEXT,
    downloaded BOOLEAN DEFAULT FALSE,
    parse_status TEXT,
    official_code_url TEXT,
    created_at DATETIME,
    updated_at DATETIME
)
```

---

### `paper_files`

```sql
paper_files (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL,
    file_type TEXT,
    relative_path TEXT,
    sha256 TEXT,
    file_size INTEGER,
    created_at DATETIME
)
```

---

### `annotations`

```sql
annotations (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL,
    page_number INTEGER,
    selected_text TEXT,
    rects_json TEXT,
    comment TEXT,
    color TEXT,
    created_at DATETIME
)
```

---

### `ideas`

```sql
ideas (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT,
    hypothesis TEXT,
    motivation TEXT,
    status TEXT,
    evidence_json TEXT,
    risks_json TEXT,
    created_at DATETIME,
    updated_at DATETIME
)
```

---

### `experiments`

```sql
experiments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT,
    slug TEXT,
    root_path TEXT,
    source_repository_id TEXT,
    related_idea_id TEXT,
    status TEXT,
    created_at DATETIME
)
```

---

### `experiment_runs`

```sql
experiment_runs (
    id TEXT PRIMARY KEY,
    experiment_id TEXT NOT NULL,
    run_path TEXT,
    command TEXT,
    status TEXT,
    git_commit TEXT,
    environment_fingerprint TEXT,
    start_at DATETIME,
    end_at DATETIME,
    created_at DATETIME
)
```

---

### `run_metrics`

```sql
run_metrics (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step INTEGER,
    metric_name TEXT,
    metric_value REAL,
    created_at DATETIME
)
```

---

### `repositories`

```sql
repositories (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    paper_id TEXT,
    repo_url TEXT,
    local_path TEXT,
    commit_sha TEXT,
    official_status TEXT,
    license TEXT,
    provenance_json TEXT,
    created_at DATETIME
)
```

---

### `agent_tasks`

```sql
agent_tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    task_type TEXT,
    input_json TEXT,
    plan_json TEXT,
    status TEXT,
    result_json TEXT,
    created_at DATETIME,
    updated_at DATETIME
)
```

---

### `approvals`

```sql
approvals (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    action_type TEXT,
    payload_json TEXT,
    status TEXT,
    approved_at DATETIME,
    rejected_at DATETIME
)
```

---

# 15. 后端 API 设计

## 15.1 项目 API

```text
POST   /api/v1/projects
GET    /api/v1/projects
GET    /api/v1/projects/{project_id}
PATCH  /api/v1/projects/{project_id}
DELETE /api/v1/projects/{project_id}
```

---

## 15.2 文献 API

```text
POST /api/v1/projects/{project_id}/literature/search
GET  /api/v1/projects/{project_id}/papers
POST /api/v1/projects/{project_id}/papers/download
POST /api/v1/projects/{project_id}/papers/import-local
GET  /api/v1/papers/{paper_id}
GET  /api/v1/papers/{paper_id}/pdf
POST /api/v1/papers/{paper_id}/parse
POST /api/v1/papers/{paper_id}/translate
POST /api/v1/papers/{paper_id}/annotations
```

---

## 15.3 实验 API

```text
POST /api/v1/projects/{project_id}/experiments
GET  /api/v1/projects/{project_id}/experiments
GET  /api/v1/experiments/{experiment_id}

POST /api/v1/experiments/{experiment_id}/plan
POST /api/v1/experiments/{experiment_id}/scaffold
POST /api/v1/experiments/{experiment_id}/runs
POST /api/v1/runs/{run_id}/stop

GET  /api/v1/runs/{run_id}
GET  /api/v1/runs/{run_id}/logs
GET  /api/v1/runs/{run_id}/metrics
GET  /api/v1/runs/{run_id}/artifacts
```

---

## 15.4 Agent API

```text
POST /api/v1/projects/{project_id}/agent/tasks
GET  /api/v1/agent/tasks/{task_id}
GET  /api/v1/agent/tasks/{task_id}/events
POST /api/v1/agent/tasks/{task_id}/approve
POST /api/v1/agent/tasks/{task_id}/reject
POST /api/v1/agent/tasks/{task_id}/retry
```

---

# 16. 审批与安全策略

## 16.1 默认需要用户确认的操作

| 操作 | 是否确认 |
|---|---|
| 搜索公开论文元数据 | 否 |
| 查看论文详情 | 否 |
| 下载 PDF | 是 |
| 导入本地 PDF | 是 |
| 克隆 GitHub 仓库 | 是 |
| 创建实验目录 | 是 |
| 写入或覆盖代码 | 是 |
| 安装 Python 依赖 | 是 |
| 运行训练命令 | 是 |
| 使用 GPU | 是 |
| 删除文件 | 强确认 |
| Git Push | 强确认 |
| 上传文件 | 强确认 |

---

## 16.2 Agent 不直接执行 Shell

Agent 只能生成计划，例如：

```text
建议执行命令：

uv sync
uv run python -m src.train experiment=baseline
```

前端展示：

```text
工作目录：
命令：
环境：
GPU 数：
预计训练时间：
可能下载的依赖：
```

只有用户点击确认后，后端 Runner 才能启动命令。

---

## 16.3 文件系统限制

所有文件读写必须在：

```text
ResearchAgentWorkspace/projects/<project-slug>/
```

范围内。

禁止：

```text
读取 ~/.ssh
读取 ~/.aws
读取系统目录
访问任意绝对路径
使用 ../ 路径逃逸
```

---

# 17. 关键 Prompt 模板

## 17.1 文献趋势分析 Prompt

```text
你是计算机科学研究分析助手。

请根据提供的论文证据包，分析主题：
{research_topic}

时间范围：
{year_range}

要求：

1. 仅根据 evidence 中的论文内容进行事实陈述。
2. 每一条论文相关结论必须附带 paper_id 和页码或章节。
3. 将输出分为：
   - 事实
   - 推断
   - 假设
   - 待验证
4. 不得根据论文标题猜测方法细节。
5. 不得捏造实验数字、数据集或作者结论。
6. 需要输出：
   - 研究时间线
   - 方法分类
   - 代表论文
   - 技术路线变化
   - 主要局限
   - 潜在研究方向
   - 仍需检索的问题
```

---

## 17.2 官方代码检索 Prompt

```text
任务：为论文寻找代码实现。

规则：

1. 首先检查论文 PDF 中是否有项目主页或代码链接。
2. 再检查论文作者主页、实验室主页和项目主页。
3. 最后才使用 GitHub 搜索结果。
4. 只有论文或作者明确关联的仓库才能标记为 official。
5. 标题相似、仓库名称相似、Star 数高，不能作为 official 的唯一依据。
6. 输出每个仓库时必须包含：
   - repo_url
   - official_status
   - evidence
   - license
   - commit
   - 风险说明
```

---

## 17.3 实验计划 Prompt

```text
你是科研实验设计助手。

当前研究假设：
{hypothesis}

可用论文：
{papers}

可用代码仓库：
{repositories}

用户资源限制：
{resource_budget}

请生成实验计划。

必须包括：

1. 研究问题。
2. 假设。
3. 基线方法。
4. 新方法。
5. 对照变量。
6. 消融实验。
7. 数据集。
8. 评价指标。
9. 随机种子策略。
10. 训练预算。
11. 失败判据。
12. 代码目录设计。
13. 配置文件设计。
14. 最小 smoke test。
15. 风险与不确定性。

禁止：

- 声称实验已经运行；
- 伪造论文超参数；
- 伪造官方代码；
- 缺少 baseline；
- 缺少评估方案。
```

---

## 17.4 LaTeX 写作 Prompt

```text
你是科研论文写作助手。

请为章节 {section_name} 生成 LaTeX 草稿。

只能使用：

- 已下载并验证的论文；
- 已存在的 citation_key；
- 已完成实验 run；
- 已存在的图表 artifact；
- 用户笔记。

规则：

1. 不得生成不存在的引用。
2. 不得生成不存在的实验结果。
3. 实验数字必须来自具体 run_id。
4. 每一条相关工作描述必须有 citation_key。
5. 对不确定结论使用保守措辞。
6. 输出：
   - tex_body
   - cited_papers
   - used_runs
   - claims_to_verify
   - missing_citations
```

---

# 18. MVP 实施路线

## Phase 1：项目与文献基础能力

实现：

- 工作区初始化；
- 项目创建；
- SQLite 数据库；
- 文献搜索；
- 顶会筛选；
- 用户选择下载 PDF；
- PDF 本地保存；
- PDF.js 预览；
- PDF 文本提取；
- 阅读笔记；
- 文献收藏与标签。

验收流程：

```text
创建项目
→ 搜索 CVPR/ICML/AAAI 论文
→ 用户下载一篇论文
→ 本地打开 PDF
→ 选中段落翻译
→ 保存笔记
```

---

## Phase 2：Agent 与研究思路

实现：

- LangChain 模型调用；
- LangGraph 任务编排；
- 文献趋势分析；
- 研究路线图；
- 想法卡片；
- 假设生成；
- GitHub 代码搜索；
- 官方代码状态判断；
- Agent 任务中心；
- 审批流程。

---

## Phase 3：实验工作台

实现：

- 实验设计表单；
- 实验目录创建；
- uv 环境；
- Python 模板；
- Shell Runner；
- 日志流；
- 指标曲线；
- TensorBoard；
- 实验对比；
- 结果 artifact 管理。

---

## Phase 4：论文写作

实现：

- LaTeX 项目初始化；
- 编辑器；
- PDF 编译；
- 引用管理；
- 从已下载论文插入引用；
- 从已完成实验插入图表；
- 相关工作草稿；
- 实验章节草稿；
- 引用和实验事实校验。

---

# 19. MVP 完成标准

以下流程可以完整跑通时，系统达到 MVP：

```text
1. 用户创建一个研究项目。
2. 用户输入研究方向。
3. 系统搜索近年 CVPR、ICML、ICLR、NeurIPS、AAAI 等论文。
4. 用户从搜索结果中选择一篇论文。
5. 用户确认下载。
6. 论文保存到本地项目 literature/papers 目录。
7. 用户直接在系统中浏览本地 PDF。
8. 用户可以翻译、批注、记笔记。
9. Agent 根据用户选择的论文给出研究路线和候选假设。
10. 用户创建一个实验设计。
11. Agent 先参考论文与官方代码，生成实验实施计划。
12. 用户确认后，系统创建本地 Python 实验目录。
13. 用户确认后，系统运行 smoke test 或训练任务。
14. 系统显示日志、指标、图表和实验产物。
15. 用户可以把真实实验图表和已验证论文引用插入 LaTeX 文档。
```

---

# 20. 后续扩展方向

```text
1. 多用户实验室协作。
2. PostgreSQL 团队数据库。
3. 局域网部署。
4. Slurm 集群调度。
5. Kubernetes 训练任务。
6. 远程 GPU 机器。
7. 数据集版本管理。
8. DVC / Git LFS 集成。
9. 自动生成实验报告。
10. 审稿人 Agent。
11. 统计显著性分析 Agent。
12. 多模态论文图表理解。
13. 代码仓库自动复现评估。
14. Zotero 双向同步。
15. 本地知识图谱。
16. 研究项目模板市场。
```

---

# 21. 最终开发约束

后续实现该系统的 AI 或工程团队必须遵守：

1. 先实现可跑通的文献下载、本地 PDF 阅读、实验创建垂直闭环。
2. 文献搜索结果默认不下载 PDF。
3. 用户下载后，PDF 必须保存到当前项目目录。
4. 本地 PDF 下载后可直接浏览。
5. Agent 主要通过 API 调用模型，不强制要求本地部署大模型。
6. Agent 框架明确采用 LangChain + LangGraph。
7. 所有 Agent 输出必须可审计。
8. 所有外部写文件、下载、安装依赖、执行命令必须经过用户审批。
9. 代码生成前必须优先检索论文官方代码。
10. 没有官方代码时必须明确说明。
11. 实验结果只能来自真实运行记录。
12. 写作引用必须来自已验证文献记录。
13. 项目之间必须在目录、数据库记录、向量索引和任务上下文上隔离。
14. 不允许 Agent 访问项目目录以外的敏感文件。
15. 所有实验必须保留配置、环境、代码版本、日志和指标。
