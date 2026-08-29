import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCw, Home } from "@/components/ui/icons";
import { Link } from "react-router-dom";
import { Button } from "./ui/Button";

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Global error boundary (C1). Previously any uncaught render error — e.g. a
 * malformed `JSON.parse(task.result_json)` — would unmount the entire React
 * tree and leave a blank white page. This boundary surfaces the error with a
 * friendly UI and offers two escape paths: retry this page, or jump back to
 * the projects index.
 *
 * The boundary intentionally lives at the page level (not the layout level)
 * so the sidebar / global workflow status remain visible — the user can still
 * navigate elsewhere even if one page is broken.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("ErrorBoundary caught:", error, info);
  }

  reset = () => this.setState({ error: null });

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
      const err = this.state.error;
      return (
        <div className="min-h-[70vh] flex items-center justify-center p-6 animate-fade-in">
          <div className="max-w-xl w-full rounded-xl border border-destructive/40 bg-destructive/5 p-6 shadow-soft">
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-destructive/10 p-2 shrink-0">
                <AlertTriangle className="h-5 w-5 text-destructive" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-destructive">页面渲染出错</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  这页没能正确渲染,但你的项目数据和后台任务都没有受影响。可以重试,或返回首页继续操作。
                </p>
                <details className="mt-3 text-xs">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    错误详情
                  </summary>
                  <pre className="mt-2 p-3 bg-muted/60 rounded-md text-[11px] overflow-auto max-h-40 break-all">
                    {err.message}
                    {"\n\n"}
                    {err.stack?.split("\n").slice(0, 5).join("\n")}
                  </pre>
                </details>
                <div className="mt-4 flex gap-2">
                  <Button variant="outline" size="sm" onClick={this.reset}>
                    <RotateCw className="h-3.5 w-3.5" /> 重试
                  </Button>
                  <Link to="/">
                    <Button variant="outline" size="sm">
                      <Home className="h-3.5 w-3.5" /> 返回项目列表
                    </Button>
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
