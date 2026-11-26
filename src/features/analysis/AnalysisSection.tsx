import { AnalysisResults } from "./AnalysisResults";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useWorkspace } from "@/features/workspace/use-workspace";

function AnalysisSection() {
  const {
    form,
    activeWorkspace,
    workspaceBusy,
    analysis,
    savedClean,
    displayedAnalysis,
    analysisOutdated,
    analyseFigures,
  } = useWorkspace();
  const busy = analysis.loading || workspaceBusy;

  return (
    <>
      <PageHeader
        title="Analysis"
        description={
          <span role="status" aria-live="polite" aria-busy={busy}>
            {busy
              ? "Calculating from the submitted figures…"
              : analysisOutdated
                ? "Entries changed. Previous results are hidden; review and analyse again."
                : savedClean &&
                    activeWorkspace &&
                    activeWorkspace.analysis === null &&
                    activeWorkspace.runs.some((run) => run.superseded)
                  ? `Saved revision ${activeWorkspace.revision} supersedes earlier analysis runs. Review and analyse again to refresh results.`
                  : displayedAnalysis
                    ? "Analysis complete. Unconfirmed or missing inputs show as gaps."
                    : "No analysis yet. Analysis does not confirm entries for you."}
          </span>
        }
        actions={
          <Button type="button" onClick={() => void analyseFigures()} disabled={busy}>
            {busy ? <Spinner /> : null}
            {busy ? "Analysing…" : analysis.error ? "Retry analysis" : "Analyse figures"}
          </Button>
        }
      />
      {analysis.error ? (
        <Alert variant="destructive">
          <AlertTitle>Analysis could not complete</AlertTitle>
          <AlertDescription>{analysis.error} Your entries are kept.</AlertDescription>
        </Alert>
      ) : null}
      {displayedAnalysis ? (
        <AnalysisResults
          data={displayedAnalysis}
          businessName={form.businessName}
          businessId={savedClean && activeWorkspace ? activeWorkspace.id : undefined}
          inputRevision={savedClean && activeWorkspace ? activeWorkspace.revision : undefined}
          runs={savedClean && activeWorkspace ? activeWorkspace.runs : undefined}
        />
      ) : null}
    </>
  );
}

export { AnalysisSection };
