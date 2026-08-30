import { useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Play, Sparkles, CheckCircle, AlertTriangle, ChevronDown, Loader2, RotateCw } from "@/components/ui/icons";
import { api, qk, type Project } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog, Spinner } from "@/components/ui/Dialog";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { ShortcutTooltip } from "@/components/ui/Tooltip";
import { useAgentTaskStatus } from "@/lib/hooks/useAgentTaskStatus";
import { useToastMutation } from "@/lib/hooks/useToastMutation";
import { showFriendlyError, showSuccess } from "@/lib/useFriendlyError";
import { TONE_CLASSES } from "@/lib/statusMeta";

export default function WritingPage() {
  const { project } = useOutletContext<{ project: Project }>();
  const qc = useQueryClient();
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  // Line-number gutter: the count derives from content; scroll position is
  // synced from the textarea's onScroll, so the gutter itself needs no
  // listener (and stays non-interactive).
  const gutterRef = useRef<HTMLDivElement>(null);
  const lineCount = useMemo(() => content.split("\n").length, [content]);
  // Bump on every successful compile so the preview iframe (same URL each
  // time) reloads instead of showing the cached previous build.
  const [compileSeq, setCompileSeq] = useState(0);
  // Which template is currently active (inferred from main.tex content); the
  // "switch template" control is the shared Dropdown primitive.
  const [currentTemplate, setCurrentTemplate] = useState<string>("generic");

  const { data: templatesResp } = useQuery({
    queryKey: qk.writing.templates(project.id),
    queryFn: () => api.listWritingTemplates(project.id),
  });
  const templates = templatesResp?.templates ?? [];

  const filesQuery = useQuery({
    queryKey: qk.writing.files(project.id),
    queryFn: () => api.listWritingFiles(project.id),
  });
  const filesResp = filesQuery.data;

  // Object form so the citations panel can distinguish loading / error /
  // success — previously a failed fetch rendered as a Spinner forever.
  const citationsQuery = useQuery({
    queryKey: qk.writing.citations(project.id),
    queryFn: () => api.getCitations(project.id),
    enabled: !!filesResp?.files.length,
  });
  const citations = citationsQuery.data;

  const fileQuery = useQuery({
    queryKey: qk.writing.file(project.id, currentPath ?? ""),
    queryFn: () => api.getWritingFile(project.id, currentPath!),
    enabled: !!currentPath,
  });

  // Load file content into the editor when the PATH changes (switching files)
  // OR when data for a not-yet-loaded path arrives. The naive `[currentPath]`
  // dep loses a race on first page load: the effect runs while the fetch is
  // still in flight, and never re-runs when data lands -> blank editor. The
  // old `[fileQuery.data]` dep instead clobbered user typing after a save.
  // The loaded-path ref fixes both: load once per path, ignore refetches.
  const loadedPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (fileQuery.data && loadedPathRef.current !== currentPath) {
      loadedPathRef.current = currentPath;
      setContent(fileQuery.data.content);
    }
  }, [fileQuery.data, currentPath]);

  // Infer the active template from main.tex's \documentclass so the "switch
  // template" control shows the current selection. Falls back to "generic".
  useEffect(() => {
    if (currentPath !== "main.tex" || !fileQuery.data) return;
    const src = fileQuery.data.content;
    if (/\\documentclass.*IEEEtran/.test(src)) setCurrentTemplate("ieee");
    else if (/\\documentclass.*elsarticle/.test(src)) setCurrentTemplate("elsevier");
    else setCurrentTemplate("generic");
  }, [currentPath, fileQuery.data]);

  useEffect(() => {
    // M5: only auto-pick main.tex if it actually exists; previously this would
    // set currentPath to "main.tex" even when no such file existed, causing a
    // 404 in fileQuery and a blank editor.
    if (!currentPath && filesResp?.files?.length) {
      const files = filesResp.files;
      setCurrentPath(files.includes("main.tex") ? "main.tex" : files[0]);
    }
  }, [filesResp, currentPath]);

  // M4: track dirty state so we can show the "● 未保存" indicator + title
  // dot and warn before window-close.
  const isDirty = !!currentPath && !!fileQuery.data && content !== fileQuery.data.content;

  // Dirty guard: beforeunload covers tab close / refresh, but the in-app loss
  // path is FILE SWITCHING — editor content is per-file state, so clicking
  // another file would silently drop unsaved edits. Gate that with a
  // ConfirmDialog ("为什么空 / 如何挽回" 的交互契约同样适用于数据丢失).
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  const switchFile = (path: string) => {
    if (path === currentPath) return;
    if (isDirty) setPendingSwitch(path);
    else setCurrentPath(path);
  };

  const saveMutation = useToastMutation({
    mutationFn: () => api.putWritingFile(project.id, currentPath!, content),
    successMessage: "已保存",
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.writing.file(project.id, currentPath!) }),
  });

  // The inline "已保存" badge belongs to the file it came from — reset it on
  // file switch so it doesn't bleed onto the freshly opened file.
  useEffect(() => {
    saveMutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath]);

  // Cmd/Ctrl+S to save when the editor is focused. Avoids stealing the
  // shortcut when the user is inside an Input/dialog (those are HTML <input>
  // children which already have their own native handling).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (currentPath && !saveMutation.isPending && content !== fileQuery.data?.content) {
          saveMutation.mutate();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath, content, saveMutation.isPending, fileQuery.data?.content]);

  // Warn before window close / refresh if there are unsaved edits. Modern
  // browsers ignore the custom message but still show their own "Leave site?"
  // dialog when returnValue is set.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isDirty) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  // A template switch the user still has to confirm (dirty main.tex). Held in
  // state so the ConfirmDialog can replace the old window.confirm.
  const [pendingTemplate, setPendingTemplate] = useState<{ key: string; label: string } | null>(null);

  const initMutation = useToastMutation({
    mutationFn: (args: { template: string; force?: boolean }) =>
      api.initWriting(project.id, args.template, args.force ?? false),
    successMessage: (_data, args) => (args.force ? "模板已切换" : "写作项目已初始化"),
    onSuccess: (_data, args) => {
      qc.invalidateQueries({ queryKey: qk.writing.files(project.id) });
      qc.invalidateQueries({ queryKey: qk.writing.file(project.id, "main.tex") });
      setCurrentTemplate(args.template);
    },
  });

  const compileMutation = useToastMutation({
    mutationFn: () => api.compileWriting(project.id),
    onSuccess: (data) => {
      // compile is now backgrounded server-side; it returns a job_id. Track it
      // via the shared workflows/active query (polled globally) to learn when
      // it finishes, then refresh the PDF preview.
      setLastCompileResult(null);
      setLastCompileError(null);
      setCompileJobId(data.job_id ?? null);
      qc.invalidateQueries({ queryKey: qk.writing.citations(project.id) });
    },
  });

  // Observe our compile job's status through the shared active-workflows cache.
  const [compileJobId, setCompileJobId] = useState<string | null>(null);
  // "done" | "failed" | null — the outcome of the last compile, kept around so
  // the preview stays shown after the job leaves the active window.
  const [lastCompileResult, setLastCompileResult] = useState<"done" | "failed" | null>(null);
  const [lastCompileError, setLastCompileError] = useState<string | null>(null);
  const { data: active } = useQuery({
    queryKey: qk.workflows.active,
    queryFn: () => api.listActiveWorkflows(),
    refetchInterval: (q) => {
      const d = q.state.data;
      const mine = d?.jobs.find((j) => j.id === compileJobId);
      const mineActive = mine && !mine.recent;
      return compileJobId && (mineActive || d === undefined) ? 2000 : false;
    },
    enabled: !!compileJobId,
  });
  const compileJob = active?.jobs.find((j) => j.id === compileJobId) ?? null;
  // When the job reaches a terminal state, refresh the preview (+ citations)
  // and cache the outcome so it survives the job leaving the recent window.
  // Also toast the result — the user may have switched away from the preview
  // pane while the background compile ran, so the pane alone isn't enough.
  useEffect(() => {
    if (!compileJob || compileJob.recent === undefined) return;
    if (!compileJob.recent) return; // still active
    if (compileJob.status === "completed") {
      setCompileSeq((n) => n + 1);
      setLastCompileResult("done");
      setLastCompileError(null);
      setCompileJobId(null);
      qc.invalidateQueries({ queryKey: qk.writing.citations(project.id) });
      showSuccess("编译完成,PDF 预览已更新");
    } else if (compileJob.status === "failed" || compileJob.status === "stopped") {
      setLastCompileResult("failed");
      setLastCompileError(compileJob.error);
      setCompileJobId(null);
      // Chinese summary in the toast; the raw LaTeX error stays visible in
      // the preview pane for debugging.
      showFriendlyError(new Error("编译失败：请检查 LaTeX 源文件，或确认本地已安装 TeX 环境。"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compileJob?.status, compileJob?.recent]);

  const draftMutation = useToastMutation({
    mutationFn: () =>
      api.runAgentTask(project.id, "writing.draft_section", { section_name: "related_work" }),
    onSuccess: (task) => {
      // The synchronous endpoint created the draft + returned the terminal
      // task. Refresh the affected lists so the new file/notes appear.
      qc.invalidateQueries({ queryKey: qk.writing.files(project.id) });
      qc.invalidateQueries({ queryKey: qk.writing.citations(project.id) });
      qc.invalidateQueries({ queryKey: qk.workflows.active });
      if (task?.id) setActiveDraftTaskId(task.id);
    },
  });

  // Track the most recent draft task so the button stays in "running" state
  // through the sidebar's recent window (avoids the "submitted → idle →
  // waiting" flicker while the user reads the result).
  const [activeDraftTaskId, setActiveDraftTaskId] = useState<string | null>(null);
  const draftStatus = useAgentTaskStatus(
    activeDraftTaskId,
    () => {
      setActiveDraftTaskId(null);
    },
  );
  const isDraftRunning = draftMutation.isPending || draftStatus.isActive || draftStatus.isTerminal;

  const files = filesResp?.files ?? [];

  return (
    <div className="flex flex-col h-full">
      <div className="h-11 shrink-0 border-b border-border/60 bg-card px-4 flex items-center gap-2">
        <h1 className="text-sm font-semibold flex-1">
          论文写作
          {isDirty && <span className={`ml-1.5 text-sm ${TONE_CLASSES.amber.text}`} title="有未保存的修改">●</span>}
        </h1>
        {!filesQuery.isError && files.length === 0 && (
          <span className="text-xs text-muted-foreground">
            {initMutation.isPending ? "初始化中…" : "选择下方模板开始"}
          </span>
        )}
        {files.length !== 0 && (
          <>
            {/* Switch-template menu (shared Dropdown primitive).
                force=True rewrites only main.tex; sections and references.bib
                are preserved. */}
            <Dropdown
              align="end"
              menuClassName="w-64"
              trigger={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={initMutation.isPending}
                >
                  模板:{templates.find((t) => t.key === currentTemplate)?.label ?? "通用"}
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              }
            >
              {(close) =>
                templates.map((t) => (
                  <DropdownItem
                    key={t.key}
                    className={t.key === currentTemplate ? "bg-muted font-medium" : undefined}
                    onClick={() => {
                      close();
                      if (t.key === currentTemplate) return;
                      // Only confirm when there are local edits worth losing;
                      // otherwise the template switch is a no-op for the user.
                      if (isDirty) setPendingTemplate({ key: t.key, label: t.label });
                      else initMutation.mutate({ template: t.key, force: true });
                    }}
                  >
                    <div>
                      <div>{t.label}</div>
                      <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{t.note}</div>
                    </div>
                  </DropdownItem>
                ))
              }
            </Dropdown>
            <Button size="sm" variant="outline" onClick={() => draftMutation.mutate()} disabled={isDraftRunning}>
              {isDraftRunning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {isDraftRunning ? "生成草稿…" : "Agent 草稿"}
            </Button>
            <Button size="sm" onClick={() => compileMutation.mutate()} disabled={compileMutation.isPending || !!compileJobId}>
              <Play className="h-4 w-4" />
              {compileMutation.isPending
                ? "提交中…"
                : compileJobId
                  ? "编译中…"
                  : "编译 PDF"}
            </Button>
          </>
        )}
      </div>

      {filesQuery.isError ? (
        /* 错误≠空:文件列表加载失败时给错误卡 + 重试,而不是掉进下面
           「选择模板初始化」的空态(那会诱导用户重复初始化)。 */
        <div className="p-8 max-w-3xl mx-auto w-full">
          <Card className="p-6 text-center">
            <AlertTriangle className="mx-auto h-6 w-6 text-destructive/70" />
            <div className="mt-2 text-sm text-muted-foreground">写作文件加载失败</div>
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => filesQuery.refetch()}
            >
              <RotateCw className="h-3.5 w-3.5" /> 重试
            </Button>
          </Card>
        </div>
      ) : files.length === 0 ? (
        <div className="p-8 max-w-3xl mx-auto">
          <Card className="p-8 text-center text-muted-foreground animate-pop">
            <FileText className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <div className="text-sm">选择一个 LaTeX 模板初始化写作项目</div>
            <div className="text-xs mt-2">main.tex + 章节骨架 + references.bib</div>
            <div className="text-xs mt-2">
              编译需本地安装 TeX(macOS: brew install --cask mactex);未安装时编译会给出提示,但源文件仍可编辑。
            </div>
          </Card>
          <div className="grid gap-3 mt-4 sm:grid-cols-3">
            {templates.map((t, i) => (
              <Card
                key={t.key}
                style={{ animationDelay: `${i * 60}ms` }}
                className="p-5 flex flex-col animate-slide-up hover-lift hover:shadow-medium"
              >
                <div className="font-medium text-sm">{t.label}</div>
                <div className="text-xs text-muted-foreground mt-1.5 flex-1 leading-relaxed">{t.note}</div>
                <Button
                  size="sm"
                  className="mt-4"
                  onClick={() => initMutation.mutate({ template: t.key })}
                  disabled={initMutation.isPending}
                >
                  使用此模板
                </Button>
              </Card>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          {/* File tree */}
          <aside className="w-56 shrink-0 border-r border-border bg-muted/30 overflow-auto p-2 text-sm">
            <div className="px-2 mb-1 text-[11px] tracking-wide text-muted-foreground">文稿文件</div>
            {files.map((f) => (
              <button
                key={f}
                onClick={() => switchFile(f)}
                className={`block w-full text-left rounded px-2 py-1 hover:bg-muted font-mono text-xs ${
                  currentPath === f ? "bg-card shadow-sm font-medium" : ""
                }`}
              >
                {f}
              </button>
            ))}
          </aside>

          {/* Editor */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <div className="flex items-center gap-2 border-b border-border px-3 py-1 text-xs text-muted-foreground shrink-0">
              <ShortcutTooltip content="保存" shortcut="⌘S">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => saveMutation.mutate()}
                  loading={saveMutation.isPending}
                  disabled={!currentPath}
                >
                  保存
                </Button>
              </ShortcutTooltip>
            </div>
            <div className="flex-1 min-h-0 flex">
              {/* Line-number gutter — pure presentation; scroll is synced
                  from the textarea below. Line heights match (leading-6). */}
              <div
                ref={gutterRef}
                aria-hidden
                className="w-10 shrink-0 select-none overflow-hidden border-r border-border/60 bg-muted/30 py-4 pr-2 text-right font-mono text-[11px] leading-6 text-muted-foreground/50"
              >
                {Array.from({ length: lineCount }, (_, i) => (
                  <div key={i}>{i + 1}</div>
                ))}
              </div>
              <textarea
                className="flex-1 min-h-0 w-full py-4 pl-3 pr-4 font-mono text-[13px] leading-6 tabular-nums bg-card resize-none border-0 focus:outline-none focus:ring-0"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                onScroll={(e) => {
                  if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
                }}
                spellCheck={false}
              />
            </div>
            {/* Editor status bar — path, size, and the dirty/saved indicator
                (moved down from the save strip above). */}
            <div className="h-7 shrink-0 border-t border-border/60 flex items-center gap-3 px-3 text-[11px] text-muted-foreground">
              <span className="font-mono truncate">{currentPath}</span>
              <span className="tabular-nums shrink-0">
                共 {lineCount} 行 · {content.length} 字符
              </span>
              {isDirty && <span className={TONE_CLASSES.amber.text}>● 未保存</span>}
              {saveMutation.isSuccess && !isDirty && (
                <span className={TONE_CLASSES.green.text}>已保存</span>
              )}
            </div>
          </div>

          {/* Right: PDF preview + citations */}
          <aside className="w-80 shrink-0 border-l border-border bg-card flex flex-col">
            <div className="border-b border-border p-2 text-xs font-medium">PDF 预览</div>
            <div className="flex-1 overflow-auto bg-muted/30">
              {compileJobId ? (
                <div className={`p-3 text-xs flex items-center gap-2 ${TONE_CLASSES.blue.text}`}>
                  <Spinner className="h-3.5 w-3.5" />
                  正在后台编译(laTeX,最多 2 分钟)…侧栏同步显示进度。
                </div>
              ) : lastCompileResult === "done" ? (
                /* key by the compile sequence so a successful recompile (same
                   URL, new PDF on disk) forces the iframe to reload instead of
                   showing the cached previous build. */
                <iframe
                  key={compileSeq}
                  src={api.writingPdfUrl(project.id)}
                  className="w-full h-full min-h-96"
                  title="pdf"
                />
              ) : lastCompileResult === "failed" ? (
                <div className={`p-3 text-xs ${TONE_CLASSES.red.text}`}>
                  编译失败:{lastCompileError || "请检查源文件或确认本地已安装 TeX 环境。"}
                </div>
              ) : (
                <div className="p-3 text-xs text-muted-foreground">
                  点击「编译 PDF」生成预览。需本地 TeX 环境;编译在后台进行,可切页,侧栏会显示进度。
                </div>
              )}
            </div>
            <div className="border-t border-border p-2">
              <div className="text-xs font-medium mb-1">引用校验</div>
              {citationsQuery.isError ? (
                <div className="text-xs text-muted-foreground flex items-center gap-1.5 flex-wrap">
                  <AlertTriangle className="h-3 w-3 text-destructive/70 shrink-0" />
                  加载失败
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-1.5 text-xs"
                    onClick={() => citationsQuery.refetch()}
                  >
                    <RotateCw className="h-3 w-3" /> 重试
                  </Button>
                </div>
              ) : citations ? (
                <div className="text-xs space-y-1">
                  <div className="flex items-center gap-1">
                    {citations.ok ? (
                      <><CheckCircle className={`h-3 w-3 ${TONE_CLASSES.green.text}`} /><span className={TONE_CLASSES.green.text}>所有引用已验证</span></>
                    ) : (
                      <><AlertTriangle className={`h-3 w-3 ${TONE_CLASSES.amber.text}`} /><span className={TONE_CLASSES.amber.text}>{citations.missing.length} 个引用缺失</span></>
                    )}
                  </div>
                  {citations.missing.length > 0 && (
                    <div className={`font-mono break-all ${TONE_CLASSES.amber.text}`}>
                      {citations.missing.join(", ")}
                    </div>
                  )}
                  <div className="text-muted-foreground">可用引用:{citations.available_keys.length}</div>
                </div>
              ) : <Spinner />}
            </div>
          </aside>
        </div>
      )}

      {/* 脏检查:切换文件前确认,避免未保存的修改被静默丢弃。 */}
      <ConfirmDialog
        open={pendingSwitch !== null}
        title="有未保存的修改"
        description={`切换到「${pendingSwitch ?? ""}」将丢失当前文件中未保存的修改。可先取消，用 ⌘S / Ctrl+S 保存后再切换。`}
        confirmLabel="放弃修改并切换"
        danger
        onConfirm={() => {
          if (pendingSwitch) setCurrentPath(pendingSwitch);
          setPendingSwitch(null);
        }}
        onCancel={() => setPendingSwitch(null)}
      />

      {/* 模板切换覆盖 main.tex,属于破坏性操作 —— danger 样式。 */}
      <ConfirmDialog
        open={pendingTemplate !== null}
        title={`切换到「${pendingTemplate?.label ?? ""}」?`}
        description="将覆盖 main.tex(文档类与导言区),章节内容与 references.bib 会保留；当前 main.tex 未保存的修改会丢失。"
        confirmLabel="切换模板"
        danger
        onConfirm={() => {
          if (pendingTemplate) initMutation.mutate({ template: pendingTemplate.key, force: true });
          setPendingTemplate(null);
        }}
        onCancel={() => setPendingTemplate(null)}
      />
    </div>
  );
}
