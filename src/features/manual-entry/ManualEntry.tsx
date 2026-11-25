import { AnalysisResults } from "../analysis/AnalysisResults";
import {
  analyseWorkspace,
  deleteDocument,
  deleteWorkspace,
  documentFileUrl,
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
} from "../analysis/api";
import { useAnalysis } from "../analysis/use-analysis";
import { SourceReview, type HighlightedCell } from "../documents/SourceReview";
import { WorkspaceQA } from "../qa/WorkspaceQA";
import { PreparationReportPanel } from "../reports/PreparationReport";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { AppShell } from "@/app/AppShell";
import { SECTIONS, type Section } from "@/app/sections";
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
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
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
  immediatePrior,
  isDocumentFigure,
  nextPeriodYear,
  presentFigures,
  resetBrokenComparability,
  resetReview,
  sortedPeriods,
  unitLabel,
  validateForm,
  type CandidateImport,
  type FieldDefinition,
  type FigureDraft,
  type FigureSource,
  type FinancialFieldKey,
  type FormDraft,
  type FormErrors,
  type PeriodDraft,
  type Unit,
} from "./model";

const EMPTY_ERRORS: FormErrors = { years: {}, figures: {} };
type Replacement = { type: "load"; id: string } | { type: "new" } | { type: "signout" };

