import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Skeleton } from "@/components/ui/Skeleton";
import { showFriendlyError } from "@/lib/useFriendlyError";

export default function SettingsPage() {
  const { data: settings, isLoading } = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
  const { data: health } = useQuery({ queryKey: ["health"], queryFn: api.health });

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
  if (!settings) return <div className="p-8">无法读取设置。</div>;

  const models = settings.models || {};
  const configuredRoles: string[] = models.configured_roles || [];

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">设置</h1>

      <Card className="p-4">
        <div className="text-sm text-muted-foreground">后端状态</div>
        <div className="mt-1 flex items-center gap-2">
          <Badge className={health?.status === "ok" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>
            {health?.status ?? "未知"}
          </Badge>
          <span className="text-sm">版本 {health?.version ?? "?"}</span>
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
        <div className="text-sm text-muted-foreground mb-2">已注册顶会</div>
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
 * Field semantics:
 *   - Provider <select>: stable preset ids from GET /llm/config. Selecting one
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
  const { data: llm, isLoading } = useQuery({
    queryKey: ["llm-config"],
    queryFn: api.getLLMConfig,
  });

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

  const saveMutation = useMutation({
    mutationFn: () =>
      api.saveLLMConfig({
        provider_id: providerId,
        model: model.trim() || undefined,
        base_url: baseUrl.trim() === "" ? "" : baseUrl.trim(),
        api_key: apiKey || undefined,
      }),
    onSuccess: (cur) => {
      // Re-seed from the server response so the form reflects canonical state
      // (e.g. matched_preset_id, resolved model) and the key field clears.
      setProviderId(cur.matched_preset_id ?? providerId);
      setModel(cur.model ?? "");
      setBaseUrl(cur.base_url ?? "");
      setApiKey("");
      setSeeded(true);
      // The settings page + any LLM-dependent query should re-read.
      qc.invalidateQueries({ queryKey: ["llm-config"] });
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err) => showFriendlyError(err),
  });

  const showBaseUrl = !!selectedPreset && (selectedPreset.id === "custom" || !!selectedPreset.base_url);
  const keyPlaceholder = current?.api_key_set ? "已配置,留空保持不变" : "请输入 API Key";

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
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">模型网关</div>
        <Badge className={current?.api_key_set ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}>
          {current?.api_key_set ? "Key 已配置" : "Key 未配置"}
        </Badge>
      </div>

      {/* Provider dropdown */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">供应商</label>
        <select
          value={providerId}
          onChange={(e) => handleProviderChange(e.target.value)}
          className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>{p.name_zh}</option>
          ))}
        </select>
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

      <div className="flex items-center gap-2 pt-1">
        <Button
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending || !providerId}
          size="sm"
        >
          {saveMutation.isPending ? "保存中…" : "保存"}
        </Button>
        {saveMutation.isSuccess && (
          <span className="text-xs text-green-700">已保存,即时生效</span>
        )}
        {configuredRoles.length > 0 && (
          <span className="ml-auto text-xs text-muted-foreground">
            已配置角色:{configuredRoles.join(", ")}
          </span>
        )}
      </div>
    </Card>
  );
}
