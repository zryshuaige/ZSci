# Z-Sci

Z-Sci 把一个研究方向的完整流程搬到本地:搜文献、读论文、整思路、跑实验、写论文,所有产物都在你自己的项目目录里。

![Python](https://img.shields.io/badge/Python-3.12-3776AB)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688)
![React](https://img.shields.io/badge/React-18-61dafb)
![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178c6)
![Vite](https://img.shields.io/badge/Vite-5-646cff)
![TailwindCSS](https://img.shields.io/badge/Tailwind-3.4-38bdf8)
![PDF.js](https://img.shields.io/badge/PDF.js-4.5-ff6600)
![License](https://img.shields.io/badge/License-MIT-green)

---

## Features

### 项目管理
每个研究方向是一个独立项目。创建时在 `workspace/projects/<slug>/` 下生成目录骨架,并写一条 SQLite 记录。删除时连同目录和所有子资源一起清掉。所有后续产物(文献、PDF、笔记、实验、LaTeX)都挂在对应项目目录下,互不干扰。

### 文献检索
通过 OpenAlex 和 arXiv 两个源检索,自动去重。检索结果只返回元数据(标题、作者、年份、会议、引用数、abstract),不会自动下载任何东西。顶会标注基于内置注册表,覆盖 CVPR / ICML / NeurIPS / AAAI / ACL 等主流会议,并区分"已验证顶会"和普通来源。可勾选"仅显示顶会"过滤。

### PDF 下载与解析
从检索结果里选论文后,弹确认框才会下载。PDF 落盘后算 sha256,同时生成 `metadata.json` 和 `paper.bib`(BibTeX 条目)。下载完成后用 PyMuPDF 解析,抽取页级文本、章节结构、图片信息,供翻译、笔记、Agent 引用使用。解析状态会在论文详情里显示(未解析 / 解析中 / 成功 / 失败)。

### PDF 三栏阅读器
基于 PDF.js 的阅读器,左侧原文,右侧分三个 tab:翻译、笔记、元数据。选中文本即可翻译或加入批注。翻译和批注都按页保存,再次打开时还在。笔记 tab 里可以一键让 Agent 基于已抽取的论文文本生成结构化阅读笔记,笔记里的事实声明会带页码证据,不允许模型凭空编造。生成的笔记支持手动编辑和保存。

### Agent 任务中心
内置 4 个 Agent 技能,通过 LangGraph 编排:

- `research.trend_analysis` — 基于已下载论文做研究趋势分析
- `research.generate_hypothesis` — 基于已有文献生成可验证假设,结果落到研究想法库
- `code.search_github` — 检索 GitHub 上和某篇论文相关的代码仓库,并保守判断官方性(official / author_affiliated / community / unverified)
- `writing.draft_section` — 基于已验证引用和已完成的实验 run 起草论文章节

Agent 产出的陈述会强制区分为四类证据:事实、推断、假设、待验证,事实声明必须带来源引用。任务执行过程中的事件实时流式可见。涉及下载文件、写文件、运行 shell 命令的操作都要用户在审批门里点头才会执行,所有这些操作都写入 `audit_log` 表可追溯。

### 研究想法库
Agent 生成的假设和你手动添加的灵感都放在这里,带状态流转:backlog → hypothesis → decision 或 rejected。每个想法记录标题、假设、动机、状态,可以在项目内增删改。

### 实验工作台
新建实验时,在项目目录下生成一个标准的 Python 实验骨架:

```
experiments/<slug>/
├── pyproject.toml          依赖(torch>=2.2 等),用 uv 管理
├── src/train.py            Hydra 入口训练脚本
├── configs/base.yaml       Hydra 配置
├── scripts/smoke_test.sh   冒烟测试脚本
└── runs/                   每次 run 的产物目录
```

Shell Runner 异步执行命令,日志通过 SSE 实时推到前端,可以中途停止。训练脚本里 `print("METRIC step=<n> <name>=<value>")` 格式的输出会被自动解析成指标曲线,多个 run 之间可以在对比表里横向看。每个 run 目录下保存当时的 config、完整 stdout/stderr、`metrics.jsonl` 和 checkpoints。

### LaTeX 写作
在项目内初始化一个 LaTeX 工程:

```
writing/
├── main.tex                主文件,\input 各章节
├── references.bib          参考文献库
└── sections/
    ├── introduction.tex
    ├── related_work.tex
    ├── method.tex
    ├── experiments.tex
    └── conclusion.tex
```

前端提供文件树编辑器,可以编辑任意 `.tex` 文件。点编译会用 `latexmk` 生成 PDF 并在页面里预览。本机没装 TeX 时,编译按钮会降级提示,但编辑功能照常可用。引用校验会扫描所有 `.tex` 文件里的 `\cite{key}`,和已下载论文生成的 BibTeX 条目比对,列出缺失的 key 以及每个 key 在哪些文件里被用到了。`writing.draft_section` 技能起草章节时,只用已验证的引用和已完成的实验 run,不会编造参考文献。

---

## Tech Stack

**后端** (`backend/`)

| 用途 | 选型 |
| --- | --- |
| Web 框架 | FastAPI 0.115 + Uvicorn |
| 数据校验 | Pydantic v2 |
| ORM / 迁移 | SQLAlchemy 2 + Alembic |
| 数据库 | SQLite(WAL 模式) |
| PDF 解析 | PyMuPDF |
| 模型网关 | LiteLLM(OpenAI / Anthropic / Gemini / DeepSeek / Qwen / Zhipu / Ollama / 任何 OpenAI 兼容端点) |
| Agent 编排 | LangGraph |
| 包管理 | uv(Python 3.12) |

**前端** (`frontend/`)

| 用途 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript 5.5 |
| 构建 | Vite 5 |
| 样式 | Tailwind CSS 3.4 |
| PDF 渲染 | PDF.js 4.5 |
| 路由 | React Router 6 |
| 数据层 | TanStack Query 5 + Zustand |
| Markdown | react-markdown |
| 图标 | lucide-react |

**工具链** — ruff(后端 lint)、pytest(后端测试)、`tsc --noEmit`(前端类型检查)。

---

## Prerequisites

- **Python 3.12**(uv 会帮你装)
- **Node.js 18+**
- **uv**:`curl -LsSf https://astral.sh/uv/install.sh | sh`
- **(可选)TeX Live** — 仅在用到 LaTeX 编译时需要。macOS:`brew install --cask mactex`。不装也能用写作页编辑源文件,只是编译按钮会降级提示。

---

## Quick Start

```bash
# 1. 装依赖(uv 装后端,npm 装前端)
make install

# 2. 拷配置模板
cp backend/config.example.yaml workspace/.research-agent/config.yaml
cp backend/.env.example backend/.env

# 3. 编辑 backend/.env,填上你用的模型的 API key,例如:
#    DEEPSEEK_API_KEY=sk-...

# 4. 起服务(前后端并行,Ctrl+C 一起停)
make dev
```

打开浏览器:

- 前端 **http://localhost:5173**
- 后端 API 文档 **http://127.0.0.1:8000/docs**

> 国内网络:`backend/pyproject.toml` 默认走清华 PyPI 镜像,`uv sync` 通常几秒搞定。

---

## Configuration

两个文件,各管一摊。

### `workspace/.research-agent/config.yaml`

告诉后端用哪个模型。模板 `backend/config.example.yaml` 里列了所有支持的 provider,取消注释其中一组即可:

```yaml
models:
  default_chat:
    provider: deepseek          # openai / anthropic / gemini / deepseek / qwen / zhipu / ollama
    model: deepseek-chat
    api_key_env: DEEPSEEK_API_KEY   # 指向下面 .env 里的变量名
```

需要本地模型时,用 `provider: openai` + `base_url` 指向 vLLM / LM Studio / Ollama 的 OpenAI 兼容端口,配置示例都在模板里。

### `backend/.env`

放 API key。模板 `backend/.env.example` 列了所有 provider 对应的变量名,只填你用的那个就行。

```
DEEPSEEK_API_KEY=sk-...
```

**API key 只从环境变量读,不写进 config.yaml,不入数据库,不进 prompt。**

### 可选环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ZSCI_WORKSPACE_PATH` | `./workspace` | 所有项目、PDF、数据库的根目录 |
| `ZSCI_LLM_CONFIG_PATH` | `<workspace>/.research-agent/config.yaml` | 模型配置文件位置 |

---

## Project Structure

前端跑在 `:5173`,后端跑在 `:8000`,所有持久化数据落在 `workspace/` 下的 SQLite 文件和项目目录里。后端本身无状态,每个项目的文件读写都被限制在 `workspace/projects/<slug>/` 沙箱内,Agent 不会越界碰其它目录。

```
ZSci/
├── backend/
│   ├── app/
│   │   ├── main.py            FastAPI 入口
│   │   ├── routers/           11 个路由模块(projects / papers / agent / ...)
│   │   ├── agent/             LangGraph 技能(research / code / writing)
│   │   ├── db/                SQLAlchemy 模型 + session
│   │   ├── literature/        OpenAlex / arXiv 检索 + 顶会注册表
│   │   ├── pdf/               PyMuPDF 解析
│   │   ├── experiments/       实验骨架生成 + Shell Runner
│   │   ├── writing/           LaTeX 工程初始化 + 编译 + 引用校验
│   │   └── workspace/         文件沙箱管理
│   ├── alembic/               数据库迁移
│   ├── tests/                 74 个单元测试
│   └── pyproject.toml
├── frontend/
│   ├── src/
│   │   ├── pages/             路由页面(项目 / 文献库 / 阅读器 / 实验 / 写作 / ...)
│   │   ├── components/        UI 组件 + PDF.js 包装
│   │   ├── lib/               API 客户端
│   │   └── stores/            Zustand
│   └── package.json
├── workspace/                 运行时数据(gitignored)
└── Makefile                   install / dev / test / migrate / lint / clean
```

`workspace/` 在 `.gitignore` 里,首次启动时自动创建。

---

## API Reference

完整 OpenAPI 文档在 `http://127.0.0.1:8000/docs`。下面是按模块的端点速查。

### Projects
```
POST   /api/v1/projects                       创建项目
GET    /api/v1/projects                       列出所有项目
GET    /api/v1/projects/{id}                  获取单个项目
PATCH  /api/v1/projects/{id}                  更新项目
DELETE /api/v1/projects/{id}                  删除项目(含目录)
```

### Literature & Papers
```
POST   /api/v1/projects/{id}/literature/search       检索论文(元数据)
GET    /api/v1/projects/{id}/papers                  项目内论文列表
POST   /api/v1/projects/{id}/papers/download         下载并入库 PDF(需确认)
POST   /api/v1/projects/{id}/papers/import-local     导入本地已有 PDF
GET    /api/v1/papers/{id}                           论文详情
GET    /api/v1/papers/{id}/pdf                       PDF 原文件
POST   /api/v1/papers/{id}/parse                     触发 PyMuPDF 解析
```

### Notes & Annotations
```
POST   /api/v1/papers/{id}/translate                 翻译选段
GET    /api/v1/papers/{id}/translations              翻译历史
POST   /api/v1/papers/{id}/reading-note              生成结构化阅读笔记
GET    /api/v1/papers/{id}/reading-note              读取笔记
PATCH  /api/v1/papers/{id}/reading-note              编辑笔记
GET    /api/v1/papers/{id}/annotations               批注列表
POST   /api/v1/papers/{id}/annotations               新建批注
PATCH  /api/v1/annotations/{id}                      更新批注
DELETE /api/v1/annotations/{id}                      删除批注
```

### Ideas & Repositories
```
GET    /api/v1/projects/{id}/ideas                   研究想法列表
POST   /api/v1/projects/{id}/ideas                   新建想法
PATCH  /api/v1/ideas/{id}                            更新想法
DELETE /api/v1/ideas/{id}                            删除想法
GET    /api/v1/projects/{id}/repositories            代码仓库列表
PATCH  /api/v1/repositories/{id}                     更新仓库标注
DELETE /api/v1/repositories/{id}                     删除仓库
```

### Agent
```
GET    /api/v1/agent/skills                          列出可用技能
POST   /api/v1/projects/{id}/agent/tasks             派发任务
       task_type ∈ {research.trend_analysis,
                    research.generate_hypothesis,
                    code.search_github,
                    writing.draft_section}
GET    /api/v1/agent/tasks/{id}                      任务状态
GET    /api/v1/agent/tasks/{id}/events               事件历史
GET    /api/v1/agent/tasks/{id}/stream               SSE 实时流
GET    /api/v1/agent/tasks/{id}/approvals            待审批列表
POST   /api/v1/agent/tasks/{id}/approve              批准 / 拒绝
```

### Experiments & Runs
```
POST   /api/v1/projects/{id}/experiments             新建实验(生成骨架)
GET    /api/v1/projects/{id}/experiments             实验列表
GET    /api/v1/experiments/{id}                      实验详情
POST   /api/v1/experiments/{id}/runs                 新建 run(需确认命令)
GET    /api/v1/experiments/{id}/runs                 run 列表
GET    /api/v1/runs/{id}                             run 状态
POST   /api/v1/runs/{id}/stop                        停止运行中的 run
GET    /api/v1/runs/{id}/logs                        完整日志
GET    /api/v1/runs/{id}/stream                      SSE 实时日志
GET    /api/v1/runs/{id}/metrics                     指标曲线数据
```

### Writing
```
POST   /api/v1/projects/{id}/writing/init            初始化 LaTeX 工程
GET    /api/v1/projects/{id}/writing/files           文件树
GET    /api/v1/projects/{id}/writing/file            读取文件内容
PUT    /api/v1/projects/{id}/writing/file            写入文件
POST   /api/v1/projects/{id}/writing/compile         latexmk 编译
GET    /api/v1/projects/{id}/writing/pdf             下载编译产物
GET    /api/v1/projects/{id}/writing/citations       引用校验报告
```

### System
```
GET    /api/v1/health                                健康检查
GET    /api/v1/settings                              工作区 / 模型 / 顶会列表
```

---

## Development

分别启动前后端(各自独立终端):

```bash
make dev-backend     # uvicorn app.main:app --reload --port 8000
make dev-frontend    # vite dev server :5173
```

其它命令:

```bash
make migrate         # alembic upgrade head(正式迁移路径)
make lint            # ruff check . + tsc --noEmit
make clean           # 删 .venv / node_modules / dist
```

数据库说明:启动时 `Base.metadata.create_all` 会自动建表,所以 `uvicorn` 直接起就能跑;要做 schema 变更时用 Alembic 生成迁移,`make migrate` 应用。

---

## Testing

```bash
make test            # 后端:uv run pytest -q
```

后端 74 个单元测试,每个用例都跑在独立的临时 workspace + 临时 SQLite 上,互不污染,测完即销。

前端类型检查:

```bash
cd frontend && npm run build    # tsc -b && vite build
```

---

## Roadmap

- 本地 embedding 检索(把已下载论文做成可 RAG 的小库)
- 多 run 自动对比报告(不只是曲线,加统计摘要)
- 实验骨架模板扩展(PyTorch Lightning / JAX)
- 项目导出 / 协作(打包成一个可分享的 bundle)

---

## Security & Constraints

- **文件沙箱** — 所有文件读写限定在 `workspace/projects/<slug>/`,Agent 不会碰外面。
- **审计留痕** — PDF 下载、写文件、跑 shell 命令都进 `audit_log` 表,可追溯。
- **审批门** — Agent 不直接执行 shell;跑训练命令必须用户 `confirmed=true`。
- **Key 隔离** — API key 只从环境变量读,不入库、不进 prompt、不写 config.yaml。
- **优雅降级** — 模型没配时翻译/笔记/Agent 会给出提示而不是崩溃;LaTeX 没装时写作页降级为纯编辑器。
- **证据分类** — Agent 产出的陈述强制区分事实 / 推断 / 假设 / 待验证,事实声明必须带来源引用。

---

## License

[MIT](LICENSE)
