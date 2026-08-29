// System domain: health check, app settings, LLM provider configuration.
import { request } from "./client";

export interface Health {
  status: string;
  version: string;
  workspace: string;
  db_ok?: boolean;
  db_error?: string | null;
}

export interface LLMProviderPreset {
  id: string;
  name_zh: string;
  provider: string;
  model: string;
  base_url: string | null;
  api_key_env: string | null;
  needs_key: boolean;
  key_hint: string;
}

export interface LLMCurrentConfig {
  provider: string | null;
  model: string | null;
  base_url: string | null;
  api_key_env: string | null;
  api_key_set: boolean;
  matched_preset_id: string | null;
}

export interface LLMConfig {
  presets: LLMProviderPreset[];
  current: LLMCurrentConfig;
}

export interface LLMConfigUpdate {
  provider_id: string;
  /** Override the preset's default model. */
  model?: string;
  /** Override the preset's base_url. Empty string clears it. */
  base_url?: string;
  /** The API key to persist. Omit/blank to keep any existing key. */
  api_key?: string;
}

export interface ModelsSettings {
  configured_roles: string[];
  default_chat_model: string | null;
  default_chat_provider: string | null;
  default_chat_base_url: string | null;
  default_chat_api_key_env: string | null;
  default_chat_api_key_set: boolean;
}

export interface AppSettings {
  workspace_path: string;
  models: ModelsSettings;
  venues: string[];
}

export const systemApi = {
  health: () => request<Health>("/health"),
  getSettings: () => request<AppSettings>("/settings"),
  getLLMConfig: () => request<LLMConfig>("/llm/config"),
  saveLLMConfig: (body: LLMConfigUpdate) =>
    request<LLMCurrentConfig>("/llm/config", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
};
