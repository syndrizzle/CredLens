import { useEffect, useRef, useState, type FormEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  askWorkspaceQuestion,
  documentFileUrl,
  type DocumentCitation,
  type FinancialCitation,
  type QAResponse,
} from "../analysis/api";
import { financialYearLabel } from "../manual-entry/model";

type WorkspaceQAProps = {
  businessId: string;
  businessName: string;
  inputRevision: number;
  years: number[];
  hasReadyDocuments: boolean;
  hasUnsavedChanges: boolean;
  disabled?: boolean;
};

const ALL_YEARS = "all";

function stateBadgeVariant(
  state: FinancialCitation["state"],
): "secondary" | "outline" | "destructive" {
  if (state === "Supported") return "secondary";
  if (state === "Needs review") return "destructive";
  return "outline";
}

export function WorkspaceQA({
  businessId,
  businessName,
  inputRevision,
  years,
  hasReadyDocuments,
  hasUnsavedChanges,
  disabled = false,
}: WorkspaceQAProps) {
  const [question, setQuestion] = useState("");
  const [yearFilter, setYearFilter] = useState<string>(ALL_YEARS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<{ id: number; turn: QAResponse }[]>([]);
  const nextTurnId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const activeYearFilter =
    yearFilter !== ALL_YEARS &&
    years.some((year) => String(year) === yearFilter)
      ? yearFilter
      : ALL_YEARS;

  const suggestedPrompts = [
    years.length >= 2
      ? "How did net profit margin and revenue growth change?"
      : "Summarize the supported financial indicators.",
    "What missing or unreviewed inputs are blocking analysis?",
    ...(hasReadyDocuments
      ? ["What do the borrowing notes say about leases and current maturities?"]
      : []),
  ];

  const yearItems = [
    { value: ALL_YEARS, label: "All saved years" },
    ...years.map((year) => ({
      value: String(year),
      label: financialYearLabel(year),
    })),
  ];

  async function submitQuestion(event: FormEvent) {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed) {
      setError("Enter a focused question about your figures or uploaded statements.");
      inputRef.current?.focus();
      return;
    }
    if (hasUnsavedChanges || disabled || loading) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);

    try {
      const response = await askWorkspaceQuestion(
        businessId,
        {
          question: trimmed,
          year_start:
            activeYearFilter === ALL_YEARS ? null : Number(activeYearFilter),
        },
        controller.signal,
      );
      if (abortRef.current !== controller) return;
      const id = nextTurnId.current++;
      setTurns((current) => [{ id, turn: response }, ...current].slice(0, 10));
      setQuestion("");
    } catch (caught) {
      if (controller.signal.aborted || abortRef.current !== controller) return;
      setError(
        caught instanceof Error
          ? caught.message
          : "Q&A could not complete. Retry after checking the local backend.",
      );
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  }

  const formBlocked = disabled || loading || hasUnsavedChanges;

  return (
    <section className="space-y-4" aria-labelledby="qa-heading">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 id="qa-heading">Evidence-grounded Q&amp;A</h2>
          </CardTitle>
          <CardDescription>
            Ask about {businessName}&rsquo;s saved indicators, missing inputs or
            uploaded PDF disclosures. Numbers come from the deterministic
            analysis for input revision {inputRevision}; without the local
            model, answers use a template summary.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {hasUnsavedChanges ? (
            <Alert>
              <HugeiconsIcon icon={InformationCircleIcon} />
              <AlertTitle>Unsaved edits present</AlertTitle>
              <AlertDescription>
                Save your workspace edits before asking questions so answers
                match your latest figures.
              </AlertDescription>
            </Alert>
          ) : null}

          <form
            onSubmit={(event) => void submitQuestion(event)}
            className="space-y-3"
            aria-busy={loading}
          >
            <div className="grid items-end gap-3 sm:grid-cols-[1fr_12rem_auto]">
              <div className="space-y-1.5">
                <Label htmlFor="qa-question">Question</Label>
                <Input
                  ref={inputRef}
                  id="qa-question"
                  value={question}
                  onChange={(event) => {
                    setQuestion(event.target.value);
                    if (error) setError(null);
                  }}
                  maxLength={500}
                  disabled={formBlocked}
                  placeholder="What is blocking interest coverage?"
                  autoComplete="off"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="qa-year-filter">Year scope</Label>
                <Select<string>
                  id="qa-year-filter"
                  items={yearItems}
                  value={activeYearFilter}
                  disabled={formBlocked}
                  onValueChange={(value) => {
                    if (value !== null) setYearFilter(value);
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {yearItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" disabled={formBlocked}>
                {loading ? "Assembling answer…" : "Ask question"}
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {turns.length > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={loading}
                  onClick={() => setTurns([])}
                >
                  Clear answers
                </Button>
              ) : null}
              <span
                role="status"
                aria-live="polite"
                className="text-xs text-muted-foreground"
              >
                {loading
                  ? "Checking saved analysis and authorised passages…"
                  : ""}
              </span>
            </div>
          </form>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">
              Suggested prompts:
            </span>
            {suggestedPrompts.map((prompt) => (
              <Button
                key={prompt}
                type="button"
                variant="outline"
                size="xs"
                disabled={formBlocked}
                onClick={() => {
                  setQuestion(prompt);
                  setError(null);
                  inputRef.current?.focus();
                }}
              >
                {prompt}
              </Button>
            ))}
          </div>

          {error ? (
            <Alert variant="destructive">
              <HugeiconsIcon icon={Alert02Icon} />
              <AlertTitle>Question could not be answered</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {turns.length > 0 ? (
            <div className="space-y-4 pt-2">
              {turns.map(({ id, turn }) => (
                <QATurnCard
                  key={id}
                  businessId={businessId}
                  currentRevision={inputRevision}
                  turn={turn}
                />
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

function QATurnCard({
  businessId,
  currentRevision,
  turn,
}: {
  businessId: string;
  currentRevision: number;
  turn: QAResponse;
}) {
  const isSuperseded = turn.input_revision < currentRevision;
  const citedFin = turn.financial_citations.filter((c) => c.cited);
  const uncitedFin = turn.financial_citations.filter((c) => !c.cited);
  const citedDocs = turn.document_citations.filter((c) => c.cited);
  const otherDocs = turn.document_citations.filter((c) => !c.cited);

  return (
    <article className="space-y-3 rounded-lg border border-border p-4 animate-in duration-200 ease-out fade-in-0 motion-safe:slide-in-from-top-1">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="font-heading text-base font-medium">{turn.question}</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={turn.mode === "ollama" ? "secondary" : "outline"}>
            {turn.mode === "ollama"
              ? `Local model (${turn.model ?? "ollama"})`
              : turn.mode === "deterministic" ? "Deterministic answer" : "Template fallback"}
          </Badge>
          <Badge variant="outline">
            Input revision {turn.input_revision}
          </Badge>
          {isSuperseded ? (
            <Badge variant="destructive">
              Superseded by Rev {currentRevision}
            </Badge>
          ) : null}
        </div>
      </div>

      {turn.mode === "fallback" && turn.fallback_reason ? (
        <Alert>
          <HugeiconsIcon icon={InformationCircleIcon} />
          <AlertTitle>Local explanation model unavailable</AlertTitle>
          <AlertDescription>{turn.fallback_reason}</AlertDescription>
        </Alert>
      ) : null}

      {turn.retrieval_note ? (
        <p className="text-xs text-muted-foreground">{turn.retrieval_note}</p>
      ) : null}

      <div className="whitespace-pre-line text-sm leading-relaxed text-foreground">
        {turn.answer}
      </div>

      {citedFin.length > 0 ? (
        <div className="space-y-2 border-t border-border pt-3">
          <h4 className="text-xs font-medium text-muted-foreground">
            Cited financial evidence ({turn.rule_version})
          </h4>
          <ul className="space-y-2">
            {citedFin.map((cit) => (
              <FinancialCitationRow key={cit.citation_id} citation={cit} />
            ))}
          </ul>
        </div>
      ) : null}

      {citedDocs.length > 0 ? (
        <div className="space-y-2 border-t border-border pt-3">
          <h4 className="text-xs font-medium text-muted-foreground">
            Cited document passages
          </h4>
          <ul className="space-y-2">
            {citedDocs.map((doc) => (
              <DocumentCitationRow
                key={doc.citation_id}
                businessId={businessId}
                citation={doc}
              />
            ))}
          </ul>
        </div>
      ) : null}

      {uncitedFin.length > 0 || otherDocs.length > 0 ? (
        <details className="border-t border-border pt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium">
            Additional workspace evidence checked ({uncitedFin.length} financial
            {otherDocs.length > 0 ? `, ${otherDocs.length} document` : ""})
          </summary>
          <div className="mt-2 space-y-3">
            {uncitedFin.length > 0 ? (
              <ul className="space-y-2">
                {uncitedFin.map((cit) => (
                  <FinancialCitationRow key={cit.citation_id} citation={cit} />
                ))}
              </ul>
            ) : null}
            {otherDocs.length > 0 ? (
              <ul className="space-y-2">
                {otherDocs.map((doc) => (
                  <DocumentCitationRow
                    key={doc.citation_id}
                    businessId={businessId}
                    citation={doc}
                  />
                ))}
              </ul>
            ) : null}
          </div>
        </details>
      ) : null}

      {turn.limitations.length > 0 ? (
        <p className="border-t border-border pt-2 text-xs text-muted-foreground">
          {turn.limitations[turn.limitations.length - 1]}
        </p>
      ) : null}
    </article>
  );
}

function FinancialCitationRow({ citation }: { citation: FinancialCitation }) {
  return (
    <li className="space-y-1 rounded-md border border-border/70 p-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono">
          [{citation.citation_id}]
        </Badge>
        <span className="font-medium text-foreground">
          {citation.label} · {financialYearLabel(citation.year_start)}
        </span>
        <Badge variant={stateBadgeVariant(citation.state)}>
          {citation.state}
        </Badge>
        {citation.value_display ? (
          <span className="font-mono font-medium text-foreground">
            {citation.value_display}
          </span>
        ) : null}
      </div>
      {citation.reasons.length > 0 ? (
        <p className="text-muted-foreground">{citation.reasons.join(" ")}</p>
      ) : null}
      {citation.origins.length > 0 ? (
        <p className="text-muted-foreground">
          Sources: {citation.origins.join("; ")}
        </p>
      ) : null}
    </li>
  );
}

function DocumentCitationRow({
  businessId,
  citation,
}: {
  businessId: string;
  citation: DocumentCitation;
}) {
  return (
    <li className="space-y-1 rounded-md border border-border/70 p-2.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-mono">
            [{citation.citation_id}]
          </Badge>
          <span className="font-medium text-foreground">
            {citation.filename} · p. {citation.page_number}
            {citation.section ? ` · ${citation.section}` : ""}
          </span>
        </div>
        <a
          href={documentFileUrl(
            businessId,
            citation.document_id,
            citation.page_number,
          )}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 font-medium underline underline-offset-4"
        >
          Open page {citation.page_number}
        </a>
      </div>
      <p className="whitespace-pre-line text-muted-foreground">
        {citation.excerpt}
      </p>
    </li>
  );
}
