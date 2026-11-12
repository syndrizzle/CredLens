import { AnalysisResults } from "../analysis/AnalysisResults";
import {
  analyseWorkspace,
  fetchBusinesses,
  fetchSession,
  fetchWorkspace,
  saveWorkspace,
  signOut,
  submitCredentials,
  updateWorkspace,
  type AnalysisResponse,
  type AnalysisRunSummary,
  type BusinessSummary,
  type SessionUser,
  type WorkspaceResponse,
} from "../analysis/api";
import { useAnalysis } from "../analysis/use-analysis";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  AiSparklesIcon,
  Alert02Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FIELD_GROUPS,
  FINANCIAL_FIELDS,
  UNIT_ITEMS,
  YEAR_ITEMS,
  countReview,
  createEmptyForm,
  createExampleForm,
  createPeriod,
  financialYearLabel,
  firstErrorId,
  formFromRequest,
  hasEntries,
  hasErrors,
  immediatePrior,
  nextPeriodYear,
  presentFigures,
  resetBrokenComparability,
  resetReview,
  sortedPeriods,
  unitLabel,
  validateForm,
  type FieldDefinition,
  type FinancialFieldKey,
  type FormDraft,
  type FormErrors,
  type PeriodDraft,
  type Unit,
} from "./model";

const EMPTY_ERRORS: FormErrors = { years: {}, figures: {} };
type Replacement = { type: "load"; id: string } | { type: "new" } | { type: "signout" };

