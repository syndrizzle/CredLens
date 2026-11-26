import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { EvidenceBadge } from "@/features/analysis/EvidenceBadge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  FINANCIAL_FIELDS,
  financialYearLabel,
  unitLabel,
} from "../manual-entry/model";
import {
  ACTION_CATEGORIES,
  INDICATORS,
  displayDecimal,
  groupIndian,
  documentFileUrl,
  type AnalysisResponse,
  type AnalysisRunSummary,
  type Indicator,
  type InputEvidence,
  type PreparationAction,
} from "./api";

function OriginLabel({
  input,
  businessId,
}: {
  input: InputEvidence;
  businessId?: string;
}) {
  if (input.figure.origin === "document" && input.figure.source) {
    const src = input.figure.source;
    if (src.document_id) {
      return (
        <>
          Document: {src.filename} · p. {src.page_number}
          {businessId ? (
            <>
              {" "}
              (
              <a
                className="underline underline-offset-4"
                href={documentFileUrl(
                  businessId,
                  src.document_id,
                  src.page_number,
                )}
                target="_blank"
                rel="noreferrer"
              >
                View page {src.page_number}
              </a>
              )
            </>
          ) : null}
        </>
      );
    }
    return (
      <>
        Source PDF removed (was {src.filename} · p. {src.page_number})
      </>
    );
  }
  return <>Manual entry</>;
}

