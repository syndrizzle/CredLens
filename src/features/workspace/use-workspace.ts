import {
  analyseWorkspace,
  deleteDocument,
  deleteWorkspace,
  fetchAuditEvents,
  fetchDocumentExtraction,
  fetchDocuments,
  fetchBusinesses,
  fetchSession,
  fetchWorkspace,
  retryDocument,
  runDocumentExtraction,
  saveWorkspace,
  signOut,
  submitCredentials,
  updateWorkspace,
  uploadDocument,
  type AnalysisResponse,
  type AnalysisRunSummary,
  type AuditEventSummary,
  type BusinessSummary,
  type DocumentExtractionResponse,
  type DocumentSummary,
  type PreparationReportResponse,
  type SessionUser,
  type WorkspaceResponse,
} from "@/features/analysis/api";
import { useAnalysis } from "@/features/analysis/use-analysis";
import type { HighlightedCell } from "@/features/documents/SourceReview";
import { createContext, useContext, useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SECTIONS, type Section } from "@/app/sections";
import {
  FINANCIAL_FIELDS,
  applyCandidatesToForm,
  countReview,
  createEmptyForm,
  createExampleForm,
  createPeriod,
  detachDocumentSource,
  financialYearLabel,
  firstErrorId,
  formFromRequest,
  hasEntries,
  hasErrors,
  isDocumentFigure,
  nextPeriodYear,
  resetBrokenComparability,
  resetReview,
  sortedPeriods,
  validateForm,
  type CandidateImport,
  type FinancialFieldKey,
  type FormDraft,
  type FormErrors,
  type PeriodDraft,
  type Unit,
} from "@/features/manual-entry/model";

const EMPTY_ERRORS: FormErrors = { years: {}, figures: {} };
type Replacement = { type: "load"; id: string } | { type: "new" } | { type: "signout" };

