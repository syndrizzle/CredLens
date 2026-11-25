import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalysisResults } from "../src/features/analysis/AnalysisResults";
import { SourceReview } from "../src/features/documents/SourceReview";
import { WorkspaceQA } from "../src/features/qa/WorkspaceQA";
import { PreparationReportSheet } from "../src/features/reports/PreparationReport";
import {
  analysisRequest,
  displayDecimal,
  fetchAnalysis,
  type AnalysisResponse,
} from "../src/features/analysis/api";
import {
  createExampleForm,
  type FormDraft,
} from "../src/features/manual-entry/model";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
function reviewed() {
  const form = createExampleForm();
  for (const period of form.periods)
    for (const figure of Object.values(period.figures)) figure.reviewed = true;
  return form;
}
function engine(form: FormDraft): AnalysisResponse {
  const python =
    process.platform === "win32"
      ? "backend/.venv/Scripts/python.exe"
      : "backend/.venv/bin/python";
  const result = Bun.spawnSync(
    [
      python,
      "-c",
      "import json,sys; from app.schemas.financial import AnalysisRequest; from app.analysis import analyse; print(analyse(AnalysisRequest.model_validate(json.load(sys.stdin))).model_dump_json())",
    ],
    {
      env: { ...Bun.env, PYTHONPATH: "backend" },
      stdin: new TextEncoder().encode(JSON.stringify(analysisRequest(form))),
    },
  );
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}
function respond(body: unknown, status = 200) {
  globalThis.fetch = (async () =>
    Response.json(body, { status })) as typeof fetch;
}

describe("decimal display", () => {
  for (const [raw, expected] of [
    ["0", "0.00"],
    ["1.005", "1.01"],
    ["-1.005", "-1.01"],
    ["999.999", "1000.00"],
    ["-0.0049", "0.00"],
    ["9999999999999999900000", "9999999999999999900000.00"],
  ]) {
    test(raw!, () => expect(displayDecimal(raw!)).toBe(expected!));
  }
});

test("transport preserves raw text, zero, missing, confirmation, and revisions without mutation", () => {
  const form = reviewed();
  form.periods[0]!.figures.interest_expense = { raw: "  ", reviewed: false };
  form.periods[1]!.figures.revenue = {
    raw: " +12000000.00 ",
    reviewed: false,
    revision: 2,
  };
  form.periods[1]!.figures.current_maturities.raw = "0";
  const before = JSON.stringify(form);
  const request = analysisRequest(form);
  expect(request.periods[0]!.values.interest_expense.raw).toBe("  ");
  expect(request.periods[1]!.values.revenue).toEqual({
    raw: " +12000000.00 ",
    reviewed: false,
    revision: 2,
    origin: "manual",
  });
  expect(request.periods[1]!.values.current_maturities.raw).toBe("0");
  expect(JSON.stringify(form)).toBe(before);
});

test("real Python response passes transport guard and renders all indicators with evidence", async () => {
  const form = reviewed();
  const data = engine(form);
  respond(data);
  const signal = new AbortController().signal;
  const output = await fetchAnalysis(form, signal);
  const html = renderToStaticMarkup(
    <AnalysisResults data={output} businessName={form.businessName} />,
  );
  expect(html).toContain("20.00%");
  expect(html).toContain("3.00x");
  expect(html).toContain("INR 2500000.00");
  expect(html).toContain("Manual entry");
  expect(html).toContain("Revision 1");
  expect(html).toContain("financial-rules-v1");
  expect(html.match(/Inputs and manual origin/g)).toHaveLength(12);
});

test("missing interest blocks coverage only; restoring it refreshes results", () => {
  const form = reviewed();
  form.periods[1]!.figures.interest_expense = { raw: "", reviewed: false };
  const findings = engine(form).periods[1]!.indicators;
  expect(findings.filter((item) => item.state === "Supported")).toHaveLength(5);
  expect(
    findings.find((item) => item.indicator === "interest_coverage")!.state,
  ).toBe("Not assessed");
  form.periods[1]!.figures.interest_expense = {
    raw: "400000",
    reviewed: true,
    revision: 2,
  };
  expect(
    displayDecimal(engine(form).periods[1]!.indicators.at(-1)!.value!),
  ).toBe("3.00");
});

