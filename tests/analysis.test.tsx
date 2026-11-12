import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalysisResults } from "../src/features/analysis/AnalysisResults";
import { analysisRequest, displayDecimal, fetchAnalysis, type AnalysisResponse } from "../src/features/analysis/api";
import { createExampleForm, type FormDraft } from "../src/features/manual-entry/model";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
function reviewed() {
  const form = createExampleForm();
  for (const period of form.periods) for (const figure of Object.values(period.figures)) figure.reviewed = true;
  return form;
}
function engine(form: FormDraft): AnalysisResponse {
  const python = process.platform === "win32" ? "backend/.venv/Scripts/python.exe" : "backend/.venv/bin/python";
  const result = Bun.spawnSync([python, "-c", "import json,sys; from app.schemas import AnalysisRequest; from app.analysis import analyse; print(analyse(AnalysisRequest.model_validate(json.load(sys.stdin))).model_dump_json())"], {
    env: { ...Bun.env, PYTHONPATH: "backend" }, stdin: new TextEncoder().encode(JSON.stringify(analysisRequest(form))),
  });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}
function respond(body: unknown, status = 200) {
  globalThis.fetch = (async () => Response.json(body, { status })) as typeof fetch;
}

describe("decimal display", () => {
  for (const [raw, expected] of [["0", "0.00"], ["1.005", "1.01"], ["-1.005", "-1.01"], ["999.999", "1000.00"], ["-0.0049", "0.00"], ["9999999999999999900000", "9999999999999999900000.00"]]) {
    test(raw!, () => expect(displayDecimal(raw!)).toBe(expected!));
  }
});

test("transport preserves raw text, zero, missing, confirmation, and revisions without mutation", () => {
  const form = reviewed();
  form.periods[0]!.figures.interest_expense = { raw: "  ", reviewed: false };
  form.periods[1]!.figures.revenue = { raw: " +12000000.00 ", reviewed: false, revision: 2 };
  form.periods[1]!.figures.current_maturities.raw = "0";
  const before = JSON.stringify(form);
  const request = analysisRequest(form);
  expect(request.periods[0]!.values.interest_expense.raw).toBe("  ");
  expect(request.periods[1]!.values.revenue).toEqual({ raw: " +12000000.00 ", reviewed: false, revision: 2, origin: "manual" });
  expect(request.periods[1]!.values.current_maturities.raw).toBe("0");
  expect(JSON.stringify(form)).toBe(before);
});

test("real Python response passes transport guard and renders all indicators with evidence", async () => {
  const form = reviewed(); const data = engine(form); respond(data);
  const signal = new AbortController().signal;
  const output = await fetchAnalysis(form, signal);
  const html = renderToStaticMarkup(<AnalysisResults data={output} businessName={form.businessName} />);
  expect(html).toContain("20.00%"); expect(html).toContain("3.00x"); expect(html).toContain("INR 2500000.00");
  expect(html).toContain("Manual entry"); expect(html).toContain("Revision 1"); expect(html).toContain("financial-rules-v1");
  expect(html.match(/Inputs and manual origin/g)).toHaveLength(12);
});

test("missing interest blocks coverage only; restoring it refreshes results", () => {
  const form = reviewed(); form.periods[1]!.figures.interest_expense = { raw: "", reviewed: false };
  const findings = engine(form).periods[1]!.indicators;
  expect(findings.filter(item => item.state === "Supported")).toHaveLength(5);
  expect(findings.find(item => item.indicator === "interest_coverage")!.state).toBe("Not assessed");
  form.periods[1]!.figures.interest_expense = { raw: "400000", reviewed: true, revision: 2 };
  expect(displayDecimal(engine(form).periods[1]!.indicators.at(-1)!.value!)).toBe("3.00");
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
  const byKey = Object.fromEntries(output.periods[0]!.indicators.map(item => [item.indicator, item]));
  expect(byKey.revenue_growth!.state).toBe("Not assessed");
  expect(byKey.net_profit_margin!.state).toBe("Not meaningful");
  expect(byKey.working_capital!.state).toBe("Supported");
  expect(displayDecimal(byKey.working_capital!.value!)).toBe("5000000.00");
  expect(byKey.current_ratio!.state).toBe("Not meaningful");
  expect(byKey.debt_to_equity!.state).toBe("Not meaningful");
  expect(byKey.interest_coverage!.state).toBe("Not meaningful");
  const html = renderToStaticMarkup(<AnalysisResults data={output} businessName={form.businessName} />);
  expect(html).toContain("Supply the immediately preceding financial year starting 2023.");
  expect(html).toContain("Revenue must be positive for this ratio to be meaningful.");
  expect(html).toContain("Current liabilities must be positive for this ratio to be meaningful.");
  expect(html).toContain("Total equity must be positive for this ratio to be meaningful.");
  expect(html).toContain("Interest expense must be positive for this ratio to be meaningful.");
  expect(html).not.toContain("Infinity");
});

