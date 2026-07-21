import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";

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
  const configured = configuredRoles.length > 0;

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

      <Card className="p-4">
        <div className="text-sm text-muted-foreground">模型网关</div>
        {configured ? (
          <div className="mt-1 space-y-1">
            <div>默认对话模型:{models.default_chat_model ?? "(未设置)"}</div>
            <div className="text-xs text-muted-foreground">Provider:{models.default_chat_provider ?? "(未设置)"}</div>
            <div className="text-xs text-muted-foreground">已配置角色:{configuredRoles.join(", ")}</div>
          </div>
        ) : (
          <div className="mt-1 text-sm">
            <div className="text-amber-600 font-medium">尚未配置模型。</div>
            <div className="text-xs text-muted-foreground mt-1">
              翻译与阅读笔记功能需要 LLM。请编辑{" "}
              <code className="bg-muted px-1 rounded">workspace/.research-agent/config.yaml</code>,
              并在 <code className="bg-muted px-1 rounded">backend/.env</code> 设置对应 API Key。
              参见 <code className="bg-muted px-1 rounded">backend/config.example.yaml</code>。
            </div>
          </div>
        )}
      </Card>

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
