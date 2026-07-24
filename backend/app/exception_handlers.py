"""Centralised exception → user-facing message mapping (Phase A: 全局友好错误层).

Before this layer existed, every router raised `HTTPException(code, str(exc))`
with raw backend error text (OpenAI 401 strings, network timeouts, OpenAlex
malformed response messages, etc.). The frontend then rendered the same
`detail` string in red text via `(mutation.error as Error).message`,
showing users things like:

    "openai.AuthenticationError: Incorrect API key provided"
    "('Connection aborted.', RemoteDisconnected('Remote end closed connection'))"

This module registers FastAPI exception handlers that map common failure
modes into a stable, localised JSON shape:

    {
      "code": "LLM_NOT_CONFIGURED",      // stable, frontend-friendly enum
      "user_message": "未配置 LLM 模型,请先在设置中完成配置。",  // user-facing
      "suggestion": "go_settings",        // optional CTA hint for the UI
      "detail": "<original technical text>"  // optional, for debug panel
    }

The frontend's `useFriendlyError` hook (frontend/src/lib/useFriendlyError.ts)
parses this shape and renders a friendly toast with an action button
(`去设置` / `重试` / `上传数据集`).

Design notes:

- We KEEP the old `{"detail": "..."}` JSON shape as a fallback so the frontend
  can detect either the old or new format during rollout.
- The `code` is stable across releases; the `user_message` may change copy.
- HTTP status codes are preserved (`status_code=` matches `code`'s semantics
  — e.g. LLM_NOT_CONFIGURED still emits 503, INPUT_INVALID still 422).
- This is opt-in: routers that explicitly want raw errors can still do
  `raise HTTPException(400, str(exc))`; only default uncaught exceptions
  flow through this mapper.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

logger = logging.getLogger("zsci.exception_handlers")


# Stable error codes that the frontend knows about. Treat as an enum: do
# NOT localise, do NOT change without updating `useFriendlyError.ts`.
CODE_LLM_NOT_CONFIGURED = "LLM_NOT_CONFIGURED"
CODE_LLM_UPSTREAM_ERROR = "LLM_UPSTREAM_ERROR"
CODE_LLM_TIMEOUT = "LLM_TIMEOUT"
CODE_NETWORK_ERROR = "NETWORK_ERROR"
CODE_INPUT_INVALID = "INPUT_INVALID"
CODE_NOT_FOUND = "NOT_FOUND"
CODE_TASK_RUNNING = "TASK_RUNNING"
CODE_DATA_DOWNLOAD = "DATA_DOWNLOAD"
CODE_INTERNAL = "INTERNAL"
CODE_SKILL_NOT_FOUND = "SKILL_NOT_FOUND"
CODE_PROJECT_NOT_FOUND = "PROJECT_NOT_FOUND"


def _payload(
    code: str,
    user_message: str,
    status_code: int,
    suggestion: str | None = None,
    detail: str | None = None,
) -> dict:
    """Build the JSON body returned to the client."""
    out: dict = {"code": code, "user_message": user_message}
    if suggestion:
        out["suggestion"] = suggestion
    if detail:
        out["detail"] = detail
    # Keep `detail` for backward compat with old frontend code paths that
    # only know how to read `body.detail`. New UI uses `user_message`.
    if "detail" not in out:
        out["detail"] = user_message
    return out


async def _http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    """Map HTTPException to a localised payload.

    FastAPI's default handler returns `{"detail": <exc.detail>}`. We replace
    it with the richer `{code, user_message, ...}` shape for the cases we
    recognise, while preserving the original `detail` so the rest of the UI
    keeps working during the rollout.
    """
    # FastAPI turns `HTTPException(404, "X")` into a 404 with detail="X".
    # We special-case a few well-known messages so we don't accidentally
    # translate arbitrary router-side strings (those stay as `detail`).
    detail_text = str(exc.detail) if not isinstance(exc.detail, str) else exc.detail

    # 404 — most "not found" messages are safe to surface to users as-is,
    # but we localise the common ones.
    if exc.status_code == 404:
        code = CODE_NOT_FOUND
        user_message = "找不到这个资源。"
        if "Project not found" in detail_text:
            code = CODE_PROJECT_NOT_FOUND
            user_message = "项目不存在,可能已被删除。"
        elif "Idea not found" in detail_text:
            user_message = "找不到这个想法。"
        elif "Task not found" in detail_text:
            user_message = "任务已结束或不存在。"
        return JSONResponse(
            status_code=exc.status_code,
            content=_payload(code, user_message, exc.status_code, detail=detail_text),
        )

    # 422 / RequestValidationError is handled by its own handler below.
    # 400 — generic business validation, but several routers leak raw
    # LLM / network errors here (e.g. OpenAI 401 raised from inside an
    # LLM call wrapped in a 400 HTTPException). Try to recognise those
    # via keyword before falling back to a generic INPUT_INVALID.
    if exc.status_code == 400:
        # First: our own "Unknown task type" string.
        if "Unknown task type" in detail_text:
            return JSONResponse(
                status_code=exc.status_code,
                content=_payload(
                    CODE_SKILL_NOT_FOUND,
                    "暂不支持这个能力,请刷新页面后重试。",
                    exc.status_code,
                    detail=detail_text,
                ),
            )
        # Second: leak-detection on the raw detail string. If a router
        # funneled an upstream error into a 400, route to a more
        # appropriate code so the UI shows a meaningful toast.
        dl = detail_text.lower()
        if any(k in dl for k in ("401", "api key", "authentication", "incorrect api")):
            return JSONResponse(
                status_code=exc.status_code,
                content=_payload(
                    CODE_LLM_UPSTREAM_ERROR,
                    "AI 服务认证失败,请检查设置中的 API Key。",
                    exc.status_code,
                    suggestion="go_settings",
                    detail=detail_text,
                ),
            )
        if any(k in dl for k in ("timeout", "timed out", "network", "remote end closed")):
            return JSONResponse(
                status_code=exc.status_code,
                content=_payload(
                    CODE_LLM_TIMEOUT,
                    "AI 响应超时,请检查网络后重试。",
                    exc.status_code,
                    suggestion="retry",
                    detail=detail_text,
                ),
            )
        if any(k in dl for k in ("403", "forbidden", "permission denied")):
            return JSONResponse(
                status_code=exc.status_code,
                content=_payload(
                    CODE_LLM_UPSTREAM_ERROR,
                    "AI 服务拒绝访问,请检查权限或稍后重试。",
                    exc.status_code,
                    suggestion="retry",
                    detail=detail_text,
                ),
            )
        # Generic 400 — fall through to INPUT_INVALID but with a polite
        # wrapper (the raw detail is preserved under `detail` for debug).
        return JSONResponse(
            status_code=exc.status_code,
            content=_payload(
                CODE_INPUT_INVALID,
                "请求无效,请检查输入或稍后重试。",
                exc.status_code,
                suggestion="check_input",
                detail=detail_text,
            ),
        )

    if exc.status_code == 503 and ("未配置" in detail_text or "ModelNotConfigured" in detail_text):
        return JSONResponse(
            status_code=exc.status_code,
            content=_payload(
                CODE_LLM_NOT_CONFIGURED,
                "未配置 LLM 模型,请先在设置中完成配置。",
                exc.status_code,
                suggestion="go_settings",
                detail=detail_text,
            ),
        )

    if exc.status_code == 502:
        return JSONResponse(
            status_code=exc.status_code,
            content=_payload(
                CODE_LLM_UPSTREAM_ERROR,
                "AI 暂时无法响应,请稍后重试。",
                exc.status_code,
                suggestion="retry",
                detail=detail_text,
            ),
        )

    if exc.status_code == 409:
        # "task is already running" / "agent task already running" — surface a
        # gentle notice so the frontend doesn't try again immediately.
        return JSONResponse(
            status_code=exc.status_code,
            content=_payload(
                CODE_TASK_RUNNING,
                "该任务已在进行中,请等待其完成。",
                exc.status_code,
                detail=detail_text,
            ),
        )

    if exc.status_code == 500:
        return JSONResponse(
            status_code=exc.status_code,
            content=_payload(
                CODE_INTERNAL,
                "服务暂时不可用,请稍后重试。",
                exc.status_code,
                suggestion="retry",
                detail=detail_text,
            ),
        )

    # Fallback: keep the original detail string so the UI still has *something*
    # to show. Status code preserved.
    return JSONResponse(
        status_code=exc.status_code,
        content=_payload(
            CODE_INTERNAL,
            detail_text,
            exc.status_code,
            detail=detail_text,
        ),
    )


async def _validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """Translate pydantic validation errors to INPUT_INVALID.

    Original `detail` is the list of `{loc, msg, type}` dicts pydantic emits;
    we drop the field paths (those belong in a developer console) and keep
    a short, user-readable summary plus the original detail for debugging.
    """
    errors = exc.errors() if hasattr(exc, "errors") else []
    # Surface the first error message in plain Chinese; the rest stays in
    # `detail` for the developer debug panel only.
    first_msg = ""
    for e in errors:
        loc = e.get("loc") or ()
        msg = e.get("msg") or ""
        # Skip internal types like "missing"; prefer the human-readable msg.
        first_msg = f"「{'.'.join(str(x) for x in loc if x != 'body')}」{msg}"
        break
    user_message = (
        f"输入有误:{first_msg}。请检查后重试。" if first_msg else "输入有误,请检查表单内容。"
    )
    return JSONResponse(
        status_code=422,
        content=_payload(
            CODE_INPUT_INVALID,
            user_message,
            422,
            suggestion="check_input",
            detail=str(errors),
        ),
    )


async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Last-resort catch-all for uncaught exceptions.

    Logs the traceback server-side and returns a localised payload. The
    original exception is hidden from the client to avoid leaking stack
    traces or internal paths.
    """
    logger.exception("unhandled exception on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content=_payload(
            CODE_INTERNAL,
            "服务暂时不可用,请稍后重试。",
            500,
            suggestion="retry",
            detail=type(exc).__name__,
        ),
    )


def register_friendly_handlers(app: FastAPI) -> None:
    """Mount the handlers on the FastAPI app. Call once from main.py."""
    app.add_exception_handler(HTTPException, _http_exception_handler)
    app.add_exception_handler(RequestValidationError, _validation_exception_handler)
    app.add_exception_handler(Exception, _unhandled_exception_handler)