function ManualEntry({ section }: { section?: Section }) {
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
    if (!element) return;
    pendingReveal.current = null;
    element.scrollIntoView({ behavior: "smooth", block: target.block });
    element.focus({ preventScroll: true });
  }
  // Targets in another section only exist after navigation renders them.
  useEffect(revealPending);

  function reveal(id: string, target: Section, block: ScrollLogicalPosition = "center") {
    pendingReveal.current = { id, block };
    if (section && section !== target) {
      void navigate({ to: SECTIONS.find((item) => item.id === target)!.path });
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

  const show = (id: Section) => !section || section === id;
  const needsWorkspace =
    !activeWorkspace && (section === "documents" || section === "report" || section === "qa");

  return (
    <AppShell
      section={section}
      email={session?.email ?? null}
      status={
        <Badge variant={savedClean ? "secondary" : "outline"}>
          {savedClean
            ? `Saved · Rev ${activeWorkspace.revision}`
            : session
              ? "Unsaved draft"
              : "Not saved"}
        </Badge>
      }
    >
      <fieldset disabled={actionsDisabled} className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-6 print:max-w-none" aria-label="Financial health workspace">
        <div className={activeReport ? "flex flex-col gap-6 print:hidden" : "flex flex-col gap-6"}>
        {notice ? (
          <p
            role="status"
            aria-live="polite"
            className="text-sm font-medium text-foreground"
          >
            {notice}
          </p>
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

        {needsWorkspace ? (
          <Empty className="border border-dashed border-border">
            <EmptyHeader>
              <EmptyTitle>No saved workspace</EmptyTitle>
              <EmptyDescription>
                {section === "documents"
                  ? "Sign in and save a workspace to upload PDF statements."
                  : section === "report"
                    ? "Sign in and save a workspace to generate preparation reports."
                    : "Sign in and save a workspace to ask questions about its evidence."}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Link to="/" className={buttonVariants({ variant: "outline" })}>
                Go to Overview
              </Link>
            </EmptyContent>
          </Empty>
        ) : null}

        {show("overview") ? (
          <>
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
                      {activeWorkspace ? (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => {
                            setConfirmDeleteWorkspace(true);
                            setReplacement(null);
                          }}
                          disabled={workspaceBusy || documentBusy}
                        >
                          Delete workspace
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleToggleAuditLog()}
                        disabled={workspaceBusy || auditLoading}
                      >
                        {auditOpen ? "Hide activity log" : "Activity log"}
                      </Button>
                    </div>
                    {confirmDeleteWorkspace && activeWorkspace ? (
                      <div
                        role="group"
                        aria-label="Delete workspace permanently?"
                        className="space-y-2 rounded-lg border border-destructive/40 bg-muted/50 p-3 text-sm"
                      >
                        <p className="font-medium text-destructive">
                          Delete &ldquo;{activeWorkspace.form.businessName}&rdquo; and all active data?
                        </p>
                        <p className="text-muted-foreground">
                          This immediately removes saved figures, revision history, uploaded PDFs, extraction snapshots, retrieval chunks/embeddings, analysis runs, preparation reports, and in-session Q&amp;A answers.
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Backup limitation: external PostgreSQL host backups or point-in-time recovery snapshots follow database-host retention policies and are not immediately purged.
                        </p>
                        <div className="flex flex-wrap gap-2 pt-1">
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={workspaceBusy}
                            onClick={() => void handleDeleteWorkspace()}
                          >
                            Delete workspace permanently
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={workspaceBusy}
                            onClick={() => setConfirmDeleteWorkspace(false)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : null}
                    {auditOpen ? (
                      <div className="space-y-2 rounded-lg border border-border p-3 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-medium text-foreground">
                            Recent activity (minimal audit log · actor, action, time · no financial payloads)
                          </p>
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            disabled={auditLoading}
                            onClick={async () => {
                              setAuditLoading(true);
                              setAuditError(null);
                              try {
                                setAuditEvents(await fetchAuditEvents());
                              } catch (error) {
                                setAuditError(
                                  error instanceof Error
                                    ? error.message
                                    : "Could not load activity log.",
                                );
                              } finally {
                                setAuditLoading(false);
                              }
                            }}
                          >
                            {auditLoading ? "Loading…" : "Refresh log"}
                          </Button>
                        </div>
                        {auditError ? (
                          <p role="alert" className="text-destructive">
                            {auditError}
                          </p>
                        ) : auditEvents.length === 0 ? (
                          <p className="text-muted-foreground">
                            {auditLoading
                              ? "Loading activity log…"
                              : "No activity recorded yet."}
                          </p>
                        ) : (
                          <ul className="space-y-1.5">
                            {auditEvents.slice(0, 15).map((event) => (
                              <li
                                key={event.id}
                                className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-1.5"
                              >
                                <span className="font-mono text-foreground">
                                  {event.action} · {event.resource_type}
                                  {event.details
                                    ? ` (${Object.entries(event.details)
                                        .map(([k, v]) => `${k}=${String(v)}`)
                                        .join(", ")})`
                                    : ""}
                                </span>
                                <span className="text-muted-foreground">
                                  {event.created_at}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ) : null}
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
          </>
        ) : null}

        {show("documents") ? (
          <>
            {session && activeWorkspace ? (
              <Card>
                <CardHeader>
                  <CardTitle>Source PDF documents</CardTitle>
                  <CardDescription>
                    Upload digital financial statement PDFs for &ldquo;{activeWorkspace.form.businessName}&rdquo;. Maximum 20 MB and 50 pages per PDF; one processing job runs at a time. Scanned or image-only PDFs are rejected.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-64 flex-1 space-y-1.5">
                      <Label htmlFor="pdf-upload-input">Financial statement PDF</Label>
                      <Input
                        ref={fileInputRef}
                        id="pdf-upload-input"
                        type="file"
                        accept=".pdf,application/pdf"
                        disabled={actionsDisabled}
                        onChange={(event) => {
                          const nextFile = event.target.files?.[0] ?? null;
                          setSelectedPdf(nextFile);
                          setDocumentError(null);
                        }}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void handleUploadDocument()}
                      disabled={actionsDisabled || !selectedPdf}
                    >
                      {documentBusy ? "Processing PDF…" : "Upload PDF"}
                    </Button>
                    <Button type="button" variant="outline" disabled={actionsDisabled} onClick={() => void handleRefreshDocuments()}>
                      Refresh document status
                    </Button>
                  </div>
                  {documentError ? (
                    <Alert variant="destructive">
                      <HugeiconsIcon icon={Alert02Icon} />
                      <AlertTitle>PDF upload or processing failed</AlertTitle>
                      <AlertDescription className="col-start-2">
                        {documentError} Refresh document status before retrying an interrupted request.
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  {activeWorkspace.documents.length > 0 ? (
                    <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Uploaded PDF documents">
                      {activeWorkspace.documents.map((doc) => (
                        <li
                          key={doc.id}
                          className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm"
                        >
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{doc.filename}</span>
                              <Badge
                                variant={
                                  doc.status === "ready"
                                    ? "secondary"
                                    : doc.status === "failed"
                                      ? "destructive"
                                      : "outline"
                                }
                              >
                                {doc.status === "ready"
                                  ? "Ready"
                                  : doc.status === "failed"
                                    ? "Failed"
                                    : "Processing"}
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {Math.max(1, Math.round(doc.byte_size / 1024))} KB
                              {doc.page_count !== null
                                ? ` · ${doc.page_count} ${doc.page_count === 1 ? "page" : "pages"}`
                                : ""}
                              {doc.extracted_char_count !== null
                                ? ` · ${doc.extracted_char_count} digital chars`
                                : ""}
                            </p>
                            {doc.error_message ? (
                              <p className="text-xs text-destructive">
                                {doc.error_message}
                              </p>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            {doc.status === "ready" ? (
                              <>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={actionsDisabled}
                                  onClick={() => void handleOpenReview(doc.id)}
                                >
                                  {activeReview?.id === doc.id
                                    ? "Reviewing"
                                    : "Review extracted figures"}
                                </Button>
                                <a
                                  href={documentFileUrl(activeWorkspace.id, doc.id)}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                                >
                                  View PDF
                                </a>
                              </>
                            ) : null}
                            {doc.status === "failed" && doc.error_code !== "deletion_pending" ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={actionsDisabled}
                                onClick={() => void handleRetryDocument(doc.id)}
                              >
                                Retry processing
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={actionsDisabled}
                              onClick={() => void handleDeleteDocument(doc.id, doc.filename)}
                            >
                              Remove
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No PDFs uploaded for this workspace yet.
                    </p>
                  )}
                </CardContent>
              </Card>
            ) : null}

            {session && activeWorkspace && activeReview ? (
              <SourceReview
                key={activeReview.id}
                businessId={activeWorkspace.id}
                extraction={activeReview}
                activePage={reviewPage}
                highlightedCell={highlightedCell}
                disabled={actionsDisabled}
                form={form}
                onSelectPage={(page) => setReviewPage(page)}
                onHighlightCell={(cell) => setHighlightedCell(cell)}
                onRunExtraction={(docId) => void handleRunExtraction(docId)}
                onApplyCandidates={handleApplyCandidates}
                onJumpToField={handleJumpToField}
                onClose={() => {
                  setActiveReview(null);
                  setHighlightedCell(null);
                }}
              />
            ) : null}

            {applyWarnings.length > 0 ? (
              <Alert>
                <HugeiconsIcon icon={Alert02Icon} />
                <AlertTitle>Some PDF candidates were not applied</AlertTitle>
                <AlertDescription className="col-start-2">
                  <ul className="list-disc space-y-1 pl-4">
                    {applyWarnings.map((warning, idx) => (
                      <li key={idx}>{warning}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}
          </>
        ) : null}

        {show("figures") ? (
          <>
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
                    businessId={activeWorkspace?.id}
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
                    onToggleFigureReview={(field, checked) =>
                      toggleFigureReview(period.id, field, checked)
                    }
                    onInspectSource={(source) => {
                      if (!source.document_id) return;
                      void handleOpenReview(source.document_id, source.page_number, {
                        page: source.page_number,
                        table: source.table_index,
                        row: source.row_index,
                        col: source.column_index,
                      });
                    }}
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
                </CardContent>
              </Card>
            </form>
          </>
        ) : null}

        {show("analysis") ? (
          <>
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
                businessId={savedClean ? activeWorkspace.id : undefined}
                inputRevision={savedClean ? activeWorkspace.revision : undefined}
                runs={savedClean ? activeWorkspace.runs : undefined}
              />
            ) : null}
          </>
        ) : null}
        </div>

        {show("report") && activeWorkspace ? (
          <PreparationReportPanel
            key={`report-${activeWorkspace.id}`}
            businessId={activeWorkspace.id}
            businessName={activeWorkspace.form.businessName}
            inputRevision={activeWorkspace.revision}
            runs={activeWorkspace.runs}
            hasUnsavedChanges={!savedClean}
            disabled={workspaceBusy || analysis.loading}
            activeReport={activeReport}
            documents={activeWorkspace.documents}
            onActiveReportChange={setActiveReport}
            onReportGenerated={(report) => {
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
            }}
          />
        ) : null}

        {show("qa") && activeWorkspace ? (
          <div className={activeReport ? "print:hidden" : undefined}>
            <WorkspaceQA
              key={activeWorkspace.id}
              businessId={activeWorkspace.id}
              businessName={activeWorkspace.form.businessName}
              inputRevision={activeWorkspace.revision}
              years={sortedPeriods(activeWorkspace.form.periods).map(
                (period) => period.yearStart,
              )}
              hasReadyDocuments={activeWorkspace.documents.some(
                (doc) => doc.status === "ready",
              )}
              hasUnsavedChanges={!savedClean}
              disabled={workspaceBusy || analysis.loading}
            />
          </div>
        ) : null}

        <footer className="space-y-1 pb-4 text-xs text-muted-foreground print:hidden">
          <p>
            Protected workspaces and page-linked source review · Financial rules
            are provisional pending finance-reviewer validation.
          </p>
          <p>
            Cash generation is not assessed; no cash-flow statement is entered
            in this workflow. Borrowings exclude leases and count current
            maturities once.
          </p>
        </footer>
      </fieldset>
    </AppShell>
  );
}

type PeriodCardProps = {
  businessId?: string;
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
  onToggleFigureReview: (field: FinancialFieldKey, checked: boolean) => void;
  onInspectSource: (source: FigureSource) => void;
};

function PeriodCard({
  businessId,
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
  onToggleFigureReview,
  onInspectSource,
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
                  businessId={businessId}
                  disabled={disabled}
                  periodId={period.id}
                  field={field}
                  figure={period.figures[field.key]}
                  error={errors.figures[`${period.id}:${field.key}`]}
                  onValueChange={(raw) => onFigureChange(field.key, raw)}
                  onToggleReview={(checked) =>
                    onToggleFigureReview(field.key, checked)
                  }
                  onInspectSource={onInspectSource}
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
  businessId?: string;
  disabled: boolean;
  periodId: string;
  field: FieldDefinition;
  figure: FigureDraft;
  error: string | undefined;
  onValueChange: (raw: string) => void;
  onToggleReview: (checked: boolean) => void;
  onInspectSource: (source: FigureSource) => void;
};

function FigureField({
  businessId,
  disabled,
  periodId,
  field,
  figure,
  error,
  onValueChange,
  onToggleReview,
  onInspectSource,
}: FigureFieldProps) {
  const inputId = `figure-${periodId}-${field.key}`;
  const confirmId = `confirm-${periodId}-${field.key}`;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy = error ? `${hintId} ${errorId}` : hintId;
  const hasValue = figure.raw.trim() !== "";
  const docFigure = isDocumentFigure(figure);
  const source = docFigure ? figure.source! : null;

  return (
    <div className="space-y-1.5">
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-2">
        <Label htmlFor={inputId} className="leading-snug">
          {field.label}
        </Label>
        {hasValue ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">
              {source
                ? source.document_id
                  ? `PDF p. ${source.page_number}`
                  : `PDF removed (p. ${source.page_number})`
                : "Manual"}
            </Badge>
            <Badge variant={figure.reviewed ? "secondary" : "outline"}>
              {figure.reviewed ? "Confirmed" : "Unreviewed"}
            </Badge>
          </div>
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
      {source ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            {source.document_id
              ? `Document: ${source.filename} · p. ${source.page_number}`
              : `Source PDF removed (was ${source.filename} · p. ${source.page_number})`}
          </span>
          {source.document_id ? (
            <>
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-auto p-0 text-xs"
                disabled={disabled}
                onClick={() => onInspectSource(source)}
              >
                Inspect p. {source.page_number}
              </Button>
              {businessId ? (
                <a
                  href={documentFileUrl(
                    businessId,
                    source.document_id,
                    source.page_number,
                  )}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Open PDF
                </a>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {hasValue ? (
        <div className="flex items-center gap-2 pt-0.5">
          <Checkbox
            id={confirmId}
            disabled={disabled}
            checked={figure.reviewed}
            onCheckedChange={(checked) => onToggleReview(checked === true)}
          />
          <Label htmlFor={confirmId} className="text-xs font-normal text-muted-foreground">
            Confirm {field.label.toLowerCase()}
          </Label>
        </div>
      ) : null}
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
            const docFig = isDocumentFigure(figure);
            const src = docFig ? figure.source! : null;
            return (
              <div
                key={field.key}
                className="flex items-start justify-between gap-3"
              >
                <dt className="text-sm text-muted-foreground">
                  {field.label}
                  <span className="block text-xs">
                    {src
                      ? src.document_id
                        ? `Document · ${src.filename} p. ${src.page_number}`
                        : `Source PDF removed · ${src.filename} p. ${src.page_number}`
                      : "Manual entry"}
                  </span>
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
