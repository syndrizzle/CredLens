import { Badge } from "@/components/ui/badge";
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
  documentFileUrl,
  type AnalysisResponse,
  type AnalysisRunSummary,
  type InputEvidence,
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
        <h2 id="analysis-heading" className="font-heading text-xl font-semibold">
          {businessName}
        </h2>
        <p className="text-sm text-muted-foreground">
          INR · Standalone · {data.rule_version} · {originSummary}
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
      <Card>
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
            <ol className="flex flex-col divide-y divide-border">
              {data.actions?.map((action, index) => (
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
              ))}
            </ol>
          ) : (
            <p className="text-sm">
              This saved analysis predates the preparation action list. Analyse
              the saved workspace again to generate it.
            </p>
          )}
        </CardContent>
      </Card>
      {data.periods.map((period) => (
        <section
          key={period.year_start}
          className="flex flex-col gap-4"
          aria-label={financialYearLabel(period.year_start)}
        >
          <h3 className="font-heading text-lg font-semibold">
            {financialYearLabel(period.year_start)}
          </h3>
          <Card
            size="sm"
            id={`finding-${period.year_start}-balance_check`}
            className="scroll-mt-20"
          >
            <CardHeader>
              <CardTitle>Balance-sheet consistency</CardTitle>
              <CardDescription>
                Assets − liabilities − equity:{" "}
                {period.balance_check.difference_inr === null
                  ? "Not assessed"
                  : `INR ${period.balance_check.difference_inr}`}{" "}
                · Tolerance: INR {period.balance_check.tolerance_inr}. A passing
                check does not authenticate a statement.
              </CardDescription>
              <CardAction>
                <Badge variant={period.balance_check.state === "Supported" ? "secondary" : "outline"}>
                  {period.balance_check.state}
                </Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {period.balance_check.reasons.map((reason, index) => (
                <p key={index}>{reason.message}</p>
              ))}
              <details>
                <summary className="cursor-pointer text-sm font-medium">
                  Balance-check inputs
                </summary>
                <Evidence
                  inputs={period.balance_check.inputs}
                  businessId={businessId}
                />
              </details>
            </CardContent>
          </Card>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {period.indicators.map((finding) => {
              const definition = INDICATORS[finding.indicator];
              const hasDocInput = finding.inputs.some(
                (input) => input.figure.origin === "document",
              );
              // The engine often repeats the only reason as the next step; show it once.
              const reasons = finding.reasons.filter((reason) => reason.message !== finding.next_step);
              return (
                <Card
                  key={finding.indicator}
                  id={`finding-${period.year_start}-${finding.indicator}`}
                  className="scroll-mt-20"
                >
                  <CardHeader>
                    <CardTitle>
                      <h4>{definition.label}</h4>
                    </CardTitle>
                    <CardDescription>{definition.formula}</CardDescription>
                    <CardAction>
                      <Badge variant={finding.state === "Supported" ? "secondary" : "outline"}>
                        {finding.state}
                      </Badge>
                    </CardAction>
                  </CardHeader>
                  <CardContent className="flex flex-1 flex-col gap-3">
                    {finding.state === "Supported" && finding.value !== null ? (
                      <p className="break-all text-2xl font-semibold tabular-nums">
                        {definition.unit === "INR" ? "INR " : ""}
                        {displayDecimal(finding.value)}
                        {definition.unit === "INR" ? "" : definition.unit}
                      </p>
                    ) : null}
                    {reasons.length > 0 ? (
                      <ul className="list-disc space-y-1 pl-4 text-sm">
                        {reasons.map((reason, index) => (
                          <li key={index}>{reason.message}</li>
                        ))}
                      </ul>
                    ) : null}
                    <p className="text-sm text-muted-foreground">
                      <span className="font-medium text-foreground">Next step: </span>
                      {finding.next_step}
                    </p>
                    <details className="mt-auto">
                      <summary className="cursor-pointer text-sm font-medium">
                        {hasDocInput
                          ? "Inputs and source origins"
                          : "Inputs and manual origin"}
                      </summary>
                      <Evidence
                        inputs={finding.inputs}
                        businessId={businessId}
                      />
                    </details>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      ))}
      <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
        {data.limitations.map((limit) => (
          <li key={limit}>{limit}</li>
        ))}
      </ul>
    </section>
  );
}
