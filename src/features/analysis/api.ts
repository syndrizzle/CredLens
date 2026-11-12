import { FINANCIAL_FIELDS, type FormDraft, type FinancialFieldKey, type Unit } from "../manual-entry/model";

export const INDICATORS = {
  revenue_growth: { label: "Revenue growth", formula: "100 × (current revenue − prior revenue) ÷ prior revenue", unit: "%" },
  net_profit_margin: { label: "Net profit margin", formula: "100 × profit after tax ÷ revenue", unit: "%" },
  working_capital: { label: "Working capital", formula: "Current assets − current liabilities", unit: "INR" },
  current_ratio: { label: "Current ratio", formula: "Current assets ÷ current liabilities", unit: "x" },
  debt_to_equity: { label: "Debt-to-equity", formula: "(Short-term + long-term borrowings + current maturities) ÷ equity", unit: "x" },
  interest_coverage: { label: "Interest coverage", formula: "EBIT ÷ interest expense", unit: "x" },
} as const;
export type Indicator = keyof typeof INDICATORS;
export type EvidenceState = "Supported" | "Needs review" | "Not assessed" | "Not meaningful";
export type Reason = { code: string; message: string; fields: FinancialFieldKey[] };
export type InputEvidence = {
  year_start: number; field: FinancialFieldKey; unit: Unit;
  figure: { raw: string | null; reviewed: boolean; revision: number; origin: "manual" };
  normalized_inr: string | null;
};
export type Finding = {
  indicator: Indicator; state: EvidenceState; value: string | null;
  inputs: InputEvidence[]; reasons: Reason[]; next_step: string;
};
export type AnalysisResponse = {
  rule_version: "financial-rules-v1"; limitations: string[];
  periods: { year_start: number; indicators: Finding[]; balance_check: {
    state: EvidenceState; difference_inr: string | null; tolerance_inr: string;
    inputs: InputEvidence[]; reasons: Reason[];
  } }[];
};

export function analysisRequest(form: FormDraft) {
  return {
    business_name: form.businessName.trim(), currency: "INR", basis: "standalone",
    periods: form.periods.map(period => ({
      year_start: period.yearStart, unit: period.unit, comparable_to_prior: period.comparableToPrior,
      values: Object.fromEntries(FINANCIAL_FIELDS.map(({ key }) => {
        const figure = period.figures[key];
        return [key, { raw: figure.raw, reviewed: Boolean(figure.raw.trim()) && figure.reviewed, origin: "manual", revision: figure.revision ?? 1 }];
      })),
    })),
  };
}

// Format decimal text for display only; never use these rounded values as inputs.
export function displayDecimal(value: string): string {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^[+-]/, "").split(".");
  let cents = BigInt(whole!) * 100n + BigInt((fraction + "00").slice(0, 2));
  if ((fraction[2] ?? "0") >= "5") cents += 1n;
  return `${negative && cents !== 0n ? "-" : ""}${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

export async function fetchAnalysis(form: FormDraft, signal: AbortSignal): Promise<AnalysisResponse> {
  const response = await fetch("/api/analysis", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(analysisRequest(form)), signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
  });
  if (!response.ok) {
    throw new Error(response.status === 422
      ? "The server rejected these entries. Check the business, completed years, and amount format, then retry."
      : "Analysis is unavailable. Check that the local backend is running, then retry.");
  }
  const body: unknown = await response.json();
  if (!validResponse(body, form)) {
    throw new Error("The server returned an incomplete analysis. Retry after checking the backend version.");
  }
  return body;
}

const decimal = (value: unknown): value is string => typeof value === "string" && /^[+-]?\d+(\.\d+)?$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const state = (value: unknown) => ["Supported", "Needs review", "Not assessed", "Not meaningful"].includes(value as string);
const field = (value: unknown) => FINANCIAL_FIELDS.some(item => item.key === value);
function reasons(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => record(item) && typeof item.code === "string" && typeof item.message === "string" && Array.isArray(item.fields) && item.fields.every(field));
}
function inputs(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => record(item) && Number.isInteger(item.year_start) && field(item.field) &&
    ["rupees", "thousands", "lakhs", "crores"].includes(item.unit as string) && record(item.figure) &&
    (item.figure.raw === null || typeof item.figure.raw === "string") && typeof item.figure.reviewed === "boolean" &&
    Number.isInteger(item.figure.revision) && Number(item.figure.revision) > 0 && item.figure.origin === "manual" &&
    (item.normalized_inr === null || decimal(item.normalized_inr)));
}
function validResponse(value: unknown, form: FormDraft): value is AnalysisResponse {
  if (!record(value) || value.rule_version !== "financial-rules-v1" || !Array.isArray(value.limitations) ||
      !value.limitations.every(item => typeof item === "string") || !Array.isArray(value.periods) || value.periods.length !== form.periods.length) return false;
  const years = new Set();
  return value.periods.every(period => {
    if (!record(period) || years.has(period.year_start) || !form.periods.some(input => input.yearStart === period.year_start)) return false;
    years.add(period.year_start);
    const balance = period.balance_check;
    if (!record(balance) || !state(balance.state) || !decimal(balance.tolerance_inr) ||
        !(balance.difference_inr === null || decimal(balance.difference_inr)) || !inputs(balance.inputs) || !reasons(balance.reasons)) return false;
    const indicators = period.indicators;
    return Array.isArray(indicators) && indicators.length === 6 &&
      new Set(indicators.map(item => record(item) ? item.indicator : null)).size === 6 &&
      indicators.every(item => record(item) && typeof item.indicator === "string" && Object.hasOwn(INDICATORS, item.indicator) && state(item.state) &&
        (item.state === "Supported" ? decimal(item.value) : item.value === null) && inputs(item.inputs) && reasons(item.reasons) &&
        (item.state === "Supported" || (item.reasons as unknown[]).length > 0) && typeof item.next_step === "string");
  });
}
