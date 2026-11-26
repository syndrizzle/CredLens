import { Bar } from "@/components/dither-kit/bar";
import { BarChart } from "@/components/dither-kit/bar-chart";
import { Line } from "@/components/dither-kit/area";
import { LineChart } from "@/components/dither-kit/area-chart";
import { Grid } from "@/components/dither-kit/grid";
import { BlockLegend } from "@/components/dither-kit/block-legend";
import { Tooltip } from "@/components/dither-kit/tooltip";
import { XAxis } from "@/components/dither-kit/x-axis";
import { YAxis } from "@/components/dither-kit/y-axis";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  FINANCIAL_FIELDS,
  financialYearLabel,
  type FinancialFieldKey,
} from "@/features/manual-entry/model";
import {
  ACTION_CATEGORIES,
  INDICATORS,
  displayDecimal,
  groupIndian,
  type AnalysisResponse,
  type Finding,
  type Indicator,
} from "./api";

type AnalysisOverviewProps = {
  data: AnalysisResponse;
  onOpenFinding: (yearStart: number, indicator: Indicator | "balance_check") => void;
  onOpenInput: (yearStart: number, field: FinancialFieldKey) => void;
};

function formatFinding(finding: Finding) {
  const unit = INDICATORS[finding.indicator].unit;
  const value = displayDecimal(finding.value!);
  return unit === "INR" ? `₹${groupIndian(value)}` : `${value}${unit}`;
}

// Chart labels only: plotted numbers are approximations and never reused as financial values.
function compactInr(max: number) {
  const [divisor, suffix] = max >= 1e7 ? [1e7, " Cr"] : max >= 1e5 ? [1e5, " L"] : [1, ""];
  return (value: number) => `₹${(value / divisor).toFixed(divisor === 1 ? 0 : 1)}${suffix}`;
}

function inputValue(finding: Finding, field: FinancialFieldKey) {
  return finding.inputs.find((input) => input.field === field)?.normalized_inr ?? null;
}

const FLOW_CONFIG = {
  revenue: { label: "Revenue", color: "green" },
  profit: { label: "Profit after tax", color: "blue" },
} as const;
const MARGIN_CONFIG = { margin: { label: "Net profit margin", color: "green" } } as const;

