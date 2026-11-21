import {
  FINANCIAL_FIELDS,
  formFromRequest,
  isDocumentFigure,
  type FigureOrigin,
  type FigureSource,
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
  figure: { raw: string | null; reviewed: boolean; revision: number; origin: FigureOrigin; source?: FigureSource | null };
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
export type AnalysisRunSummary = {
  run_id: string; input_revision: number; rule_version: string;
  action_version?: string | null; superseded: boolean; created_at: string;
};
export type DocumentSummary = {
  id: string; business_id: string; filename: string; sha256: string;
  byte_size: number; page_count: number | null; extracted_char_count: number | null;
  status: "processing" | "ready" | "failed";
  error_code: string | null; error_message: string | null;
  created_at: string; updated_at: string;
};
export type CandidateIssueCode =
  | "missing_value"
  | "invalid_amount"
  | "ambiguous_mapping"
  | "missing_unit"
  | "conflicting_unit"
  | "missing_period"
  | "conflicting_period"
  | "missing_basis"
  | "conflicting_basis"
  | "duplicate_match"
  | "conflicting_match";

export type ExtractedTable = {
  table_index: number;
  rows: string[][];
};

export type ExtractedPage = {
  page_number: number;
  text: string;
  tables: ExtractedTable[];
  statement_title: string | null;
  basis: "standalone" | null;
  basis_context: string | null;
  period_context: string | null;
  unit: Unit | null;
  multiplier: number | null;
  unit_header: string | null;
  issues: string[];
};

export type ExtractedCandidate = {
  page_number: number;
  table_index: number;
  row_index: number;
  column_index: number;
  field: FinancialFieldKey | null;
  label: string;
  note: string | null;
  raw: string;
  source_row: string[];
  source_context: string[];
  period_header: string;
  period_context: string | null;
  year_start: number | null;
  unit_header: string | null;
  unit: Unit | null;
  multiplier: number | null;
  basis: "standalone" | null;
  basis_context: string | null;
  amount: string | null;
  normalized_inr: string | null;
  reviewed: false;
  issues: CandidateIssueCode[];
};

export type DocumentExtractionSnapshot = {
  schema_version: "document-extraction-v2";
  document_sha256: string;
  layout: "layout_a" | "unsupported";
  page_count: number;
  extracted_char_count: number;
  pages: ExtractedPage[];
  candidates: ExtractedCandidate[];
  issues: string[];
};

export type DocumentExtractionResponse = DocumentSummary & {
  extraction_status:
    | "ready"
    | "not_extracted"
    | "refresh_required"
    | "processing"
    | "failed"
    | "deletion_pending";
  extraction_message: string | null;
  extraction: DocumentExtractionSnapshot | null;
};

export type WorkspaceResponse = {
  business_id: string; input_revision: number;
  request: RequestPayload;
  latest_run_id: string | null; latest_analysis: AnalysisResponse | null;
  runs?: AnalysisRunSummary[];
  documents?: DocumentSummary[];
};
export type FinancialCitation = {
  citation_id: string;
  year_start: number;
  indicator: Indicator | "balance_check";
  label: string;
  state: EvidenceState;
  value_display: string | null;
  summary: string;
  origins: string[];
  reasons: string[];
  cited: boolean;
};
export type DocumentCitation = {
  citation_id: string;
  chunk_id: string;
  document_id: string;
  filename: string;
  page_number: number;
  section: string | null;
  period_years: number[];
  excerpt: string;
  score: number;
  cited: boolean;
};
export type QAResponse = {
  question: string;
  answer: string;
  mode: "ollama" | "fallback";
  model: string | null;
  fallback_reason: string | null;
  retrieval_status: "ok" | "no_documents" | "unavailable";
  retrieval_note: string | null;
  input_revision: number;
  rule_version: "financial-rules-v1";
  financial_citations: FinancialCitation[];
  document_citations: DocumentCitation[];
  limitations: string[];
};
export type ReportSummary = {
  report_id: string;
  business_id: string;
  report_version: number;
  input_revision: number;
  current_input_revision: number;
  rule_version: string;
  action_version?: string | null;
  superseded: boolean;
  superseded_reason: string | null;
  created_at: string;
};
export type ReportMissingEvidenceItem = {
  year_start: number;
  fields: FinancialFieldKey[];
  code: string;
  state: EvidenceState;
  message: string;
  affected_analyses: (Indicator | "balance_check")[];
};
export type ReportDocumentReference = {
  document_id: string | null;
  filename: string;
  pages: number[];
  detached: boolean;
};
export type PreparationReportResponse = ReportSummary & {
  report_schema_version: "preparation-report-v1";
  business_name: string;
  currency: "INR";
  basis: "standalone";
  inputs: RequestPayload;
  analysis: AnalysisResponse;
  missing_evidence: ReportMissingEvidenceItem[];
  documents_referenced: ReportDocumentReference[];
  limitations: string[];
};

export function documentFileUrl(businessId: string, documentId: string, pageNumber?: number): string {
  const base = `/api/businesses/${encodeURIComponent(businessId)}/documents/${encodeURIComponent(documentId)}/file`;
  return pageNumber !== undefined ? `${base}#page=${pageNumber}` : base;
}

export function analysisRequest(form: FormDraft): RequestPayload {
  return {
    business_name: form.businessName.trim(), currency: "INR", basis: "standalone",
    periods: form.periods.map(period => ({
      year_start: period.yearStart, unit: period.unit, comparable_to_prior: period.comparableToPrior,
      values: Object.fromEntries(FINANCIAL_FIELDS.map(({ key }) => {
        const figure = period.figures[key];
        if (isDocumentFigure(figure)) {
          return [key, {
            raw: figure.raw,
            reviewed: figure.reviewed,
            origin: "document" as const,
            source: figure.source!,
            revision: figure.revision ?? 1,
          }];
        }
        return [key, { raw: figure.raw, reviewed: Boolean(figure.raw.trim()) && figure.reviewed, origin: "manual" as const, revision: figure.revision ?? 1 }];
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

export async function updateWorkspace(businessId: string, expectedRevision: number, form: FormDraft): Promise<WorkspaceResponse> {
  const response = await fetch(`/api/businesses/${encodeURIComponent(businessId)}`, {
    method: "PUT", credentials: "same-origin", signal: AbortSignal.timeout(30000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...analysisRequest(form), expected_revision: expectedRevision }),
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

export async function fetchDocuments(businessId: string): Promise<DocumentSummary[]> {
  const response = await fetch(`/api/businesses/${encodeURIComponent(businessId)}/documents`, {
    credentials: "same-origin", signal: AbortSignal.timeout(30000),
  });
  if (response.status === 401) throw new Error("Your session expired. Sign in again.");
  if (!response.ok) throw new Error("Could not refresh document status.");
  const body: unknown = await response.json();
  if (!Array.isArray(body) || !body.every(validDocument)) throw new Error("The server returned invalid document status.");
  return body;
}

export async function uploadDocument(businessId: string, file: File): Promise<DocumentSummary> {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`/api/businesses/${encodeURIComponent(businessId)}/documents`, {
    method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(30000),
    body: formData,
  });
  return parseDocumentResponse(response);
}

export async function retryDocument(businessId: string, documentId: string): Promise<DocumentSummary> {
  const response = await fetch(`/api/businesses/${encodeURIComponent(businessId)}/documents/${encodeURIComponent(documentId)}/retry`, {
    method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(30000),
  });
  return parseDocumentResponse(response);
}

export async function fetchDocumentExtraction(businessId: string, documentId: string): Promise<DocumentExtractionResponse> {
  const response = await fetch(`/api/businesses/${encodeURIComponent(businessId)}/documents/${encodeURIComponent(documentId)}/extraction`, {
    credentials: "same-origin", signal: AbortSignal.timeout(30000),
  });
  return parseExtractionResponse(response);
}

export async function runDocumentExtraction(businessId: string, documentId: string): Promise<DocumentExtractionResponse> {
  const response = await fetch(`/api/businesses/${encodeURIComponent(businessId)}/documents/${encodeURIComponent(documentId)}/extract`, {
    method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(30000),
  });
  return parseExtractionResponse(response);
}

export async function deleteDocument(businessId: string, documentId: string): Promise<void> {
  const response = await fetch(`/api/businesses/${encodeURIComponent(businessId)}/documents/${encodeURIComponent(documentId)}`, {
    method: "DELETE", credentials: "same-origin", signal: AbortSignal.timeout(30000),
  });
  if (response.status === 401) throw new Error("Your session expired. Sign in again.");
  if (response.status === 404) throw new Error("Document not found.");
  if (!response.ok) {
    const msg = await extractDocumentError(response);
    throw new Error(msg ?? "Could not remove document.");
  }
}

export async function askWorkspaceQuestion(
  businessId: string,
  params: { question: string; year_start?: number | null; document_id?: string | null; top_k?: number },
  signal?: AbortSignal,
): Promise<QAResponse> {
  const timeout = AbortSignal.timeout(45000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(`/api/businesses/${encodeURIComponent(businessId)}/qa`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    signal: combined,
    body: JSON.stringify({
      question: params.question,
      ...(params.year_start != null ? { year_start: params.year_start } : {}),
      ...(params.document_id != null ? { document_id: params.document_id } : {}),
      ...(params.top_k != null ? { top_k: params.top_k } : {}),
    }),
  });
  if (response.status === 401) throw new Error("Your session expired. Sign in again.");
  if (response.status === 404) throw new Error("Workspace or document not found.");
  if (response.status === 422) throw new Error("Enter a question between 1 and 500 characters.");
  if (!response.ok) throw new Error("Q&A service is unavailable. Check that the local backend is running, then retry.");
  const body: unknown = await response.json();
  if (!validQAResponse(body)) throw new Error("The server returned an invalid Q&A payload.");
  return body;
}

export async function fetchReports(businessId: string): Promise<ReportSummary[]> {
  const response = await fetch(`/api/businesses/${encodeURIComponent(businessId)}/reports`, {
    credentials: "same-origin",
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 401) throw new Error("Your session expired. Sign in again.");
  if (response.status === 404) throw new Error("Workspace not found.");
  if (!response.ok) throw new Error("Could not load report history.");
  const body: unknown = await response.json();
  if (!Array.isArray(body) || !body.every(validReportSummary)) {
    throw new Error("The server returned an invalid report list.");
  }
  return body;
}

export async function generateReport(businessId: string): Promise<PreparationReportResponse> {
  const response = await fetch(`/api/businesses/${encodeURIComponent(businessId)}/reports`, {
    method: "POST",
    credentials: "same-origin",
    signal: AbortSignal.timeout(30000),
  });
  return parseReportResponse(response);
}

export async function fetchReport(
  businessId: string,
  reportId: string,
): Promise<PreparationReportResponse> {
  const response = await fetch(
    `/api/businesses/${encodeURIComponent(businessId)}/reports/${encodeURIComponent(reportId)}`,
    { credentials: "same-origin", signal: AbortSignal.timeout(30000) },
  );
  return parseReportResponse(response);
}

async function parseReportResponse(response: Response): Promise<PreparationReportResponse> {
  if (response.status === 401) throw new Error("Your session expired. Sign in again.");
  if (response.status === 404) throw new Error("Workspace or report not found.");
  if (!response.ok) throw new Error("Report service is unavailable. Check that the local backend is running, then retry.");
  const body: unknown = await response.json();
  if (!validPreparationReport(body)) throw new Error("The server returned an invalid report payload.");
  return body;
}

async function extractDocumentError(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (record(body) && record(body.detail) && typeof body.detail.message === "string") {
      return body.detail.message;
    }
    if (record(body) && typeof body.detail === "string") {
      return body.detail;
    }
  } catch {
    // ignore non-json error body
  }
  return null;
}

async function parseDocumentResponse(response: Response): Promise<DocumentSummary> {
  if (response.status === 401) throw new Error("Your session expired. Sign in again.");
  if (response.status === 404) throw new Error("Workspace or document not found.");
  if (!response.ok) {
    const msg = await extractDocumentError(response);
    if (msg) throw new Error(msg);
    if (response.status === 413) throw new Error("PDF exceeds the 20 MB maximum file size limit.");
    if (response.status === 415) throw new Error("Only PDF files (.pdf) are supported.");
    if (response.status === 409) throw new Error("Another PDF processing job is already active; wait for it to finish or retry it.");
    throw new Error("Document processing is unavailable. Check the file and try again.");
  }
  const body: unknown = await response.json();
  if (!validDocument(body)) throw new Error("The server returned an invalid document payload.");
  return body;
}

async function parseExtractionResponse(response: Response): Promise<DocumentExtractionResponse> {
  if (response.status === 401) throw new Error("Your session expired. Sign in again.");
  if (response.status === 404) throw new Error("Workspace or document not found.");
  if (!response.ok) {
    const msg = await extractDocumentError(response);
    if (msg) throw new Error(msg);
    if (response.status === 409) throw new Error("Another PDF processing job is already active; wait for it to finish.");
    throw new Error("Could not load PDF extraction details.");
  }
  const body: unknown = await response.json();
  if (!validExtractionResponse(body)) throw new Error("The server returned an invalid extraction payload.");
  return body;
}

async function parseWorkspace(response: Response): Promise<WorkspaceResponse> {
  if (response.status === 401) throw new Error("Your session expired. Sign in again.");
  if (response.status === 404) throw new Error("Workspace not found.");
  if (response.status === 409) throw new Error("Workspace has been updated in another session; reload before saving.");
  if (response.status === 422) {
    const msg = await extractDocumentError(response);
    throw new Error(msg ?? "The server rejected these entries. Check the business, completed years, and amount format.");
  }
  if (!response.ok) throw new Error("Workspace service is unavailable. Check that the local backend and database are running.");
  const body: unknown = await response.json();
  if (!validWorkspace(body)) throw new Error("The server returned an invalid workspace payload.");
  return body;
}

const decimal = (value: unknown): value is string => typeof value === "string" && /^[+-]?\d+(\.\d+)?$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const state = (value: unknown) => ["Supported", "Needs review", "Not assessed", "Not meaningful"].includes(value as string);
const field = (value: unknown) => FINANCIAL_FIELDS.some(item => item.key === value);
function validFigureSource(value: unknown): value is FigureSource {
  return record(value) &&
    (value.document_id === null || (typeof value.document_id === "string" && value.document_id.length > 0)) &&
    typeof value.filename === "string" && value.filename.length > 0 &&
    Number.isInteger(value.page_number) && Number(value.page_number) >= 1 && Number(value.page_number) <= 50 &&
    Number.isInteger(value.table_index) && Number(value.table_index) >= 1 && Number(value.table_index) <= 10 &&
    Number.isInteger(value.row_index) && Number(value.row_index) >= 2 && Number(value.row_index) <= 250 &&
    Number.isInteger(value.column_index) && Number(value.column_index) >= 2 && Number(value.column_index) <= 16 &&
    typeof value.label === "string" && value.label.length > 0 &&
    typeof value.raw_token === "string" && value.raw_token.length > 0;
}
function validFigureValue(value: unknown): boolean {
  if (!record(value)) return false;
  if (!(value.raw === null || typeof value.raw === "string")) return false;
  if (typeof value.reviewed !== "boolean") return false;
  if (!Number.isInteger(value.revision) || Number(value.revision) <= 0) return false;
  if (value.origin === "manual") return value.source === undefined || value.source === null;
  if (value.origin === "document") return validFigureSource(value.source);
  return false;
}
function reasons(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => record(item) && typeof item.code === "string" && typeof item.message === "string" && Array.isArray(item.fields) && item.fields.every(field));
}
function inputs(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => record(item) && Number.isInteger(item.year_start) && field(item.field) &&
    ["rupees", "thousands", "lakhs", "crores"].includes(item.unit as string) && validFigureValue(item.figure) &&
    (item.normalized_inr === null || decimal(item.normalized_inr)));
}
function validRequest(value: unknown): value is RequestPayload {
  return record(value) && typeof value.business_name === "string" && value.business_name.trim().length > 0 &&
    value.currency === "INR" && value.basis === "standalone" && Array.isArray(value.periods) &&
    value.periods.length >= 1 && value.periods.length <= 3 &&
    value.periods.every(period => record(period) && Number.isInteger(period.year_start) &&
      ["rupees", "thousands", "lakhs", "crores"].includes(period.unit as string) &&
      typeof period.comparable_to_prior === "boolean" && record(period.values) &&
      Object.entries(period.values).every(([key, fig]) => field(key) && validFigureValue(fig)));
}
function validRuns(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(run => record(run) &&
    typeof run.run_id === "string" && run.run_id.length > 0 &&
    Number.isInteger(run.input_revision) && Number(run.input_revision) > 0 &&
    typeof run.rule_version === "string" && run.rule_version.length > 0 &&
    (run.action_version === undefined || run.action_version === null || typeof run.action_version === "string") &&
    typeof run.superseded === "boolean" && typeof run.created_at === "string" && run.created_at.length > 0));
}
function validDocument(value: unknown): value is DocumentSummary {
  return record(value) && typeof value.id === "string" && value.id.length > 0 &&
    typeof value.business_id === "string" && value.business_id.length > 0 &&
    typeof value.filename === "string" && value.filename.length > 0 &&
    typeof value.sha256 === "string" && value.sha256.length === 64 &&
    Number.isInteger(value.byte_size) && Number(value.byte_size) > 0 &&
    (value.page_count === null || (Number.isInteger(value.page_count) && Number(value.page_count) >= 1 && Number(value.page_count) <= 50)) &&
    (value.extracted_char_count === null || (Number.isInteger(value.extracted_char_count) && Number(value.extracted_char_count) >= 0)) &&
    ["processing", "ready", "failed"].includes(value.status as string) &&
    (value.error_code === null || typeof value.error_code === "string") &&
    (value.error_message === null || typeof value.error_message === "string") &&
    typeof value.created_at === "string" && typeof value.updated_at === "string";
}
function validDocuments(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(validDocument));
}
function validExtractionSnapshot(value: unknown): value is DocumentExtractionSnapshot {
  if (!record(value) || value.schema_version !== "document-extraction-v2" ||
      typeof value.document_sha256 !== "string" || value.document_sha256.length !== 64 ||
      !["layout_a", "unsupported"].includes(value.layout as string) ||
      !Number.isInteger(value.page_count) || Number(value.page_count) < 1 || Number(value.page_count) > 50 ||
      !Number.isInteger(value.extracted_char_count) || Number(value.extracted_char_count) < 1 ||
      !Array.isArray(value.pages) || value.pages.length !== value.page_count ||
      !Array.isArray(value.candidates) || !Array.isArray(value.issues)) return false;
  const pagesOk = value.pages.every(page => record(page) &&
    Number.isInteger(page.page_number) && Number(page.page_number) >= 1 &&
    typeof page.text === "string" && Array.isArray(page.tables) &&
    page.tables.every(table => record(table) && Number.isInteger(table.table_index) &&
      Array.isArray(table.rows) && table.rows.every(row => Array.isArray(row) && row.every(cell => typeof cell === "string"))));
  const candidatesOk = value.candidates.every(candidate => record(candidate) &&
    Number.isInteger(candidate.page_number) && Number.isInteger(candidate.table_index) &&
    Number.isInteger(candidate.row_index) && Number.isInteger(candidate.column_index) &&
    (candidate.field === null || field(candidate.field)) &&
    typeof candidate.label === "string" && typeof candidate.raw === "string" &&
    Array.isArray(candidate.source_row) && Array.isArray(candidate.issues) &&
    candidate.reviewed === false &&
    (candidate.amount === null || decimal(candidate.amount)) &&
    (candidate.normalized_inr === null || decimal(candidate.normalized_inr)));
  return pagesOk && candidatesOk;
}
function validExtractionResponse(value: unknown): value is DocumentExtractionResponse {
  if (!validDocument(value)) return false;
  const raw = value as Record<string, unknown>;
  if (!["ready", "not_extracted", "refresh_required", "processing", "failed", "deletion_pending"].includes(raw.extraction_status as string)) return false;
  if (!(raw.extraction_message === null || typeof raw.extraction_message === "string")) return false;
  if (raw.extraction_status === "ready") return validExtractionSnapshot(raw.extraction);
  return raw.extraction === null;
}
function validFinancialCitation(value: unknown): value is FinancialCitation {
  return record(value) &&
    typeof value.citation_id === "string" && /^F[1-9][0-9]*$/.test(value.citation_id) &&
    Number.isInteger(value.year_start) &&
    (value.indicator === "balance_check" || (typeof value.indicator === "string" && Object.hasOwn(INDICATORS, value.indicator))) &&
    typeof value.label === "string" && value.label.length > 0 &&
    state(value.state) &&
    (value.value_display === null || typeof value.value_display === "string") &&
    typeof value.summary === "string" && value.summary.length > 0 &&
    Array.isArray(value.origins) && value.origins.every(item => typeof item === "string") &&
    Array.isArray(value.reasons) && value.reasons.every(item => typeof item === "string") &&
    typeof value.cited === "boolean";
}
function validDocumentCitation(value: unknown): value is DocumentCitation {
  return record(value) &&
    typeof value.citation_id === "string" && /^D[1-9][0-9]*$/.test(value.citation_id) &&
    typeof value.chunk_id === "string" && value.chunk_id.length > 0 &&
    typeof value.document_id === "string" && value.document_id.length > 0 &&
    typeof value.filename === "string" && value.filename.length > 0 &&
    Number.isInteger(value.page_number) && Number(value.page_number) >= 1 && Number(value.page_number) <= 50 &&
    (value.section === null || typeof value.section === "string") &&
    Array.isArray(value.period_years) && value.period_years.every(y => Number.isInteger(y)) &&
    typeof value.excerpt === "string" && value.excerpt.length > 0 &&
    typeof value.score === "number" && Number.isFinite(value.score) &&
    typeof value.cited === "boolean";
}
function validQAResponse(value: unknown): value is QAResponse {
  return record(value) &&
    typeof value.question === "string" && value.question.length > 0 &&
    typeof value.answer === "string" && value.answer.length > 0 &&
    (value.mode === "ollama" || value.mode === "fallback") &&
    (value.model === null || typeof value.model === "string") &&
    (value.fallback_reason === null || typeof value.fallback_reason === "string") &&
    ["ok", "no_documents", "unavailable"].includes(value.retrieval_status as string) &&
    (value.retrieval_note === null || typeof value.retrieval_note === "string") &&
    Number.isInteger(value.input_revision) && Number(value.input_revision) > 0 &&
    value.rule_version === "financial-rules-v1" &&
    Array.isArray(value.financial_citations) && value.financial_citations.every(validFinancialCitation) &&
    Array.isArray(value.document_citations) && value.document_citations.every(validDocumentCitation) &&
    Array.isArray(value.limitations) && value.limitations.every(item => typeof item === "string");
}
function validReportSummary(value: unknown): value is ReportSummary {
  return record(value) &&
    typeof value.report_id === "string" && value.report_id.length > 0 &&
    typeof value.business_id === "string" && value.business_id.length > 0 &&
    Number.isInteger(value.report_version) && Number(value.report_version) > 0 &&
    Number.isInteger(value.input_revision) && Number(value.input_revision) > 0 &&
    Number.isInteger(value.current_input_revision) && Number(value.current_input_revision) > 0 &&
    typeof value.rule_version === "string" && value.rule_version.length > 0 &&
    (value.action_version === undefined || value.action_version === null || typeof value.action_version === "string") &&
    typeof value.superseded === "boolean" &&
    (value.superseded_reason === null || typeof value.superseded_reason === "string") &&
    typeof value.created_at === "string" && value.created_at.length > 0;
}
function validPreparationReport(value: unknown): value is PreparationReportResponse {
  if (!validReportSummary(value)) return false;
  const raw = value as Record<string, unknown>;
  if (
    raw.report_schema_version !== "preparation-report-v1" ||
    typeof raw.business_name !== "string" || raw.business_name.trim().length === 0 ||
    raw.currency !== "INR" || raw.basis !== "standalone" ||
    !validRequest(raw.inputs) ||
    !validResponse(raw.analysis, formFromRequest(raw.inputs)) ||
    !Array.isArray(raw.missing_evidence) ||
    !Array.isArray(raw.documents_referenced) ||
    !Array.isArray(raw.limitations) || !raw.limitations.every(item => typeof item === "string")
  ) return false;
  const missingOk = raw.missing_evidence.every(item => record(item) &&
    Number.isInteger(item.year_start) &&
    Array.isArray(item.fields) && item.fields.every(field) &&
    typeof item.code === "string" && item.code.length > 0 &&
    state(item.state) && typeof item.message === "string" && item.message.length > 0 &&
    Array.isArray(item.affected_analyses) && item.affected_analyses.every(target =>
      target === "balance_check" || (typeof target === "string" && Object.hasOwn(INDICATORS, target))));
  const docsOk = raw.documents_referenced.every(item => record(item) &&
    (item.document_id === null || (typeof item.document_id === "string" && item.document_id.length > 0)) &&
    typeof item.filename === "string" && item.filename.length > 0 &&
    Array.isArray(item.pages) && item.pages.every(p => Number.isInteger(p) && Number(p) >= 1 && Number(p) <= 50) &&
    typeof item.detached === "boolean");
  return missingOk && docsOk;
}
function validWorkspace(value: unknown): value is WorkspaceResponse {
  if (!record(value) || typeof value.business_id !== "string" || !Number.isInteger(value.input_revision) || !validRequest(value.request) || !validRuns(value.runs) || !validDocuments(value.documents)) return false;
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