function Evidence({
  inputs,
  businessId,
}: {
  inputs: InputEvidence[];
  businessId?: string;
}) {
  return (
    <dl className="space-y-3 text-sm">
      {inputs.map((input) => (
        <div
          key={`${input.year_start}-${input.field}`}
          className="space-y-1 border-t pt-3"
        >
          <dt className="font-medium">
            {FINANCIAL_FIELDS.find((field) => field.key === input.field)?.label}{" "}
            · {financialYearLabel(input.year_start)}
          </dt>
          <dd className="break-words text-muted-foreground">
            {input.figure.raw?.trim() || "Missing"} {unitLabel(input.unit)} ·{" "}
            <OriginLabel input={input} businessId={businessId} /> ·{" "}
            {input.figure.reviewed ? "Confirmed" : "Unreviewed"} · Revision{" "}
            {input.figure.revision}
          </dd>
          <dd className="break-all text-muted-foreground">
            Normalized INR: {input.normalized_inr ?? "Not available"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

type Row = Indicator | "balance_check";
type Period = AnalysisResponse["periods"][number];
const ROWS: Row[] = [...(Object.keys(INDICATORS) as Indicator[]), "balance_check"];

const rowLabel = (row: Row) => (row === "balance_check" ? "Balance-sheet consistency" : INDICATORS[row].label);
const rowFormula = (row: Row) =>
  row === "balance_check" ? "Assets − liabilities − equity, within the rounding tolerance" : INDICATORS[row].formula;

function formatValue(row: Row, value: string) {
  if (row === "balance_check") return `₹${groupIndian(value)}`;
  const unit = INDICATORS[row].unit;
  return unit === "INR" ? `₹${groupIndian(displayDecimal(value))}` : `${displayDecimal(value)}${unit}`;
}

function cellFor(period: Period, row: Row) {
  if (row === "balance_check") {
    const check = period.balance_check;
    return { state: check.state, value: check.difference_inr === null ? null : formatValue(row, check.difference_inr), reasons: check.reasons };
  }
  const finding = period.indicators.find((item) => item.indicator === row)!;
  return {
    state: finding.state,
    value: finding.state === "Supported" && finding.value !== null ? formatValue(row, finding.value) : null,
    reasons: finding.reasons,
  };
}

export function IndicatorDetails({ data, row, businessId }: { data: AnalysisResponse; row: Row; businessId?: string }) {
  const periods = [...data.periods].sort((a, b) => a.year_start - b.year_start);
  return (
    <div className="flex flex-col divide-y divide-border">
      {periods.map((period) => {
        const cell = cellFor(period, row);
        const finding = row === "balance_check" ? null : period.indicators.find((item) => item.indicator === row)!;
        const inputs = finding ? finding.inputs : period.balance_check.inputs;
        const hasDocInput = inputs.some((input) => input.figure.origin === "document");
        // The engine often repeats the only reason as the next step; show it once.
        const reasons = cell.reasons.filter((reason) => reason.message !== finding?.next_step);
        return (
          <section key={period.year_start} className="space-y-3 py-4 first:pt-0" aria-label={financialYearLabel(period.year_start)}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium">{financialYearLabel(period.year_start)}</h3>
              <EvidenceBadge state={cell.state} />
            </div>
            {cell.value ? <p className="text-2xl font-semibold tabular-nums">{cell.value}</p> : null}
            {row === "balance_check" ? (
              <p className="text-xs text-muted-foreground">
                Tolerance: INR {period.balance_check.tolerance_inr}. A passing check does not authenticate a statement.
              </p>
            ) : null}
            {reasons.length > 0 ? (
              <ul className="list-disc space-y-1 pl-4">
                {reasons.map((reason, index) => (
                  <li key={index}>{reason.message}</li>
                ))}
              </ul>
            ) : null}
            {finding ? (
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">Next step: </span>
                {finding.next_step}
              </p>
            ) : null}
            <div className="space-y-1">
              <h4 className="text-xs font-medium text-muted-foreground">
                {row === "balance_check"
                  ? "Balance-check inputs"
                  : hasDocInput
                    ? "Inputs and source origins"
                    : "Inputs and manual origin"}
              </h4>
              <Evidence inputs={inputs} businessId={businessId} />
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function AnalysisResults({
  data,
  businessName,
  businessId,
  inputRevision,
  runs,
}: {
  data: AnalysisResponse;
  businessName: string;
  businessId?: string;
  inputRevision?: number;
  runs?: AnalysisRunSummary[];
}) {
  const [openRow, setOpenRow] = useState<Row | null>(null);
  // The sheet opens programmatically, so it needs to be told where focus returns.
  const returnFocus = useRef<HTMLElement | null>(null);
  const openDetails = (row: Row, from: HTMLElement) => {
    returnFocus.current = from;
    setOpenRow(row);
  };
  const periods = [...data.periods].sort((a, b) => a.year_start - b.year_start);
  // Fix and supply actions lead; supported findings to investigate are folded below them.
  const actionList = data.actions ?? [];
  const urgentActions = actionList.filter((action) => action.category !== "investigate");
  const laterActions = actionList.filter((action) => action.category === "investigate");
  const renderAction = (action: PreparationAction, index: number) => (
    <li key={index} className="flex flex-col gap-1.5 py-3 text-sm first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p>
          <span className="mr-2 text-muted-foreground tabular-nums">{index + 1}.</span>
          {action.message}
        </p>
        <Badge variant="outline">{ACTION_CATEGORIES[action.category]}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        Inputs:{" "}
        {action.inputs
          .map(
            (input) =>
              `${FINANCIAL_FIELDS.find((field) => field.key === input.field)?.label} · ${financialYearLabel(input.year_start)}`,
          )
          .join("; ")}
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {action.targets.map((target) => (
          <li key={`${target.year_start}-${target.indicator}`}>
            <a
              className="underline underline-offset-4"
              href={`#finding-${target.year_start}-${target.indicator}`}
              onClick={(event) => openDetails(target.indicator, event.currentTarget)}
            >
              {target.indicator === "balance_check"
                ? "Balance-sheet consistency"
                : INDICATORS[target.indicator].label}{" "}
              · {financialYearLabel(target.year_start)}
            </a>
          </li>
        ))}
      </ul>
    </li>
  );
  const superseded = runs?.filter((run) => run.superseded) ?? [];
  const allInputs = data.periods.flatMap((period) => [
    ...period.balance_check.inputs,
    ...period.indicators.flatMap((finding) => finding.inputs),
  ]);
  const hasDocument = allInputs.some(
    (input) => input.figure.origin === "document",
  );
  const hasManual = allInputs.some(
    (input) =>
      input.figure.origin === "manual" && Boolean(input.figure.raw?.trim()),
  );
  const originSummary =
    hasDocument && hasManual
      ? "Document-supported and manual figures"
      : hasDocument
        ? "Document-supported figures"
        : "Manually supplied figures";
  return (
    <section className="flex flex-col gap-6" aria-labelledby="analysis-heading">
      <div className="space-y-1">
        <h2 id="analysis-heading" className="sr-only">
          Results for {businessName}
        </h2>
        <p className="text-sm text-muted-foreground">
          {originSummary} · {data.rule_version}
          {inputRevision !== undefined
            ? ` · Input revision ${inputRevision} (current)`
            : ""}
        </p>
        {superseded.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Supersedes {superseded.length} earlier analysis{" "}
            {superseded.length === 1 ? "run" : "runs"} (
            {superseded.map((run) => `Rev ${run.input_revision}`).join(", ")}{" "}
            marked superseded).
          </p>
        ) : null}
      </div>
      <Card id="indicator-table" className="pb-0">
        <CardHeader>
          <CardTitle>
            <h3>Indicators</h3>
          </CardTitle>
          <CardDescription>
            Select a result for its formula, inputs and next step.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-lg border-collapse text-sm">
              <thead>
                <tr className="border-y border-border bg-muted/40 text-left">
                  <th scope="col" className="w-56 px-4 py-2 font-medium">Indicator</th>
                  {periods.map((period) => (
                    <th key={period.year_start} scope="col" className="px-3 py-2 font-medium">
                      {financialYearLabel(period.year_start)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => (
                  <tr key={row} className="border-t border-border/60 align-top">
                    <th scope="row" className="px-4 py-3 text-left font-normal">
                      <span className="block font-medium">{rowLabel(row)}</span>
                      <span className="block text-xs text-muted-foreground">{rowFormula(row)}</span>
                    </th>
                    {periods.map((period) => {
                      const cell = cellFor(period, row);
                      return (
                        <td key={period.year_start} className="px-2 py-2">
                          <Button
                            type="button"
                            variant="ghost"
                            id={`finding-${period.year_start}-${row}`}
                            className="h-auto w-full scroll-mt-20 flex-col items-start gap-1.5 px-2 py-1.5 text-left whitespace-normal"
                            onClick={(event) => openDetails(row, event.currentTarget)}
                          >
                            <span className="flex w-full flex-wrap items-center justify-between gap-2">
                              <span className="text-base font-semibold tabular-nums">
                                {cell.value ?? "No result"}
                              </span>
                              <EvidenceBadge state={cell.state} />
                            </span>
                            {cell.reasons.length > 0 ? (
                              <span className="text-xs font-normal text-muted-foreground">
                                {cell.reasons.map((reason) => reason.message).join(" ")}
                              </span>
                            ) : null}
                          </Button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
      <Card id="preparation-actions" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Preparation actions</CardTitle>
          <CardDescription>
            Resolve and review inputs first, supply missing evidence, then
            investigate supported findings. This is workflow order, not a
            credit-risk ranking. Check units against your records; a wrongly
            labelled unit cannot be detected automatically.
          </CardDescription>
          {data.action_version ? (
            <CardAction className="text-xs text-muted-foreground">{data.action_version}</CardAction>
          ) : null}
        </CardHeader>
        <CardContent>
          {data.action_version ? (
            <>
              <ol className="flex flex-col divide-y divide-border">
                {urgentActions.map((action, index) => renderAction(action, index))}
              </ol>
              {laterActions.length > 0 ? (
                <details className="mt-3 border-t border-border pt-3" open={urgentActions.length === 0}>
                  <summary className="cursor-pointer text-sm font-medium">
                    {laterActions.length} supported findings to investigate
                  </summary>
                  <ol className="mt-2 flex flex-col divide-y divide-border">
                    {laterActions.map((action, index) => renderAction(action, urgentActions.length + index))}
                  </ol>
                </details>
              ) : null}
            </>
          ) : (
            <p className="text-sm">
              This saved analysis predates the preparation action list. Analyse
              again to generate it.
            </p>
          )}
        </CardContent>
      </Card>
      <Sheet open={openRow !== null} onOpenChange={(open) => { if (!open) setOpenRow(null); }}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg" finalFocus={returnFocus}>
          {openRow ? (
            <>
              <SheetHeader>
                <SheetTitle>{rowLabel(openRow)}</SheetTitle>
                <SheetDescription>{rowFormula(openRow)}</SheetDescription>
              </SheetHeader>
              <div className="px-4 pb-6">
                <IndicatorDetails data={data} row={openRow} businessId={businessId} />
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
      <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
        {data.limitations.map((limit) => (
          <li key={limit}>{limit}</li>
        ))}
      </ul>
    </section>
  );
}
