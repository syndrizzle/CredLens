import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  documentFileUrl,
  type CandidateIssueCode,
  type DocumentExtractionResponse,
  type ExtractedCandidate,
} from "../analysis/api";
import {
  FINANCIAL_FIELDS,
  countCandidateOverwrites,
  financialYearLabel,
  unitLabel,
  type CandidateImport,
  type FinancialFieldKey,
  type FormDraft,
} from "../manual-entry/model";

export type HighlightedCell = {
  page: number;
  table: number;
  row: number;
  col: number;
};

const ISSUE_LABELS: Record<CandidateIssueCode, string> = {
  missing_value: "Blank or dash value (kept missing)",
  invalid_amount: "Unsupported number format",
  ambiguous_mapping: "Ambiguous line-item label",
  missing_unit: "Missing unit declaration",
  conflicting_unit: "Conflicting units",
  missing_period: "Missing or non-annual period",
  conflicting_period: "Conflicting period dates",
  missing_basis: "Standalone basis not declared",
  conflicting_basis: "Conflicting reporting basis",
  duplicate_match: "Duplicate row for field and year",
  conflicting_match: "Conflicting amounts for field and year",
};

function fieldLabel(key: FinancialFieldKey | null): string {
  if (!key) return "Unmapped line item";
  return FINANCIAL_FIELDS.find((item) => item.key === key)?.label ?? key;
}

function candidateToImport(
  docId: string,
  filename: string,
  candidate: ExtractedCandidate,
): CandidateImport | null {
  if (
    candidate.issues.length > 0 ||
    candidate.normalized_inr === null ||
    candidate.field === null ||
    candidate.year_start === null ||
    candidate.unit === null ||
    candidate.amount === null
  ) {
    return null;
  }
  return {
    field: candidate.field,
    yearStart: candidate.year_start,
    unit: candidate.unit,
    amount: candidate.amount,
    source: {
      document_id: docId,
      filename,
      page_number: candidate.page_number,
      table_index: candidate.table_index,
      row_index: candidate.row_index,
      column_index: candidate.column_index,
      label: candidate.label,
      raw_token: candidate.raw,
    },
  };
}

function matchesFormFigure(
  form: FormDraft,
  docId: string,
  candidate: ExtractedCandidate,
): "confirmed" | "unreviewed" | null {
  if (
    !candidate.field ||
    candidate.year_start === null ||
    candidate.amount === null
  ) {
    return null;
  }
  const period = form.periods.find((p) => p.yearStart === candidate.year_start);
  if (!period || period.unit !== candidate.unit) return null;
  const fig = period.figures[candidate.field];
  if (
    fig.origin === "document" &&
    fig.source?.document_id === docId &&
    fig.source.page_number === candidate.page_number &&
    fig.source.table_index === candidate.table_index &&
    fig.source.row_index === candidate.row_index &&
    fig.source.column_index === candidate.column_index &&
    fig.raw.trim() === candidate.amount
  ) {
    return fig.reviewed ? "confirmed" : "unreviewed";
  }
  return null;
}

type SourceReviewProps = {
  businessId: string;
  extraction: DocumentExtractionResponse;
  activePage: number;
  highlightedCell: HighlightedCell | null;
  disabled: boolean;
  form: FormDraft;
  onSelectPage: (pageNumber: number) => void;
  onHighlightCell: (cell: HighlightedCell | null) => void;
  onRunExtraction: (documentId: string) => void;
  onApplyCandidates: (candidates: CandidateImport[]) => void;
  onJumpToField: (
    yearStart: number | null,
    field: FinancialFieldKey | null,
  ) => void;
  onClose: () => void;
};

