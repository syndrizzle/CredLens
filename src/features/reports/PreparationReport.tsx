import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import { Logo } from "@/components/logo";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  ACTION_CATEGORIES,
  INDICATORS,
  displayDecimal,
  documentFileUrl,
  fetchReport,
  generateReport,
  type AnalysisRunSummary,
  type DocumentSummary,
  type EvidenceState,
  type Indicator,
  type PreparationReportResponse,
} from "../analysis/api";
import {
  FINANCIAL_FIELDS,
  financialYearLabel,
  unitLabel,
  type FinancialFieldKey,
  type RequestPayload,
} from "../manual-entry/model";

type PreparationReportPanelProps = {
  businessId: string;
  inputRevision: number;
  runs: AnalysisRunSummary[];
  hasUnsavedChanges: boolean;
  disabled?: boolean;
  activeReport: PreparationReportResponse | null;
  documents: DocumentSummary[];
  onActiveReportChange: (report: PreparationReportResponse | null) => void;
  onReportGenerated?: (report: PreparationReportResponse) => void;
};

function stateVariant(
  state: EvidenceState,
): "secondary" | "outline" | "destructive" {
  if (state === "Supported") return "secondary";
  if (state === "Needs review") return "destructive";
  return "outline";
}

function analysisTargetLabel(target: Indicator | "balance_check"): string {
  return target === "balance_check"
    ? "Balance-sheet consistency"
    : INDICATORS[target].label;
}

function formatOrigin(
  figure:
    | RequestPayload["periods"][number]["values"][FinancialFieldKey]
    | undefined,
): string {
  if (!figure || !figure.raw?.trim()) return "—";
  if (figure.origin === "document" && figure.source) {
    return figure.source.document_id
      ? `Document: ${figure.source.filename} (p. ${figure.source.page_number})`
      : `Source PDF removed (was ${figure.source.filename}, p. ${figure.source.page_number})`;
  }
  return "Manual entry";
}

function normalizedByKey(
  report: PreparationReportResponse,
): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const period of report.analysis.periods) {
    for (const input of period.balance_check.inputs) {
      map.set(`${input.year_start}:${input.field}`, input.normalized_inr);
    }
    for (const finding of period.indicators) {
      for (const input of finding.inputs) {
        map.set(`${input.year_start}:${input.field}`, input.normalized_inr);
      }
    }
  }
  return map;
}

const createdAt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" });

