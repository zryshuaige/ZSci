// Standard mutation path for the whole app.
//
// The interaction contract: every mutation gets error feedback. Before this
// hook, ~15 mutations across pages had no onError and failed silently. Now
// the default IS the toast — opting out requires passing an explicit onError.

import {
  useMutation,
  type UseMutationOptions,
  type UseMutationResult,
} from "@tanstack/react-query";
import { showFriendlyError, showSuccess } from "../useFriendlyError";

export function useToastMutation<TData, TVariables = void, TContext = unknown>(
  options: UseMutationOptions<TData, unknown, TVariables, TContext> & {
    /** Success toast text (string or derived from the result). Omit to stay silent. */
    successMessage?: string | ((data: TData, vars: TVariables) => string);
  },
): UseMutationResult<TData, unknown, TVariables, TContext> {
  const { successMessage, onError, onSuccess, ...rest } = options;
  return useMutation<TData, unknown, TVariables, TContext>({
    ...rest,
    onError: (err, vars, ctx) => {
      if (onError) {
        (onError as (e: unknown, v: TVariables, c: TContext | undefined) => void)(err, vars, ctx);
      } else {
        showFriendlyError(err);
      }
    },
    onSuccess: (data, vars, ctx) => {
      if (successMessage) {
        showSuccess(
          typeof successMessage === "function" ? successMessage(data, vars) : successMessage,
        );
      }
      if (onSuccess) {
        (onSuccess as (d: TData, v: TVariables, c: TContext | undefined) => void)(data, vars, ctx);
      }
    },
  });
}
