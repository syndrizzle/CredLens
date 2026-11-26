import { lazy, Suspense, useState } from "react";
import { Navigate } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { AppShell } from "@/app/AppShell";
import { SECTIONS, type Section } from "@/app/sections";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { AuthPage } from "@/features/auth/AuthPage";
import { AnalysisSection } from "@/features/analysis/AnalysisSection";
import { DocumentsSection } from "@/features/documents/DocumentsSection";
import { FiguresSection } from "@/features/manual-entry/FiguresSection";
import { sortedPeriods } from "@/features/manual-entry/model";
import { PreparationReportPanel } from "@/features/reports/PreparationReport";
import { SettingsSection } from "@/features/settings/SettingsSection";
import { AccountMenu } from "./AccountMenu";
import { OverviewSection } from "./OverviewSection";
import {
  WorkspaceContext,
  useWorkspaceController,
  type AuthMode,
} from "./use-workspace";
import { WorkspaceDialogs } from "./WorkspaceDialogs";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

// The AI SDK and chat components load only once the Assistant is first opened.
const WorkspaceQA = lazy(() => import("@/features/qa/WorkspaceQA").then((module) => ({ default: module.WorkspaceQA })));

function Workspace({
  section,
  authMode,
}: {
  section?: Section;
  authMode?: AuthMode;
}) {
  const workspace = useWorkspaceController(section);
  const [assistantSeen, setAssistantSeen] = useState(false);
  if (!assistantSeen && (!section || section === "assistant")) setAssistantSeen(true);
  const {
    session,
    guest,
    checkingSession,
    form,
    activeWorkspace,
    workspaceBusy,
    workspaceError,
    setActiveReport,
    handleReportGenerated,
    activeReport,
    actionsDisabled,
    analysis,
    savedClean,
    handleSaveWorkspace,
    leaveGuest,
    counts,
    analysisOutdated,
  } = workspace;

  if (checkingSession) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Spinner
          className="size-6 text-muted-foreground"
          aria-label="Checking your session"
        />
      </div>
    );
  }

  if (!session && !guest) {
    return (
      <WorkspaceContext.Provider value={workspace}>
        <AuthPage mode={authMode ?? "login"} />
        {section ? <Navigate to="/login" replace /> : null}
      </WorkspaceContext.Provider>
    );
  }
  if (authMode) return <Navigate to="/" replace />;

  const show = (id: Section) => !section || section === id;
  const locked = (id: Section) => {
    const { requires } = SECTIONS.find((item) => item.id === id)!;
    return requires !== null && (!session || (requires === "business" && !activeWorkspace));
  };
  const lockedPage = section && locked(section) ? SECTIONS.find((item) => item.id === section)! : null;

  return (
    <WorkspaceContext.Provider value={workspace}>
      <AppShell
        section={section}
        businessName={form.businessName.trim() || "Untitled business"}
        switcher={<WorkspaceSwitcher />}
        account={<AccountMenu />}
        badges={{
          documents: activeWorkspace?.documents.length || undefined,
          figures:
            counts.present > 0 ? (
              <>
                {counts.reviewed}/{counts.present}
                <span className="sr-only"> confirmed</span>
              </>
            ) : undefined,
          analysis: analysisOutdated ? "Outdated" : undefined,
        }}
        actions={
          !session ? (
            <Button
              type="button"
              size="sm"
              onClick={() => leaveGuest("/signup")}
            >
              Create account
            </Button>
          ) : savedClean ? (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <HugeiconsIcon icon={Tick02Icon} className="size-4" />
              Saved
            </span>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={handleSaveWorkspace}
              disabled={actionsDisabled}
            >
              {workspaceBusy ? <Spinner /> : null}
              {workspaceBusy ? "Saving…" : "Save"}
            </Button>
          )
        }
      >
        <fieldset
          disabled={actionsDisabled}
          className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6 print:max-w-none"
          aria-label="Business workspace"
        >
          <div
            className={
              activeReport
                ? "flex flex-col gap-6 print:hidden"
                : "flex flex-col gap-6"
            }
          >
            {workspaceError ? (
              <Alert variant="destructive">
                <HugeiconsIcon icon={Alert02Icon} />
                <AlertTitle>Something went wrong</AlertTitle>
                <AlertDescription className="col-start-2">
                  {workspaceError}
                </AlertDescription>
              </Alert>
            ) : null}

            {lockedPage ? (
              <>
                <PageHeader
                  title={
                    lockedPage.title
                  }
                />
                <Empty className="border border-dashed border-border">
                  <EmptyHeader>
                    <EmptyTitle>
                      {session
                        ? "Save this business first"
                        : "Create an account to continue"}
                    </EmptyTitle>
                    <EmptyDescription>
                      {session
                        ? `Once saved, you can ${lockedPage.offers}.`
                        : `An account lets you ${lockedPage.offers}. Your demo figures carry over.`}
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    {session ? (
                      <Button type="button" onClick={handleSaveWorkspace}>
                        Save business
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        onClick={() => leaveGuest("/signup")}
                      >
                        Create account
                      </Button>
                    )}
                  </EmptyContent>
                </Empty>
              </>
            ) : null}

            <div className={show("overview") ? "contents" : "hidden"}>
              <OverviewSection />
            </div>
            <div
              className={
                show("documents") && !locked("documents")
                  ? "contents"
                  : "hidden"
              }
            >
              <DocumentsSection />
            </div>
            <div className={show("figures") ? "contents" : "hidden"}>
              <FiguresSection />
            </div>
            <div className={show("analysis") ? "contents" : "hidden"}>
              <AnalysisSection />
            </div>
            <div className={show("settings") ? "contents" : "hidden"}>
              <SettingsSection active={section === "settings"} />
            </div>
          </div>

          <div
            className={
              show("reports")
                ? "contents"
                : activeReport
                  ? "hidden print:contents"
                  : "hidden"
            }
          >
            {activeWorkspace ? (
                <PreparationReportPanel
                  key={`report-${activeWorkspace.id}`}
                  businessId={activeWorkspace.id}
                  inputRevision={activeWorkspace.revision}
                  runs={activeWorkspace.runs}
                  hasUnsavedChanges={!savedClean}
                  disabled={workspaceBusy || analysis.loading}
                  activeReport={activeReport}
                  documents={activeWorkspace.documents}
                  onActiveReportChange={setActiveReport}
                  onReportGenerated={handleReportGenerated}
                />
            ) : null}
          </div>

          {activeWorkspace ? (
            <div
              className={
                !show("assistant")
                  ? "hidden"
                  : activeReport
                    ? "flex flex-col gap-6 print:hidden"
                    : "flex flex-col gap-6"
              }
            >
              <PageHeader
                title="Assistant"
                description="Answers cite your saved figures and document pages."
              />
              {assistantSeen ? (
              <Suspense fallback={<Spinner className="mx-auto size-6 text-muted-foreground" aria-label="Loading assistant" />}>
              <WorkspaceQA
                key={activeWorkspace.id}
                businessId={activeWorkspace.id}
                businessName={activeWorkspace.form.businessName}
                inputRevision={activeWorkspace.revision}
                years={sortedPeriods(activeWorkspace.form.periods).map(
                  (period) => period.yearStart,
                )}
                hasReadyDocuments={activeWorkspace.documents.some(
                  (doc) => doc.status === "ready",
                )}
                hasUnsavedChanges={!savedClean}
                disabled={workspaceBusy || analysis.loading}
              />
              </Suspense>
              ) : null}
            </div>
          ) : null}
        </fieldset>
        <WorkspaceDialogs />
      </AppShell>
    </WorkspaceContext.Provider>
  );
}

export { Workspace };
