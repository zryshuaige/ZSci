import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      // 30s staleTime: navigating between tabs/pages reuses fresh cache
      // instead of refetching everything on every mount. Polling queries
      // (workflows, stages) set their own refetchInterval regardless.
      staleTime: 30_000,
    },
  },
});

// ErrorBoundary must live INSIDE BrowserRouter: its fallback renders <Link>
// and needs router context, otherwise the fallback itself crashes.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </QueryClientProvider>
    </BrowserRouter>
  </React.StrictMode>
);
