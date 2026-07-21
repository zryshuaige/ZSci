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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
