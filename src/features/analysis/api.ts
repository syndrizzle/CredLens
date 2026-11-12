import {
  FINANCIAL_FIELDS,
  formFromRequest,
  type FormDraft,
  type FinancialFieldKey,
  type RequestPayload,
  type Unit,
} from "../manual-entry/model";

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
export const ACTION_CATEGORIES = {
  review: "Resolve and review inputs",
  missing: "Supply missing evidence",
  interpretation: "Check interpretation limits",
  investigate: "Investigate supported findings",
} as const;
export type PreparationAction = {
  category: keyof typeof ACTION_CATEGORIES; code: string; message: string;
  inputs: { year_start: number; field: FinancialFieldKey }[];
  targets: { year_start: number; indicator: Indicator | "balance_check" }[];
};
export type AnalysisResponse = {
  rule_version: "financial-rules-v1"; limitations: string[];
  action_version?: "preparation-actions-v1" | null; actions?: PreparationAction[];
  periods: { year_start: number; indicators: Finding[]; balance_check: {
    state: EvidenceState; difference_inr: string | null; tolerance_inr: string;
    inputs: InputEvidence[]; reasons: Reason[];
  } }[];
};
export type SessionUser = { owner_id: string; email: string };
export type BusinessSummary = { id: string; business_name: string; input_revision: number };
export type WorkspaceResponse = {
  business_id: string; input_revision: number;
  request: RequestPayload;
  latest_run_id: string | null; latest_analysis: AnalysisResponse | null;
};

export function analysisRequest(form: FormDraft): RequestPayload {
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

export async function fetchSession(): Promise<SessionUser | null> {
  const response = await fetch("/api/auth/session", { credentials: "same-origin", signal: AbortSignal.timeout(30000) });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Account service is unavailable. Check that the backend and database are running.");
  return response.json() as Promise<SessionUser>;
}

export async function submitCredentials(mode: "login" | "register", email: string, password: string): Promise<SessionUser> {
  const response = await fetch(`/api/auth/${mode}`, {
    method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(30000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (response.status === 401) throw new Error("Invalid email or password.");
  if (response.status === 409) throw new Error("An account with this email already exists. Sign in instead.");
  if (response.status === 422) throw new Error("Enter a valid email address and a password of 12 to 128 characters.");
  if (!response.ok) throw new Error("Account service is unavailable. Check that the backend and database are running.");
  return response.json() as Promise<SessionUser>;
}

export async function signOut(): Promise<void> {
  const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error("Sign out could not be confirmed. Your session may still be active. Please retry.");
}

export async function fetchBusinesses(): Promise<BusinessSummary[]> {
  const response = await fetch("/api/businesses", { credentials: "same-origin", signal: AbortSignal.timeout(30000) });
  if (response.status === 401) throw new Error("Your session expired. Sign in again.");
  if (!response.ok) throw new Error("Could not load saved workspaces.");
  return response.json() as Promise<BusinessSummary[]>;
}

export async function saveWorkspace(form: FormDraft): Promise<WorkspaceResponse> {
  const response = await fetch("/api/businesses", {
    method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(30000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify(analysisRequest(form)),
  });
  return parseWorkspace(response);
}

export async function fetchWorkspace(businessId: string): Promise<WorkspaceResponse> {
  const response = await fetch(`/api/businesses/${encodeURIComponent(businessId)}`, { credentials: "same-origin", signal: AbortSignal.timeout(30000) });
  return parseWorkspace(response);
}

export async function analyseWorkspace(businessId: string): Promise<WorkspaceResponse> {
  const response = await fetch(`/api/businesses/${encodeURIComponent(businessId)}/analysis`, {
    method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(30000),
  });
  return parseWorkspace(response);
}

async function parseWorkspace(response: Response): Promise<WorkspaceResponse> {
  if (response.status === 401) throw new Error("Your session expired. Sign in again.");
  if (response.status === 404) throw new Error("Workspace not found.");
  if (response.status === 422) throw new Error("The server rejected these entries. Check the business, completed years, and amount format.");
  if (!response.ok) throw new Error("Workspace service is unavailable. Check that the local backend and database are running.");
  const body: unknown = await response.json();
  if (!validWorkspace(body)) throw new Error("The server returned an invalid workspace payload.");
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
function validRequest(value: unknown): value is RequestPayload {
  return record(value) && typeof value.business_name === "string" && value.business_name.trim().length > 0 &&
    value.currency === "INR" && value.basis === "standalone" && Array.isArray(value.periods) &&
    value.periods.length >= 1 && value.periods.length <= 3 &&
    value.periods.every(period => record(period) && Number.isInteger(period.year_start) &&
      ["rupees", "thousands", "lakhs", "crores"].includes(period.unit as string) &&
      typeof period.comparable_to_prior === "boolean" && record(period.values));
}
function validWorkspace(value: unknown): value is WorkspaceResponse {
  if (!record(value) || typeof value.business_id !== "string" || !Number.isInteger(value.input_revision) || !validRequest(value.request)) return false;
  if (value.latest_analysis === null || value.latest_analysis === undefined) return true;
  return validResponse(value.latest_analysis, formFromRequest(value.request));
}
function validResponse(value: unknown, form: FormDraft): value is AnalysisResponse {
  if (!record(value) || value.rule_version !== "financial-rules-v1" || !Array.isArray(value.limitations) ||
      !value.limitations.every(item => typeof item === "string") || !Array.isArray(value.periods) || value.periods.length !== form.periods.length) return false;
  if (value.action_version == null) {
    if (value.actions !== undefined && (!Array.isArray(value.actions) || value.actions.length !== 0)) return false;
  } else if (value.action_version !== "preparation-actions-v1" || !Array.isArray(value.actions) || value.actions.length === 0 ||
      !value.actions.every(action => record(action) && typeof action.category === "string" && Object.hasOwn(ACTION_CATEGORIES, action.category) &&
        typeof action.code === "string" && action.code.length > 0 && typeof action.message === "string" && action.message.length > 0 &&
        Array.isArray(action.inputs) && action.inputs.length > 0 && action.inputs.every(input => record(input) && Number.isInteger(input.year_start) && field(input.field)) &&
        Array.isArray(action.targets) && action.targets.length > 0 && action.targets.every(target => record(target) && form.periods.some(period => period.yearStart === target.year_start) &&
          (target.indicator === "balance_check" || (typeof target.indicator === "string" && Object.hasOwn(INDICATORS, target.indicator)))))) return false;
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