test("errors retain the draft and a subsequent retry succeeds", async () => {
  const form = reviewed(); const before = JSON.stringify(form);
  respond({}, 503); await expect(fetchAnalysis(form, new AbortController().signal)).rejects.toThrow("unavailable");
  respond({}, 422); await expect(fetchAnalysis(form, new AbortController().signal)).rejects.toThrow("rejected");
  globalThis.fetch = (async () => { throw new TypeError("Network unavailable"); }) as typeof fetch;
  await expect(fetchAnalysis(form, new AbortController().signal)).rejects.toThrow();
  respond(engine(form)); expect((await fetchAnalysis(form, new AbortController().signal)).periods).toHaveLength(2);
  expect(JSON.stringify(form)).toBe(before);
});

test("rejects malformed responses instead of displaying partial findings", async () => {
  const form = reviewed(); const data = engine(form);
  for (const bad of [null, {}, { ...data, periods: [] }, { ...data, periods: [data.periods[0], data.periods[0]] }, { ...data, periods: [{ ...data.periods[0], balance_check: null }, data.periods[1]] }]) {
    respond(bad); await expect(fetchAnalysis(form, new AbortController().signal)).rejects.toThrow("incomplete");
  }
});

test("forwards cancellation signal to fetch", async () => {
  const controller = new AbortController(); controller.abort();
  globalThis.fetch = (async (_url, init) => {
    expect(init!.signal!.aborted).toBe(true); init!.signal!.throwIfAborted();
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
  const { formFromRequest } = await import("../src/features/manual-entry/model");

  const form = reviewed();
  const payload = analysisRequest(form);
  const roundTripped = formFromRequest(payload);
  expect(analysisRequest(roundTripped)).toEqual(payload);

  respond({ detail: "Authentication required" }, 401);
  expect(await fetchSession()).toBeNull();
  await expect(submitCredentials("login", "user@example.com", "wrong-password-123")).rejects.toThrow("Invalid email or password.");
  await expect(fetchBusinesses()).rejects.toThrow("expired");

  respond({ detail: "Account already exists" }, 409);
  await expect(submitCredentials("register", "user@example.com", "valid-password-123")).rejects.toThrow("already exists");

  respond({ detail: "Business not found" }, 404);
  await expect(fetchWorkspace("00000000-0000-0000-0000-000000000000")).rejects.toThrow("Workspace not found.");

  const analysis = engine(form);
  respond({
    business_id: "11111111-1111-1111-1111-111111111111",
    input_revision: 1,
    request: payload,
    latest_run_id: "22222222-2222-2222-2222-222222222222",
    latest_analysis: analysis,
  }, 201);
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
  globalThis.fetch = (async () => { throw new TypeError("offline"); }) as typeof fetch;
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
  const html = renderToStaticMarkup(<AnalysisResults data={result} businessName={form.businessName} />);
  expect(html).toContain("Preparation actions");
  expect(html).toContain("preparation-actions-v1");
  expect(html.indexOf("Review current assets")).toBeLessThan(html.indexOf("Supply interest expense"));
  expect(html).toContain("not a credit-risk ranking");
  expect(html).toContain("wrongly labelled unit cannot be detected automatically");
  for (const action of result.actions!) for (const target of action.targets) {
    const id = `finding-${target.year_start}-${target.indicator}`;
    expect(html).toContain(`href="#${id}"`);
    expect(html).toContain(`id="${id}"`);
  }
  const currentAssets = result.actions!.filter(action => action.code === "unreviewed" && action.inputs.some(input => input.field === "current_assets"));
  expect(currentAssets).toHaveLength(1);
  expect(currentAssets[0]!.targets.map(target => target.indicator)).toEqual(["working_capital", "current_ratio"]);
});

test("legacy analysis remains readable and asks for re-analysis; malformed actions are rejected", async () => {
  const form = reviewed();
  const data = engine(form);
  const { actions, action_version: _actionVersion, ...legacy } = data;
  respond(legacy);
  const result = await fetchAnalysis(form, new AbortController().signal);
  const html = renderToStaticMarkup(<AnalysisResults data={result} businessName={form.businessName} />);
  expect(html).toContain("predates the preparation action list");
  expect(html).toContain("Analyse the saved workspace again");
  expect(html).toContain("20.00%");
  for (const malformed of [
    { ...data, actions: [] },
    { ...data, action_version: "unknown" },
    { ...data, action_version: null },
    { ...data, actions: [{ ...actions![0], category: "credit_score" }] },
    { ...data, actions: [{ ...actions![0], inputs: [{ year_start: 2023, field: "unknown" }] }] },
    { ...data, actions: [{ ...actions![0], targets: [{ year_start: 9999, indicator: "current_ratio" }] }] },
  ]) {
    respond(malformed);
    await expect(fetchAnalysis(form, new AbortController().signal)).rejects.toThrow("incomplete analysis");
  }
});

test("updateWorkspace sends expected_revision, handles 409 conflicts, validates run history, and renders supersession", async () => {
  const { updateWorkspace } = await import("../src/features/analysis/api");
  const form = reviewed();
  form.periods[1]!.figures.interest_expense = { raw: "300000.00", reviewed: true, revision: 2 };
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
      runs: [{
        run_id: "22222222-2222-2222-2222-222222222222",
        input_revision: 1,
        rule_version: "financial-rules-v1",
        action_version: "preparation-actions-v1",
        superseded: true,
        created_at: "2026-11-12T10:00:00Z",
      }],
    });
  }) as typeof fetch;

  const updated = await updateWorkspace("11111111-1111-1111-1111-111111111111", 1, form);
  expect(sentMethod).toBe("PUT");
  expect(sentBody.expected_revision).toBe(1);
  expect(updated.input_revision).toBe(2);
  expect(updated.latest_analysis).toBeNull();
  expect(updated.runs?.[0]?.superseded).toBe(true);

  respond({ detail: "Workspace has been updated in another session; reload before saving" }, 409);
  await expect(updateWorkspace("11111111-1111-1111-1111-111111111111", 1, form)).rejects.toThrow("updated in another session");

  respond({
    business_id: "11111111-1111-1111-1111-111111111111",
    input_revision: 2,
    request: payload,
    latest_run_id: null,
    latest_analysis: null,
    runs: [{ run_id: "", input_revision: 0, superseded: "yes" }],
  });
  await expect(updateWorkspace("11111111-1111-1111-1111-111111111111", 1, form)).rejects.toThrow("invalid workspace payload");

  const html = renderToStaticMarkup(
    <AnalysisResults
      data={analysis}
      businessName={form.businessName}
      inputRevision={2}
      runs={[
        { run_id: "33333333-3333-3333-3333-333333333333", input_revision: 2, rule_version: "financial-rules-v1", action_version: "preparation-actions-v1", superseded: false, created_at: "2026-11-12T10:05:00Z" },
        { run_id: "22222222-2222-2222-2222-222222222222", input_revision: 1, rule_version: "financial-rules-v1", action_version: "preparation-actions-v1", superseded: true, created_at: "2026-11-12T10:00:00Z" },
      ]}
    />,
  );
  expect(html).toContain("Input revision 2 (current)");
  expect(html).toContain("Supersedes 1 earlier analysis run (Rev 1 marked superseded).");
  expect(html).toContain("Revision 2");
  expect(html).toContain("4.00x");
});
