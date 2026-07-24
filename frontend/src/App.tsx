import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import { Spinner } from "./components/ui/Dialog";

// L11: lazy-load page components so the initial bundle doesn't include
// pdfjs-dist + every page upfront. The PDF reader in particular pulls in a
// large worker bundle that's only needed on the paper page.
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
const ExperimentDetailPage = lazy(() => import("./pages/ExperimentDetailPage"));
const WritingPage = lazy(() => import("./pages/WritingPage"));
// Phase B: 5-screen journey — Idea exploration pages, mounted at the top
// level so they share the Layout (sidebar + global workflow status) but
// don't require a ProjectLayout wrapper (which adds another nav chrome
// above the hero). They take the projectId from the URL.
const ExploreNewPage = lazy(() => import("./pages/ExploreNewPage"));
const ExploreIdeasPage = lazy(() => import("./pages/ExploreIdeasPage"));
// Phase C: research-plan preview (between adopting a direction and launching).
const ExperimentPreviewPlanPage = lazy(() => import("./pages/ExperimentPreviewPlanPage"));
// Phase D: experiment result + next-steps page.
const ExperimentResultPage = lazy(() => import("./pages/ExperimentResultPage"));

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route
          path="/"
          element={
            <Suspense fallback={<div className="p-6"><Spinner /></div>}>
              <ProjectsPage />
            </Suspense>
          }
        />
        <Route
          path="/settings"
          element={
            <Suspense fallback={<div className="p-6"><Spinner /></div>}>
              <SettingsPage />
            </Suspense>
          }
        />
        <Route path="/projects/:projectId" element={
          <Suspense fallback={<div className="p-6"><Spinner /></div>}>
            <ProjectLayout />
          </Suspense>
        }>
          <Route index element={
            <Suspense fallback={<div className="p-6"><Spinner /></div>}>
              <ProjectOverview />
            </Suspense>
          } />
          <Route path="literature" element={
            <Suspense fallback={<div className="p-6"><Spinner /></div>}>
              <LiteraturePage />
            </Suspense>
          } />
          <Route path="papers" element={
            <Suspense fallback={<div className="p-6"><Spinner /></div>}>
              <PapersListPage />
            </Suspense>
          } />
          <Route path="papers/:paperId" element={
            <Suspense fallback={<div className="p-6"><Spinner /></div>}>
              <PaperReaderPage />
            </Suspense>
          } />
          <Route path="ideas" element={
            <Suspense fallback={<div className="p-6"><Spinner /></div>}>
              <IdeasPage />
            </Suspense>
          } />
          <Route path="code" element={
            <Suspense fallback={<div className="p-6"><Spinner /></div>}>
              <CodePage />
            </Suspense>
          } />
          <Route path="experiments" element={
            <Suspense fallback={<div className="p-6"><Spinner /></div>}>
              <ExperimentsPage />
            </Suspense>
          } />
          <Route path="experiments/:expId" element={
            <Suspense fallback={<div className="p-6"><Spinner /></div>}>
              <ExperimentDetailPage />
            </Suspense>
          } />
          <Route path="writing" element={
            <Suspense fallback={<div className="p-6"><Spinner /></div>}>
              <WritingPage />
            </Suspense>
          } />
          <Route path="agent" element={
            <Suspense fallback={<div className="p-6"><Spinner /></div>}>
              <AgentPage />
            </Suspense>
          } />
          {/* M7: render a "not found" message inside the project layout so
              unknown sub-paths don't show a blank body. */}
          <Route path="*" element={<div className="p-6 text-muted-foreground">未知子页面</div>} />
        </Route>
        {/* Phase B: idea-exploration pages. Outside the project layout so
            they get the global Layout (sidebar + toasts) without the
            project-internal 8-tab chrome. The projectId is in the URL so
            each page can fetch the project via /projects/{id}. */}
        <Route
          path="/explore/:projectId/new"
          element={
            <Suspense fallback={<div className="p-6"><Spinner /></div>}>
              <ExploreNewPage />
            </Suspense>
          }
        />
        <Route
          path="/explore/:projectId/ideas"
          element={
            <Suspense fallback={<div className="p-6"><Spinner /></div>}>
              <ExploreIdeasPage />
            </Suspense>
          }
        />
        <Route
          path="/experiments/:expId/preview"
          element={
            <Suspense fallback={<div className="p-6"><Spinner /></div>}>
              <ExperimentPreviewPlanPage />
            </Suspense>
          }
        />
        <Route
          path="/experiments/:expId/result"
          element={
            <Suspense fallback={<div className="p-6"><Spinner /></div>}>
              <ExperimentResultPage />
            </Suspense>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
