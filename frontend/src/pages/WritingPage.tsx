import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Play, Sparkles, CheckCircle, AlertTriangle, ChevronDown } from "lucide-react";
import { api, type Project } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Spinner } from "@/components/ui/Dialog";

export default function WritingPage() {
  const { project } = useOutletContext<{ project: Project }>();
  const qc = useQueryClient();
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  // Bump on every successful compile so the preview iframe (same URL each
  // time) reloads instead of showing the cached previous build.
  const [compileSeq, setCompileSeq] = useState(0);
  // Which template is currently active (inferred from main.tex content), plus a
  // dropdown toggle for the "switch template" control.
  const [currentTemplate, setCurrentTemplate] = useState<string>("generic");
  const [tplMenuOpen, setTplMenuOpen] = useState(false);

  const { data: templatesResp } = useQuery({
    queryKey: ["writing-templates", project.id],
    queryFn: () => api.listWritingTemplates(project.id),
  });
  const templates = templatesResp?.templates ?? [];

  const { data: filesResp } = useQuery({
    queryKey: ["writing-files", project.id],
    queryFn: () => api.listWritingFiles(project.id),
  });

  const { data: citations } = useQuery({
    queryKey: ["citations", project.id],
    queryFn: () => api.getCitations(project.id),
    enabled: !!filesResp?.files.length,
  });

  const fileQuery = useQuery({
    queryKey: ["writing-file", project.id, currentPath],
    queryFn: () => api.getWritingFile(project.id, currentPath!),
    enabled: !!currentPath,
  });

  useEffect(() => {
    if (fileQuery.data) setContent(fileQuery.data.content);
  }, [fileQuery.data]);

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

  // M4: track dirty state so we can warn before switching files and losing
  // unsaved edits.
  const isDirty = !!currentPath && !!fileQuery.data && content !== fileQuery.data.content;
  const switchFile = (path: string) => {
    if (isDirty && !window.confirm(`放弃对 ${currentPath} 的未保存修改?`)) return;
    setCurrentPath(path);
  };

  const saveMutation = useMutation({
    mutationFn: () => api.putWritingFile(project.id, currentPath!, content),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["writing-file", project.id, currentPath] }),
  });

  const initMutation = useMutation({
    mutationFn: (args: { template: string; force?: boolean }) =>
      api.initWriting(project.id, args.template, args.force ?? false),
    onSuccess: (_data, args) => {
      qc.invalidateQueries({ queryKey: ["writing-files", project.id] });
      qc.invalidateQueries({ queryKey: ["writing-file", project.id, "main.tex"] });
      setCurrentTemplate(args.template);
    },
  });

  const compileMutation = useMutation({
    mutationFn: () => api.compileWriting(project.id),
    onSuccess: (data) => {
      if (data.ok) setCompileSeq((n) => n + 1);
      qc.invalidateQueries({ queryKey: ["citations", project.id] });
    },
  });

  const draftMutation = useMutation({
    mutationFn: () =>
      api.runAgentTask(project.id, "writing.draft_section", { section_name: "related_work" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["writing-files", project.id] });
      qc.invalidateQueries({ queryKey: ["citations", project.id] });
    },
  });

  const files = filesResp?.files ?? [];

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border bg-card px-4 py-2 flex items-center gap-2 shrink-0">
        <h1 className="font-semibold flex-1">论文写作</h1>
        {files.length === 0 && (
          <span className="text-xs text-muted-foreground">
            {initMutation.isPending ? "初始化中…" : "选择下方模板开始"}
          </span>
        )}
        {files.length !== 0 && (
          <>
            {/* Switch-template dropdown. force=True rewrites only main.tex;
                sections and references.bib are preserved. */}
            <div className="relative">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setTplMenuOpen((v) => !v)}
                disabled={initMutation.isPending}
              >
                模板:{templates.find((t) => t.key === currentTemplate)?.label ?? "通用"}
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
              {tplMenuOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setTplMenuOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 z-40 w-64 rounded-xl border border-border bg-card shadow-float p-1.5 animate-pop origin-top-right">
                    {templates.map((t) => (
                      <button
                        key={t.key}
                        onClick={() => {
                          setTplMenuOpen(false);
                          if (t.key === currentTemplate) return;
                          if (
                            window.confirm(
              `切换到「${t.label}」?\n\n将覆盖 main.tex(文档类与导言区),章节内容与 references.bib 会保留。`
                            )
                          ) {
                            initMutation.mutate({ template: t.key, force: true });
                          }
                        }}
                        className={`w-full text-left rounded-lg px-3 py-2 text-sm transition-colors duration-sm ease-out hover:bg-muted ${
                          t.key === currentTemplate ? "bg-muted font-medium" : ""
                        }`}
                      >
                        <div>{t.label}</div>
                        <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{t.note}</div>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <Button size="sm" variant="outline" onClick={() => draftMutation.mutate()} disabled={draftMutation.isPending}>
              <Sparkles className="h-4 w-4" />
              {draftMutation.isPending ? "生成草稿…" : "Agent 草稿"}
            </Button>
            <Button size="sm" onClick={() => compileMutation.mutate()} disabled={compileMutation.isPending}>
              <Play className="h-4 w-4" />
              {compileMutation.isPending ? "编译中…" : "编译 PDF"}
            </Button>
          </>
        )}
      </div>

      {files.length === 0 ? (
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
          {initMutation.isError && (
            <div className="text-xs text-destructive mt-3 text-center">
              初始化失败:{(initMutation.error as Error).message}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          {/* File tree */}
          <aside className="w-56 shrink-0 border-r border-border bg-card overflow-auto p-2 text-sm">
            <div className="text-xs text-muted-foreground mb-1 px-2">文件</div>
            {files.map((f) => (
              <button
                key={f}
                onClick={() => switchFile(f)}
                className={`block w-full text-left rounded px-2 py-1 hover:bg-muted font-mono text-xs ${
                  currentPath === f ? "bg-muted font-medium" : ""
                }`}
              >
                {f}
              </button>
            ))}
          </aside>

          {/* Editor */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <div className="flex items-center gap-2 border-b border-border px-3 py-1 text-xs text-muted-foreground shrink-0">
              <span className="font-mono">{currentPath}</span>
              {isDirty && <span className="text-amber-600">● 未保存</span>}
              <Button size="sm" variant="outline" onClick={() => saveMutation.mutate()} disabled={!currentPath || saveMutation.isPending}>
                保存
              </Button>
              {saveMutation.isSuccess && !isDirty && <span className="text-green-600 text-xs">已保存</span>}
            </div>
            <textarea
              className="flex-1 min-h-0 w-full p-3 font-mono text-xs resize-none border-0 focus:outline-none focus:ring-0"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              spellCheck={false}
            />
          </div>

          {/* Right: PDF preview + citations */}
          <aside className="w-80 shrink-0 border-l border-border bg-card flex flex-col">
            <div className="border-b border-border p-2 text-xs font-medium">PDF 预览</div>
            <div className="flex-1 overflow-auto bg-muted/30">
              {compileMutation.data?.ok ? (
                /* key by the compile run's timestamp so a successful recompile
                   (same URL, new PDF on disk) forces the iframe to reload
                   instead of showing the cached previous build. */
                <iframe
                  key={compileSeq}
                  src={api.writingPdfUrl(project.id)}
                  className="w-full h-full min-h-96"
                  title="pdf"
                />
              ) : (
                <div className="p-3 text-xs text-muted-foreground">
                  {compileMutation.data?.error || "点击「编译 PDF」生成预览。需本地 TeX 环境。"}
                </div>
              )}
            </div>
            <div className="border-t border-border p-2">
              <div className="text-xs font-medium mb-1">引用校验</div>
              {citations ? (
                <div className="text-xs space-y-1">
                  <div className="flex items-center gap-1">
                    {citations.ok ? (
                      <><CheckCircle className="h-3 w-3 text-green-600" /><span className="text-green-700">所有引用已验证</span></>
                    ) : (
                      <><AlertTriangle className="h-3 w-3 text-amber-600" /><span className="text-amber-700">{citations.missing.length} 个引用缺失</span></>
                    )}
                  </div>
                  {citations.missing.length > 0 && (
                    <div className="text-amber-700 font-mono break-all">
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

      {draftMutation.isError && (
        <div className="p-2 text-xs text-destructive border-t border-border">
          Agent 草稿生成失败:{(draftMutation.error as Error).message}(需配置 LLM)
        </div>
      )}
    </div>
  );
}