function AnalysisOverview({ data, onOpenFinding, onOpenInput }: AnalysisOverviewProps) {
  const periods = [...data.periods].sort((a, b) => a.year_start - b.year_start);
  const latest = periods.at(-1)!;
  const trend = periods.flatMap((period) => {
    const finding = period.indicators.find((item) => item.indicator === "net_profit_margin");
    const revenue = finding && inputValue(finding, "revenue");
    const profit = finding && inputValue(finding, "profit_after_tax");
    if (finding?.state !== "Supported" || !finding.value || !revenue || !profit) return [];
    return [{
      year: financialYearLabel(period.year_start),
      revenue: Number(revenue),
      profit: Number(profit),
      margin: Number(finding.value),
      revenueText: groupIndian(displayDecimal(revenue)),
      profitText: groupIndian(displayDecimal(profit)),
      marginText: displayDecimal(finding.value),
    }];
  });
  const actions = data.actions ?? [];
  const formatInr = compactInr(Math.max(...trend.map((row) => Math.abs(row.revenue))));

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="overview-indicators" className="flex flex-col gap-3">
        <h2 id="overview-indicators" className="font-heading text-lg font-semibold">
          {financialYearLabel(latest.year_start)}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {latest.indicators.map((finding) => {
            const supported = finding.state === "Supported" && finding.value !== null;
            return (
              <Card key={finding.indicator}>
                <CardHeader>
                  <CardDescription>{INDICATORS[finding.indicator].label}</CardDescription>
                  <CardTitle
                    className={
                      supported
                        ? "font-sans text-2xl font-semibold tabular-nums"
                        : "font-sans text-2xl font-semibold text-muted-foreground"
                    }
                  >
                    {supported ? formatFinding(finding) : "No result"}
                  </CardTitle>
                  <CardAction>
                    <Badge variant={finding.state === "Supported" ? "secondary" : "outline"}>
                      {finding.state}
                    </Badge>
                  </CardAction>
                </CardHeader>
                {finding.reasons[0] ? (
                  <CardFooter className="mt-auto border-t border-border py-3">
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto min-w-0 shrink justify-start p-0 text-left whitespace-normal text-muted-foreground hover:text-foreground"
                      onClick={() => onOpenFinding(latest.year_start, finding.indicator)}
                    >
                      <span className="line-clamp-2">{finding.reasons[0].message}</span>
                    </Button>
                  </CardFooter>
                ) : null}
              </Card>
            );
          })}
        </div>
      </section>

      {trend.length >= 2 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Revenue and profit after tax</CardTitle>
              <CardAction>
                <BlockLegend config={FLOW_CONFIG} />
              </CardAction>
            </CardHeader>
            <CardContent>
              <div className="h-56" aria-hidden>
                <BarChart data={trend} config={FLOW_CONFIG} margins={{ left: 56 }}>
                  <Grid />
                  <XAxis dataKey="year" />
                  <YAxis tickFormatter={formatInr} />
                  <Tooltip labelKey="year" valueFormatter={formatInr} />
                  <Bar dataKey="revenue" />
                  <Bar dataKey="profit" variant="hatched" />
                </BarChart>
              </div>
              <table className="sr-only">
                <caption>Revenue and profit after tax in INR</caption>
                <thead>
                  <tr><th scope="col">Year</th><th scope="col">Revenue</th><th scope="col">Profit after tax</th></tr>
                </thead>
                <tbody>
                  {trend.map((row) => (
                    <tr key={row.year}><th scope="row">{row.year}</th><td>₹{row.revenueText}</td><td>₹{row.profitText}</td></tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Net profit margin</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-56" aria-hidden>
                <LineChart data={trend} config={MARGIN_CONFIG} margins={{ left: 40, right: 40 }}>
                  <Grid />
                  <XAxis dataKey="year" />
                  <YAxis tickFormatter={(value) => `${value}%`} />
                  <Tooltip labelKey="year" valueFormatter={(value) => `${value.toFixed(2)}%`} />
                  <Line dataKey="margin" />
                </LineChart>
              </div>
              <table className="sr-only">
                <caption>Net profit margin</caption>
                <thead>
                  <tr><th scope="col">Year</th><th scope="col">Margin</th></tr>
                </thead>
                <tbody>
                  {trend.map((row) => (
                    <tr key={row.year}><th scope="row">{row.year}</th><td>{row.marginText}%</td></tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Trend charts need net profit margin supported in at least two years.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Preparation actions</CardTitle>
          <CardDescription>Workflow order, not a credit-risk ranking.</CardDescription>
        </CardHeader>
        <CardContent>
          {!data.action_version ? (
            <p className="text-sm">Analyse the saved workspace again to list preparation actions.</p>
          ) : actions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No preparation actions for this analysis.</p>
          ) : (
            <ol className="flex flex-col divide-y divide-border">
              {actions.map((action, index) => (
                <li key={index} className="flex flex-col gap-2 py-3 text-sm first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p>{action.message}</p>
                    <Badge variant="outline">{ACTION_CATEGORIES[action.category]}</Badge>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {action.inputs.map((input) => (
                      <Button
                        key={`input-${input.year_start}-${input.field}`}
                        type="button"
                        variant="link"
                        size="sm"
                        className="h-auto p-0 text-foreground"
                        onClick={() => onOpenInput(input.year_start, input.field)}
                      >
                        {FINANCIAL_FIELDS.find((field) => field.key === input.field)?.label} · {financialYearLabel(input.year_start)}
                      </Button>
                    ))}
                    {action.targets.map((target) => (
                      <Button
                        key={`target-${target.year_start}-${target.indicator}`}
                        type="button"
                        variant="link"
                        size="sm"
                        className="h-auto p-0 text-muted-foreground"
                        onClick={() => onOpenFinding(target.year_start, target.indicator)}
                      >
                        {target.indicator === "balance_check"
                          ? "Balance-sheet consistency"
                          : INDICATORS[target.indicator].label}{" "}
                        · {financialYearLabel(target.year_start)}
                      </Button>
                    ))}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export { AnalysisOverview };
