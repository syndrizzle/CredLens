import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { FINANCIAL_FIELDS, financialYearLabel, unitLabel } from "../manual-entry/model";
import { ACTION_CATEGORIES, INDICATORS, displayDecimal, type AnalysisResponse, type AnalysisRunSummary, type InputEvidence } from "./api";

function Evidence({ inputs }: { inputs: InputEvidence[] }) {
  return <dl className="space-y-3 text-sm">{inputs.map(input => <div key={`${input.year_start}-${input.field}`} className="space-y-1 border-t pt-3">
    <dt className="font-medium">{FINANCIAL_FIELDS.find(field => field.key === input.field)?.label} · {financialYearLabel(input.year_start)}</dt>
    <dd className="break-words text-muted-foreground">{input.figure.raw?.trim() || "Missing"} {unitLabel(input.unit)} · Manual entry · {input.figure.reviewed ? "Confirmed" : "Unreviewed"} · Revision {input.figure.revision}</dd>
    <dd className="break-all text-muted-foreground">Normalized INR: {input.normalized_inr ?? "Not available"}</dd>
  </div>)}</dl>;
}

export function AnalysisResults({ data, businessName, inputRevision, runs }: {
  data: AnalysisResponse; businessName: string; inputRevision?: number; runs?: AnalysisRunSummary[];
}) {
  const superseded = runs?.filter(run => run.superseded) ?? [];
  return <section className="space-y-6" aria-labelledby="analysis-heading">
    <div><h2 id="analysis-heading" className="font-heading text-2xl font-semibold">Analysis · {businessName}</h2>
      <p className="text-sm text-muted-foreground">INR · Standalone · {data.rule_version} · Manually supplied figures{inputRevision !== undefined ? ` · Input revision ${inputRevision} (current)` : ""}</p>
      {superseded.length > 0 ? <p className="text-xs text-muted-foreground">Supersedes {superseded.length} earlier analysis {superseded.length === 1 ? "run" : "runs"} ({superseded.map(run => `Rev ${run.input_revision}`).join(", ")} marked superseded).</p> : null}</div>
    <Card><CardHeader><CardTitle>Preparation actions</CardTitle>
      <CardDescription>Resolve and review inputs first, supply missing evidence, then investigate supported findings. This is workflow order, not a credit-risk ranking. Check units against your records; a wrongly labelled unit cannot be detected automatically.</CardDescription>
    </CardHeader><CardContent>
      {data.action_version ? <>
        <p className="mb-4 text-xs text-muted-foreground">{data.action_version}</p>
        <ol className="list-decimal space-y-4 pl-5">{data.actions?.map((action, index) => <li key={index} className="space-y-2 text-sm">
          <Badge variant="outline">{ACTION_CATEGORIES[action.category]}</Badge>
          <p>{action.message}</p>
          <p className="text-muted-foreground">Inputs: {action.inputs.map(input => `${FINANCIAL_FIELDS.find(field => field.key === input.field)?.label} · ${financialYearLabel(input.year_start)}`).join("; ")}</p>
          <ul className="list-disc pl-4">{action.targets.map(target => <li key={`${target.year_start}-${target.indicator}`}>
            <a className="underline underline-offset-4" href={`#finding-${target.year_start}-${target.indicator}`}>{target.indicator === "balance_check" ? "Balance-sheet consistency" : INDICATORS[target.indicator].label} · {financialYearLabel(target.year_start)}</a>
          </li>)}</ul>
        </li>)}</ol>
      </> : <p className="text-sm">This saved analysis predates the preparation action list. Analyse the saved workspace again to generate it.</p>}
    </CardContent></Card>
    {data.periods.map(period => <section key={period.year_start} className="space-y-4" aria-label={financialYearLabel(period.year_start)}>
      <h3 className="font-heading text-xl">{financialYearLabel(period.year_start)}</h3>
      <Card id={`finding-${period.year_start}-balance_check`}><CardHeader><CardTitle>Balance-sheet consistency</CardTitle><CardDescription>{period.balance_check.state} · A passing check does not authenticate a statement.</CardDescription></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>Assets − liabilities − equity: {period.balance_check.difference_inr === null ? "Not assessed" : `INR ${period.balance_check.difference_inr}`} · Tolerance: INR {period.balance_check.tolerance_inr}</p>
          {period.balance_check.reasons.map((reason, index) => <p key={index}>{reason.message}</p>)}
          <details><summary className="cursor-pointer font-medium">Balance-check inputs</summary><Evidence inputs={period.balance_check.inputs} /></details>
        </CardContent></Card>
      <div className="grid gap-4 sm:grid-cols-2">
        {period.indicators.map(finding => {
          const definition = INDICATORS[finding.indicator];
          return <Card key={finding.indicator} id={`finding-${period.year_start}-${finding.indicator}`}><CardHeader>
            <CardTitle><h4>{definition.label}</h4></CardTitle><CardDescription>{definition.formula}</CardDescription>
          </CardHeader><CardContent className="space-y-4">
            <Badge variant={finding.state === "Supported" ? "secondary" : "outline"}>{finding.state}</Badge>
            {finding.state === "Supported" && finding.value !== null ? <p className="break-all text-2xl font-semibold tabular-nums">{definition.unit === "INR" ? "INR " : ""}{displayDecimal(finding.value)}{definition.unit === "INR" ? "" : definition.unit}</p> : null}
            {finding.reasons.length > 0 ? <ul className="list-disc space-y-1 pl-4 text-sm">{finding.reasons.map((reason, index) => <li key={index}>{reason.message}</li>)}</ul> : null}
            <p className="text-sm"><span className="font-medium">Next step: </span>{finding.next_step}</p>
            <details><summary className="cursor-pointer text-sm font-medium">Inputs and manual origin</summary><Evidence inputs={finding.inputs} /></details>
          </CardContent></Card>;
        })}
      </div>
    </section>)}
    <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">{data.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul>
  </section>;
}
