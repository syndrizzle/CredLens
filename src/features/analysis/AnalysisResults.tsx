import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { FINANCIAL_FIELDS, financialYearLabel, unitLabel } from "../manual-entry/model";
import { INDICATORS, displayDecimal, type AnalysisResponse, type InputEvidence } from "./api";

function Evidence({ inputs }: { inputs: InputEvidence[] }) {
  return <dl className="space-y-3 text-sm">{inputs.map(input => <div key={`${input.year_start}-${input.field}`} className="space-y-1 border-t pt-3">
    <dt className="font-medium">{FINANCIAL_FIELDS.find(field => field.key === input.field)?.label} · {financialYearLabel(input.year_start)}</dt>
    <dd className="break-words text-muted-foreground">{input.figure.raw?.trim() || "Missing"} {unitLabel(input.unit)} · Manual entry · {input.figure.reviewed ? "Confirmed" : "Unreviewed"} · Revision {input.figure.revision}</dd>
    <dd className="break-all text-muted-foreground">Normalized INR: {input.normalized_inr ?? "Not available"}</dd>
  </div>)}</dl>;
}

export function AnalysisResults({ data, businessName }: { data: AnalysisResponse; businessName: string }) {
  return <section className="space-y-6" aria-labelledby="analysis-heading">
    <div><h2 id="analysis-heading" className="font-heading text-2xl font-semibold">Analysis · {businessName}</h2>
      <p className="text-sm text-muted-foreground">INR · Standalone · {data.rule_version} · Manually supplied figures</p></div>
    {data.periods.map(period => <section key={period.year_start} className="space-y-4" aria-label={financialYearLabel(period.year_start)}>
      <h3 className="font-heading text-xl">{financialYearLabel(period.year_start)}</h3>
      <Card><CardHeader><CardTitle>Balance-sheet consistency</CardTitle><CardDescription>{period.balance_check.state} · A passing check does not authenticate a statement.</CardDescription></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>Assets − liabilities − equity: {period.balance_check.difference_inr === null ? "Not assessed" : `INR ${period.balance_check.difference_inr}`} · Tolerance: INR {period.balance_check.tolerance_inr}</p>
          {period.balance_check.reasons.map((reason, index) => <p key={index}>{reason.message}</p>)}
          <details><summary className="cursor-pointer font-medium">Balance-check inputs</summary><Evidence inputs={period.balance_check.inputs} /></details>
        </CardContent></Card>
      <div className="grid gap-4 sm:grid-cols-2">
        {period.indicators.map(finding => {
          const definition = INDICATORS[finding.indicator];
          return <Card key={finding.indicator}><CardHeader>
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
