import { WorkspaceQA } from "@/features/qa/WorkspaceQA";
import { PreparationReportPanel } from "@/features/reports/PreparationReport";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import { AppShell } from "@/app/AppShell";
import { type Section } from "@/app/sections";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { sortedPeriods } from "@/features/manual-entry/model";
import { WorkspaceContext, useWorkspaceController } from "./use-workspace";
import { OverviewSection } from "./OverviewSection";
import { AccountMenu } from "./AccountMenu";
import { WorkspaceDialogs } from "./WorkspaceDialogs";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { DocumentsSection } from "@/features/documents/DocumentsSection";
import { FiguresSection } from "@/features/manual-entry/FiguresSection";
import { AnalysisSection } from "@/features/analysis/AnalysisSection";

function Workspace({ section }: { section?: Section }) {
  const workspace = useWorkspaceController(section);
  const {
    notice,
    session,
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
  } = workspace;

  const show = (id: Section) => !section || section === id;
  const needsWorkspace =
    !activeWorkspace && (section === "documents" || section === "report" || section === "qa");

  return (
    <WorkspaceContext.Provider value={workspace}>
      <AppShell
        section={section}
        switcher={<WorkspaceSwitcher />}
        account={<AccountMenu />}
        actions={
          session ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleSaveWorkspace}
              disabled={actionsDisabled || savedClean}
            >
              {workspaceBusy
                ? "Saving…"
                : savedClean && activeWorkspace
                  ? `Saved · Rev ${activeWorkspace.revision}`
                  : "Save workspace"}
            </Button>
          ) : (
            <Badge variant="outline">Not saved</Badge>
          )
        }
      >
        <fieldset disabled={actionsDisabled} className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-6 print:max-w-none" aria-label="Financial health workspace">
          <div className={activeReport ? "flex flex-col gap-6 print:hidden" : "flex flex-col gap-6"}>
          {notice ? (
            <p
              role="status"
              aria-live="polite"
              className="text-sm font-medium text-foreground"
            >
              {notice}
            </p>
          ) : null}

          {workspaceError ? (
            <Alert variant="destructive">
              <HugeiconsIcon icon={Alert02Icon} />
              <AlertTitle>Workspace action failed</AlertTitle>
              <AlertDescription className="col-start-2">
                {workspaceError}
              </AlertDescription>
            </Alert>
          ) : null}

          {needsWorkspace ? (
            <Empty className="border border-dashed border-border">
              <EmptyHeader>
                <EmptyTitle>No saved workspace</EmptyTitle>
                <EmptyDescription>
                  {section === "documents"
                    ? "Sign in and save a workspace to upload PDF statements."
                    : section === "report"
                      ? "Sign in and save a workspace to generate preparation reports."
                      : "Sign in and save a workspace to ask questions about its evidence."}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Link to="/" className={buttonVariants({ variant: "outline" })}>
                  Go to Overview
                </Link>
              </EmptyContent>
            </Empty>
          ) : null}

          <div className={show("overview") ? "contents" : "hidden"}>
            <OverviewSection />
          </div>

          <div className={show("documents") ? "contents" : "hidden"}>
            <DocumentsSection />
          </div>

          <div className={show("figures") ? "contents" : "hidden"}>
            <FiguresSection />
          </div>

          <div className={show("analysis") ? "contents" : "hidden"}>
            <AnalysisSection />
          </div>
          </div>

          <div className={show("report") ? "contents" : activeReport ? "hidden print:contents" : "hidden"}>
          {activeWorkspace ? (
            <PreparationReportPanel
              key={`report-${activeWorkspace.id}`}
              businessId={activeWorkspace.id}
              businessName={activeWorkspace.form.businessName}
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
            <div className={!show("qa") ? "hidden" : activeReport ? "print:hidden" : undefined}>
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
            </div>
          ) : null}

          <footer className="space-y-1 pb-4 text-xs text-muted-foreground print:hidden">
            <p>
              Financial rules are provisional pending finance-reviewer validation.
            </p>
            <p>
              Cash generation is not assessed; no cash-flow statement is entered
              in this workflow. Borrowings exclude leases and count current
              maturities once.
            </p>
          </footer>
        </fieldset>
        <WorkspaceDialogs />
      </AppShell>
    </WorkspaceContext.Provider>
  );
}

export { Workspace };