export function PreparationReportPanel({
  businessId,
  inputRevision,
  runs,
  hasUnsavedChanges,
  disabled = false,
  activeReport,
  documents,
  onActiveReportChange,
  onReportGenerated,
}: PreparationReportPanelProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => () => pending.current?.abort(), []);

  // Assign chronological 1-based version numbers matching backend _index_runs.
  const versionByRunId = new Map<string, number>();
  [...runs]
    .sort((a, b) =>
      a.created_at === b.created_at
        ? a.run_id.localeCompare(b.run_id)
        : a.created_at.localeCompare(b.created_at),
    )
    .forEach((run, index) => {
      versionByRunId.set(run.run_id, index + 1);
    });

  async function handleReportRequest(reportId?: string) {
    if (disabled || pending.current || (!reportId && hasUnsavedChanges)) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError(null);
    try {
      const report = reportId
        ? await fetchReport(businessId, reportId, controller.signal)
        : await generateReport(businessId, controller.signal);
      if (controller.signal.aborted) return;
      onActiveReportChange(report);
      if (!reportId) onReportGenerated?.(report);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not open preparation report.",
      );
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return (
    <section className="flex flex-col gap-6" aria-labelledby="preparation-report-panel-heading">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 print:hidden">
        <div className="min-w-0 space-y-1">
          <h1 id="preparation-report-panel-heading" className="font-heading text-2xl font-semibold tracking-tight">
            Reports
          </h1>
          <p className="text-sm text-muted-foreground">
            Printable summaries to share with your accountant or lender. Corrections supersede earlier versions.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {activeReport ? (
            <>
              <Button type="button" variant="ghost" onClick={() => onActiveReportChange(null)} disabled={loading}>
                Close report
              </Button>
              <Button type="button" variant="outline" onClick={() => window.print()} disabled={disabled || loading}>
                Print / Save as PDF
              </Button>
            </>
          ) : null}
          <Button
            type="button"
            onClick={() => void handleReportRequest()}
            disabled={disabled || loading || hasUnsavedChanges}
          >
            {loading ? <Spinner /> : null}
            {loading ? "Preparing report…" : "Generate preparation report"}
          </Button>
        </div>
      </div>

      {hasUnsavedChanges ? (
        <Alert className="print:hidden">
          <HugeiconsIcon icon={InformationCircleIcon} />
          <AlertTitle>Unsaved edits present</AlertTitle>
          <AlertDescription>
            Save your edits before generating a new report so it matches your latest figures.
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="destructive" className="print:hidden">
          <HugeiconsIcon icon={Alert02Icon} />
          <AlertTitle>Report could not be loaded</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {runs.length > 0 ? (
        <Card className="py-0 print:hidden">
          <Table>
            <TableCaption className="sr-only">Versions ({runs.length})</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Version</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">Created</TableHead>
                <TableHead className="hidden md:table-cell">Rules</TableHead>
                <TableHead className="pr-4 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => {
                const version = versionByRunId.get(run.run_id) ?? 1;
                const isCurrent = !run.superseded && run.input_revision === inputRevision;
                const isOpen = activeReport?.report_id === run.run_id;
                return (
                  <TableRow key={run.run_id} data-state={isOpen ? "selected" : undefined}>
                    <TableCell className="pl-4 font-medium">
                      Report v{version} · Input revision {run.input_revision}
                    </TableCell>
                    <TableCell>
                      <Badge variant={isCurrent ? "secondary" : "outline"}>{isCurrent ? "Current" : "Superseded"}</Badge>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      <time dateTime={run.created_at}>{createdAt.format(new Date(run.created_at))}</time>
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground md:table-cell">{run.rule_version}</TableCell>
                    <TableCell className="pr-4 text-right">
                      <Button
                        type="button"
                        variant={isOpen ? "secondary" : "outline"}
                        size="sm"
                        disabled={disabled || loading}
                        onClick={() => void handleReportRequest(run.run_id)}
                      >
                        {isOpen ? "Viewing" : isCurrent ? "Open current report" : "Open superseded report"}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      ) : (
        <Empty className="border border-dashed border-border print:hidden">
          <EmptyHeader>
            <EmptyTitle>No reports yet</EmptyTitle>
            <EmptyDescription>
              Generate a report to create Report v1 at input revision {inputRevision}.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {activeReport ? (
        <PreparationReportSheet
          report={activeReport}
          currentWorkspaceRevision={inputRevision}
          supersededByNewRun={runs.some((run) => run.run_id === activeReport.report_id && run.superseded)}
          documents={documents}
          businessId={businessId}
        />
      ) : null}
    </section>
  );
}

export function PreparationReportSheet({
  report,
  currentWorkspaceRevision,
  supersededByNewRun = false,
  documents,
  businessId,
}: {
  report: PreparationReportResponse;
  currentWorkspaceRevision?: number;
  supersededByNewRun?: boolean;
  documents?: DocumentSummary[];
  businessId?: string;
}) {
  const effectiveCurrentRev = Math.max(
    report.current_input_revision,
    currentWorkspaceRevision ?? report.current_input_revision,
  );
  const isSuperseded =
    report.superseded || supersededByNewRun || report.input_revision < effectiveCurrentRev;
  const supersededMessage =
    report.superseded_reason ??
    (report.input_revision < effectiveCurrentRev
      ? `Superseded by workspace input revision ${effectiveCurrentRev}. Re-run analysis or generate a refreshed report.`
      : "Superseded by a newer report version.");
  const normalizedMap = normalizedByKey(report);
  const sortedPeriods = [...report.inputs.periods].sort(
    (a, b) => a.year_start - b.year_start,
  );

  return (
    <article
      id="preparation-report-sheet"
      aria-labelledby="preparation-report-heading"
      className="space-y-6 rounded-xl border border-border bg-card p-6 text-card-foreground animate-in duration-200 ease-out fade-in-0 motion-safe:slide-in-from-top-1 print:animate-none print:border-0 print:bg-white print:p-0 print:text-black"
    >
      <header className="space-y-3 border-b border-border pb-4 print-avoid-break">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Logo className="size-4 text-foreground print:text-black" />
              CredLens Financial Preparation Report
            </p>
            <h2
              id="preparation-report-heading"
              className="font-heading text-2xl font-semibold"
            >
              {report.business_name}
            </h2>
          </div>
          <Badge variant={isSuperseded ? "destructive" : "secondary"}>
            {isSuperseded ? "SUPERSEDED" : "CURRENT VERSION"}
          </Badge>
        </div>

        <dl className="grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="inline font-medium text-foreground">
              Report version:{" "}
            </dt>
            <dd className="inline">
              v{report.report_version} ({report.report_schema_version})
            </dd>
          </div>
          <div>
            <dt className="inline font-medium text-foreground">
              Input revision:{" "}
            </dt>
            <dd className="inline">
              Rev {report.input_revision}
              {effectiveCurrentRev > report.input_revision
                ? ` (workspace now at Rev ${effectiveCurrentRev})`
                : " (current)"}
            </dd>
          </div>
          <div>
            <dt className="inline font-medium text-foreground">
              Currency &amp; basis:{" "}
            </dt>
            <dd className="inline">
              {report.currency} · {report.basis}
            </dd>
          </div>
          <div>
            <dt className="inline font-medium text-foreground">
              Rule version:{" "}
            </dt>
            <dd className="inline">
              {report.rule_version}
              {report.action_version ? ` · ${report.action_version}` : ""}
            </dd>
          </div>
          <div>
            <dt className="inline font-medium text-foreground">Generated: </dt>
            <dd className="inline">{report.created_at}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-foreground">Report ID: </dt>
            <dd className="inline font-mono">{report.report_id}</dd>
          </div>
        </dl>

        {isSuperseded ? (
          <Alert variant="destructive">
            <HugeiconsIcon icon={Alert02Icon} />
            <AlertTitle>
              Report v{report.report_version} (input revision{" "}
              {report.input_revision}) is superseded
            </AlertTitle>
            <AlertDescription>{supersededMessage}</AlertDescription>
          </Alert>
        ) : (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              className="size-4 shrink-0"
            />
            <span>
              Current preparation report matching saved workspace input revision{" "}
              {report.input_revision}.
            </span>
          </div>
        )}
      </header>

      <section className="space-y-4">
        <h3 className="font-heading text-lg font-semibold">
          1. Six financial indicators and balance-sheet consistency
        </h3>
        {report.analysis.periods.map((period) => (
          <div key={period.year_start} className="space-y-2">
            <h4 className="font-heading text-base font-medium">
              {financialYearLabel(period.year_start)}
            </h4>
            <div className="overflow-x-auto" tabIndex={0}>
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Indicator</th>
                    <th className="py-2 pr-3 font-medium">Evidence state</th>
                    <th className="py-2 pr-3 font-medium">Result</th>
                    <th className="py-2 font-medium">Reasons &amp; next step</th>
                  </tr>
                </thead>
                <tbody>
                  {period.indicators.map((finding) => {
                    const def = INDICATORS[finding.indicator];
                    const formattedValue =
                      finding.state === "Supported" && finding.value !== null
                        ? `${def.unit === "INR" ? "INR " : ""}${displayDecimal(finding.value)}${def.unit === "INR" ? "" : def.unit}`
                        : "Not calculated";
                    return (
                      <tr
                        key={finding.indicator}
                        className="border-b border-border/60 align-top"
                      >
                        <td className="py-2 pr-3">
                          <div className="font-medium text-foreground">
                            {def.label}
                          </div>
                          <div className="text-muted-foreground">
                            {def.formula}
                          </div>
                        </td>
                        <td className="py-2 pr-3">
                          <Badge variant={stateVariant(finding.state)}>
                            {finding.state}
                          </Badge>
                        </td>
                        <td className="py-2 pr-3 font-mono tabular-nums">
                          {formattedValue}
                        </td>
                        <td className="py-2 space-y-1">
                          {finding.reasons.length > 0 ? (
                            <p className="text-foreground">
                              {finding.reasons.map((r) => r.message).join(" ")}
                            </p>
                          ) : null}
                          <p className="text-muted-foreground">
                            Next step: {finding.next_step}
                          </p>
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="border-b border-border/60 align-top">
                    <td className="py-2 pr-3">
                      <div className="font-medium text-foreground">
                        Balance-sheet consistency
                      </div>
                      <div className="text-muted-foreground">
                        Assets − liabilities − equity (tolerance INR{" "}
                        {period.balance_check.tolerance_inr})
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      <Badge variant={stateVariant(period.balance_check.state)}>
                        {period.balance_check.state}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3 font-mono tabular-nums">
                      {period.balance_check.difference_inr === null
                        ? "Not assessed"
                        : `INR ${period.balance_check.difference_inr}`}
                    </td>
                    <td className="py-2 text-muted-foreground">
                      {period.balance_check.reasons.length > 0
                        ? period.balance_check.reasons
                            .map((r) => r.message)
                            .join(" ")
                        : "Within rounding tolerance; a passing check does not authenticate a statement."}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <h3 className="font-heading text-lg font-semibold">
          2. Missing, unreviewed and blocked evidence
        </h3>
        {report.missing_evidence.length > 0 ? (
          <div className="overflow-x-auto" tabIndex={0}>
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Period</th>
                  <th className="py-2 pr-3 font-medium">State</th>
                  <th className="py-2 pr-3 font-medium">Issue</th>
                  <th className="py-2 font-medium">Affected analyses</th>
                </tr>
              </thead>
              <tbody>
                {report.missing_evidence.map((item, idx) => (
                  <tr
                    key={`${item.year_start}-${item.code}-${idx}`}
                    className="border-b border-border/60 align-top"
                  >
                    <td className="py-2 pr-3 font-medium">
                      {financialYearLabel(item.year_start)}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge variant={stateVariant(item.state)}>
                        {item.state}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3">{item.message}</td>
                    <td className="py-2 text-muted-foreground">
                      {item.affected_analyses
                        .map(analysisTargetLabel)
                        .join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No missing, unreviewed, or conflicting evidence in this report
            snapshot.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="font-heading text-lg font-semibold">
          3. Ordered preparation actions
        </h3>
        <p className="text-xs text-muted-foreground">
          Workflow order: review conflicts first, then missing evidence,
          interpretation limits and supported investigation. This is not a
          credit-risk ranking.
        </p>
        {report.analysis.action_version && report.analysis.actions?.length ? (
          <ol className="list-decimal space-y-2 pl-5 text-xs">
            {report.analysis.actions.map((action, index) => (
              <li key={index} className="space-y-0.5">
                <span className="font-medium">
                  [{ACTION_CATEGORIES[action.category]}]
                </span>{" "}
                {action.message}{" "}
                <span className="text-muted-foreground">
                  (Affects:{" "}
                  {action.targets
                    .map(
                      (t) =>
                        `${analysisTargetLabel(t.indicator)} ${financialYearLabel(t.year_start)}`,
                    )
                    .join("; ")}
                  )
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-xs text-muted-foreground">
            This historical snapshot predates preparation actions; generate a
            refreshed report to include ordered actions.
          </p>
        )}
      </section>

      <section className="space-y-4">
        <h3 className="font-heading text-lg font-semibold">
          4. Submitted figures, origins and review states
        </h3>
        {sortedPeriods.map((period) => (
          <div key={period.year_start} className="space-y-2">
            <h4 className="font-heading text-base font-medium">
              {financialYearLabel(period.year_start)} ·{" "}
              {unitLabel(period.unit)} ·{" "}
              {period.comparable_to_prior
                ? "Comparable with prior year"
                : "Comparability not confirmed / no immediate prior"}
            </h4>
            <div className="overflow-x-auto" tabIndex={0}>
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">Line item</th>
                    <th className="py-1.5 pr-3 font-medium">Entered value</th>
                    <th className="py-1.5 pr-3 font-medium">Normalized INR</th>
                    <th className="py-1.5 pr-3 font-medium">Source / origin</th>
                    <th className="py-1.5 pr-3 font-medium">Review</th>
                    <th className="py-1.5 font-medium">Rev</th>
                  </tr>
                </thead>
                <tbody>
                  {FINANCIAL_FIELDS.map((field) => {
                    const figure = period.values[field.key];
                    const hasVal = Boolean(figure?.raw?.trim());
                    const norm =
                      normalizedMap.get(`${period.year_start}:${field.key}`) ??
                      null;
                    return (
                      <tr
                        key={field.key}
                        className="border-b border-border/50 align-top"
                      >
                        <td className="py-1.5 pr-3 font-medium">
                          {field.label}
                        </td>
                        <td className="py-1.5 pr-3 font-mono tabular-nums">
                          {hasVal
                            ? `${figure!.raw!.trim()} ${unitLabel(period.unit).toLowerCase()}`
                            : "Missing"}
                        </td>
                        <td className="py-1.5 pr-3 font-mono tabular-nums">
                          {norm ?? "—"}
                        </td>
                        <td className="py-1.5 pr-3 text-muted-foreground">
                          {formatOrigin(figure)}
                        </td>
                        <td className="py-1.5 pr-3">
                          {!hasVal
                            ? "Missing"
                            : figure!.reviewed
                              ? "Confirmed"
                              : "Unreviewed"}
                        </td>
                        <td className="py-1.5 font-mono">
                          {figure ? `v${figure.revision}` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-3 border-t border-border pt-4 print-avoid-break">
        <h3 className="font-heading text-lg font-semibold">
          5. Source documents and limitations
        </h3>
        {report.documents_referenced.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-xs">
            {report.documents_referenced.map((doc) => (
              <li key={`${doc.document_id ?? "detached"}-${doc.filename}`}>
                <span className="font-medium">{doc.filename}</span> · Pages{" "}
                {doc.pages.join(", ")}
                {doc.detached || (documents && !documents.some((source) => source.id === doc.document_id && source.status === "ready")) ? (
                  " · Source PDF unavailable (historical provenance)"
                ) : businessId && doc.document_id ? (
                  <span className="print:hidden">
                    {" "}
                    (
                    <a
                      href={documentFileUrl(
                        businessId,
                        doc.document_id,
                        doc.pages[0],
                      )}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-4"
                    >
                      Open PDF
                    </a>
                    )
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            All figures in this report snapshot are manually entered (no source
            PDF figures attached).
          </p>
        )}

        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {report.limitations.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      </section>
    </article>
  );
}
