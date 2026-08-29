// Friendly error parser + lightweight toast queue (Phase A: 全局友好错误层).
//
// The backend (app/exception_handlers.py) returns errors in a stable shape:
//
//     {
//       "code": "LLM_NOT_CONFIGURED",
//       "user_message": "未配置 LLM 模型,请先在设置中完成配置。",
//       "detail": "<optional technical detail>",
//       "suggestion": "go_settings"
//     }
//
// This module:
//   1. Defines the FriendlyError class so request() can throw it.
//   2. Provides useFriendlyError(err) — returns a normalised
//      { title, body, action? } record the rest of the UI can render.
//   3. Exposes showFriendlyError(err) — appends the error to a global toast
//      queue that any page can subscribe to (via ErrorToast component).
//
// The frontend's old contract was `mutation.error: Error` with `.message`
// carrying the raw backend `detail` string. Backwards-compat is preserved:
// if the server is on an older build that still emits plain {"detail": "..."},
// the parser falls back to that string verbatim. New code should use
// `useFriendlyError` and render the structured shape — old code keeps
// working until pages are gradually updated.

import { useEffect, useState } from "react";

export type FriendlyErrorCode =
  | "LLM_NOT_CONFIGURED"
  | "LLM_UPSTREAM_ERROR"
  | "LLM_TIMEOUT"
  | "NETWORK_ERROR"
  | "INPUT_INVALID"
  | "NOT_FOUND"
  | "TASK_RUNNING"
  | "DATA_DOWNLOAD"
  | "INTERNAL"
  | "SKILL_NOT_FOUND"
  | "PROJECT_NOT_FOUND"
  | "UNKNOWN";

export interface FriendlyErrorPayload {
  code: FriendlyErrorCode;
  user_message: string;
  detail?: string | null;
  suggestion?: string | null;
}

export class FriendlyError extends Error {
  code: FriendlyErrorCode;
  suggestion: string | null;
  detail: string | null;
  /** HTTP status code, if this came from a network response. Undefined for
   *  raw network failures (CORS / DNS / connection-reset). */
  status: number | undefined;

  constructor(payload: FriendlyErrorPayload, status?: number) {
    super(payload.user_message);
    this.code = payload.code;
    this.suggestion = payload.suggestion ?? null;
    this.detail = payload.detail ?? null;
    this.status = status;
    this.name = "FriendlyError";
  }
}

export interface FriendlyErrorDisplay {
  title: string;
  body: string;
  /** Optional CTA label. */
  action: string | null;
  /** Optional action key — the caller decides what to do with it
   *  (e.g. navigate to /settings, retry). */
  actionKey: string | null;
  /** Original raw technical string for a developer debug panel. */
  debug: string | null;
  /** Categorical severity for UI treatment (color / icon). */
  severity: "info" | "warning" | "error";
}

// Stable mapping from backend code → human title + suggested action key.
// Keep this table in sync with app/exception_handlers.py on the backend.
const FRIENDLY_TITLE: Record<FriendlyErrorCode, string> = {
  LLM_NOT_CONFIGURED: "AI 模型未配置",
  LLM_UPSTREAM_ERROR: "AI 暂时无法响应",
  LLM_TIMEOUT: "AI 响应超时",
  NETWORK_ERROR: "网络异常",
  INPUT_INVALID: "输入有误",
  NOT_FOUND: "资源不存在",
  TASK_RUNNING: "任务进行中",
  DATA_DOWNLOAD: "数据下载失败",
  INTERNAL: "服务暂时不可用",
  SKILL_NOT_FOUND: "能力暂不支持",
  PROJECT_NOT_FOUND: "项目不存在",
  UNKNOWN: "出错了",
};

function classify(err: unknown): FriendlyErrorPayload {
  // 1. Already-parsed FriendlyError
  if (err instanceof FriendlyError) {
    return {
      code: err.code,
      user_message: err.message,
      detail: err.detail,
      suggestion: err.suggestion,
    };
  }
  // 2. Plain Error with a body whose message is JSON (the new envelope)
  //    request() throws a FriendlyError, but legacy callers may still get
  //    raw Error objects.
  if (err instanceof Error) {
    const raw = err.message || "";
    // Try parsing as JSON to handle legacy error.message containing the
    // serialised payload (older wrappers did this).
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && "code" in obj && "user_message" in obj) {
        return {
          code: (obj.code as FriendlyErrorCode) ?? "UNKNOWN",
          user_message: String(obj.user_message),
          detail: obj.detail ?? null,
          suggestion: obj.suggestion ?? null,
        };
      }
    } catch {
      // not JSON — fall through
    }
    // 3. Network failure: Error("Failed to fetch") / TypeError("NetworkError").
    if (/failed to fetch|networkerror|network request failed/i.test(raw)) {
      return {
        code: "NETWORK_ERROR",
        user_message: "网络异常,请检查网络后重试。",
        detail: raw,
        suggestion: "retry",
      };
    }
    // 4. Generic fallback: show the raw message as the user_message.
    //    NOT classified as UNKNOWN; keep the original so a developer can
    //    trace what's wrong. Front-end will wrap it politely.
    return { code: "UNKNOWN", user_message: raw || "出错了,请稍后重试。" };
  }
  // 5. Non-Error throwables.
  return { code: "UNKNOWN", user_message: typeof err === "string" ? err : "出错了,请稍后重试。" };
}

