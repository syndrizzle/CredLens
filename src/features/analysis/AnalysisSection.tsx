import { AnalysisResults } from "./AnalysisResults";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useWorkspace } from "@/features/workspace/use-workspace";

function AnalysisSection() {
  const {
    form,
    activeWorkspace,
    workspaceBusy,
    analysis,
    savedClean,
    displayedAnalysis,
    analyseFigures,
  } = useWorkspace();

  return (
    <>
      <Card size="sm" aria-label="Run analysis" aria-busy={analysis.loading || workspaceBusy}>
        <CardHeader>
          <CardTitle>
            <p role="status" aria-live="polite" className="font-sans text-sm font-medium">
              {analysis.loading || workspaceBusy
                ? "Calculating from the submitted figures…"
                : analysis.stale ||
                    (activeWorkspace !== null &&
                      activeWorkspace.form !== form &&
                      activeWorkspace.analysis !== null)
                  ? "Entries changed. Previous results are hidden; review and analyse again."
                  : savedClean &&
                      activeWorkspace &&
                      activeWorkspace.analysis === null &&
                      activeWorkspace.runs.some((run) => run.superseded)
                    ? `Saved revision ${activeWorkspace.revision} supersedes earlier analysis runs. Review and analyse again to refresh results.`
                    : displayedAnalysis
                      ? "Analysis complete."
                      : "No analysis yet."}
            </p>
          </CardTitle>
          <CardDescription>
            Unconfirmed or missing inputs remain visible as evidence gaps.
            Analysis does not confirm entries for you.
          </CardDescription>
          <CardAction>
            <Button
              type="button"
              onClick={() => void analyseFigures()}
              disabled={analysis.loading || workspaceBusy}
            >
              {analysis.loading || workspaceBusy
                ? "Analysing…"
                : analysis.error
                  ? "Retry analysis"
                  : "Analyse figures"}
            </Button>
          </CardAction>
        </CardHeader>
        {analysis.error ? (
          <CardContent>
            <Alert variant="destructive">
              <AlertTitle>Analysis could not complete</AlertTitle>
              <AlertDescription>
                {analysis.error} Your entries are kept.
              </AlertDescription>
            </Alert>
          </CardContent>
        ) : null}
      </Card>
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
