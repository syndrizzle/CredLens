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
