import { useQuery } from "@tanstack/react-query";
import { api, qk } from "@/api";

/**
 * useLLMReadiness — 首启预检共享 hook。
 *
 * Home Hero、探索流、助手页在触发 LLM 任务前先查模型配置；未配置时给出
 * 「先去设置配 Key」的引导卡，而不是让用户的第一步就撞 503。
 *
 * 数据源是 GET /settings 的 models 配置（configured_roles /
 * default_chat_model 反映运行时网关状态），qk.settings 与 SettingsPage
 * 共享缓存；设置页保存后会失效该 key，这里拿到的总是新状态。
 */
export function useLLMReadiness() {
  const q = useQuery({
    queryKey: qk.settings,
    queryFn: () => api.getSettings(),
    staleTime: 30_000,
    retry: false,
  });
  const models = q.data?.models;
  const ready =
    models != null &&
    (models.configured_roles?.includes("default_chat") ||
      models.default_chat_model != null);
  return {
    /** true=已配置默认模型；false=未配置；undefined=还在查询 */
    ready: q.isLoading ? undefined : ready,
    isLoading: q.isLoading,
    /** 触发一次重新检查（设置保存返回后调用） */
    recheck: () => q.refetch(),
  };
}
