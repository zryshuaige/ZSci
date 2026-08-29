<div align="center">

# 🔬 Z-Sci

**把一整条科研流程，放进你自己的电脑。**

从选题到成文——检索文献、精读 PDF、沉淀想法、管理数据集、运行实验、起草论文——
Z-Sci 帮你在本地完成，数据与产物始终属于你。

[![Python](https://img.shields.io/badge/Python-3.12+-3776AB?style=flat-square&logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115+-009688?style=flat-square&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vitejs.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-3-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![TanStack Query](https://img.shields.io/badge/TanStack_Query-5-FF4154?style=flat-square)](https://tanstack.com/query)
[![ECharts](https://img.shields.io/badge/ECharts-6-AA344D?style=flat-square&logo=apacheecharts&logoColor=white)](https://echarts.apache.org/)
[![SQLite](https://img.shields.io/badge/SQLite-local-003B57?style=flat-square&logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![LiteLLM](https://img.shields.io/badge/LiteLLM-多提供商-1C3C3C?style=flat-square)](https://github.com/BerriAI/litellm)
[![uv](https://img.shields.io/badge/uv-包管理-DE5FE9?style=flat-square)](https://github.com/astral-sh/uv)
[![pytest](https://img.shields.io/badge/tests-221%20passing-0A9EDC?style=flat-square&logo=pytest&logoColor=white)](backend/)
[![License](https://img.shields.io/badge/License-MIT-22c55e?style=flat-square)](LICENSE)
![Local-first](https://img.shields.io/badge/Local--first-隐私可控-1a1a1a?style=flat-square)

</div>

---

## 为什么是 Z-Sci

科研工具往往要么是「聊天窗口」，要么是「一堆互不关联的脚本」。Z-Sci 面向真实研究节奏：

| 你真正需要的 | Z-Sci 怎么做 |
| --- | --- |
| 文献要可追溯 | 检索 → 确认下载 → 本地 PDF + BibTeX，可随时复现 |
| 阅读要有产出 | 对照阅读、划词翻译、批注、结构化笔记（带页码证据） |
| 想法不能丢 | 候选方向、假设、动机、实验方案集中管理，状态可流转 |
| 实验要可对比 | 标准项目骨架、实时日志、指标曲线、多轮对比 |
| AI 要可控 | 每个关键节点停下来等你确认；陈述区分事实 / 推断 / 假设 |
| 数据要私密 | 默认本地运行，项目文件与数据库都在你的机器上 |

---

## 旗舰特性：五阶段自主实验

写下研究问题后，AI 会驱动一条完整的实验流水线，**每个关键节点都停下来等你确认**，你看懂了再继续：

```text
① 需求与基准  →  ② 方案设计  →  ③ 代码与自检  →  ④ 首轮运行  →  ⑤ 分析与报告
   确认研究问题     确认指标/基线     生成代码+冒烟      自动执行       确认结论
   与候选基准  ⏸   与运行配置  ⏸    自迭代修复  ⏸                  与后续方向  ⏸
```

- 每个确认点用**人话**呈现结论：研究假设是什么、跟踪哪些指标（附定义）、与哪些基线对比、确认后会发生什么
- 不满意可以直接用自然语言修改（「对照方法只保留仅文本」），后续阶段按你的要求重新进行
- 流程状态**持久化在数据库**——关掉电脑再打开，实验从停下的地方继续，不重复消耗模型调用
- 侧栏全程显示进行中的任务，换页面、关浏览器都不会丢进度

---

## 一条完整研究路径

```text
创建项目  →  检索文献  →  下载并精读  →  生成 / 整理想法
    →  查找并加入数据集  →  搭建与运行实验  →  写作与引用校验
```

---

## 核心能力

### 项目管理
每个研究方向是一个独立工作区。文献、PDF、笔记、实验与 LaTeX 工程都挂在同一项目下，互不干扰；首页项目卡实时标出「N 个实验等你确认 / 运行中」，删除项目时一并清理本地目录。

### 文献检索
对接 OpenAlex 与 arXiv，自动去重。先看元数据（标题、作者、会议、引用、摘要），**不会悄悄下载**。内置顶会标注（CVPR / ICML / NeurIPS / AAAI / ACL 等），可一键只看顶会；支持导入本机已有 PDF。

### 精读与笔记
三栏阅读：原文 · 翻译 · 笔记。划词即可翻译或批注，内容按页保存。可生成结构化阅读笔记——事实性表述会尽量附带页码依据，便于复查。

### 研究想法
手动记录，或让 AI 基于项目文献生成一批**候选方向**（含可行性、创新性、成本预估与推荐标记）供你对比挑选。候选一旦生成即落库——离开页面再回来还在，不会重复生成。每条想法可展开完整方案，状态支持：候选 → 待验证 → 已采纳 / 已否决。

### 数据集与基准
独立的「数据集基准」页，在 HuggingFace 上搜索候选数据集与任务（支持中文任务名，如「语义分割」）。**搜索结果默认不入库**——你确认「加入项目」后才会保留；可关联到具体实验，供自主实验直接选用。

### 实验工作台
- 新建实验自动生成可运行的 Python 项目骨架（uv + Hydra）
- 五阶段自主实验（见上），或单阶段手动运行
- 日志实时流式展示、可中途停止；指标自动成曲线，多轮可对比，支持对数坐标
- 决策历史完整留痕；实验失败时给出可读的原因与修复入口

### 研究助手
用自然语言完成：研究趋势分析、生成研究想法、检索相关代码仓库、协助起草章节。涉及下载、写文件、执行命令时，会先请你确认，并留下可追溯记录。

### 论文写作
一键初始化 LaTeX 工程，内置通用 / IEEE / Elsevier 模板与章节骨架。在线编辑源文件，本机有 TeX 时可编译预览；引用校验帮助发现缺失的 `\cite` 键。

---

## 设计原则

- **本地优先** — 项目文件、PDF、实验产物与数据库都在本机 `workspace/`
- **你说了算** — 下载 PDF、跑训练命令等敏感操作需明确确认
- **可追溯** — 关键操作写入审计记录；助手陈述区分证据类型
- **优雅降级** — 未配置模型时仍可管理文献与文件；未装 TeX 仍可编辑文稿
- **密钥隔离** — API Key 只读环境变量，不进配置文件正文、不入库、不进提示词

---

## 快速开始

### 环境要求

- Python 3.12+（依赖由 [uv](https://github.com/astral-sh/uv) 管理）
- Node.js 18+
- （可选）TeX Live — 仅编译 PDF 时需要

### 安装并启动

```bash
# 1. 安装前后端依赖
make install

# 2. 准备配置模板
cp backend/config.example.yaml workspace/.research-agent/config.yaml
cp backend/.env.example backend/.env

# 3. 在 backend/.env 中填入你的模型 API Key，例如：
#    DEEPSEEK_API_KEY=sk-...

# 4. 一键启动前后端（Ctrl+C 同时停止）
make dev
```

打开浏览器访问 **http://localhost:5173**，后端 API 与文档在 **http://127.0.0.1:8000/docs**。

> 国内网络：后端默认使用清华 PyPI 镜像，安装通常很快；HuggingFace 可经 `ZSCI_HF_ENDPOINT` 切换镜像。

---

## 配置说明

### 模型（`workspace/.research-agent/config.yaml`）

指定对话所用的模型提供方。模板中已列出 OpenAI / Anthropic / Gemini / DeepSeek / 通义 / 智谱 / Ollama 等，取消注释一组即可；也可在网页「设置」页直接填写。

```yaml
models:
  default_chat:
    provider: deepseek
    model: deepseek-chat
    api_key_env: DEEPSEEK_API_KEY   # 对应 .env 中的变量名
```

本地模型可使用 OpenAI 兼容接口（vLLM / LM Studio / Ollama），示例见配置模板。

### 密钥（`backend/.env`）

```bash
DEEPSEEK_API_KEY=sk-...
```

只填写你实际使用的提供方即可。`.env` 已被 gitignore，不会进入版本库。

### 可选变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ZSCI_WORKSPACE_PATH` | `./workspace` | 项目与数据根目录 |
| `ZSCI_LLM_CONFIG_PATH` | `<workspace>/.research-agent/config.yaml` | 模型配置路径 |
| `ZSCI_HF_ENDPOINT` | 官方 HuggingFace | 数据集检索端点；网络受限时可设为镜像 |

---

## 技术概览

| 层级 | 选型 |
| --- | --- |
| 后端 | FastAPI · SQLAlchemy 2 + Alembic · SQLite · LiteLLM（多模型网关）· PyMuPDF |
| Agent 循环 | 自研持久化状态机：检查点落库、断点续跑、SSE 实时事件流（无重量级编排框架） |
| 前端 | React 18 · TypeScript · Vite · Tailwind CSS · TanStack Query · ECharts（按需注册）· PDF.js |
| 实验 | uv + Hydra 项目骨架 · smoke 自迭代 · 指标曲线 · 多 run 对比 |
| 运行 | 本地双进程：UI `:5173` · API `:8000` |

数据落在 `workspace/`（已 gitignore）：SQLite 数据库与各项目沙箱目录。后端无状态，文件读写限制在对应项目路径内。

---

## 项目结构

```text
ZSci/
├── backend/               # FastAPI 应用
│   ├── app/
│   │   ├── agent/         # 技能调度、事件流、持久化任务
│   │   ├── experiments/   # 五阶段流水线、编排器、代码生成、脚手架
│   │   ├── routers/       # REST 路由（项目/文献/想法/实验/写作…）
│   │   ├── workspace/     # 项目沙箱与文件访问控制
│   │   └── db/            # SQLAlchemy 模型与轻量迁移
│   └── tests/             # 221 个后端测试
├── frontend/              # React 单页应用
│   └── src/
│       ├── pages/         # 路由页面（概览/文献/想法/实验/写作/助手…）
│       ├── components/    # 旅程导航、确认卡、图表等组件
│       └── lib/           # API client、查询键、事件人话化等
├── workspace/             # 运行时数据（gitignore，不入库）
└── Makefile               # install / dev / test / lint 一键命令
```

---

## 常用命令

```bash
make dev             # 同时启动前后端
make dev-backend     # 仅后端
make dev-frontend    # 仅前端
make test            # 后端测试
make lint            # 代码检查
make migrate         # 数据库迁移
make clean           # 清理构建产物与依赖目录
```

---

## 路线图

- [ ] 本地论文向量检索（项目内 RAG）
- [ ] 多轮实验自动对比报告
- [ ] 更多实验骨架模板（Lightning / JAX 等）
- [ ] 项目打包导出与协作分享

---

## 许可

[MIT](LICENSE)

---

<p align="center">
  <sub>为认真做研究的人而建 · 本地、可控、可复现</sub>
</p>