export function SourceReview({
  businessId,
  extraction,
  activePage,
  highlightedCell,
  disabled,
  form,
  onSelectPage,
  onHighlightCell,
  onRunExtraction,
  onApplyCandidates,
  onJumpToField,
  onClose,
}: SourceReviewProps) {
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [showPdfEmbed, setShowPdfEmbed] = useState(false);

  const snapshot = extraction.extraction;
  const usableCandidates = snapshot
    ? snapshot.candidates.filter(
        (c) => c.issues.length === 0 && c.normalized_inr !== null,
      )
    : [];
  const unresolvedCandidates = snapshot
    ? snapshot.candidates.filter(
        (c) => c.issues.length > 0 || c.normalized_inr === null,
      )
    : [];
  const usableImports = usableCandidates
    .map((c) => candidateToImport(extraction.id, extraction.filename, c))
    .filter((item): item is CandidateImport => item !== null);
  const overwriteCount = countCandidateOverwrites(form, usableImports);
  const currentPage =
    snapshot?.pages.find((p) => p.page_number === activePage) ??
    snapshot?.pages[0] ??
    null;

  function handleApplyAll() {
    if (usableImports.length === 0) return;
    if (overwriteCount > 0) {
      setConfirmOverwrite(true);
      return;
    }
    onApplyCandidates(usableImports);
  }

  function inspectCandidate(candidate: ExtractedCandidate) {
    onSelectPage(candidate.page_number);
    onHighlightCell({
      page: candidate.page_number,
      table: candidate.table_index,
      row: candidate.row_index,
      col: candidate.column_index,
    });
  }

  return (
    <Card id="source-review-panel" aria-labelledby="source-review-heading">
      <CardHeader>
        <CardTitle id="source-review-heading">
          Source review · {extraction.filename}
        </CardTitle>
        <CardDescription>
          Inspect extracted pages and candidate figures against the source PDF.
          Applied candidates start unreviewed; editing an applied amount
          converts it to a manual entry.
        </CardDescription>
        <CardAction>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={onClose}
          >
            Close review
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-5">
        {extraction.extraction_status !== "ready" || !snapshot ? (
          <div className="space-y-3">
            <Alert>
              <HugeiconsIcon icon={InformationCircleIcon} />
              <AlertTitle>
                {extraction.extraction_status === "not_extracted"
                  ? "Extraction not yet run"
                  : extraction.extraction_status === "refresh_required"
                    ? "Extraction refresh required"
                    : "Extraction unavailable"}
              </AlertTitle>
              <AlertDescription className="col-start-2">
                {extraction.extraction_message ??
                  "Run extraction on this ready PDF to review source pages and candidates."}
              </AlertDescription>
            </Alert>
            {extraction.extraction_status === "not_extracted" ||
            extraction.extraction_status === "refresh_required" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => onRunExtraction(extraction.id)}
              >
                Run extraction
              </Button>
            ) : null}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={
                    snapshot.layout === "layout_a" ? "secondary" : "outline"
                  }
                >
                  {snapshot.layout === "layout_a"
                    ? "Supported table layout"
                    : "Unsupported layout"}
                </Badge>
                <span className="text-muted-foreground">
                  {usableCandidates.length} usable ·{" "}
                  {unresolvedCandidates.length} unresolved ·{" "}
                  {snapshot.page_count}{" "}
                  {snapshot.page_count === 1 ? "page" : "pages"}
                </span>
              </div>
              {usableImports.length > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={disabled}
                  onClick={handleApplyAll}
                >
                  <HugeiconsIcon
                    icon={CheckmarkCircle02Icon}
                    data-icon="inline-start"
                  />
                  Apply all usable candidates ({usableImports.length})
                </Button>
              ) : null}
            </div>

            {confirmOverwrite ? (
              <div
                role="group"
                aria-label="Replace entered figures with PDF candidates?"
                className="rounded-lg border border-border bg-muted/50 p-3 text-sm"
              >
                <p className="font-medium">
                  Replace {overwriteCount} entered{" "}
                  {overwriteCount === 1 ? "figure" : "figures"} with extracted
                  PDF candidates?
                </p>
                <p className="mt-1 text-muted-foreground">
                  Replaced figures will be set to the extracted PDF amounts and
                  marked unreviewed until you confirm them.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={disabled}
                    onClick={() => {
                      setConfirmOverwrite(false);
                      onApplyCandidates(usableImports);
                    }}
                  >
                    Apply and replace
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmOverwrite(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}

            {extraction.extraction_message ? (
              <Alert>
                <HugeiconsIcon icon={InformationCircleIcon} />
                <AlertTitle>Extraction notice</AlertTitle>
                <AlertDescription className="col-start-2">
                  {extraction.extraction_message}
                </AlertDescription>
              </Alert>
            ) : null}

            {usableCandidates.length > 0 ? (
              <section
                className="space-y-2"
                aria-label="Usable extracted candidates"
              >
                <h3 className="text-sm font-semibold">
                  Usable candidates ({usableCandidates.length})
                </h3>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {usableCandidates.map((candidate) => {
                    const key = `${candidate.page_number}-${candidate.table_index}-${candidate.row_index}-${candidate.column_index}`;
                    const imported = candidateToImport(
                      extraction.id,
                      extraction.filename,
                      candidate,
                    );
                    const formStatus = matchesFormFigure(
                      form,
                      extraction.id,
                      candidate,
                    );
                    return (
                      <li
                        key={key}
                        className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm"
                      >
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">
                              {fieldLabel(candidate.field)}
                            </span>
                            {candidate.year_start !== null ? (
                              <Badge variant="outline">
                                {financialYearLabel(candidate.year_start)}
                              </Badge>
                            ) : null}
                            {formStatus ? (
                              <Badge
                                variant={
                                  formStatus === "confirmed"
                                    ? "secondary"
                                    : "outline"
                                }
                              >
                                {formStatus === "confirmed"
                                  ? "In form · Confirmed"
                                  : "In form · Unreviewed"}
                              </Badge>
                            ) : null}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            <span className="font-mono text-foreground">
                              {candidate.amount}
                            </span>{" "}
                            {candidate.unit ? unitLabel(candidate.unit) : ""} ·
                            Printed: &ldquo;{candidate.raw}&rdquo; · Page{" "}
                            {candidate.page_number}, Table{" "}
                            {candidate.table_index}, Row {candidate.row_index}
                            {candidate.note ? ` · Note ${candidate.note}` : ""}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={disabled}
                            onClick={() => inspectCandidate(candidate)}
                          >
                            Inspect p. {candidate.page_number}
                          </Button>
                          {imported ? (
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              disabled={disabled}
                              onClick={() => onApplyCandidates([imported])}
                            >
                              {formStatus ? "Re-apply" : "Apply to form"}
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={disabled}
                            onClick={() => {
                              inspectCandidate(candidate);
                              onJumpToField(
                                candidate.year_start,
                                candidate.field,
                              );
                            }}
                          >
                            Edit in form
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            {unresolvedCandidates.length > 0 ? (
              <section
                className="space-y-2"
                aria-label="Unresolved extracted candidates"
              >
                <h3 className="text-sm font-semibold">
                  Unresolved items — manual review required (
                  {unresolvedCandidates.length})
                </h3>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {unresolvedCandidates.map((candidate) => {
                    const key = `u-${candidate.page_number}-${candidate.table_index}-${candidate.row_index}-${candidate.column_index}`;
                    return (
                      <li
                        key={key}
                        className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm"
                      >
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">
                              {candidate.field
                                ? fieldLabel(candidate.field)
                                : candidate.label}
                            </span>
                            <Badge variant="outline">Needs manual entry</Badge>
                            {candidate.year_start !== null ? (
                              <Badge variant="outline">
                                {financialYearLabel(candidate.year_start)}
                              </Badge>
                            ) : candidate.period_header ? (
                              <span className="text-xs text-muted-foreground">
                                {candidate.period_header}
                              </span>
                            ) : null}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Row label: &ldquo;{candidate.label}&rdquo; ·
                            Printed: &ldquo;{candidate.raw || "(blank)"}&rdquo;
                            · Page {candidate.page_number}, Table{" "}
                            {candidate.table_index}, Row {candidate.row_index}
                          </p>
                          <div className="flex flex-wrap gap-1.5 pt-0.5">
                            {candidate.issues.map((issue) => (
                              <Badge key={issue} variant="destructive">
                                {ISSUE_LABELS[issue] ?? issue}
                              </Badge>
                            ))}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={disabled}
                            onClick={() => inspectCandidate(candidate)}
                          >
                            Inspect p. {candidate.page_number}
                          </Button>
                          {candidate.field ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={disabled}
                              onClick={() => {
                                inspectCandidate(candidate);
                                onJumpToField(
                                  candidate.year_start,
                                  candidate.field,
                                );
                              }}
                            >
                              Enter manually
                            </Button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            {currentPage ? (
              <section
                className="space-y-3 rounded-lg border border-border p-4"
                aria-label="Source page inspector"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {snapshot.pages.map((page) => (
                      <Button
                        key={page.page_number}
                        type="button"
                        size="sm"
                        variant={
                          currentPage.page_number === page.page_number
                            ? "secondary"
                            : "outline"
                        }
                        aria-pressed={
                          currentPage.page_number === page.page_number
                        }
                        onClick={() => {
                          onSelectPage(page.page_number);
                          if (
                            highlightedCell &&
                            highlightedCell.page !== page.page_number
                          ) {
                            onHighlightCell(null);
                          }
                        }}
                      >
                        Page {page.page_number}
                      </Button>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setShowPdfEmbed((prev) => !prev)}
                    >
                      {showPdfEmbed
                        ? `Hide PDF preview`
                        : `Preview PDF page ${currentPage.page_number}`}
                    </Button>
                    <a
                      href={documentFileUrl(
                        businessId,
                        extraction.id,
                        currentPage.page_number,
                      )}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                    >
                      Open page {currentPage.page_number} in new tab
                    </a>
                  </div>
                </div>

                <div className="space-y-1 text-xs text-muted-foreground">
                  {currentPage.statement_title ? (
                    <p className="font-medium text-foreground">
                      {currentPage.statement_title}
                    </p>
                  ) : null}
                  <p>
                    Page {currentPage.page_number} of {snapshot.page_count}
                    {currentPage.unit
                      ? ` · Unit: ${unitLabel(currentPage.unit)}`
                      : currentPage.unit_header
                        ? ` · Unit heading: ${currentPage.unit_header}`
                        : " · Unit not declared at page level"}
                    {currentPage.basis ? ` · Basis: ${currentPage.basis}` : ""}
                    {currentPage.period_context
                      ? ` · ${currentPage.period_context}`
                      : ""}
                  </p>
                  {currentPage.issues.length > 0 ? (
                    <p className="flex items-center gap-1 text-destructive">
                      <HugeiconsIcon icon={Alert02Icon} className="size-3.5" />
                      Page issues: {currentPage.issues.join(", ")}
                    </p>
                  ) : null}
                </div>

                {showPdfEmbed ? (
                  <iframe
                    key={`${extraction.id}-page-${currentPage.page_number}`}
                    src={documentFileUrl(
                      businessId,
                      extraction.id,
                      currentPage.page_number,
                    )}
                    title={`${extraction.filename} — Page ${currentPage.page_number}`}
                    className="h-[28rem] w-full rounded-md border border-border bg-background"
                  />
                ) : null}

                {currentPage.tables.length > 0 ? (
                  <div className="space-y-3">
                    {currentPage.tables.map((table) => (
                      <div key={table.table_index} className="space-y-1">
                        <p className="text-xs font-medium text-muted-foreground">
                          Table {table.table_index} (Page{" "}
                          {currentPage.page_number})
                        </p>
                        <div className="overflow-x-auto rounded-md border border-border">
                          <table className="w-full border-collapse text-left text-xs">
                            <tbody>
                              {table.rows.map((row, rowIdx) => {
                                const rowNumber = rowIdx + 1;
                                const isHeader = rowIdx === 0;
                                return (
                                  <tr
                                    key={rowNumber}
                                    className={
                                      isHeader
                                        ? "border-b border-border bg-muted/60 font-medium"
                                        : "border-b border-border last:border-b-0"
                                    }
                                  >
                                    {row.map((cell, colIdx) => {
                                      const colNumber = colIdx + 1;
                                      const isSelected =
                                        highlightedCell !== null &&
                                        highlightedCell.page ===
                                          currentPage.page_number &&
                                        highlightedCell.table ===
                                          table.table_index &&
                                        highlightedCell.row === rowNumber &&
                                        highlightedCell.col === colNumber;
                                      const CellTag = isHeader ? "th" : "td";
                                      return (
                                        <CellTag
                                          key={colNumber}
                                          data-selected={
                                            isSelected ? "true" : undefined
                                          }
                                          className={`px-2.5 py-1.5 align-top ${
                                            isSelected
                                              ? "bg-primary/15 font-semibold text-foreground ring-2 ring-inset ring-primary"
                                              : ""
                                          }`}
                                        >
                                          {cell || "—"}
                                          {isSelected ? (
                                            <span className="sr-only">
                                              {" "}
                                              (selected source cell)
                                            </span>
                                          ) : null}
                                        </CellTag>
                                      );
                                    })}
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No structured tables extracted on page{" "}
                    {currentPage.page_number}. Inspect the page text or PDF page
                    directly.
                  </p>
                )}

                <details className="text-xs">
                  <summary className="cursor-pointer font-medium text-muted-foreground">
                    Extracted text on page {currentPage.page_number}
                  </summary>
                  <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 font-mono text-xs">
                    {currentPage.text}
                  </pre>
                </details>
              </section>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
