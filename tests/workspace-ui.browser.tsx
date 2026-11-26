// Bundle for a headless browser; see README for the dependency-free run command.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { Workspace } from "../src/features/workspace/Workspace";
import { analysisRequest } from "../src/features/analysis/api";
import { createExampleForm } from "../src/features/manual-entry/model";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const checks: string[] = [];
function check(value: unknown, message: string) {
  if (!value) throw new Error(message);
  checks.push(message);
}
function button(text: string): HTMLButtonElement {
  const element = [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === text);
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}
const name = () => document.querySelector<HTMLInputElement>("#business-name")!;
const text = () => document.body.textContent ?? "";
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function rename(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name(), value);
    name().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}
const payload = analysisRequest(createExampleForm());
const workspace = (id: string, businessName: string) => ({
  business_id: id, input_revision: 1, request: { ...payload, business_name: businessName },
  latest_run_id: null, latest_analysis: null,
});
let pending = deferred();
let analysisPending = deferred();
let docPending = deferred();
let qaPending = deferred();
let reportPending = deferred();
let auditPending = deferred();
const restoration = deferred();
let logoutFailure: "http" | "network" | null = "http";
const calls: string[] = [];
let reportSignal: AbortSignal | null | undefined;
globalThis.fetch = async (input, options) => {
  const path = String(input);
  calls.push(`${options?.method ?? "GET"} ${path}`);
  if (path === "/api/auth/session") return restoration.promise;
  if (path === "/api/auth/logout") {
    if (logoutFailure === "network") throw new TypeError("offline");
    return Response.json({}, { status: logoutFailure ? 503 : 200 });
  }
  if (path === "/api/businesses" && options?.method !== "POST") {
    return Response.json(["a", "b"].map(id => ({ id, business_name: `Business ${id}`, input_revision: 1 })));
  }
  if (path.startsWith("/api/audit-events")) return auditPending.promise;
  if (path.includes("/reports")) {
    reportSignal = options?.signal;
    return reportPending.promise;
  }
  if (path.endsWith("/qa/stream")) return qaPending.promise;
  if (path.includes("/documents")) return docPending.promise;
  return path.endsWith("/analysis") ? analysisPending.promise : pending.promise;
};
// Mirrors backend `ui_message_stream`: metadata part, text deltas, then [DONE].
function uiMessageStream({ answer, ...qa }: { answer: string } & Record<string, unknown>) {
  const events = [
    { type: "start" },
    { type: "data-qa", data: qa },
    { type: "text-start", id: "answer" },
    ...answer.match(/\s*\S+/g)!.map(delta => ({ type: "text-delta", id: "answer", delta })),
    { type: "text-end", id: "answer" },
    { type: "finish" },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" },
  });
}
const switcher = () => document.querySelector<HTMLButtonElement>("#workspace-switcher")!;
const account = () => document.querySelector<HTMLButtonElement>("#account-menu")!;
async function settled(ready: () => boolean) {
  for (let attempt = 0; attempt < 40 && !ready(); attempt++)
    await act(() => new Promise<void>(done => setTimeout(done, 25)));
}
// Base UI menus open on a mouse press, once any closing menu or dialog has unmounted, and mount items a frame later.
async function menuItem(trigger: HTMLElement, matches: (item: HTMLElement) => boolean) {
  await settled(() => !document.querySelector('[role="menu"], [role="alertdialog"]'));
  await click(trigger);
  const item = () => [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(matches);
  await settled(() => Boolean(item()));
  return item() ?? null;
}
async function fromMenu(trigger: HTMLElement, label: string) {
  const item = await menuItem(trigger, el => el.textContent?.trim() === label);
  if (!item) throw new Error(`Missing menu item: ${label}`);
  await click(item);
}
async function chooseWorkspace(label: string) {
  const item = await menuItem(switcher(), el => el.getAttribute("role") === "menuitemradio" && Boolean(el.textContent?.includes(label)));
  if (!item) throw new Error(`Missing option: ${label}`);
  await click(item);
}

async function run() {
  const root = createRoot(document.getElementById("root")!);
  // No section prop: every section renders on one page, so checks can span the whole workflow.
  const router = createRouter({ routeTree: createRootRoute({ component: () => <Workspace /> }), history: createMemoryHistory() });
  // Action notices are toasts, so the page needs a Toaster as in the app.
  await act(async () => root.render(<><RouterProvider router={router} /><Toaster /></>));
  check(!name() && Boolean(document.querySelector('[aria-label="Checking your session"]')), "Session restoration shows a loading state instead of competing actions");
  await act(async () => restoration.resolve(Response.json({ owner_id: "owner", email: "owner@example.com" })));
  check(calls.includes("GET /api/businesses/a"), "Restored session opens the newest saved business");
  await act(async () => pending.resolve(Response.json({}, { status: 503 })));
  pending = deferred();
  check(name()?.value === "", "A failed open after restoration leaves an empty draft");
  await rename("Unsaved draft");
  await fromMenu(switcher(), "New business");
  check(name().value === "Unsaved draft", "New workspace waits for confirmation");
  await click(button("Keep editing"));
  check(name().value === "Unsaved draft", "Cancel keeps draft");

  const opensBeforeSwitch = calls.filter(call => call === "GET /api/businesses/a").length;
  await chooseWorkspace("Business a");
  check(calls.filter(call => call === "GET /api/businesses/a").length === opensBeforeSwitch, "Switch waits for confirmation before fetching");
  await click(button("Keep editing"));
  check(name().value === "Unsaved draft", "Cancelled switch keeps draft");

  await act(async () => {
    button("Save").click();
    button("Save").click();
  });
  check(calls.filter(call => call === "POST /api/businesses").length === 1, "Same-turn double save sends one request");
  check(name().matches(":disabled"), "Name locked during save");
  check(document.querySelector('input[id^="figure-"]')?.matches(":disabled"), "Figures locked during save");
  check(switcher().matches(":disabled") && account().matches(":disabled"), "Replacement locked during save");
  check(switcher().matches(":disabled"), "Selection locked during save");
  const count = calls.length;
  await click(switcher());
  await click(account());
  check(calls.length === count, "Pending save prevents competing requests");
  await act(async () => pending.resolve(Response.json(workspace("saved", "Unsaved draft"))));
  check(!name().matches(":disabled") && name().value === "Unsaved draft", "Save unlocks its original draft");

  pending = deferred();
  await chooseWorkspace("Business a");
  check(name().matches(":disabled"), "Name locked during load");
  const select = switcher();
  const requestsBeforeSelect = calls.length;
  await click(select);
  check(select.matches(":disabled") && calls.length === requestsBeforeSelect, "Pending load prevents another selection");
  await act(async () => pending.resolve(Response.json({
    ...workspace("a", "Business a"),
    documents: [{
      id: "doc-1",
      business_id: "a",
      filename: "Aster_FY24.pdf",
      sha256: "a".repeat(64),
      byte_size: 16384,
      page_count: null,
      extracted_char_count: null,
      status: "failed",
      error_code: "interrupted_job",
      error_message: "Processing was interrupted before completion. Retry processing to continue.",
      created_at: "2026-11-17T10:00:00Z",
      updated_at: "2026-11-17T10:00:01Z",
    }],
  })));
  check(name().value === "Business a", "Load applies selected workspace");
  check(text().includes("Aster_FY24.pdf") && text().includes("Failed"), "Loaded workspace renders failed/interrupted PDF document");

  docPending = deferred();
  await click(button("Retry processing"));
  check(name().matches(":disabled"), "Editor locked during PDF retry processing");
  await act(async () => docPending.resolve(Response.json({
    id: "doc-1",
    business_id: "a",
    filename: "Aster_FY24.pdf",
    sha256: "a".repeat(64),
    byte_size: 16384,
    page_count: 3,
    extracted_char_count: 980,
    status: "ready",
    error_code: null,
    error_message: null,
    created_at: "2026-11-17T10:00:00Z",
    updated_at: "2026-11-17T10:00:05Z",
  })));
  check(text().includes("Ready") && text().includes("3 pages") && Boolean(document.querySelector('button[aria-label="More actions for Aster_FY24.pdf"]')), "Retried PDF transitions to Ready with page count and a file menu");

  // P3-03 page-linked source review: open extraction, inspect page 2 cell, apply candidate, confirm individually, edit -> manual, and detach on PDF delete.
  docPending = deferred();
  await click(button("Review extracted figures"));
  check(name().matches(":disabled"), "Opening source review locks competing actions");
  await act(async () => docPending.resolve(Response.json({
    id: "doc-1",
    business_id: "a",
    filename: "Aster_FY24.pdf",
    sha256: "a".repeat(64),
    byte_size: 16384,
    page_count: 2,
    extracted_char_count: 980,
    status: "ready",
    error_code: null,
    error_message: null,
    created_at: "2026-11-17T10:00:00Z",
    updated_at: "2026-11-17T10:00:05Z",
    extraction_status: "ready",
    extraction_message: null,
    extraction: {
      schema_version: "document-extraction-v2",
      document_sha256: "a".repeat(64),
      layout: "layout_a",
      page_count: 2,
      extracted_char_count: 980,
      issues: [],
      pages: [
        {
          page_number: 1,
          text: "Profit and Loss",
          statement_title: "Statement of Profit and Loss",
          basis: "standalone",
          basis_context: "Standalone",
          period_context: "FY 2024-25",
          unit: "rupees",
          multiplier: 1,
          unit_header: "INR in Rupees",
          issues: [],
          tables: [{
            table_index: 1,
            rows: [
              ["Particulars", "FY 2024-25"],
              ["Revenue from operations", "1,25,00,000.00"],
            ],
          }],
        },
        {
          page_number: 2,
          text: "Balance Sheet",
          statement_title: "Balance Sheet",
          basis: "standalone",
          basis_context: "Standalone",
          period_context: "As at 31 March 2025",
          unit: "rupees",
          multiplier: 1,
          unit_header: "INR in Rupees",
          issues: [],
          tables: [{
            table_index: 1,
            rows: [
              ["Particulars", "FY 2024-25"],
              ["Total current assets", "52,00,000.00"],
            ],
          }],
        },
      ],
      candidates: [
        {
          page_number: 1, table_index: 1, row_index: 2, column_index: 2,
          field: "revenue", label: "Revenue from operations", note: null, raw: "1,25,00,000.00",
          source_row: ["Revenue from operations", "1,25,00,000.00"], source_context: ["P&L"],
          period_header: "FY 2024-25", period_context: "FY 2024-25", year_start: 2024,
          unit_header: "INR in Rupees", unit: "rupees", multiplier: 1,
          basis: "standalone", basis_context: "Standalone",
          amount: "12500000.00", normalized_inr: "12500000.00", reviewed: false, issues: [],
        },
        {
          page_number: 2, table_index: 1, row_index: 2, column_index: 2,
          field: "current_assets", label: "Total current assets", note: null, raw: "52,00,000.00",
          source_row: ["Total current assets", "52,00,000.00"], source_context: ["BS"],
          period_header: "FY 2024-25", period_context: "As at 31 March 2025", year_start: 2024,
          unit_header: "INR in Rupees", unit: "rupees", multiplier: 1,
          basis: "standalone", basis_context: "Standalone",
          amount: "5200000.00", normalized_inr: "5200000.00", reviewed: false, issues: [],
        },
      ],
    },
  })));
  check(Boolean(document.getElementById("source-review-panel")) && text().includes("Usable candidates (2)"), "Source review panel opens with extracted candidates");
  await click(button("Inspect p. 2"));
  check(document.querySelector('[data-selected="true"]')?.textContent?.includes("52,00,000.00"), "Inspect p. 2 switches source inspector to page 2 and highlights exact table cell");
  await click(button("Apply all usable candidates (2)"));
  check(text().includes("Replace 2 entered figures"), "Apply all asks for confirmation before overwriting entered figures");
  await click(button("Apply and replace"));
  check(Boolean(document.querySelector('button[aria-label="Inspect PDF p. 2 (Aster_FY24.pdf)"]')?.textContent?.includes("PDF p. 2")), "Applied candidates show document origin and page reference");

  const currentAssetsInput = [...document.querySelectorAll<HTMLInputElement>('input[id^="figure-"][id$="-current_assets"]')].at(-1)!;
  check(currentAssetsInput.value === "5200000.00", "Applied candidate populates the target financial figure input");
  const currentAssetsConfirmId = currentAssetsInput.id.replace("figure-", "confirm-");
  await click(document.getElementById(currentAssetsConfirmId)!);
  const confirmEl = document.getElementById(currentAssetsConfirmId);
  const isConfirmed =
    confirmEl?.getAttribute("aria-checked") === "true" ||
    confirmEl?.hasAttribute("data-checked") ||
    (confirmEl as HTMLInputElement | null)?.checked === true;
  check(isConfirmed && text().includes("1 of 24 present figures confirmed"), "Per-figure confirmation checkbox confirms a single figure");

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(currentAssetsInput, "5300000.00");
    currentAssetsInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  check(text().includes("converted from document source to manual entry"), "Editing a document-sourced figure converts it to manual entry and resets review");
  await click(button("Close review"));
  check(!document.getElementById("source-review-panel"), "Close review dismisses source review panel");

  pending = deferred();
  analysisPending = deferred();
  await click(button("Analyse figures"));
  check(name().matches(":disabled"), "Editor locked during saved analysis");
  await act(async () => pending.resolve(Response.json(workspace("a", "Business a"))));
  await act(async () => analysisPending.resolve(Response.json(workspace("a", "Business a"))));
  await rename("Unsaved PDF review draft");
  docPending = deferred();
  await click(button("Refresh document status"));
  check(name().matches(":disabled"), "Refresh locks competing actions");
  await act(async () => docPending.resolve(Response.json([{
    id: "doc-1", business_id: "a", filename: "Aster_FY24.pdf", sha256: "a".repeat(64),
    byte_size: 16384, page_count: null, extracted_char_count: null, status: "failed",
    error_code: "deletion_pending", error_message: "Removal is pending. Use Remove again to finish.",
    created_at: "2026-11-17T10:00:00Z", updated_at: "2026-11-17T10:00:05Z",
  }])));
  check(name().value === "Unsaved PDF review draft", "Refreshing document status preserves unsaved financial draft");
  check(text().includes("Removal is pending") && !text().includes("Retry processing") && !text().includes("View PDF"), "Pending removal exposes Remove without retry or file access");


  await rename("Edited after analysis");
  pending = deferred();
  analysisPending = deferred();
  await click(button("Analyse figures"));
  check(name().matches(":disabled"), "Editor locked during update-and-analyse");
  check(calls.includes("PUT /api/businesses/a"), "Editing saved workspace updates in place with PUT");
  await act(async () => pending.resolve(Response.json({
    ...workspace("a", "Edited after analysis"),
    input_revision: 2,
    runs: [{ run_id: "r1", input_revision: 1, rule_version: "financial-rules-v1", action_version: "preparation-actions-v1", superseded: true, created_at: "2026-11-12T10:00:00Z" }],
  })));
  check(name().matches(":disabled"), "Editor stays locked between save and analysis responses");
  await act(async () => analysisPending.resolve(Response.json({
    ...workspace("a", "Edited after analysis"),
    input_revision: 2,
    runs: [{ run_id: "r1", input_revision: 1, rule_version: "financial-rules-v1", action_version: "preparation-actions-v1", superseded: true, created_at: "2026-11-12T10:00:00Z" }],
  })));
  check(name().value === "Edited after analysis", "Update-and-analyse keeps submitted entries");
  check(text().includes("Saved revision 2 supersedes earlier analysis runs"), "Superseded status shown when saved revision has no current analysis");

  // P4-03 focused Q&A checks on saved workspace
  const qaInput = document.querySelector<HTMLTextAreaElement>("#qa-question")!;
  check(Boolean(qaInput) && !qaInput.matches(":disabled"), "Saved clean workspace enables Q&A input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(qaInput, "Why did net profit margin change?");
    qaInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  qaPending = deferred();
  await click(button("Ask question"));
  check(calls.includes("POST /api/businesses/a/qa/stream"), "Ask question posts to the streaming Q&A endpoint");
  check(qaInput.matches(":disabled"), "Q&A input locks while assembling answer");
  await act(async () => qaPending.resolve(uiMessageStream({
    question: "Why did net profit margin change?",
    answer: "Deterministic summary: net profit margin moved from 9.00% [F2] to 5.00% [F9]. Borrowings exclude leases [D1].",
    mode: "fallback",
    model: null,
    fallback_reason: "Explanation model is not reachable.",
    retrieval_status: "ok",
    retrieval_note: null,
    input_revision: 2,
    rule_version: "financial-rules-v1",
    financial_citations: [{
      citation_id: "F2", year_start: 2023, indicator: "net_profit_margin", label: "Net profit margin",
      state: "Supported", value_display: "9.00%", summary: "Net profit margin (FY 2023-24): 9.00% [Supported].",
      origins: ["revenue (FY 2023-24): 10000000 rupees, confirmed, Manual entry"], reasons: [], cited: true,
    }],
    document_citations: [{
      citation_id: "D1", chunk_id: "c1", document_id: "doc-1", filename: "Aster_FY24.pdf",
      page_number: 3, section: "Note 4: Borrowings", period_years: [2023, 2024],
      excerpt: "Interest-bearing borrowings exclude lease liabilities.", score: 0.78, cited: true,
    }],
    limitations: ["Q&A explains reviewed figures and authorised excerpts only."],
  })));
  await settled(() => text().includes("Template fallback"));
  check(text().includes("Template fallback") && text().includes("Explanation model unavailable"), "Q&A shows explicit fallback badge and reason");
  check(text().includes("Why did net profit margin change?") && qaInput.value === "", "Asked question appears in the thread and the field clears");
  await click(button("Used 2 sources"));
  await settled(() => Boolean(document.querySelector('a[href="/api/businesses/a/documents/doc-1/file#page=3"]')));
  check(text().includes("[F2]") && text().includes("9.00%") && text().includes("[D1]") && Boolean(document.querySelector('a[href="/api/businesses/a/documents/doc-1/file#page=3"]')), "Q&A renders verified financial and page-linked document citations");

  // P5-01 printable preparation report & supersession checks
  const fakeAnalysis = {
    rule_version: "financial-rules-v1",
    limitations: ["Provisional rules pending finance review."],
    action_version: "preparation-actions-v1",
    actions: [{
      category: "review", code: "unreviewed", message: "Review submitted figures.",
      inputs: [{ year_start: 2023, field: "revenue" }],
      targets: [{ year_start: 2023, indicator: "net_profit_margin" }],
    }],
    periods: payload.periods.map(p => ({
      year_start: p.year_start,
      balance_check: { state: "Needs review", difference_inr: null, tolerance_inr: "0.015", inputs: [], reasons: [{ code: "unreviewed", message: "Review figures.", fields: ["total_assets"] }] },
      indicators: ["revenue_growth", "net_profit_margin", "working_capital", "current_ratio", "debt_to_equity", "interest_coverage"].map(ind => ({
        indicator: ind, state: "Needs review", value: null, inputs: [],
        reasons: [{ code: "unreviewed", message: "Review figures.", fields: ["revenue"] }],
        next_step: "Review figures.",
      })),
    })),
  };
  check(text().includes("Report v1 · Input revision 1") && text().includes("Superseded"), "Report history shows superseded Rev 1 report");
  reportPending = deferred();
  await click(button("Open superseded report"));
  check(calls.includes("GET /api/businesses/a/reports/r1"), "Opening historical version fetches report endpoint");
  const historicalReport = {
    report_id: "r1", business_id: "a", report_version: 1, input_revision: 1, current_input_revision: 2,
    rule_version: "financial-rules-v1", action_version: "preparation-actions-v1",
    superseded: true, superseded_reason: "Superseded by workspace input revision 2.",
    created_at: "2026-11-12T10:00:00Z", report_schema_version: "preparation-report-v1",
    business_name: "Edited after analysis", currency: "INR", basis: "standalone",
    inputs: { ...payload, business_name: "Edited after analysis" }, analysis: fakeAnalysis,
    missing_evidence: [{ year_start: 2023, fields: ["revenue"], code: "unreviewed", state: "Needs review", message: "Review figures.", affected_analyses: ["net_profit_margin"] }],
    documents_referenced: [], limitations: ["Provisional rules pending finance review."],
  };
  await act(async () => reportPending.resolve(Response.json(historicalReport)));
  check(Boolean(document.querySelector("#preparation-report-sheet")) && text().includes("SUPERSEDED") && text().includes("Superseded by workspace input revision 2."), "Historical report renders SUPERSEDED banner and reason");

  reportPending = deferred();
  await click(button("Generate preparation report"));
  check(calls.includes("POST /api/businesses/a/reports"), "Generate preparation report posts to report endpoint");
  await act(async () => reportPending.resolve(Response.json({
    report_id: "r2", business_id: "a", report_version: 2, input_revision: 2, current_input_revision: 2,
    rule_version: "financial-rules-v1", action_version: "preparation-actions-v1",
    superseded: false, superseded_reason: null,
    created_at: "2026-11-21T12:00:00Z", report_schema_version: "preparation-report-v1",
    business_name: "Edited after analysis", currency: "INR", basis: "standalone",
    inputs: { ...payload, business_name: "Edited after analysis" }, analysis: fakeAnalysis,
    missing_evidence: [], documents_referenced: [], limitations: ["Provisional rules pending finance review."],
  })));
  check(text().includes("CURRENT VERSION") && text().includes("Report v2 · Input revision 2") && Boolean(button("Print / Save as PDF")), "Generated report shows CURRENT VERSION, v2 history, and print control");

  await rename("Draft with revision conflict");
  check(button("Generate preparation report").matches(":disabled"), "Unsaved edits disable generating a new report until saved");
  check(text().includes("Unsaved edits present") && document.querySelector<HTMLInputElement>("#qa-question")!.matches(":disabled"), "Unsaved edits disable Q&A until saved");
  pending = deferred();
  await click(button("Save"));
  await act(async () => pending.resolve(Response.json({ detail: "Workspace has been updated in another session; reload before saving" }, { status: 409 })));
  check(name().value === "Draft with revision conflict" && text().includes("updated in another session") && !name().matches(":disabled"), "409 conflict preserves draft and warns user");

  await rename("Draft after save failure");
  pending = deferred();
  await click(button("Save"));
  await act(async () => pending.resolve(Response.json({}, { status: 503 })));
  check(name().value === "Draft after save failure" && !name().matches(":disabled"), "Failed save keeps draft and unlocks editor");

  await rename("Keep on failed logout");
  await fromMenu(account(), "Sign out");
  await click(button("Discard and continue"));
  check(text().includes("session may still be active") && name().value === "Keep on failed logout", "HTTP logout failure preserves draft and warns");
  check(Boolean(account()), "HTTP logout failure retains signed-in UI");
  logoutFailure = "network";
  await fromMenu(account(), "Sign out");
  await click(button("Discard and continue"));
  check(text().includes("session may still be active") && name().value === "Keep on failed logout", "Network logout failure preserves draft and warns");

  pending = deferred();
  await chooseWorkspace("Business b");
  await click(button("Discard and continue"));
  await act(async () => pending.resolve(Response.json({}, { status: 503 })));
  check(name().value === "Keep on failed logout" && !name().matches(":disabled"), "Failed load keeps draft and unlocks editor");

  // P5-02 activity log & workspace deletion with backup disclosure checks
  auditPending = deferred();
  await click(button("Refresh"));
  check(calls.some(call => call.startsWith("GET /api/audit-events")), "Activity log fetches owner audit events");
  await act(async () => auditPending.resolve(Response.json([{
    id: "ev-1", owner_id: "owner", action: "report_generated", resource_type: "report",
    resource_id: "r2", business_id: "a", details: { report_version: 2 }, created_at: "2026-11-21T15:00:00Z",
  }])));
  check(text().includes("report_generated") && text().includes("Financial figures are never logged"), "Activity log renders minimal audit events");

  await fromMenu(switcher(), "Delete business");
  check(text().includes("Backup limitation") && text().includes("not immediately purged"), "Delete workspace confirmation discloses backup retention limits");
  await click(button("Cancel"));
  await settled(() => !document.querySelector('[role="alertdialog"]'));
  check(!text().includes("Delete business permanently"), "Cancelling delete keeps workspace intact");

  reportPending = deferred();
  await click(button("Viewing"));
  await fromMenu(switcher(), "Delete business");
  pending = deferred();
  auditPending = deferred();
  await click(button("Delete business permanently"));
  check(calls.includes("DELETE /api/businesses/a"), "Confirmed workspace deletion sends DELETE /api/businesses/{id}");
  await act(async () => {
    pending.resolve(Response.json({
      status: "deleted", business_id: "a", documents_removed: 1, runs_removed: 2, revisions_removed: 2,
      chat_note: "Q&A turns are request-scoped.",
      backup_notice: "Active workspace data deleted; external backups are not immediately purged.",
    }));
    auditPending.resolve(Response.json([{
      id: "ev-2", owner_id: "owner", action: "workspace_deleted", resource_type: "workspace",
      resource_id: "a", business_id: "a", details: { documents_removed: 1 }, created_at: "2026-11-21T15:05:00Z",
    }]));
  });
  check(name().value === "" && text().includes("not immediately purged") && text().includes("workspace_deleted"), "Workspace deletion clears form, discloses backup limits, and logs workspace_deleted");
  check(reportSignal?.aborted, "Deleting a workspace aborts its pending report request");
  pending = deferred();
  await chooseWorkspace("Business b");
  await act(async () => pending.resolve(Response.json(workspace("b", "Business b"))));
  await act(async () => reportPending.resolve(Response.json(historicalReport)));
  check(!document.querySelector("#preparation-report-sheet"), "A late report cannot open in another workspace");

  await rename("Temporary draft");
  await fromMenu(switcher(), "New business");
  await click(button("Discard and continue"));
  check(name().value === "", "Confirmed new workspace clears draft");
  await rename("Last draft");
  logoutFailure = null;
  await fromMenu(account(), "Sign out");
  await click(button("Discard and continue"));
  check(!name() && Boolean(document.querySelector("#auth-email")) && text().includes("Signed out. Entries were cleared"), "Successful logout returns to sign-in and confirms success");

  const analysesBeforeGuest = calls.filter(call => call === "POST /api/analysis").length;
  const callsBeforeGuest = calls.length;
  await click(button("Continue as guest"));
  check(name()?.value === "Aster Components (fictional)" && text().includes("24/24"), "Guest demo opens the fictional company with confirmed figures");
  check(calls.filter(call => call === "POST /api/analysis").length === analysesBeforeGuest + 1, "Guest demo runs the stateless analysis once");
  check(calls.slice(callsBeforeGuest).every(call => call === "POST /api/analysis"), "Guest demo creates no server data");
  await fromMenu(account(), "Exit demo");
  check(!name() && Boolean(document.querySelector("#auth-email")), "Exiting the demo returns to sign-in");
  await act(async () => root.unmount());
}
run().then(() => {
  document.body.innerHTML = "";
  const result = document.createElement("pre");
  result.id = "result";
  result.textContent = `PASS (${checks.length} checks)\n${checks.join("\n")}`;
  document.body.append(result);
}, error => {
  const result = document.createElement("pre");
  result.id = "result";
  result.textContent = `FAIL: ${error.stack}\nCompleted: ${checks.join("; ")}`;
  document.body.prepend(result);
});