function ManualEntry() {
  const [form, setForm] = useState<FormDraft>(createEmptyForm);
  const [showErrors, setShowErrors] = useState(false);
  const [confirmExample, setConfirmExample] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [session, setSession] = useState<SessionUser | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [businesses, setBusinesses] = useState<BusinessSummary[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<{
    id: string;
    revision: number;
    form: FormDraft;
    analysis: AnalysisResponse | null;
    runs: AnalysisRunSummary[];
  } | null>(null);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [replacement, setReplacement] = useState<Replacement | null>(null);
  const actionPending = useRef(true);
  const actionsDisabled = checkingSession || authBusy || workspaceBusy;

  const analysis = useAnalysis(form);
  const periods = sortedPeriods(form.periods);
  const errors = showErrors ? validateForm(form) : EMPTY_ERRORS;
  const counts = countReview(form.periods);
  const allPresentReviewed =
    counts.present > 0 && counts.reviewed === counts.present;
  const savedClean = activeWorkspace !== null && activeWorkspace.form === form;
  const displayedAnalysis =
    savedClean && activeWorkspace.analysis && !analysis.data
      ? activeWorkspace.analysis
      : analysis.data;

  useEffect(() => {
    let active = true;
    fetchSession()
      .then((user) => {
        if (!active || !user) return;
        setSession(user);
        return fetchBusinesses().then((items) => {
          if (active) setBusinesses(items);
        });
      })
      .catch(() => {})
      .finally(() => {
        if (active) {
          actionPending.current = false;
          setCheckingSession(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  function applyWorkspace(workspace: WorkspaceResponse, message: string) {
    setReplacement(null);
    const nextForm = formFromRequest(workspace.request);
    setForm(nextForm);
    setActiveWorkspace({
      id: workspace.business_id,
      revision: workspace.input_revision,
      form: nextForm,
      analysis: workspace.latest_analysis,
      runs: workspace.runs ?? [],
    });
    setBusinesses((current) => {
      const summary: BusinessSummary = {
        id: workspace.business_id,
        business_name: workspace.request.business_name,
        input_revision: workspace.input_revision,
      };
      return [
        summary,
        ...current.filter((item) => item.id !== workspace.business_id),
      ];
    });
    setShowErrors(false);
    setConfirmExample(false);
    setWorkspaceError(null);
    setNotice(message);
  }

  async function handleAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actionPending.current) return;
    actionPending.current = true;
    setAuthBusy(true);
    setAuthError(null);
    try {
      const user = await submitCredentials(authMode, email, password);
      const items = await fetchBusinesses();
      setSession(user);
      setBusinesses(items);
      setPassword("");
      setNotice(`Signed in as ${user.email}.`);
    } catch (error) {
      setAuthError(
        error instanceof Error ? error.message : "Authentication failed.",
      );
    } finally {
      actionPending.current = false;
      setAuthBusy(false);
    }
  }

  async function handleSignOut() {
    if (actionPending.current) return;
    actionPending.current = true;
    setAuthBusy(true);
    setWorkspaceError(null);
    try {
      await signOut();
      setSession(null);
      setBusinesses([]);
      setActiveWorkspace(null);
      setWorkspaceError(null);
      setAuthError(null);
      setForm(createEmptyForm());
      setReplacement(null);
      setNotice("Signed out. Workspace entries cleared from this browser.");
    } catch {
      setWorkspaceError("Sign out could not be confirmed. Your session may still be active. Your entries are kept; please retry.");
    } finally {
      actionPending.current = false;
      setAuthBusy(false);
    }
  }

  async function handleSelectWorkspace(businessId: string) {
    if (actionPending.current) return;
    actionPending.current = true;
    setWorkspaceBusy(true);
    setWorkspaceError(null);
    try {
      const workspace = await fetchWorkspace(businessId);
      applyWorkspace(
        workspace,
        `Loaded saved workspace "${workspace.request.business_name}".`,
      );
    } catch (error) {
      setWorkspaceError(
        error instanceof Error ? error.message : "Could not load workspace.",
      );
    } finally {
      actionPending.current = false;
      setWorkspaceBusy(false);
    }
  }

  async function handleSaveWorkspace() {
    if (actionPending.current) return;
    const nextErrors = validateForm(form);
    if (hasErrors(nextErrors)) {
      setShowErrors(true);
      setNotice(null);
      const target = firstErrorId(nextErrors, form);
      if (target) {
        requestAnimationFrame(() => document.getElementById(target)?.focus());
      }
      return;
    }
    actionPending.current = true;
    setWorkspaceBusy(true);
    setWorkspaceError(null);
    try {
      const workspace = activeWorkspace
        ? await updateWorkspace(activeWorkspace.id, activeWorkspace.revision, form)
        : await saveWorkspace(form);
      applyWorkspace(
        workspace,
        `Saved workspace "${workspace.request.business_name}".`,
      );
    } catch (error) {
      setWorkspaceError(
        error instanceof Error ? error.message : "Could not save workspace.",
      );
    } finally {
      actionPending.current = false;
      setWorkspaceBusy(false);
    }
  }

  function startNewWorkspace() {
    setReplacement(null);
    setForm(createEmptyForm());
    setActiveWorkspace(null);
    setShowErrors(false);
    setConfirmExample(false);
    setWorkspaceError(null);
    setNotice("Started a new unsaved workspace draft.");
  }

  function requestReplacement(action: Replacement) {
    if (actionPending.current) return;
    if (!savedClean && (activeWorkspace !== null || hasEntries(form))) {
      setReplacement(action);
      return;
    }
    replaceDraft(action);
  }

  function replaceDraft(action: Replacement) {
    if (actionPending.current) return;
    setReplacement(null);
    if (action.type === "load") void handleSelectWorkspace(action.id);
    else if (action.type === "signout") void handleSignOut();
    else startNewWorkspace();
  }

  function updateBusinessName(businessName: string) {
    setForm((current) => ({ ...current, businessName }));
    setNotice(null);
  }

  function updateFigure(
    periodId: string,
    field: FinancialFieldKey,
    raw: string,
  ) {
    setForm((current) => ({
      ...current,
      periods: current.periods.map((period) =>
        period.id === periodId
          ? {
              ...period,
              figures: {
                ...period.figures,
                [field]: { raw, reviewed: false, revision: (period.figures[field].revision ?? 1) + 1 },
              },
            }
          : period,
      ),
    }));
    setNotice(null);
  }

  function updatePeriodYear(periodId: string, yearStart: number) {
    setForm((current) => {
      const nextPeriods = current.periods.map((period) =>
        period.id === periodId
          ? {
              ...period,
              yearStart,
              comparableToPrior: false,
              figures: resetReview(period.figures),
            }
          : period,
      );
      return {
        ...current,
        periods: resetBrokenComparability(nextPeriods),
      };
    });
    setNotice(
      "Financial year changed. Entered amounts were kept and marked unreviewed.",
    );
  }

  function updatePeriodUnit(periodId: string, unit: Unit) {
    setForm((current) => ({
      ...current,
      periods: current.periods.map((period) =>
        period.id === periodId
          ? { ...period, unit, figures: resetReview(period.figures) }
          : period,
      ),
    }));
    setNotice(
      "Unit changed. Entered amounts were kept and marked unreviewed.",
    );
  }

  function updateComparable(periodId: string, comparableToPrior: boolean) {
    setForm((current) => ({
      ...current,
      periods: current.periods.map((period) =>
        period.id === periodId ? { ...period, comparableToPrior } : period,
      ),
    }));
    setNotice(null);
  }

  function addPeriod() {
    setForm((current) => {
      if (current.periods.length >= 3) return current;
      return {
        ...current,
        periods: [...current.periods, createPeriod(nextPeriodYear(current.periods))],
      };
    });
    setNotice(null);
  }

  function removePeriod(periodId: string) {
    setForm((current) => {
      if (current.periods.length <= 1) return current;
      const remaining = current.periods.filter(
        (period) => period.id !== periodId,
      );
      return {
        ...current,
        periods: resetBrokenComparability(remaining),
      };
    });
    setNotice(null);
  }

  function loadExample() {
    if (hasEntries(form)) {
      setConfirmExample(true);
      return;
    }
    applyExample();
  }

  function applyExample() {
    setReplacement(null);
    setForm(createExampleForm());
    setActiveWorkspace(null);
    setShowErrors(false);
    setConfirmExample(false);
    setNotice(
      "Loaded the fictional example. Figures are unreviewed; check them before confirming.",
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (counts.present === 0) {
      setNotice("Enter at least one figure before confirming.");
      return;
    }

    const nextErrors = validateForm(form);
    if (hasErrors(nextErrors)) {
      setShowErrors(true);
      setNotice(null);
      const target = firstErrorId(nextErrors, form);
      if (target) {
        requestAnimationFrame(() => document.getElementById(target)?.focus());
      }
      return;
    }

    setShowErrors(false);
    setForm((current) => ({
      ...current,
      periods: current.periods.map((period) => ({
        ...period,
        figures: Object.fromEntries(
          FINANCIAL_FIELDS.map((field) => {
            const figure = period.figures[field.key];
            return [
              field.key,
              { ...figure, reviewed: figure.raw.trim() !== "" },
            ];
          }),
        ) as PeriodDraft["figures"],
      })),
    }));
    setNotice(
      `Confirmed ${counts.present} present ${
        counts.present === 1 ? "figure" : "figures"
      }. Editing a figure marks it unreviewed.`,
    );
  }

  async function analyseFigures() {
    if (actionPending.current) return;
    const nextErrors = validateForm(form);
    setShowErrors(true);
    if (hasErrors(nextErrors)) {
      const target = firstErrorId(nextErrors, form);
      if (target) requestAnimationFrame(() => document.getElementById(target)?.focus());
      return;
    }
    if (session) {
      actionPending.current = true;
      setWorkspaceBusy(true);
      setWorkspaceError(null);
      try {
        let targetId: string;
        if (savedClean) {
          targetId = activeWorkspace.id;
        } else {
          const saved = activeWorkspace
            ? await updateWorkspace(activeWorkspace.id, activeWorkspace.revision, form)
            : await saveWorkspace(form);
          applyWorkspace(
            saved,
            `Saved workspace "${saved.request.business_name}".`,
          );
          targetId = saved.business_id;
        }
        const workspace = await analyseWorkspace(targetId);
        applyWorkspace(
          workspace,
          `Saved and analysed workspace "${workspace.request.business_name}".`,
        );
      } catch (error) {
        setWorkspaceError(
          error instanceof Error ? error.message : "Could not analyse workspace.",
        );
      } finally {
        actionPending.current = false;
        setWorkspaceBusy(false);
      }
      return;
    }
    analysis.run();
  }

  return (
    <main className="min-h-screen bg-muted/30">
      <fieldset disabled={actionsDisabled} className="mx-auto flex min-w-0 max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 lg:py-12" aria-label="Financial health workspace">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium text-primary">CredLens</p>
            <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
              Financial health review
            </h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Enter one to three completed financial years, check the figures,
              and confirm them. Sign in to save and reload owner-protected
              workspaces.
            </p>
          </div>
          <Badge variant={savedClean ? "secondary" : "outline"}>
            {savedClean
              ? `Saved · Rev ${activeWorkspace.revision}`
              : session
                ? "Unsaved draft"
                : "Not saved"}
          </Badge>
        </header>

        <Card>
          <CardHeader>
            <CardTitle>
              {session ? "Protected workspace" : "Account and saved workspaces"}
            </CardTitle>
            <CardDescription>
              {session
                ? `Signed in as ${session.email}. Workspaces and analysis runs are scoped to your account.`
                : "Sign in or create a local account to save businesses and reload analyses across sessions."}
            </CardDescription>
            {session ? (
              <CardAction>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => requestReplacement({ type: "signout" })}
                  disabled={authBusy || workspaceBusy}
                >
                  Sign out
                </Button>
              </CardAction>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-4">
            {checkingSession ? <p role="status" className="text-sm text-muted-foreground">Checking saved session…</p> : null}
            {session ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-64 flex-1 space-y-1.5">
                    <Label htmlFor="workspace-select">Saved businesses</Label>
                    <Select<string>
                      disabled={actionsDisabled}
                      id="workspace-select"
                      items={businesses.map((item) => ({
                        value: item.id,
                        label: `${item.business_name} (Rev ${item.input_revision})`,
                      }))}
                      value={activeWorkspace?.id ?? ""}
                      onValueChange={(value) => {
                        if (value) requestReplacement({ type: "load", id: value });
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue
                          placeholder={
                            businesses.length === 0
                              ? "No saved businesses yet"
                              : "Select a saved business"
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {businesses.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.business_name} (Rev {item.input_revision})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleSaveWorkspace}
                    disabled={workspaceBusy || savedClean}
                  >
                    {workspaceBusy
                      ? "Saving…"
                      : savedClean
                        ? "Workspace saved"
                        : "Save workspace"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => requestReplacement({ type: "new" })}
                    disabled={workspaceBusy}
                  >
                    New workspace
                  </Button>
                </div>
                {replacement ? (
                  <div role="group" aria-label="Discard unsaved entries?" className="rounded-lg border border-border bg-muted/50 p-3">
                    <p className="text-sm font-medium">Discard unsaved entries?</p>
                    <p className="mt-1 text-sm text-muted-foreground">Continuing will replace your current draft. Save it first if you want to keep it.</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button type="button" variant="destructive" size="sm" onClick={() => replaceDraft(replacement)}>Discard and continue</Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => setReplacement(null)}>Keep editing</Button>
                    </div>
                  </div>
                ) : null}
                {workspaceError ? (
                  <Alert variant="destructive">
                    <HugeiconsIcon icon={Alert02Icon} />
                    <AlertTitle>Workspace action failed</AlertTitle>
                    <AlertDescription className="col-start-2">
                      {workspaceError}
                    </AlertDescription>
                  </Alert>
                ) : null}
              </div>
            ) : (
              <form onSubmit={handleAuth} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="auth-email">Email</Label>
                    <Input
                      id="auth-email"
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      autoComplete="email"
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="auth-password">Password</Label>
                    <Input
                      id="auth-password"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete={
                        authMode === "register"
                          ? "new-password"
                          : "current-password"
                      }
                      minLength={12}
                      maxLength={128}
                      required
                    />
                    <p className="text-xs text-muted-foreground">
                      Use 12 to 128 characters.
                    </p>
                  </div>
                </div>
                {authError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {authError}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" size="sm" disabled={authBusy}>
                    {authBusy
                      ? "Submitting…"
                      : authMode === "register"
                        ? "Create account"
                        : "Sign in"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setAuthMode((current) =>
                        current === "login" ? "register" : "login",
                      );
                      setAuthError(null);
                    }}
                  >
                    {authMode === "login"
                      ? "Need an account? Create one"
                      : "Already have an account? Sign in"}
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>

        {!session ? (
          <Alert role="status">
            <HugeiconsIcon icon={InformationCircleIcon} />
            <AlertTitle>Prototype data is not saved</AlertTitle>
            <AlertDescription className="col-start-2">
              Without signing in, reloading the page clears every entry. Use
              fictional data until private-data protection is verified. Figures
              are confirmed manually and are not authenticated.
            </AlertDescription>
          </Alert>
        ) : null}


        {showErrors && hasErrors(errors) ? (
          <Alert variant="destructive">
            <HugeiconsIcon icon={Alert02Icon} />
            <AlertTitle>Check the highlighted fields</AlertTitle>
            <AlertDescription className="col-start-2">
              Your entries are kept. Fix the fields marked below, then confirm
              again.
            </AlertDescription>
          </Alert>
        ) : null}

        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Start with a fictional example</CardTitle>
              <CardDescription>
                Aster Components (fictional) · FY 2023-24 and FY 2024-25 · INR
                rupees. Example only; not a real business or lending benchmark.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button type="button" variant="outline" onClick={loadExample}>
                <HugeiconsIcon icon={AiSparklesIcon} data-icon="inline-start" />
                Load fictional example
              </Button>
              <p className="text-xs text-muted-foreground">
                Loading replaces current entries after confirmation. Example
                figures start unreviewed.
              </p>
              {confirmExample ? (
                <div className="rounded-lg border border-border bg-muted/50 p-3">
                  <p className="text-sm font-medium">Replace current entries?</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    This will replace the business name, years, units, and figures
                    you have entered.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={applyExample}
                    >
                      Replace entries
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmExample(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Business details</CardTitle>
              <CardDescription>
                Currency INR · Standalone basis · April–March financial years
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="max-w-md space-y-2">
                <Label htmlFor="business-name">Business name</Label>
                <Input
                  id="business-name"
                  value={form.businessName}
                  onChange={(event) => updateBusinessName(event.target.value)}
                  maxLength={120}
                  autoComplete="organization"
                  aria-invalid={errors.businessName ? true : undefined}
                  aria-describedby={
                    errors.businessName ? "business-name-error" : undefined
                  }
                />
                {errors.businessName ? (
                  <p id="business-name-error" className="text-sm text-destructive">
                    {errors.businessName}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    The name is context only; it is not used in any calculation.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <section className="space-y-4" aria-labelledby="periods-heading">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="space-y-1">
                <h2
                  id="periods-heading"
                  className="font-heading text-2xl font-semibold"
                >
                  Financial years
                </h2>
                <p className="text-sm text-muted-foreground">
                  Add one to three completed years. Leave any figure blank if it
                  is missing.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={addPeriod}
                disabled={form.periods.length >= 3}
              >
                <HugeiconsIcon icon={Add01Icon} data-icon="inline-start" />
                Add year
              </Button>
            </div>

            {periods.map((period) => (
              <PeriodCard
                key={period.id}
                period={period}
                periods={form.periods}
                errors={errors}
                canRemove={form.periods.length > 1}
                disabled={actionsDisabled}
                onRemove={() => removePeriod(period.id)}
                onYearChange={(yearStart) =>
                  updatePeriodYear(period.id, yearStart)
                }
                onUnitChange={(unit) => updatePeriodUnit(period.id, unit)}
                onComparableChange={(checked) =>
                  updateComparable(period.id, checked)
                }
                onFigureChange={(field, raw) =>
                  updateFigure(period.id, field, raw)
                }
              />
            ))}
          </section>

          <Card>
            <CardHeader>
              <CardTitle>Review and confirm</CardTitle>
              <CardDescription>
                Check the business, year, unit, and entered amounts. Confirmation
                means you checked the entry; it does not authenticate the figures.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
                <p>
                  <span className="font-medium">Business:</span>{" "}
                  {form.businessName.trim() || "Not entered"}
                </p>
                <p className="text-muted-foreground">
                  INR · Standalone basis · April–March years
                </p>
              </div>

              {periods.map((period) => (
                <ReviewPeriod key={period.id} period={period} />
              ))}

              <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
                <Button
                  type="submit"
                  disabled={counts.present === 0 || allPresentReviewed}
                >
                  <HugeiconsIcon
                    icon={CheckmarkCircle02Icon}
                    data-icon="inline-start"
                  />
                  Confirm present figures
                </Button>
                <p className="text-sm text-muted-foreground">
                  {counts.present === 0
                    ? "No figures entered yet."
                    : `${counts.reviewed} of ${counts.present} present figures confirmed.`}
                </p>
              </div>

              {notice ? (
                <p
                  role="status"
                  aria-live="polite"
                  className="text-sm font-medium text-foreground"
                >
                  {notice}
                </p>
              ) : null}
            </CardContent>
          </Card>
        </form>

        <section
          className="space-y-4"
          aria-label="Run analysis"
          aria-busy={analysis.loading || workspaceBusy}
        >
          <Button
            type="button"
            onClick={() => void analyseFigures()}
            disabled={analysis.loading || workspaceBusy}
          >
            {analysis.loading || workspaceBusy
              ? "Analysing…"
              : analysis.error
                ? "Retry analysis"
                : "Analyse figures"}
          </Button>
          <p className="text-sm text-muted-foreground">
            Unconfirmed or missing inputs remain visible as evidence gaps.
            Analysis does not confirm entries for you.
          </p>
          <p role="status" aria-live="polite">
            {analysis.loading || workspaceBusy
              ? "Calculating from the submitted figures…"
              : analysis.stale ||
                  (activeWorkspace !== null &&
                    activeWorkspace.form !== form &&
                    activeWorkspace.analysis !== null)
                ? "Entries changed. Previous results are hidden; review and analyse again."
                : savedClean &&
                    activeWorkspace.analysis === null &&
                    activeWorkspace.runs.some((run) => run.superseded)
                  ? `Saved revision ${activeWorkspace.revision} supersedes earlier analysis runs. Review and analyse again to refresh results.`
                  : displayedAnalysis
                    ? "Analysis complete."
                    : ""}
          </p>
          {analysis.error ? (
            <Alert variant="destructive">
              <AlertTitle>Analysis could not complete</AlertTitle>
              <AlertDescription>
                {analysis.error} Your entries are kept.
              </AlertDescription>
            </Alert>
          ) : null}
        </section>
        {displayedAnalysis ? (
          <AnalysisResults
            data={displayedAnalysis}
            businessName={form.businessName}
            inputRevision={savedClean ? activeWorkspace.revision : undefined}
            runs={savedClean ? activeWorkspace.runs : undefined}
          />
        ) : null}

        <footer className="space-y-1 pb-4 text-xs text-muted-foreground">
          <p>
            Phase 2 protected workspaces · Financial rules are provisional
            pending finance-reviewer validation.
          </p>
          <p>
            Cash generation is not assessed; no cash-flow statement is entered
            in this workflow. Borrowings exclude leases and count current
            maturities once.
          </p>
        </footer>
      </fieldset>
    </main>
  );
}

type PeriodCardProps = {
  disabled: boolean;
  period: PeriodDraft;
  periods: PeriodDraft[];
  errors: FormErrors;
  canRemove: boolean;
  onRemove: () => void;
  onYearChange: (yearStart: number) => void;
  onUnitChange: (unit: Unit) => void;
  onComparableChange: (checked: boolean) => void;
  onFigureChange: (field: FinancialFieldKey, raw: string) => void;
};

function PeriodCard({
  disabled,
  period,
  periods,
  errors,
  canRemove,
  onRemove,
  onYearChange,
  onUnitChange,
  onComparableChange,
  onFigureChange,
}: PeriodCardProps) {
  const prior = immediatePrior(periods, period);
  const usedYears = new Set(
    periods
      .filter((candidate) => candidate.id !== period.id)
      .map((candidate) => candidate.yearStart),
  );
  const yearError = errors.years[period.id];
  const presentCount = presentFigures(period).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{financialYearLabel(period.yearStart)}</CardTitle>
        <CardDescription>
          {unitLabel(period.unit)} · {presentCount} of {FINANCIAL_FIELDS.length}{" "}
          figures entered
        </CardDescription>
        <CardAction>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRemove}
            disabled={!canRemove}
            aria-label={`Remove ${financialYearLabel(period.yearStart)}`}
          >
            <HugeiconsIcon icon={Delete02Icon} data-icon="inline-start" />
            Remove
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`year-${period.id}`}>Financial year</Label>
            <Select<number>
              disabled={disabled}
              id={`year-${period.id}`}
              items={YEAR_ITEMS}
              value={period.yearStart}
              onValueChange={(value) => {
                if (value !== null) onYearChange(value);
              }}
            >
              <SelectTrigger
                className="w-full"
                aria-invalid={yearError ? true : undefined}
                aria-describedby={
                  yearError
                    ? `year-${period.id}-error`
                    : `year-${period.id}-hint`
                }
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {YEAR_ITEMS.map((item) => (
                  <SelectItem
                    key={item.value}
                    value={item.value}
                    disabled={usedYears.has(item.value)}
                  >
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {yearError ? (
              <p
                id={`year-${period.id}-error`}
                className="text-sm text-destructive"
              >
                {yearError}
              </p>
            ) : (
              <p
                id={`year-${period.id}-hint`}
                className="text-xs text-muted-foreground"
              >
                1 April {period.yearStart} – 31 March {period.yearStart + 1}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor={`unit-${period.id}`}>Amount unit</Label>
            <Select<Unit>
              disabled={disabled}
              id={`unit-${period.id}`}
              items={UNIT_ITEMS}
              value={period.unit}
              onValueChange={(value) => {
                if (value !== null) onUnitChange(value);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UNIT_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              All amounts for this year use this unit.
            </p>
          </div>
        </div>

        {prior ? (
          <div className="flex items-start gap-2">
            <Checkbox
              id={`comparable-${period.id}`}
              checked={period.comparableToPrior}
              onCheckedChange={(checked) =>
                onComparableChange(checked === true)
              }
            />
            <div className="space-y-1">
              <Label
                htmlFor={`comparable-${period.id}`}
                className="leading-snug"
              >
                Comparable with {financialYearLabel(prior.yearStart)}
              </Label>
              <p className="text-xs text-muted-foreground">
                Confirm both years use a consistent standalone basis.
                Unconfirmed comparability blocks revenue growth only.
              </p>
            </div>
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
            No immediately preceding year entered. Revenue growth will be not
            assessed for this year.
          </p>
        )}

        {FIELD_GROUPS.map((group) => (
          <fieldset key={group.title} className="space-y-3">
            <legend className="text-sm font-medium">{group.title}</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              {group.fields.map((field) => (
                <FigureField
                  key={field.key}
                  periodId={period.id}
                  field={field}
                  figure={period.figures[field.key]}
                  error={errors.figures[`${period.id}:${field.key}`]}
                  onValueChange={(raw) => onFigureChange(field.key, raw)}
                />
              ))}
            </div>
            {group.title === "Borrowings" ? (
              <p className="text-xs text-muted-foreground">
                Enter all three components, using 0 where none exist. Leases are
                excluded and current maturities are counted once.
              </p>
            ) : null}
          </fieldset>
        ))}
      </CardContent>
    </Card>
  );
}

type FigureFieldProps = {
  periodId: string;
  field: FieldDefinition;
  figure: { raw: string; reviewed: boolean };
  error: string | undefined;
  onValueChange: (raw: string) => void;
};

function FigureField({
  periodId,
  field,
  figure,
  error,
  onValueChange,
}: FigureFieldProps) {
  const inputId = `figure-${periodId}-${field.key}`;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy = error ? `${hintId} ${errorId}` : hintId;

  return (
    <div className="space-y-1.5">
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-2">
        <Label htmlFor={inputId} className="leading-snug">
          {field.label}
        </Label>
        {figure.raw.trim() ? (
          <Badge variant={figure.reviewed ? "secondary" : "outline"}>
            {figure.reviewed ? "Confirmed" : "Unreviewed"}
          </Badge>
        ) : null}
      </div>
      <Input
        id={inputId}
        value={figure.raw}
        onChange={(event) => onValueChange(event.target.value)}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        maxLength={64}
        placeholder="Leave blank if missing"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
      <p id={hintId} className="text-xs text-muted-foreground">
        {field.hint}
      </p>
      {error ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ReviewPeriod({ period }: { period: PeriodDraft }) {
  const present = presentFigures(period);
  const reviewed = present.filter(
    (field) => period.figures[field.key].reviewed,
  ).length;
  const missing = FINANCIAL_FIELDS.length - present.length;

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-heading text-base font-medium">
          {financialYearLabel(period.yearStart)}
        </h3>
        <p className="text-xs text-muted-foreground">
          {unitLabel(period.unit)} · {reviewed} of {present.length} present
          figures confirmed
        </p>
      </div>

      {present.length > 0 ? (
        <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
          {present.map((field) => {
            const figure = period.figures[field.key];
            return (
              <div
                key={field.key}
                className="flex items-start justify-between gap-3"
              >
                <dt className="text-sm text-muted-foreground">
                  {field.label}
                </dt>
                <dd className="flex shrink-0 flex-col items-end gap-1 text-right">
                  <span className="font-mono text-sm tabular-nums">
                    {figure.raw.trim()} {unitLabel(period.unit).toLowerCase()}
                  </span>
                  <Badge variant={figure.reviewed ? "secondary" : "outline"}>
                    {figure.reviewed ? "Confirmed" : "Unreviewed"}
                  </Badge>
                </dd>
              </div>
            );
          })}
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">
          No figures entered for this year.
        </p>
      )}

      {missing > 0 ? (
        <p className="text-xs text-muted-foreground">
          {missing} {missing === 1 ? "figure is" : "figures are"} not entered.
          Missing values are allowed and block only dependent indicators.
        </p>
      ) : null}
    </div>
  );
}

export { ManualEntry };