function useWorkspaceController(section?: Section) {
  const navigate = useNavigate();
  const pendingReveal = useRef<{ id: string; block: ScrollLogicalPosition } | null>(null);
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
    documents: DocumentSummary[];
  } | null>(null);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [reportResult, setActiveReport] =
    useState<PreparationReportResponse | null>(null);
  const activeReport = reportResult?.business_id === activeWorkspace?.id ? reportResult : null;
  const [confirmDeleteWorkspace, setConfirmDeleteWorkspace] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEventSummary[]>([]);
  const [documentBusy, setDocumentBusy] = useState(false);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [selectedPdf, setSelectedPdf] = useState<File | null>(null);
  const [activeReview, setActiveReview] = useState<DocumentExtractionResponse | null>(null);
  const [reviewPage, setReviewPage] = useState(1);
  const [highlightedCell, setHighlightedCell] = useState<HighlightedCell | null>(null);
  const [applyWarnings, setApplyWarnings] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [replacement, setReplacement] = useState<Replacement | null>(null);
  const actionPending = useRef(true);
  const actionsDisabled = checkingSession || authBusy || workspaceBusy || documentBusy;

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
    setActiveWorkspace((current) => {
      if (current && current.id !== workspace.business_id) {
        setActiveReview(null);
        setHighlightedCell(null);
        setApplyWarnings([]);
        setActiveReport(null);
        setConfirmDeleteWorkspace(false);
      }
      return {
        id: workspace.business_id,
        revision: workspace.input_revision,
        form: nextForm,
        analysis: workspace.latest_analysis,
        runs: workspace.runs ?? [],
        documents: workspace.documents ?? (current?.id === workspace.business_id ? current.documents : []),
      };
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
    setDocumentError(null);
    setNotice(message);
  }

  function revealPending() {
    const target = pendingReveal.current;
    const element = target && document.getElementById(target.id);
    if (!element || element.getClientRects().length === 0) return;
    pendingReveal.current = null;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: target.block });
    element.focus({ preventScroll: true });
  }
  // Targets in a hidden section become visible only after navigation re-renders.
  useEffect(revealPending);

  function reveal(id: string, target: Section, block: ScrollLogicalPosition = "center") {
    pendingReveal.current = { id, block };
    if (section && section !== target) {
      // Keep the router from resetting scroll to the top after the reveal starts.
      void navigate({ to: SECTIONS.find((item) => item.id === target)!.path, resetScroll: false });
    } else {
      requestAnimationFrame(revealPending);
    }
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
    setDocumentError(null);
    try {
      await signOut();
      setSession(null);
      setBusinesses([]);
      setActiveWorkspace(null);
      setActiveReview(null);
      setActiveReport(null);
      setConfirmDeleteWorkspace(false);
      setAuditOpen(false);
      setAuditEvents([]);
      setAuditError(null);
      setHighlightedCell(null);
      setApplyWarnings([]);
      setWorkspaceError(null);
      setDocumentError(null);
      setSelectedPdf(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
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

  async function handleDeleteWorkspace() {
    if (!activeWorkspace || actionPending.current) return;
    actionPending.current = true;
    setWorkspaceBusy(true);
    setWorkspaceError(null);
    setDocumentError(null);
    const targetId = activeWorkspace.id;
    const targetName = activeWorkspace.form.businessName;
    try {
      const deleted = await deleteWorkspace(targetId);
      setBusinesses((current) => current.filter((item) => item.id !== targetId));
      setActiveWorkspace(null);
      setActiveReview(null);
      setActiveReport(null);
      setHighlightedCell(null);
      setApplyWarnings([]);
      setConfirmDeleteWorkspace(false);
      setSelectedPdf(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setForm(createEmptyForm());
      setReplacement(null);
      setNotice(
        `Deleted workspace "${targetName}" (${deleted.documents_removed} PDFs, ${deleted.runs_removed} analysis runs/reports, ${deleted.revisions_removed} revisions removed). ${deleted.backup_notice}`,
      );
      if (auditOpen) {
        try {
          setAuditEvents(await fetchAuditEvents());
        } catch {
          // Keep deletion success even if activity log refresh fails.
        }
      }
    } catch (error) {
      setWorkspaceError(
        error instanceof Error ? error.message : "Could not delete workspace.",
      );
    } finally {
      actionPending.current = false;
      setWorkspaceBusy(false);
    }
  }

  async function handleToggleAuditLog() {
    if (auditOpen) {
      setAuditOpen(false);
      return;
    }
    setAuditOpen(true);
    setAuditLoading(true);
    setAuditError(null);
    try {
      setAuditEvents(await fetchAuditEvents());
    } catch (error) {
      setAuditError(
        error instanceof Error ? error.message : "Could not load activity log.",
      );
    } finally {
      setAuditLoading(false);
    }
  }

  async function handleSelectWorkspace(businessId: string) {
    if (actionPending.current) return;
    actionPending.current = true;
    setWorkspaceBusy(true);
    setWorkspaceError(null);
    setDocumentError(null);
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
      if (target) reveal(target, "figures");
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

  async function handleRefreshDocuments() {
    if (actionPending.current || !activeWorkspace) return;
    actionPending.current = true;
    setDocumentBusy(true);
    setDocumentError(null);
    try {
      const documents = await fetchDocuments(activeWorkspace.id);
      setActiveWorkspace((current) => current ? { ...current, documents } : current);
      if (activeReview && !documents.some((item) => item.id === activeReview.id && item.status === "ready")) {
        setActiveReview(null);
        setHighlightedCell(null);
      }
      setNotice("Document status refreshed. Your draft entries are kept.");
    } catch (error) {
      setDocumentError(error instanceof Error ? error.message : "Could not refresh document status.");
    } finally {
      actionPending.current = false;
      setDocumentBusy(false);
    }
  }

  async function handleUploadDocument() {
    if (actionPending.current || !activeWorkspace || !selectedPdf) return;
    actionPending.current = true;
    setDocumentBusy(true);
    setDocumentError(null);
    try {
      const uploaded = await uploadDocument(activeWorkspace.id, selectedPdf);
      setActiveWorkspace((current) =>
        current
          ? {
              ...current,
              documents: [
                uploaded,
                ...current.documents.filter((item) => item.id !== uploaded.id),
              ],
            }
          : current,
      );
      setSelectedPdf(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setNotice(uploaded.status === "ready"
        ? `Uploaded and processed "${uploaded.filename}".`
        : `Saved "${uploaded.filename}" with status: ${uploaded.status}. Check its message below.`);
    } catch (error) {
      setDocumentError(
        error instanceof Error ? error.message : "Could not upload PDF.",
      );
    } finally {
      actionPending.current = false;
      setDocumentBusy(false);
    }
  }

  async function handleRetryDocument(documentId: string) {
    if (actionPending.current || !activeWorkspace) return;
    actionPending.current = true;
    setDocumentBusy(true);
    setDocumentError(null);
    try {
      const updated = await retryDocument(activeWorkspace.id, documentId);
      setActiveWorkspace((current) =>
        current
          ? {
              ...current,
              documents: current.documents.map((item) =>
                item.id === updated.id ? updated : item,
              ),
            }
          : current,
      );
      setNotice(
        updated.status === "ready"
          ? `Retried and processed "${updated.filename}".`
          : `Retry finished for "${updated.filename}".`,
      );
    } catch (error) {
      setDocumentError(
        error instanceof Error ? error.message : "Could not retry PDF processing.",
      );
    } finally {
      actionPending.current = false;
      setDocumentBusy(false);
    }
  }

  async function handleOpenReview(
    documentId: string,
    pageNumber = 1,
    cell: HighlightedCell | null = null,
  ) {
    if (!activeWorkspace) return;
    if (activeReview?.id === documentId) {
      setReviewPage(pageNumber);
      setHighlightedCell(cell);
      reveal("source-review-panel", "documents", "start");
      return;
    }
    if (actionPending.current) return;
    actionPending.current = true;
    setDocumentBusy(true);
    setDocumentError(null);
    try {
      const data = await fetchDocumentExtraction(activeWorkspace.id, documentId);
      setActiveReview(data);
      setReviewPage(pageNumber);
      setHighlightedCell(cell);
      reveal("source-review-panel", "documents", "start");
    } catch (error) {
      setDocumentError(
        error instanceof Error ? error.message : "Could not load extracted candidates.",
      );
    } finally {
      actionPending.current = false;
      setDocumentBusy(false);
    }
  }

  async function handleRunExtraction(documentId: string) {
    if (actionPending.current || !activeWorkspace) return;
    actionPending.current = true;
    setDocumentBusy(true);
    setDocumentError(null);
    try {
      const updated = await runDocumentExtraction(activeWorkspace.id, documentId);
      setActiveReview(updated);
      setReviewPage(1);
      setHighlightedCell(null);
      setActiveWorkspace((current) =>
        current
          ? {
              ...current,
              documents: current.documents.map((item) =>
                item.id === updated.id
                  ? {
                      id: updated.id,
                      business_id: updated.business_id,
                      filename: updated.filename,
                      sha256: updated.sha256,
                      byte_size: updated.byte_size,
                      page_count: updated.page_count,
                      extracted_char_count: updated.extracted_char_count,
                      status: updated.status,
                      error_code: updated.error_code,
                      error_message: updated.error_message,
                      created_at: updated.created_at,
                      updated_at: updated.updated_at,
                    }
                  : item,
              ),
            }
          : current,
      );
      setNotice(`Extraction finished for "${updated.filename}".`);
    } catch (error) {
      setDocumentError(
        error instanceof Error ? error.message : "Could not extract candidates from PDF.",
      );
    } finally {
      actionPending.current = false;
      setDocumentBusy(false);
    }
  }

  function handleApplyCandidates(candidates: CandidateImport[]) {
    const result = applyCandidatesToForm(form, candidates);
    if (result.applied > 0) {
      setForm(result.form);
      setShowErrors(false);
    }
    setApplyWarnings(result.skipped.map((item) => item.reason));
    if (result.applied > 0) {
      setNotice(
        `Applied ${result.applied} extracted ${
          result.applied === 1 ? "figure" : "figures"
        } from PDF as unreviewed. Inspect and confirm them before relying on analysis.`,
      );
    } else if (result.skipped.length > 0) {
      setNotice("No candidates were applied. Check the skip notices below.");
    }
  }

  function handleJumpToField(
    yearStart: number | null,
    field: FinancialFieldKey | null,
  ) {
    if (!field) return;
    const period =
      yearStart !== null
        ? form.periods.find((item) => item.yearStart === yearStart)
        : form.periods[0];
    if (!period) {
      const label = FINANCIAL_FIELDS.find((item) => item.key === field)?.label ?? field;
      setNotice(
        `Add ${financialYearLabel(yearStart!)} in Financial years below to enter ${label} manually.`,
      );
      reveal("periods-heading", "figures", "start");
      return;
    }
    reveal(`figure-${period.id}-${field}`, "figures");
  }

  async function handleDeleteDocument(documentId: string, filename: string) {
    if (actionPending.current || !activeWorkspace) return;
    actionPending.current = true;
    setDocumentBusy(true);
    setDocumentError(null);
    try {
      await deleteDocument(activeWorkspace.id, documentId);
      const detachedForm = detachDocumentSource(form, documentId);
      const wasClean = activeWorkspace.form === form;
      if (detachedForm !== form) {
        setForm(detachedForm);
      }
      setActiveWorkspace((current) =>
        current
          ? {
              ...current,
              form: wasClean
                ? detachedForm
                : detachDocumentSource(current.form, documentId),
              documents: current.documents.filter((item) => item.id !== documentId),
            }
          : current,
      );
      setActiveReview((current) => (current?.id === documentId ? null : current));
      setHighlightedCell((current) =>
        activeReview?.id === documentId ? null : current,
      );
      setNotice(`Removed "${filename}" from workspace.`);
    } catch (error) {
      setDocumentError(
        error instanceof Error ? error.message : "Could not remove document.",
      );
    } finally {
      actionPending.current = false;
      setDocumentBusy(false);
    }
  }

  function startNewWorkspace() {
    setReplacement(null);
    setForm(createEmptyForm());
    setActiveWorkspace(null);
    setActiveReview(null);
    setActiveReport(null);
    setConfirmDeleteWorkspace(false);
    setHighlightedCell(null);
    setApplyWarnings([]);
    setSelectedPdf(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setShowErrors(false);
    setConfirmExample(false);
    setWorkspaceError(null);
    setDocumentError(null);
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
    const targetPeriod = form.periods.find((p) => p.id === periodId);
    const wasDocument = targetPeriod
      ? isDocumentFigure(targetPeriod.figures[field])
      : false;
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
    setNotice(
      wasDocument
        ? "Edited figure converted from document source to manual entry (unreviewed)."
        : null,
    );
  }

  function toggleFigureReview(
    periodId: string,
    field: FinancialFieldKey,
    checked: boolean,
  ) {
    if (checked) {
      const nextErrors = validateForm(form);
      if (nextErrors.figures[`${periodId}:${field}`]) {
        setShowErrors(true);
        reveal(`figure-${periodId}-${field}`, "figures");
        return;
      }
    }
    setForm((current) => ({
      ...current,
      periods: current.periods.map((period) => {
        if (period.id !== periodId) return period;
        const fig = period.figures[field];
        if (!fig.raw.trim()) return period;
        return {
          ...period,
          figures: {
            ...period.figures,
            [field]: { ...fig, reviewed: checked },
          },
        };
      }),
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
    setActiveReview(null);
    setActiveReport(null);
    setConfirmDeleteWorkspace(false);
    setHighlightedCell(null);
    setApplyWarnings([]);
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
      if (target) reveal(target, "figures");
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

  function handleReportGenerated(report: PreparationReportResponse) {
      setActiveWorkspace((current) => {
        if (current?.id !== report.business_id || current.revision !== report.input_revision) return current;
        const alreadyTracked = current.runs.some(
          (run) => run.run_id === report.report_id,
        );
        const nextRuns = alreadyTracked
          ? current.runs
          : [
              {
                run_id: report.report_id,
                input_revision: report.input_revision,
                rule_version: report.rule_version,
                action_version: report.action_version ?? null,
                superseded: false,
                created_at: report.created_at,
              },
              ...current.runs.map((run) => ({
                ...run,
                superseded: true,
              })),
            ];
        return {
          ...current,
          analysis: report.analysis,
          runs: nextRuns,
        };
      });
  }

  async function analyseFigures() {
    if (actionPending.current) return;
    const nextErrors = validateForm(form);
    setShowErrors(true);
    if (hasErrors(nextErrors)) {
      const target = firstErrorId(nextErrors, form);
      if (target) reveal(target, "figures");
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

  return {
    navigate,
    pendingReveal,
    form,
    setForm,
    showErrors,
    setShowErrors,
    confirmExample,
    setConfirmExample,
    notice,
    setNotice,
    session,
    setSession,
    authMode,
    setAuthMode,
    email,
    setEmail,
    password,
    setPassword,
    authError,
    setAuthError,
    authBusy,
    setAuthBusy,
    checkingSession,
    setCheckingSession,
    businesses,
    setBusinesses,
    activeWorkspace,
    setActiveWorkspace,
    workspaceBusy,
    setWorkspaceBusy,
    workspaceError,
    setWorkspaceError,
    reportResult,
    setActiveReport,
    activeReport,
    confirmDeleteWorkspace,
    setConfirmDeleteWorkspace,
    auditOpen,
    setAuditOpen,
    auditLoading,
    setAuditLoading,
    auditError,
    setAuditError,
    auditEvents,
    setAuditEvents,
    documentBusy,
    setDocumentBusy,
    documentError,
    setDocumentError,
    selectedPdf,
    setSelectedPdf,
    activeReview,
    setActiveReview,
    reviewPage,
    setReviewPage,
    highlightedCell,
    setHighlightedCell,
    applyWarnings,
    setApplyWarnings,
    fileInputRef,
    replacement,
    setReplacement,
    actionPending,
    actionsDisabled,
    analysis,
    periods,
    errors,
    counts,
    allPresentReviewed,
    savedClean,
    displayedAnalysis,
    applyWorkspace,
    revealPending,
    reveal,
    handleAuth,
    handleSignOut,
    handleDeleteWorkspace,
    handleToggleAuditLog,
    handleSelectWorkspace,
    handleSaveWorkspace,
    handleRefreshDocuments,
    handleUploadDocument,
    handleRetryDocument,
    handleOpenReview,
    handleRunExtraction,
    handleApplyCandidates,
    handleJumpToField,
    handleDeleteDocument,
    startNewWorkspace,
    requestReplacement,
    replaceDraft,
    updateBusinessName,
    updateFigure,
    toggleFigureReview,
    updatePeriodYear,
    updatePeriodUnit,
    updateComparable,
    addPeriod,
    removePeriod,
    loadExample,
    applyExample,
    handleSubmit,
    analyseFigures,
    handleReportGenerated,
  };
}

const WorkspaceContext = createContext<ReturnType<typeof useWorkspaceController> | null>(null);

function useWorkspace() {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("useWorkspace must be used inside WorkspaceContext");
  return workspace;
}

export { WorkspaceContext, useWorkspace, useWorkspaceController, type Replacement };