test("controlled variants render one-year growth, zero denominators, and non-positive equity explanations", () => {
  const form = reviewed();
  form.periods.shift();
  const current = form.periods[0]!;
  current.comparableToPrior = false;
  current.figures.revenue.raw = "0";
  current.figures.interest_expense.raw = "0";
  current.figures.current_liabilities.raw = "0";
  current.figures.total_equity.raw = "0";
  current.figures.total_liabilities.raw = "12000000.00";
  const output = engine(form);
  const byKey = Object.fromEntries(
    output.periods[0]!.indicators.map((item) => [item.indicator, item]),
  );
  expect(byKey.revenue_growth!.state).toBe("Not assessed");
  expect(byKey.net_profit_margin!.state).toBe("Not meaningful");
  expect(byKey.working_capital!.state).toBe("Supported");
  expect(displayDecimal(byKey.working_capital!.value!)).toBe("5000000.00");
  expect(byKey.current_ratio!.state).toBe("Not meaningful");
  expect(byKey.debt_to_equity!.state).toBe("Not meaningful");
  expect(byKey.interest_coverage!.state).toBe("Not meaningful");
  const html = renderToStaticMarkup(
    <AnalysisResults data={output} businessName={form.businessName} />,
  );
  expect(html).toContain(
    "Supply the immediately preceding financial year starting 2023.",
  );
  expect(html).toContain(
    "Revenue must be positive for this ratio to be meaningful.",
  );
  expect(html).toContain(
    "Current liabilities must be positive for this ratio to be meaningful.",
  );
  expect(html).toContain(
    "Total equity must be positive for this ratio to be meaningful.",
  );
  expect(html).toContain(
    "Interest expense must be positive for this ratio to be meaningful.",
  );
  expect(html).not.toContain("Infinity");
});

test("errors retain the draft and a subsequent retry succeeds", async () => {
  const form = reviewed();
  const before = JSON.stringify(form);
  respond({}, 503);
  await expect(
    fetchAnalysis(form, new AbortController().signal),
  ).rejects.toThrow("unavailable");
  respond({}, 422);
  await expect(
    fetchAnalysis(form, new AbortController().signal),
  ).rejects.toThrow("rejected");
  globalThis.fetch = (async () => {
    throw new TypeError("Network unavailable");
  }) as typeof fetch;
  await expect(
    fetchAnalysis(form, new AbortController().signal),
  ).rejects.toThrow();
  respond(engine(form));
  expect(
    (await fetchAnalysis(form, new AbortController().signal)).periods,
  ).toHaveLength(2);
  expect(JSON.stringify(form)).toBe(before);
});

test("rejects malformed responses instead of displaying partial findings", async () => {
  const form = reviewed();
  const data = engine(form);
  for (const bad of [
    null,
    {},
    { ...data, periods: [] },
    { ...data, periods: [data.periods[0], data.periods[0]] },
    {
      ...data,
      periods: [{ ...data.periods[0], balance_check: null }, data.periods[1]],
    },
  ]) {
    respond(bad);
    await expect(
      fetchAnalysis(form, new AbortController().signal),
    ).rejects.toThrow("incomplete");
  }
});

test("forwards cancellation signal to fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = (async (_url, init) => {
    expect(init!.signal!.aborted).toBe(true);
    init!.signal!.throwIfAborted();
  }) as typeof fetch;
  await expect(fetchAnalysis(reviewed(), controller.signal)).rejects.toThrow();
});

test("workspace and auth client handles round-trip, auth errors, and cross-owner 404s", async () => {
  const {
    analyseWorkspace,
    fetchBusinesses,
    fetchSession,
    fetchWorkspace,
    saveWorkspace,
    submitCredentials,
  } = await import("../src/features/analysis/api");
  const { formFromRequest } =
    await import("../src/features/manual-entry/model");

  const form = reviewed();
  const payload = analysisRequest(form);
  const roundTripped = formFromRequest(payload);
  expect(analysisRequest(roundTripped)).toEqual(payload);

  respond({ detail: "Authentication required" }, 401);
  expect(await fetchSession()).toBeNull();
  await expect(
    submitCredentials("login", "user@example.com", "wrong-password-123"),
  ).rejects.toThrow("Invalid email or password.");
  await expect(fetchBusinesses()).rejects.toThrow("expired");

  respond({ detail: "Account already exists" }, 409);
  await expect(
    submitCredentials("register", "user@example.com", "valid-password-123"),
  ).rejects.toThrow("already exists");

  respond({ detail: "Business not found" }, 404);
  await expect(
    fetchWorkspace("00000000-0000-0000-0000-000000000000"),
  ).rejects.toThrow("Workspace not found.");

  const analysis = engine(form);
  respond(
    {
      business_id: "11111111-1111-1111-1111-111111111111",
      input_revision: 1,
      request: payload,
      latest_run_id: "22222222-2222-2222-2222-222222222222",
      latest_analysis: analysis,
    },
    201,
  );
  const saved = await saveWorkspace(form);
  expect(saved.business_id).toBe("11111111-1111-1111-1111-111111111111");
  expect(saved.latest_analysis?.periods).toHaveLength(2);
  const analysed = await analyseWorkspace(saved.business_id);
  expect(analysed.latest_run_id).toBe("22222222-2222-2222-2222-222222222222");
});

