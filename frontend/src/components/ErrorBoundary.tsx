import { Component, type ErrorInfo, type ReactNode } from "react";

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
 * tree and leave a blank white page. This boundary surfaces the error and
 * offers a reset button.
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
      return (
        <div className="m-6 rounded-md border border-destructive/40 bg-destructive/5 p-6">
          <h2 className="text-lg font-semibold text-destructive">页面渲染出错</h2>
          <p className="mt-2 text-sm text-muted-foreground break-all">
            {this.state.error.message}
          </p>
          <button
            type="button"
            onClick={this.reset}
            className="mt-4 rounded-md border border-border bg-card px-3 py-1 text-sm hover:bg-muted"
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
