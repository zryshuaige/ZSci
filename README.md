# Z-Sci

**把一整条科研流程，放进你自己的电脑。**

从选题到成文——检索文献、精读 PDF、沉淀想法、管理数据集、运行实验、起草论文——Z-Sci 帮你在本地完成，数据与产物始终属于你。

![Python](https://img.shields.io/badge/Python-3.12-3776AB?style=flat-square)
![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?style=flat-square)
![Local-first](https://img.shields.io/badge/Local--first-Privacy-1a1a1a?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-22c55e?style=flat-square)

---

## 为什么是 Z-Sci

科研工具往往要么是「聊天窗口」，要么是「一堆互不关联的脚本」。Z-Sci 面向真实研究节奏：

| 你真正需要的 | Z-Sci 怎么做 |
| --- | --- |
| 文献要可追溯 | 检索 → 确认下载 → 本地 PDF + BibTeX，可随时复现 |
| 阅读要有产出 | 对照阅读、划词翻译、批注、结构化笔记（带页码证据） |
| 想法不能丢 | 假设、动机、实验方案集中管理，状态可流转 |
| 实验要可对比 | 标准项目骨架、实时日志、指标曲线、多轮对比 |
| AI 要可控 | 重要操作需你确认；陈述区分事实 / 推断 / 假设 |
| 数据要私密 | 默认本地运行，项目文件与数据库都在你的机器上 |

---

## 一条完整研究路径

```text
创建项目  →  检索文献  →  下载并精读  →  生成 / 整理想法
    →  查找并加入数据集  →  搭建与运行实验  →  写作与引用校验
```

左侧始终能看到**进行中的任务**，换页面也不会丢进度；需要时一键回到对应实验或助手任务。

---

## 核心能力

### 项目管理
每个研究方向是一个独立工作区。文献、PDF、笔记、实验与 LaTeX 工程都挂在同一项目下，互不干扰；删除项目时一并清理本地目录。

### 文献检索
对接 OpenAlex 与 arXiv，自动去重。先看元数据（标题、作者、会议、引用、摘要），**不会悄悄下载**。内置顶会标注（CVPR / ICML / NeurIPS / AAAI / ACL 等），可一键只看顶会。

### 精读与笔记
三栏阅读：原文 · 翻译 · 笔记。划词即可翻译或批注，内容按页保存。可生成结构化阅读笔记——事实性表述会尽量附带页码依据，便于复查。

### 研究想法
手动记录，或基于已下载论文智能生成可验证假设。每条想法可展开完整方案（最小实验、指标、成功/失败判据、风险与证据等），状态支持：待评估 → 待验证 → 已采纳 / 已否决。

### 数据集与基准
在 HuggingFace 上搜索候选数据集（支持中文任务名，如「语义分割」）。  
**搜索结果默认不入库**——你确认「加入项目」后才会保留；还可关联到具体实验，供后续自主实验选用。主流数据集优先展示。

### 实验工作台
- 左侧管理数据集，右侧管理实验列表  
- 新建实验自动生成可运行的 Python 项目骨架（uv + Hydra）  
- 手动运行或一键自主实验（查找基准 → 生成代码 → 自检 → 运行）  
- 日志实时流式展示，可中途停止；指标自动成曲线，多轮可对比  
- 运行中的实验在列表与侧栏中清晰标出

### 研究助手
用自然语言完成：研究趋势分析、生成研究想法、检索相关代码仓库、协助起草章节。  
涉及下载、写文件、执行命令时，会先请你确认，并留下可追溯记录。

### 论文写作
一键初始化 LaTeX 工程，内置章节骨架与参考文献库。在线编辑源文件，本机有 TeX 时可编译预览；引用校验帮助发现缺失的 `\cite` 键。

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

- Python 3.12（由 [uv](https://github.com/astral-sh/uv) 管理）
- Node.js 18+
- uv：`curl -LsSf https://astral.sh/uv/install.sh | sh`
- （可选）TeX Live — 仅编译 PDF 时需要

### 安装并启动

```bash
# 1. 安装依赖
make install

# 2. 配置模板
cp backend/config.example.yaml workspace/.research-agent/config.yaml
cp backend/.env.example backend/.env

# 3. 在 backend/.env 中填入你的模型 API Key，例如：
#    DEEPSEEK_API_KEY=sk-...

# 4. 一键启动前后端（Ctrl+C 同时停止）
make dev
```

打开浏览器访问 **http://localhost:5173**

> 国内网络：后端默认使用清华 PyPI 镜像，安装通常很快。

---

## 配置说明

### 模型（`workspace/.research-agent/config.yaml`）

指定对话所用的模型提供方。模板中已列出 OpenAI / Anthropic / Gemini / DeepSeek / 通义 / 智谱 / Ollama 等，取消注释一组即可：

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

只填写你实际使用的提供方即可。

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
| 后端 | FastAPI · SQLAlchemy · SQLite · LiteLLM · LangGraph · PyMuPDF |
| 前端 | React 18 · TypeScript · Vite · Tailwind · PDF.js · TanStack Query |
| 运行 | 本地双进程：UI `:5173` · API `:8000` |

数据落在 `workspace/`（已 gitignore）：SQLite 与各项目沙箱目录。后端无状态，文件读写限制在对应项目路径内。

更完整的 API 说明见启动后的 **http://127.0.0.1:8000/docs**。

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

- 本地论文向量检索（项目内 RAG）
- 多轮实验自动对比报告
- 更多实验骨架模板（Lightning / JAX 等）
- 项目打包导出与协作分享

---

## 许可

[MIT](LICENSE)

---

<p align="center">
  <sub>为认真做研究的人而建 · 本地、可控、可复现</sub>
</p>