function severityFor(code: FriendlyErrorCode): FriendlyErrorDisplay["severity"] {
  switch (code) {
    case "LLM_NOT_CONFIGURED":
    case "LLM_UPSTREAM_ERROR":
    case "LLM_TIMEOUT":
    case "INTERNAL":
    case "NETWORK_ERROR":
    case "DATA_DOWNLOAD":
      return "error";
    case "INPUT_INVALID":
    case "SKILL_NOT_FOUND":
    case "NOT_FOUND":
    case "PROJECT_NOT_FOUND":
      return "warning";
    case "TASK_RUNNING":
      return "info";
    default:
      return "warning";
  }
}

export function useFriendlyError(err: unknown | null | undefined): FriendlyErrorDisplay | null {
  if (!err) return null;
  const payload = classify(err);
  const actionByCode: Record<FriendlyErrorCode, { label: string; key: string } | null> = {
    LLM_NOT_CONFIGURED: { label: "去设置", key: "go_settings" },
    LLM_UPSTREAM_ERROR: { label: "重试", key: "retry" },
    LLM_TIMEOUT: { label: "重试", key: "retry" },
    NETWORK_ERROR: { label: "重试", key: "retry" },
    INPUT_INVALID: { label: "查看详情", key: "check_input" },
    NOT_FOUND: null,
    TASK_RUNNING: null,
    DATA_DOWNLOAD: { label: "切换数据集", key: "change_dataset" },
    INTERNAL: { label: "重试", key: "retry" },
    SKILL_NOT_FOUND: null,
    PROJECT_NOT_FOUND: null,
    UNKNOWN: { label: "重试", key: "retry" },
  };
  const action = actionByCode[payload.code] ?? null;
  return {
    title: FRIENDLY_TITLE[payload.code] ?? "出错了",
    body: payload.user_message,
    action: action?.label ?? null,
    actionKey: action?.key ?? null,
    debug: payload.detail ?? null,
    severity: severityFor(payload.code),
  };
}

// ---------------------------------------------------------------------------
// Global toast queue
// ---------------------------------------------------------------------------

export type ToastTone = "success" | "info" | "warning" | "error";

export interface ToastEntry extends FriendlyErrorDisplay {
  id: number;
  /** Visual tone. Error entries derive it from severity; success/info
   *  toasts set it explicitly. Optional for backward compat with entries
   *  created before the tone field existed. */
  tone?: ToastTone;
}

let _nextToastId = 1;
const _toastSubs = new Set<(toasts: ToastEntry[]) => void>();
let _toasts: ToastEntry[] = [];

function _publish() {
  for (const fn of _toastSubs) fn([..._toasts]);
}

/** Append a friendly error to the global toast queue. Returns the assigned id
 *  so callers can dismiss it programmatically (ErrorToast auto-dismisses
 *  after 6s; this is provided for tests / interactive dismiss). */
export function showFriendlyError(err: unknown): number {
  const display = useFriendlyError(err);
  if (!display) return -1;
  const id = _nextToastId++;
  const tone: ToastTone =
    display.severity === "error" ? "error" : display.severity === "warning" ? "warning" : "info";
  _toasts = [..._toasts, { ...display, id, tone }];
  _publish();
  return id;
}

/** Success feedback for a completed action (saved / created / launched...).
 *  Part of the app-wide interaction contract: every mutation gets an
 *  audible "回响" — success toast or error toast, never silence. */
export function showSuccess(message: string): number {
  const id = _nextToastId++;
  _toasts = [
    ..._toasts,
    {
      id,
      tone: "success",
      title: message,
      body: "",
      action: null,
      actionKey: null,
      debug: null,
      severity: "info",
    },
  ];
  _publish();
  return id;
}

/** Neutral informational toast (e.g. "任务已在后台继续"). */
export function showInfo(message: string): number {
  const id = _nextToastId++;
  _toasts = [
    ..._toasts,
    {
      id,
      tone: "info",
      title: message,
      body: "",
      action: null,
      actionKey: null,
      debug: null,
      severity: "info",
    },
  ];
  _publish();
  return id;
}

/** Dismiss a toast by id. */
export function dismissToast(id: number): void {
  _toasts = _toasts.filter((t) => t.id !== id);
  _publish();
}

/** React hook: subscribe the calling component to the toast queue. */
export function useFriendlyErrorToasts(): ToastEntry[] {
  const [snapshot, setSnapshot] = useState<ToastEntry[]>(_toasts);
  useEffect(() => {
    _toastSubs.add(setSnapshot);
    return () => {
      _toastSubs.delete(setSnapshot);
    };
  }, []);
  return snapshot;
}
