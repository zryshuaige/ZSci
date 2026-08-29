// HTTP client core: BASE, request<T>(), error parsing, time formatting.
//
// Every domain module builds on request(). The error contract: backend
// errors arrive as { code, user_message, detail?, suggestion? } and are
// thrown as FriendlyError (see lib/useFriendlyError); network failures are
// synthesised into FriendlyError(NETWORK_ERROR) so callers always get one
// error type to handle.

export const BASE = "/api/v1";

import { FriendlyError, type FriendlyErrorCode } from "../lib/useFriendlyError";

/** Format a backend ISO timestamp into the user's locale. */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

/** Parse a backend error envelope into FriendlyError.
 *
 *  New envelope from app/exception_handlers.py:
 *    { code: "LLM_NOT_CONFIGURED", user_message: "...", detail?: "...", suggestion?: "..." }
 *  Old envelope (FastAPI default — still supported as fallback):
 *    { detail: "..." }
 */
function parseErrorBody(status: number, body: unknown): FriendlyError | Error {
  if (
    body !== null &&
    typeof body === "object" &&
    "code" in body &&
    "user_message" in body &&
    typeof (body as Record<string, unknown>).user_message === "string"
  ) {
    const b = body as Record<string, unknown>;
    return new FriendlyError(
      {
        code: (b.code as FriendlyErrorCode) ?? "UNKNOWN",
        user_message: String(b.user_message ?? "出错了,请稍后重试。"),
        detail: (b.detail as string | null | undefined) ?? null,
        suggestion: (b.suggestion as string | null | undefined) ?? null,
      },
      status,
    );
  }
  // Fallback: old `{detail: "..."}` shape.
  let detail = `${status}`;
  if (body !== null && typeof body === "object" && "detail" in body) {
    const v = (body as Record<string, unknown>).detail;
    detail = typeof v === "string" ? v : JSON.stringify(v);
  } else if (typeof body === "string") {
    detail = body;
  }
  return new Error(detail);
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Destructure headers out of init so the spread below doesn't overwrite
  // our merged headers when callers pass their own.
  const { headers: initHeaders, ...restInit } = init || {};
  let resp: Response;
  try {
    resp = await fetch(`${BASE}${path}`, {
      ...restInit,
      headers: { "Content-Type": "application/json", ...(initHeaders as Record<string, string> | undefined) },
    });
  } catch (cause: unknown) {
    throw new FriendlyError(
      {
        code: "NETWORK_ERROR",
        user_message: "网络异常,请检查网络后重试。",
        detail: cause instanceof Error ? cause.message : String(cause),
        suggestion: "retry",
      },
      undefined,
    );
  }
  if (!resp.ok) {
    let body: unknown = null;
    try {
      body = await resp.json();
    } catch {
      try {
        body = await resp.text();
      } catch {
        body = null;
      }
    }
    throw parseErrorBody(resp.status, body);
  }
  if (resp.status === 204) return undefined as T;
  return resp.json() as Promise<T>;
}