test("logout rejects server and network failures so callers cannot report success", async () => {
  const { signOut } = await import("../src/features/analysis/api");
  respond({ detail: "Database unavailable" }, 503);
  await expect(signOut()).rejects.toThrow("session may still be active");
  globalThis.fetch = (async () => {
    throw new TypeError("offline");
  }) as typeof fetch;
  await expect(signOut()).rejects.toThrow("offline");
  respond({ status: "signed_out" });
  await expect(signOut()).resolves.toBeUndefined();
});

test("preparation actions render in server order with links to the affected evidence", async () => {
  const form = reviewed();
  form.periods[1]!.figures.current_assets.reviewed = false;
  form.periods[1]!.figures.interest_expense.raw = "";
  form.periods[1]!.figures.interest_expense.reviewed = false;
  const data = engine(form);
  respond(data);
  const result = await fetchAnalysis(form, new AbortController().signal);
  const html = renderToStaticMarkup(
    <AnalysisResults data={result} businessName={form.businessName} />,
  );
  expect(html).toContain("Preparation actions");
  expect(html).toContain("preparation-actions-v1");
  expect(html.indexOf("Review current assets")).toBeLessThan(
    html.indexOf("Supply interest expense"),
  );
  expect(html).toContain("not a credit-risk ranking");
  expect(html).toContain(
    "wrongly labelled unit cannot be detected automatically",
  );
  for (const action of result.actions!)
    for (const target of action.targets) {
      const id = `finding-${target.year_start}-${target.indicator}`;
      expect(html).toContain(`href="#${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
  const currentAssets = result.actions!.filter(
    (action) =>
      action.code === "unreviewed" &&
      action.inputs.some((input) => input.field === "current_assets"),
  );
  expect(currentAssets).toHaveLength(1);
  expect(currentAssets[0]!.targets.map((target) => target.indicator)).toEqual([
    "working_capital",
    "current_ratio",
  ]);
});

test("legacy analysis remains readable and asks for re-analysis; malformed actions are rejected", async () => {
  const form = reviewed();
  const data = engine(form);
  const { actions, action_version: _actionVersion, ...legacy } = data;
  respond(legacy);
  const result = await fetchAnalysis(form, new AbortController().signal);
  const html = renderToStaticMarkup(
    <AnalysisResults data={result} businessName={form.businessName} />,
  );
  expect(html).toContain("predates the preparation action list");
  expect(html).toContain("Analyse the saved workspace again");
  expect(html).toContain("20.00%");
  for (const malformed of [
    { ...data, actions: [] },
    { ...data, action_version: "unknown" },
    { ...data, action_version: null },
    { ...data, actions: [{ ...actions![0], category: "credit_score" }] },
    {
      ...data,
      actions: [
        { ...actions![0], inputs: [{ year_start: 2023, field: "unknown" }] },
      ],
    },
    {
      ...data,
      actions: [
        {
          ...actions![0],
          targets: [{ year_start: 9999, indicator: "current_ratio" }],
        },
      ],
    },
  ]) {
    respond(malformed);
    await expect(
      fetchAnalysis(form, new AbortController().signal),
    ).rejects.toThrow("incomplete analysis");
  }
});

test("updateWorkspace sends expected_revision, handles 409 conflicts, validates run history, and renders supersession", async () => {
  const { updateWorkspace } = await import("../src/features/analysis/api");
  const form = reviewed();
  form.periods[1]!.figures.interest_expense = {
    raw: "300000.00",
    reviewed: true,
    revision: 2,
  };
  const payload = analysisRequest(form);
  const analysis = engine(form);

  let sentMethod = "";
  let sentBody: Record<string, unknown> = {};
  globalThis.fetch = (async (_url, init) => {
    sentMethod = init?.method ?? "";
    sentBody = JSON.parse(String(init?.body));
    return Response.json({
      business_id: "11111111-1111-1111-1111-111111111111",
      input_revision: 2,
      request: payload,
      latest_run_id: null,
      latest_analysis: null,
      runs: [
        {
          run_id: "22222222-2222-2222-2222-222222222222",
          input_revision: 1,
          rule_version: "financial-rules-v1",
          action_version: "preparation-actions-v1",
          superseded: true,
          created_at: "2026-11-12T10:00:00Z",
        },
      ],
    });
  }) as typeof fetch;

  const updated = await updateWorkspace(
    "11111111-1111-1111-1111-111111111111",
    1,
    form,
  );
  expect(sentMethod).toBe("PUT");
  expect(sentBody.expected_revision).toBe(1);
  expect(updated.input_revision).toBe(2);
  expect(updated.latest_analysis).toBeNull();
  expect(updated.runs?.[0]?.superseded).toBe(true);

  respond(
    {
      detail:
        "Workspace has been updated in another session; reload before saving",
    },
    409,
  );
  await expect(
    updateWorkspace("11111111-1111-1111-1111-111111111111", 1, form),
  ).rejects.toThrow("updated in another session");

  respond({
    business_id: "11111111-1111-1111-1111-111111111111",
    input_revision: 2,
    request: payload,
    latest_run_id: null,
    latest_analysis: null,
    runs: [{ run_id: "", input_revision: 0, superseded: "yes" }],
  });
  await expect(
    updateWorkspace("11111111-1111-1111-1111-111111111111", 1, form),
  ).rejects.toThrow("invalid workspace payload");

  const html = renderToStaticMarkup(
    <AnalysisResults
      data={analysis}
      businessName={form.businessName}
      inputRevision={2}
      runs={[
        {
          run_id: "33333333-3333-3333-3333-333333333333",
          input_revision: 2,
          rule_version: "financial-rules-v1",
          action_version: "preparation-actions-v1",
          superseded: false,
          created_at: "2026-11-12T10:05:00Z",
        },
        {
          run_id: "22222222-2222-2222-2222-222222222222",
          input_revision: 1,
          rule_version: "financial-rules-v1",
          action_version: "preparation-actions-v1",
          superseded: true,
          created_at: "2026-11-12T10:00:00Z",
        },
      ]}
    />,
  );
  expect(html).toContain("Input revision 2 (current)");
  expect(html).toContain(
    "Supersedes 1 earlier analysis run (Rev 1 marked superseded).",
  );
  expect(html).toContain("Revision 2");
  expect(html).toContain("4.00x");
});

test("document client uploads, retries, deletes, surfaces validation errors, and guards document payloads", async () => {
  const {
    deleteDocument,
    fetchDocuments,
    fetchWorkspace,
    retryDocument,
    uploadDocument,
  } = await import("../src/features/analysis/api");
  const form = reviewed();
  const payload = analysisRequest(form);
  const validDoc = {
    id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    business_id: "11111111-1111-1111-1111-111111111111",
    filename: "FY24_Statement.pdf",
    sha256: "a".repeat(64),
    byte_size: 24576,
    page_count: 4,
    extracted_char_count: 1420,
    status: "ready" as const,
    error_code: null,
    error_message: null,
    created_at: "2026-11-17T10:00:00Z",
    updated_at: "2026-11-17T10:00:01Z",
  };

  respond(validDoc, 201);
  const file = new File(["%PDF-1.4 sample"], "FY24_Statement.pdf", {
    type: "application/pdf",
  });
  const uploaded = await uploadDocument(
    "11111111-1111-1111-1111-111111111111",
    file,
  );
  expect(uploaded).toEqual(validDoc);

  const failed = {
    ...validDoc,
    status: "failed",
    page_count: null,
    extracted_char_count: null,
    error_code: "parser_timeout",
    error_message: "Processing timed out.",
  };
  respond(failed, 201);
  expect((await uploadDocument(validDoc.business_id, file)).status).toBe(
    "failed",
  );
  respond([failed]);
  expect(await fetchDocuments(validDoc.business_id)).toEqual([failed]);
  respond([{ ...failed, status: "invalid" }]);
  await expect(fetchDocuments(validDoc.business_id)).rejects.toThrow(
    "invalid document status",
  );

  respond(
    {
      detail: {
        code: "scanned_only_pdf",
        message:
          "Scanned or image-only PDFs without selectable digital text are not supported.",
      },
    },
    422,
  );
  await expect(
    uploadDocument("11111111-1111-1111-1111-111111111111", file),
  ).rejects.toThrow("Scanned or image-only PDFs");

  respond(
    {
      detail: {
        code: "active_job_exists",
        message:
          "Another PDF processing job is already active; wait for it to finish or retry it.",
      },
    },
    409,
  );
  await expect(
    uploadDocument("11111111-1111-1111-1111-111111111111", file),
  ).rejects.toThrow("already active");

  respond(validDoc, 200);
  const retried = await retryDocument(
    "11111111-1111-1111-1111-111111111111",
    validDoc.id,
  );
  expect(retried.status).toBe("ready");

  respond({ status: "deleted" }, 200);
  await expect(
    deleteDocument("11111111-1111-1111-1111-111111111111", validDoc.id),
  ).resolves.toBeUndefined();

  respond({
    business_id: "11111111-1111-1111-1111-111111111111",
    input_revision: 1,
    request: payload,
    latest_run_id: null,
    latest_analysis: null,
    documents: [{ ...validDoc, status: "unknown" }],
  });
  await expect(
    fetchWorkspace("11111111-1111-1111-1111-111111111111"),
  ).rejects.toThrow("invalid workspace payload");
});

test("extraction client validates snapshots, runs extraction, and renders SourceReview + document-origin AnalysisResults", async () => {
  const { fetchDocumentExtraction, runDocumentExtraction } =
    await import("../src/features/analysis/api");
  const { formFromRequest } =
    await import("../src/features/manual-entry/model");

  const docId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
  const bizId = "11111111-1111-1111-1111-111111111111";
  const extractionPayload = {
    id: docId,
    business_id: bizId,
    filename: "aster-reference.pdf",
    sha256: "a".repeat(64),
    byte_size: 24576,
    page_count: 2,
    extracted_char_count: 1420,
    status: "ready" as const,
    error_code: null,
    error_message: null,
    created_at: "2026-11-20T10:00:00Z",
    updated_at: "2026-11-20T10:00:01Z",
    extraction_status: "ready" as const,
    extraction_message: null,
    extraction: {
      schema_version: "document-extraction-v2" as const,
      document_sha256: "a".repeat(64),
      layout: "layout_a" as const,
      page_count: 2,
      extracted_char_count: 1420,
      issues: [],
      pages: [
        {
          page_number: 1,
          text: "Statement of Profit and Loss (Standalone, INR in Rupees)",
          statement_title: "Statement of Profit and Loss",
          basis: "standalone" as const,
          basis_context: "Standalone",
          period_context: "FY 2024-25",
          unit: "rupees" as const,
          multiplier: 1,
          unit_header: "INR in Rupees",
          issues: [],
          tables: [
            {
              table_index: 1,
              rows: [
                ["Particulars", "FY 2024-25"],
                ["Revenue from operations", "1,20,00,000.00"],
                ["Interest expense", "-"],
              ],
            },
          ],
        },
        {
          page_number: 2,
          text: "Balance Sheet",
          statement_title: "Balance Sheet",
          basis: "standalone" as const,
          basis_context: "Standalone",
          period_context: "As at 31 March 2025",
          unit: "rupees" as const,
          multiplier: 1,
          unit_header: "INR in Rupees",
          issues: [],
          tables: [],
        },
      ],
      candidates: [
        {
          page_number: 1,
          table_index: 1,
          row_index: 2,
          column_index: 2,
          field: "revenue" as const,
          label: "Revenue from operations",
          note: null,
          raw: "1,20,00,000.00",
          source_row: ["Revenue from operations", "1,20,00,000.00"],
          source_context: ["Statement of Profit and Loss"],
          period_header: "FY 2024-25",
          period_context: "FY 2024-25",
          year_start: 2024,
          unit_header: "INR in Rupees",
          unit: "rupees" as const,
          multiplier: 1,
          basis: "standalone" as const,
          basis_context: "Standalone",
          amount: "12000000.00",
          normalized_inr: "12000000.00",
          reviewed: false as const,
          issues: [],
        },
        {
          page_number: 1,
          table_index: 1,
          row_index: 3,
          column_index: 2,
          field: "interest_expense" as const,
          label: "Interest expense",
          note: null,
          raw: "-",
          source_row: ["Interest expense", "-"],
          source_context: ["Statement of Profit and Loss"],
          period_header: "FY 2024-25",
          period_context: "FY 2024-25",
          year_start: 2024,
          unit_header: "INR in Rupees",
          unit: "rupees" as const,
          multiplier: 1,
          basis: "standalone" as const,
          basis_context: "Standalone",
          amount: null,
          normalized_inr: null,
          reviewed: false as const,
          issues: ["missing_value" as const],
        },
      ],
    },
  };

  respond(extractionPayload);
  const fetched = await fetchDocumentExtraction(bizId, docId);
  expect(fetched.extraction?.candidates).toHaveLength(2);

  respond({
    ...extractionPayload,
    extraction_status: "refresh_required",
    extraction_message: "Run extraction again.",
    extraction: null,
  });
  const stale = await fetchDocumentExtraction(bizId, docId);
  expect(stale.extraction_status).toBe("refresh_required");

  respond(extractionPayload);
  expect((await runDocumentExtraction(bizId, docId)).extraction_status).toBe(
    "ready",
  );

  // Reject malformed snapshot (v1 schema exposed as ready).
  respond({
    ...extractionPayload,
    extraction: {
      ...extractionPayload.extraction,
      schema_version: "document-extraction-v1",
    },
  });
  await expect(fetchDocumentExtraction(bizId, docId)).rejects.toThrow(
    "invalid extraction payload",
  );

  const form = reviewed();
  const reviewHtml = renderToStaticMarkup(
    <SourceReview
      businessId={bizId}
      extraction={fetched}
      activePage={1}
      highlightedCell={{ page: 1, table: 1, row: 2, col: 2 }}
      disabled={false}
      form={form}
      onSelectPage={() => {}}
      onHighlightCell={() => {}}
      onRunExtraction={() => {}}
      onApplyCandidates={() => {}}
      onJumpToField={() => {}}
      onClose={() => {}}
    />,
  );
  expect(reviewHtml).toContain("Source review · aster-reference.pdf");
  expect(reviewHtml).toContain("Usable candidates (1)");
  expect(reviewHtml).toContain("Unresolved items — manual review required (1)");
  expect(reviewHtml).toContain("Blank or dash value (kept missing)");
  expect(reviewHtml).toContain('data-selected="true"');
  expect(reviewHtml).toContain(
    `/api/businesses/${bizId}/documents/${docId}/file#page=1`,
  );

  const staleHtml = renderToStaticMarkup(
    <SourceReview
      businessId={bizId}
      extraction={stale}
      activePage={1}
      highlightedCell={null}
      disabled={false}
      form={form}
      onSelectPage={() => {}}
      onHighlightCell={() => {}}
      onRunExtraction={() => {}}
      onApplyCandidates={() => {}}
      onJumpToField={() => {}}
      onClose={() => {}}
    />,
  );
  expect(staleHtml).toContain("Run extraction");

  // Mixed document (live + detached) and manual origins round-trip and render distinctly via real Python engine.
  form.periods[1]!.figures.revenue = {
    raw: "12000000.00",
    reviewed: true,
    revision: 1,
    origin: "document",
    source: {
      document_id: docId,
      filename: "aster-reference.pdf",
      page_number: 1,
      table_index: 1,
      row_index: 2,
      column_index: 2,
      label: "Revenue from operations",
      raw_token: "1,20,00,000.00",
    },
  };
  form.periods[1]!.figures.ebit = {
    raw: "1200000.00",
    reviewed: true,
    revision: 1,
    origin: "document",
    source: {
      document_id: null,
      filename: "removed-statement.pdf",
      page_number: 2,
      table_index: 1,
      row_index: 4,
      column_index: 2,
      label: "EBIT",
      raw_token: "12,00,000.00",
    },
  };
  const reqPayload = analysisRequest(form);
  expect(analysisRequest(formFromRequest(reqPayload))).toEqual(reqPayload);

  const output = engine(form);
  const resultsHtml = renderToStaticMarkup(
    <AnalysisResults
      data={output}
      businessName={form.businessName}
      businessId={bizId}
      inputRevision={3}
    />,
  );
  expect(resultsHtml).toContain("Document-supported and manual figures");
  expect(resultsHtml).toContain("Document: aster-reference.pdf · p. 1");
  expect(resultsHtml).toContain(
    `/api/businesses/${bizId}/documents/${docId}/file#page=1`,
  );
  expect(resultsHtml).toContain(
    "Source PDF removed (was removed-statement.pdf · p. 2)",
  );
  expect(resultsHtml).toContain("Manual entry");
  expect(resultsHtml).toContain("Inputs and source origins");
});

test("Q&A client validates responses, enforces status errors, and WorkspaceQA renders citations", async () => {
  const { askWorkspaceQuestion } = await import("../src/features/analysis/api");
  const bizId = "11111111-1111-1111-1111-111111111111";
  const docId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
  const chunkId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const validPayload = {
    question: "Why did net profit margin change?",
    answer:
      "Net profit margin changed from 9.00% [F2] to 5.00% [F9]. Borrowings exclude leases [D1].",
    mode: "fallback" as const,
    model: null,
    fallback_reason:
      "Local explanation model (Ollama) is not reachable at the configured loopback address.",
    retrieval_status: "ok" as const,
    retrieval_note: null,
    input_revision: 2,
    rule_version: "financial-rules-v1" as const,
    financial_citations: [
      {
        citation_id: "F2",
        year_start: 2023,
        indicator: "net_profit_margin" as const,
        label: "Net profit margin",
        state: "Supported" as const,
        value_display: "9.00%",
        summary: "Net profit margin (FY 2023-24): 9.00% [Supported].",
        origins: ["revenue (FY 2023-24): 10000000 rupees, confirmed, Manual entry"],
        reasons: [],
        cited: true,
      },
    ],
    document_citations: [
      {
        citation_id: "D1",
        chunk_id: chunkId,
        document_id: docId,
        filename: "aster-reference.pdf",
        page_number: 3,
        section: "Note 4: Borrowings",
        period_years: [2023, 2024],
        excerpt: "Interest-bearing borrowings exclude lease liabilities.",
        score: 0.78,
        cited: true,
      },
    ],
    limitations: [
      "Q&A explains reviewed figures, deterministic Python outputs, and authorised document excerpts only.",
    ],
  };

  let sentUrl = "";
  let sentBody: Record<string, unknown> = {};
  globalThis.fetch = (async (input, init) => {
    sentUrl = String(input);
    sentBody = JSON.parse(String(init?.body ?? "{}"));
    return Response.json(validPayload);
  }) as typeof fetch;

  const result = await askWorkspaceQuestion(bizId, {
    question: "Why did net profit margin change?",
    year_start: 2024,
  });
  expect(sentUrl).toBe(`/api/businesses/${bizId}/qa`);
  expect(sentBody).toEqual({
    question: "Why did net profit margin change?",
    year_start: 2024,
  });
  expect(result.mode).toBe("fallback");
  expect(result.financial_citations[0]?.citation_id).toBe("F2");
  expect(result.document_citations[0]?.page_number).toBe(3);

  for (const [status, match] of [
    [401, "session expired"],
    [404, "not found"],
    [422, "between 1 and 500"],
    [503, "Q&A service is unavailable"],
  ] as const) {
    respond({}, status);
    await expect(
      askWorkspaceQuestion(bizId, { question: "Check margin" }),
    ).rejects.toThrow(match);
  }

  // Malformed citation ID is rejected by runtime guard.
  respond({
    ...validPayload,
    financial_citations: [{ ...validPayload.financial_citations[0], citation_id: "BAD" }],
  });
  await expect(
    askWorkspaceQuestion(bizId, { question: "Check margin" }),
  ).rejects.toThrow("invalid Q&A payload");

  const qaHtml = renderToStaticMarkup(
    <WorkspaceQA
      businessId={bizId}
      businessName="Aster Components (fictional)"
      inputRevision={2}
      years={[2023, 2024]}
      hasReadyDocuments={true}
      hasUnsavedChanges={true}
    />,
  );
  expect(qaHtml).toContain("Evidence-grounded Q&amp;A");
  expect(qaHtml).toContain("Unsaved edits present");
  expect(qaHtml).toContain("borrowing notes");
});

test("report client validates preparation reports and renders Current vs Superseded printable sheets", async () => {
  const { fetchReport, fetchReports, generateReport } =
    await import("../src/features/analysis/api");
  const form = reviewed();
  const reqPayload = analysisRequest(form);
  const analysis = engine(form);
  const bizId = "11111111-1111-1111-1111-111111111111";
  const repId = "22222222-2222-2222-2222-222222222222";
  const summary = {
    report_id: repId,
    business_id: bizId,
    report_version: 2,
    input_revision: 2,
    current_input_revision: 2,
    rule_version: "financial-rules-v1",
    action_version: "preparation-actions-v1",
    superseded: false,
    superseded_reason: null,
    created_at: "2026-11-21T12:00:00Z",
  };
  const fullReport = {
    ...summary,
    report_schema_version: "preparation-report-v1" as const,
    business_name: reqPayload.business_name,
    currency: "INR" as const,
    basis: "standalone" as const,
    inputs: reqPayload,
    analysis,
    missing_evidence: [
      {
        year_start: 2023,
        fields: ["revenue" as const],
        code: "missing_prior_year",
        state: "Not assessed" as const,
        message: "Supply the immediately preceding financial year starting 2022.",
        affected_analyses: ["revenue_growth" as const],
      },
    ],
    documents_referenced: [
      {
        document_id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
        filename: "aster-reference.pdf",
        pages: [1, 2],
        detached: false,
      },
    ],
    limitations: [
      ...analysis.limitations,
      "This preparation report summarizes reviewed inputs and deterministic Python calculations.",
    ],
  };

  respond([summary]);
  const list = await fetchReports(bizId);
  expect(list).toHaveLength(1);
  expect(list[0]?.report_version).toBe(2);

  respond(fullReport);
  const generated = await generateReport(bizId);
  expect(generated.report_schema_version).toBe("preparation-report-v1");
  expect(generated.superseded).toBe(false);

  respond(fullReport);
  const loaded = await fetchReport(bizId, repId);
  expect(loaded.report_id).toBe(repId);

  for (const [status, match] of [
    [401, "session expired"],
    [404, "not found"],
    [503, "Report service is unavailable"],
  ] as const) {
    respond({}, status);
    await expect(fetchReport(bizId, repId)).rejects.toThrow(match);
  }

  respond({ ...fullReport, report_schema_version: "wrong-version" });
  await expect(generateReport(bizId)).rejects.toThrow("invalid report payload");

  const currentHtml = renderToStaticMarkup(
    <PreparationReportSheet
      report={fullReport}
      currentWorkspaceRevision={2}
      businessId={bizId}
    />,
  );
  expect(currentHtml).toContain("CURRENT VERSION");
  expect(currentHtml).toContain("preparation-report-v1");
  expect(currentHtml).toContain("20.00%");
  expect(currentHtml).toContain("aster-reference.pdf");
  expect(currentHtml).toContain("Ordered Preparation Actions");

  const supersededHtml = renderToStaticMarkup(
    <PreparationReportSheet
      report={{
        ...fullReport,
        report_version: 1,
        input_revision: 1,
        current_input_revision: 2,
        superseded: true,
        superseded_reason: "Superseded by workspace input revision 2.",
      }}
      currentWorkspaceRevision={2}
      businessId={bizId}
    />,
  );
  expect(supersededHtml).toContain("SUPERSEDED");
  expect(supersededHtml).toContain("Superseded by workspace input revision 2.");
});

test("workspace deletion and audit log clients validate payloads and surface errors", async () => {
  const { deleteWorkspace, fetchAuditEvents } =
    await import("../src/features/analysis/api");
  const bizId = "11111111-1111-1111-1111-111111111111";
  const ownerId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

  respond({
    status: "deleted",
    business_id: bizId,
    documents_removed: 2,
    runs_removed: 3,
    revisions_removed: 2,
    chat_note: "Q&A turns are request-scoped.",
    backup_notice: "Host backups follow retention policies and are not immediately purged.",
  });
  const deleted = await deleteWorkspace(bizId);
  expect(deleted.status).toBe("deleted");
  expect(deleted.documents_removed).toBe(2);
  expect(deleted.backup_notice).toContain("not immediately purged");

  for (const [status, match] of [
    [401, "session expired"],
    [404, "Workspace not found"],
    [409, "Another PDF processing job is active"],
    [503, "Could not delete workspace"],
  ] as const) {
    respond({}, status);
    await expect(deleteWorkspace(bizId)).rejects.toThrow(match);
  }

  respond({ status: "deleted", business_id: bizId });
  await expect(deleteWorkspace(bizId)).rejects.toThrow("invalid deletion confirmation");

  respond([
    {
      id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      owner_id: ownerId,
      action: "workspace_deleted",
      resource_type: "workspace",
      resource_id: bizId,
      business_id: bizId,
      details: { documents_removed: 2, runs_removed: 3 },
      created_at: "2026-11-21T15:00:00Z",
    },
  ]);
  const events = await fetchAuditEvents(bizId);
  expect(events).toHaveLength(1);
  expect(events[0]?.action).toBe("workspace_deleted");

  respond({}, 401);
  await expect(fetchAuditEvents()).rejects.toThrow("session expired");

  respond([{ id: "", action: "workspace_deleted" }]);
  await expect(fetchAuditEvents()).rejects.toThrow("invalid activity log payload");
});
