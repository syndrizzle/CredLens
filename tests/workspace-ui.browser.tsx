// Bundle for a headless browser; see README for the dependency-free run command.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ManualEntry } from "../src/features/manual-entry/ManualEntry";
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
const restoration = deferred();
let logoutFailure: "http" | "network" | null = "http";
const calls: string[] = [];
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
  return path.endsWith("/analysis") ? analysisPending.promise : pending.promise;
};
async function chooseWorkspace(label: string) {
  await click(document.querySelector<HTMLButtonElement>('button[role="combobox"]')!);
  const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(el => el.textContent?.includes(label));
  if (!item) throw new Error(`Missing option: ${label}`);
  await click(item);
}

async function run() {
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<ManualEntry />));
  check(name().matches(":disabled"), "Session restoration locks competing account actions");
  await act(async () => restoration.resolve(Response.json({ owner_id: "owner", email: "owner@example.com" })));
  await rename("Unsaved draft");
  await click(button("New workspace"));
  check(name().value === "Unsaved draft", "New workspace waits for confirmation");
  await click(button("Keep editing"));
  check(name().value === "Unsaved draft", "Cancel keeps draft");

  await chooseWorkspace("Business a");
  check(!calls.includes("GET /api/businesses/a"), "Switch waits for confirmation before fetching");
  await click(button("Keep editing"));
  check(name().value === "Unsaved draft", "Cancelled switch keeps draft");

  await act(async () => {
    button("Save workspace").click();
    button("Save workspace").click();
  });
  check(calls.filter(call => call === "POST /api/businesses").length === 1, "Same-turn double save sends one request");
  check(name().matches(":disabled"), "Name locked during save");
  check(document.querySelector('input[id^="figure-"]')?.matches(":disabled"), "Figures locked during save");
  check(button("New workspace").matches(":disabled"), "Replacement locked during save");
  check(document.querySelector('button[role="combobox"]')?.matches(":disabled"), "Selection locked during save");
  const count = calls.length;
  await click(button("New workspace"));
  await click(button("Sign out"));
  check(calls.length === count, "Pending save prevents competing requests");
  await act(async () => pending.resolve(Response.json(workspace("saved", "Unsaved draft"))));
  check(!name().matches(":disabled") && name().value === "Unsaved draft", "Save unlocks its original draft");

  pending = deferred();
  await chooseWorkspace("Business a");
  check(name().matches(":disabled"), "Name locked during load");
  const select = document.querySelector<HTMLButtonElement>('button[role="combobox"]')!;
  await click(select);
  check(!document.querySelector('[role="option"]'), "Pending load prevents another selection");
  await act(async () => pending.resolve(Response.json(workspace("a", "Business a"))));
  check(name().value === "Business a", "Load applies selected workspace");

  analysisPending = deferred();
  await click(button("Analyse figures"));
  check(name().matches(":disabled"), "Editor locked during saved analysis");
  await act(async () => analysisPending.resolve(Response.json(workspace("a", "Business a"))));
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

  await rename("Draft with revision conflict");
  pending = deferred();
  await click(button("Save workspace"));
  await act(async () => pending.resolve(Response.json({ detail: "Workspace has been updated in another session; reload before saving" }, { status: 409 })));
  check(name().value === "Draft with revision conflict" && text().includes("updated in another session") && !name().matches(":disabled"), "409 conflict preserves draft and warns user");

  await rename("Draft after save failure");
  pending = deferred();
  await click(button("Save workspace"));
  await act(async () => pending.resolve(Response.json({}, { status: 503 })));
  check(name().value === "Draft after save failure" && !name().matches(":disabled"), "Failed save keeps draft and unlocks editor");

  await rename("Keep on failed logout");
  await click(button("Sign out"));
  await click(button("Discard and continue"));
  check(text().includes("session may still be active") && name().value === "Keep on failed logout", "HTTP logout failure preserves draft and warns");
  check(Boolean(button("Sign out")), "HTTP logout failure retains signed-in UI");
  logoutFailure = "network";
  await click(button("Sign out"));
  await click(button("Discard and continue"));
  check(text().includes("session may still be active") && name().value === "Keep on failed logout", "Network logout failure preserves draft and warns");

  pending = deferred();
  await chooseWorkspace("Business b");
  await click(button("Discard and continue"));
  await act(async () => pending.resolve(Response.json({}, { status: 503 })));
  check(name().value === "Keep on failed logout" && !name().matches(":disabled"), "Failed load keeps draft and unlocks editor");
  await click(button("New workspace"));
  await click(button("Discard and continue"));
  check(name().value === "", "Confirmed new workspace clears draft");
  await rename("Last draft");
  logoutFailure = null;
  await click(button("Sign out"));
  await click(button("Discard and continue"));
  check(name().value === "" && text().includes("Signed out. Workspace entries cleared"), "Successful logout clears draft and confirms success");
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
