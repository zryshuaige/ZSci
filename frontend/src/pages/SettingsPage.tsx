import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, PlugZap, RotateCw } from "@/components/ui/icons";
import { api, qk } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ToneBadge } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select, SelectOptions } from "@/components/ui/Select";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToastMutation } from "@/lib/hooks/useToastMutation";
import { showFriendlyError, showInfo, showSuccess } from "@/lib/useFriendlyError";
import { cn } from "@/lib/cn";
import { TONE_CLASSES } from "@/lib/statusMeta";

export default function SettingsPage() {
  // Object form: the settings fetch is the most common first-run failure
  // (backend not started yet), so it needs a real error state, not the old
  // bare "无法读取设置" text with no way to retry.
  const settingsQuery = useQuery({ queryKey: qk.settings, queryFn: api.getSettings });
  // qk.health is shared with BackendHealthBanner — the old hand-written
  // ["health"] key was a second cache polling the same endpoint.
  const healthQuery = useQuery({ queryKey: qk.health, queryFn: api.health });
  const { data: settings, isLoading } = settingsQuery;

  if (isLoading)
    return (
      <div className="p-8 max-w-3xl mx-auto space-y-4">
        <div className="h-7 w-32"><Skeleton className="h-7 w-32" /></div>
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="p-4 space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-4 w-1/2" />
          </Card>
        ))}
      </div>
    );

  if (settingsQuery.isError)
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <Card className="p-8 text-center">
          <AlertTriangle className="mx-auto h-8 w-8 text-destructive/70" />
          <div className="mt-3 font-medium">无法读取设置</div>
          <div className="mt-1.5 text-sm text-muted-foreground leading-relaxed">
            通常是后端服务还没启动,或首次启动仍在初始化(需要几秒钟)。
            <br />
            请确认后端已运行,然后重试。
          </div>
          <Button
            className="mt-4"
            variant="outline"
            onClick={() => settingsQuery.refetch()}
            loading={settingsQuery.isRefetching}
          >
            <RotateCw className="h-4 w-4" /> 重试
          </Button>
        </Card>
      </div>
    );

  if (!settings) return null; // 不可达:loading / error 已在上面处理

  const models = settings.models || {};
  const configuredRoles: string[] = models.configured_roles || [];
  const healthDown = healthQuery.isError;

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-5">
      <PageHeader title="设置" subtitle="模型网关与工作区配置" />

      <Card className="p-4">
        <div className="text-sm text-muted-foreground">后端状态</div>
        <div className="mt-0.5 text-xs text-muted-foreground">后端服务的连接状态与当前版本。</div>
        <div className="mt-1 flex items-center gap-2">
          <ToneBadge tone={!healthDown && healthQuery.data?.status === "ok" ? "green" : "red"}>
            {healthDown ? "无法连接" : (healthQuery.data?.status ?? "未知")}
          </ToneBadge>
          <span className="text-sm">版本 {healthQuery.data?.version ?? "?"}</span>
          {healthDown && (
            <span className="text-xs text-muted-foreground">请确认后端服务已启动</span>
          )}
        </div>
      </Card>

      <Card className="p-4">
        <div className="text-sm text-muted-foreground">工作区路径</div>
        <div className="mt-1 font-mono text-sm break-all">{settings.workspace_path}</div>
        <div className="text-xs text-muted-foreground mt-1">
          所有项目目录、PDF、笔记、数据库都保存在此路径下。
        </div>
      </Card>

      <ModelGatewayCard configuredRoles={configuredRoles} />

      <Card className="p-4">
        <div className="text-sm text-muted-foreground mb-0.5">已注册顶会</div>
        <div className="mb-2 text-xs text-muted-foreground">检索文献时覆盖的会议来源。</div>
        <div className="flex flex-wrap gap-1">
          {(settings.venues || []).map((v) => (
            <Badge key={v} className="bg-muted">{v}</Badge>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model gateway editor
// ---------------------------------------------------------------------------

/**
 * Editable model-gateway card. Replaces the old read-only card that told the
 * user to hand-edit config.yaml + .env. Now the user picks a provider from a
 * dropdown, tweaks the model / base_url, pastes an API key, and saves; the
 * backend writes both files and hot-reloads the gateway.
 *
 * This is the FIRST-RUN flow: a fresh install lands here to configure an LLM
 * API key. So the card optimises for that journey:
 *   填入 Key → 保存 → 测试连接(关键验证,必须给出明确的成功/失败反馈)。
 *
 * Field semantics:
 *   - Provider <Select>: stable preset ids from GET /llm/config. Selecting one
 *     pre-fills model + base_url with the preset defaults (the common case).
 *   - Model: free text; defaults to the preset's model.
 *   - Base URL: shown for OpenAI-compatible providers (custom / siliconflow /
 *     ollama); blank for native providers. Empty string clears it on save.
 *   - API Key: password field, always starts blank. Blank on save = "keep
 *     whatever's already in .env" (the field is masked so we can't distinguish
 *     "cleared" from "unchanged"). A badge shows whether a key is currently set.
 */
function ModelGatewayCard({ configuredRoles }: { configuredRoles: string[] }) {
  const qc = useQueryClient();
  const llmQuery = useQuery({
    queryKey: qk.llmConfig,
    queryFn: api.getLLMConfig,
  });
  const { data: llm, isLoading } = llmQuery;

  const presets = llm?.presets ?? [];
  const current = llm?.current;

  // Form state. Initialized once current config arrives; selecting a provider
  // re-seeds model + base_url from the preset.
  const [providerId, setProviderId] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [apiKey, setApiKey] = useState<string>("");
  const [seeded, setSeeded] = useState(false);

  // Seed the form from the live current config (once).
  useEffect(() => {
    if (seeded || !current) return;
    setProviderId(current.matched_preset_id ?? "custom");
    setModel(current.model ?? "");
    setBaseUrl(current.base_url ?? "");
    setApiKey(""); // never pre-fill a key value
    setSeeded(true);
  }, [current, seeded]);

  const selectedPreset = useMemo(
    () => presets.find((p) => p.id === providerId) ?? null,
    [presets, providerId],
  );

  // Whether the user has manually overridden the preset defaults (so we know
  // not to clobber their edits when they change provider).
  const customizedModel = selectedPreset && model !== "" && model !== selectedPreset.model;
  const customizedBaseUrl =
    selectedPreset && baseUrl !== "" && baseUrl !== (selectedPreset.base_url ?? "");

  const handleProviderChange = (id: string) => {
    const preset = presets.find((p) => p.id === id);
    setProviderId(id);
    // Only auto-fill if the user hadn't customized the fields for the prior
    // provider - otherwise switching providers would wipe their edits.
    if (preset && !customizedModel) setModel(preset.model);
    if (preset && !customizedBaseUrl) setBaseUrl(preset.base_url ?? "");
  };

  const saveMutation = useToastMutation({
    mutationFn: () =>
      api.saveLLMConfig({
        provider_id: providerId,
        model: model.trim() || undefined,
        base_url: baseUrl.trim() === "" ? "" : baseUrl.trim(),
        api_key: apiKey || undefined,
      }),
    successMessage: "已保存,即时生效",
    onSuccess: (cur) => {
      // Re-seed from the server response so the form reflects canonical state
      // (e.g. matched_preset_id, resolved model) and the key field clears.
      setProviderId(cur.matched_preset_id ?? providerId);
      setModel(cur.model ?? "");
      setBaseUrl(cur.base_url ?? "");
      setApiKey("");
      setSeeded(true);
      // The settings page + any LLM-dependent query should re-read.
      qc.invalidateQueries({ queryKey: qk.llmConfig });
      qc.invalidateQueries({ queryKey: qk.settings });
    },
  });

  // 「测试连接」—— 首次运行的关键验证。后端没有独立的 ping 端点,所以用
  // 一次 /llm/config 往返来验证三件事:后端可达、配置已生效、Key 已落盘,
  // 并顺带测出延迟。失败走 FriendlyError toast(网络异常会提示检查后端)。
  const testMutation = useMutation({
    mutationFn: async () => {
      const t0 = performance.now();
      const cfg = await api.getLLMConfig();
      return { cfg, ms: Math.max(1, Math.round(performance.now() - t0)) };
    },
    onSuccess: ({ cfg, ms }) => {
      const cur = cfg.current;
      if (!cur.model) {
        showInfo("尚未保存模型配置,请先选择供应商并保存。");
        return;
      }
      if (cur.api_key_env && !cur.api_key_set) {
        showInfo(`后端连接正常,但 ${cur.api_key_env} 未设置——请填入 Key 并保存。`);
        return;
      }
      showSuccess(`连接正常 · ${cur.model} · ${ms}ms`);
    },
    onError: (err) => showFriendlyError(err),
  });

  // The test reads the SAVED config; testing with unsaved edits would report
  // on stale state and confuse the first-run flow, so gate it with a hint.
  const hasUnsaved =
    seeded &&
    (!!apiKey.trim() ||
      providerId !== (current?.matched_preset_id ?? "custom") ||
      model !== (current?.model ?? "") ||
      baseUrl !== (current?.base_url ?? ""));

  const handleTest = () => {
    if (hasUnsaved) {
      showInfo("配置有未保存的修改,请先「保存」,再测试连接。");
      return;
    }
    testMutation.mutate();
  };

  const showBaseUrl = !!selectedPreset && (selectedPreset.id === "custom" || !!selectedPreset.base_url);
  const keyPlaceholder = current?.api_key_set ? "已配置,留空保持不变" : "请输入 API Key";

  // 错误≠空:配置加载失败给错误卡 + 重试,而不是永远停在骨架屏。
  if (llmQuery.isError) {
    return (
      <Card className="p-4 text-center">
        <AlertTriangle className="mx-auto h-5 w-5 text-destructive/70" />
        <div className="mt-2 text-sm text-muted-foreground">模型配置加载失败</div>
        <Button
          size="sm"
          variant="outline"
          className="mt-3"
          onClick={() => llmQuery.refetch()}
          loading={llmQuery.isRefetching}
        >
          <RotateCw className="h-3.5 w-3.5" /> 重试
        </Button>
      </Card>
    );
  }

  if (isLoading || !llm) {
    return (
      <Card className="p-4 space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </Card>
    );
  }

  return (
    <Card className="p-4 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm text-muted-foreground">模型网关</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            配置供应商、模型与 API Key,保存后即时生效。
          </div>
        </div>
        <ToneBadge tone={current?.api_key_set ? "green" : "amber"}>
          {current?.api_key_set ? "Key 已配置" : "Key 未配置"}
        </ToneBadge>
      </div>

      {/* Provider dropdown */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">供应商</label>
        <Select
          value={providerId}
          onChange={(e) => handleProviderChange(e.target.value)}
          className="w-full"
        >
          <SelectOptions items={presets.map((p) => ({ value: p.id, label: p.name_zh }))} />
        </Select>
        {selectedPreset && (
          <div className="text-xs text-muted-foreground">{selectedPreset.key_hint}</div>
        )}
      </div>

      {/* Model */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">模型</label>
        <Input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="模型名称,如 deepseek-chat"
          className="font-mono text-xs"
        />
      </div>

      {/* Base URL (only for OpenAI-compatible providers) */}
      {showBaseUrl && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Base URL</label>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1(留空则不使用)"
            className="font-mono text-xs"
          />
        </div>
      )}

      {/* API key */}
      {selectedPreset?.needs_key && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            API Key
            {selectedPreset.api_key_env && (
              <span className="ml-1 font-mono text-[10px] text-muted-foreground/70">
                ({selectedPreset.api_key_env})
              </span>
            )}
          </label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={keyPlaceholder}
            autoComplete="off"
            className="font-mono text-xs"
          />
          <div className="text-xs text-muted-foreground">
            Key 保存在 <code className="bg-muted px-1 rounded">backend/.env</code>,不会随配置文件外泄。
          </div>
        </div>
      )}

      {/* 首次使用引导:Key 未配置时给出三步路径,「测试连接」是最后验证。 */}
      {!current?.api_key_set && selectedPreset?.needs_key && (
        <div className={cn("rounded-lg border px-3 py-2 text-xs leading-relaxed", TONE_CLASSES.amber.soft)}>
          首次使用:填入 API Key → 保存 → 测试连接。配置成功后,文献翻译、想法探索、实验助手等功能才会可用。
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button
          onClick={() => saveMutation.mutate()}
          loading={saveMutation.isPending}
          disabled={!providerId}
          size="sm"
        >
          保存
        </Button>
        {/* 测试连接:首次运行的关键验证,给足成功(模型+延迟)/失败反馈。 */}
        <Button
          size="sm"
          variant="outline"
          onClick={handleTest}
          loading={testMutation.isPending}
          disabled={saveMutation.isPending}
        >
          <PlugZap className="h-4 w-4" /> 测试连接
        </Button>
        {configuredRoles.length > 0 && (
          <span className="ml-auto text-xs text-muted-foreground">
            已配置角色:{configuredRoles.join(", ")}
          </span>
        )}
      </div>
    </Card>
  );
}
