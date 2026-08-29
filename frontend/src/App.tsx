import { lazy, Suspense, type ReactNode } from "react";
import { Routes, Route, Navigate, Link, useParams, useLocation } from "react-router-dom";
import { SearchX } from "@/components/ui/icons";
import Layout from "./components/Layout";
import ErrorBoundary from "./components/ErrorBoundary";
import { Spinner } from "./components/ui/Dialog";
import { EmptyState } from "./components/ui/EmptyState";
import { Button } from "./components/ui/Button";

// Lazy-load page components so the initial bundle doesn't include
// pdfjs-dist + every page upfront.
const ProjectsPage = lazy(() => import("./pages/ProjectsPage"));
const ProjectLayout = lazy(() => import("./pages/ProjectLayout"));
const ProjectOverview = lazy(() => import("./pages/ProjectOverview"));
const LiteraturePage = lazy(() => import("./pages/LiteraturePage"));
const PaperReaderPage = lazy(() => import("./pages/PaperReaderPage"));
const PapersListPage = lazy(() => import("./pages/PapersListPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const IdeasPage = lazy(() => import("./pages/IdeasPage"));
const CodePage = lazy(() => import("./pages/CodePage"));
const AgentPage = lazy(() => import("./pages/AgentPage"));
const ExperimentsPage = lazy(() => import("./pages/ExperimentsPage"));
const BenchmarksPage = lazy(() => import("./pages/BenchmarksPage"));
const ExperimentDetailPage = lazy(() => import("./pages/ExperimentDetailPage"));
const ExperimentRedirect = lazy(() => import("./pages/ExperimentRedirect"));
const WritingPage = lazy(() => import("./pages/WritingPage"));
const ExploreNewPage = lazy(() => import("./pages/ExploreNewPage"));
const ExploreIdeasPage = lazy(() => import("./pages/ExploreIdeasPage"));
const ExperimentPreviewPlanPage = lazy(() => import("./pages/ExperimentPreviewPlanPage"));
const ExperimentResultPage = lazy(() => import("./pages/ExperimentResultPage"));

/** One wrapper for every route: suspense fallback + a per-page error
 *  boundary, so a crash on one page never takes down the whole app shell
 *  (sidebar + global workflow status stay alive). */
function Page({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<div className="p-6"><Spinner /></div>}>
        {children}
      </Suspense>
    </ErrorBoundary>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Page><ProjectsPage /></Page>} />
        <Route path="/settings" element={<Page><SettingsPage /></Page>} />
        <Route path="/projects/:projectId" element={<Page><ProjectLayout /></Page>}>
          <Route index element={<Page><ProjectOverview /></Page>} />
          <Route path="literature" element={<Page><LiteraturePage /></Page>} />
          <Route path="papers" element={<Page><PapersListPage /></Page>} />
          <Route path="papers/:paperId" element={<Page><PaperReaderPage /></Page>} />
          <Route path="ideas" element={<Page><IdeasPage /></Page>} />
          <Route path="code" element={<Page><CodePage /></Page>} />
          <Route path="experiments" element={<Page><ExperimentsPage /></Page>} />
          <Route path="benchmarks" element={<Page><BenchmarksPage /></Page>} />
          <Route path="experiments/:expId" element={<Page><ExperimentDetailPage /></Page>} />
          <Route path="writing" element={<Page><WritingPage /></Page>} />
          <Route path="agent" element={<Page><AgentPage /></Page>} />
          {/* 探索流程 4 页挂在项目框架内：流程中侧栏旅程轨道常在，页面顶部
              有 WizardBar 向导条。旧路径在下方重定向兼容。 */}
          <Route path="explore/new" element={<Page><ExploreNewPage /></Page>} />
          <Route path="explore/ideas" element={<Page><ExploreIdeasPage /></Page>} />
          <Route path="experiments/:expId/preview" element={<Page><ExperimentPreviewPlanPage /></Page>} />
          <Route path="experiments/:expId/result" element={<Page><ExperimentResultPage /></Page>} />
          {/* Unknown sub-paths: keep the project chrome and offer a way back
              instead of a blank body. */}
          <Route
            path="*"
            element={
              <EmptyState
                icon={<SearchX className="h-5 w-5" />}
                title="这个页面不存在"
                subtitle="它可能已被移动或删除"
                action={
                  <Link to="..">
                    <Button variant="outline" size="sm">返回项目首页</Button>
                  </Link>
                }
              />
            }
          />
        </Route>
        {/* 旧路径重定向（书签/外部链接兼容）：探索流程已纳入项目框架。 */}
        <Route path="/explore/:projectId/*" element={<ExplorePathRedirect />} />
        {/* Bare experiment links (older bookmarks) resolve to the canonical
            project-scoped route, preserving the suffix (/preview, /result)
            and query string (?task= deep links keep working). */}
        <Route path="/experiments/:expId/*" element={<Page><ExperimentRedirect /></Page>} />
        <Route path="/experiments/:expId" element={<Page><ExperimentRedirect /></Page>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

/** /explore/:projectId/new|ideas → /projects/:projectId/explore/…（保留 query） */
function ExplorePathRedirect() {
  const { projectId } = useParams<{ projectId: string }>();
  const location = useLocation();
  // location.pathname: /explore/:projectId/new → suffix = "new" | "ideas"
  const suffix = location.pathname.replace(/^\/explore\/[^/]+\/?/, "");
  const to = `/projects/${projectId}/explore/${suffix}${location.search}`;
  return <Navigate to={to} replace />;
}
