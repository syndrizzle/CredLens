import { Fragment, useMemo, useRef, useState, type FormEvent } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  ArrowUp02Icon,
  Delete02Icon,
  File02Icon,
  InformationCircleIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { EvidenceBadge } from "@/features/analysis/EvidenceBadge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import {
  Message,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import {
  documentFileUrl,
  qaErrorMessage,
  qaStreamUrl,
  validQAMetadata,
  type DocumentCitation,
  type FinancialCitation,
  type QAMetadata,
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

type QAMessage = UIMessage<never, { qa: QAMetadata }>;

const ALL_YEARS = "all";

const textOf = (message: QAMessage) =>
  message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");

function metadataOf(message: QAMessage) {
  const part = message.parts.find((item) => item.type === "data-qa");
  return part && validQAMetadata(part.data) ? part.data : null;
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
  const [inputError, setInputError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // The backend answers one question at a time, so only the latest question and filters are sent.
  const transport = useMemo(
    () =>
      new DefaultChatTransport<QAMessage>({
        api: qaStreamUrl(businessId),
        credentials: "same-origin",
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: { question: textOf(messages.at(-1)!).trim(), ...body },
        }),
      }),
    [businessId],
  );
  const {
    messages,
    sendMessage,
    status,
    error,
    stop,
    setMessages,
    regenerate,
    clearError,
  } = useChat<QAMessage>({
    transport,
  });
  const busy = status === "submitted" || status === "streaming";
  const formBlocked = disabled || busy || hasUnsavedChanges;
  const activeYearFilter =
    yearFilter !== ALL_YEARS &&
    years.some((year) => String(year) === yearFilter)
      ? yearFilter
      : ALL_YEARS;
  const yearItems = [
    { value: ALL_YEARS, label: "All years" },
    ...years.map((year) => ({
      value: String(year),
      label: financialYearLabel(year),
    })),
  ];
  const suggestions = [
    years.length >= 2
      ? "How did net profit margin and revenue growth change?"
      : "Summarize the supported financial indicators.",
    "What missing or unreviewed inputs are blocking analysis?",
    ...(hasReadyDocuments
      ? ["What do the borrowing notes say about leases and current maturities?"]
      : []),
  ];

  function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed) {
      setInputError(
        "Enter a focused question about your figures or uploaded statements.",
      );
      inputRef.current?.focus();
      return;
    }
    if (formBlocked) return;
    setInputError(null);
    clearError();
    void sendMessage(
      { text: trimmed },
      {
        body:
          activeYearFilter === ALL_YEARS
            ? {}
            : { year_start: Number(activeYearFilter) },
      },
    );
    setQuestion("");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    ask(question);
  }

  return (
    <section aria-labelledby="qa-heading" className="flex flex-col gap-4">
      <h2 id="qa-heading" className="sr-only">
        Ask about {businessName}
      </h2>
      {hasUnsavedChanges ? (
        <Alert>
          <HugeiconsIcon icon={InformationCircleIcon} />
          <AlertTitle>Unsaved edits present</AlertTitle>
          <AlertDescription>
            Save your edits before asking questions so answers match your latest
            figures.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card className="h-[min(72svh,760px)] min-h-96 gap-0 py-0">
        <MessageScrollerProvider autoScroll>
          <MessageScroller className="flex-1">
            <MessageScrollerViewport>
              <MessageScrollerContent className="mx-auto w-full max-w-3xl px-4 py-6">
                {messages.length === 0 ? (
                  <Empty className="my-auto">
                    <EmptyHeader>
                      <EmptyTitle>Ask about {businessName}</EmptyTitle>
                      <EmptyDescription>
                        Answers quote your saved analysis for input revision{" "}
                        {inputRevision} and cite the document pages they use.
                      </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent className="flex-row flex-wrap justify-center">
                      {suggestions.map((prompt) => (
                        <Button
                          key={prompt}
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-auto rounded-full py-1.5 whitespace-normal"
                          disabled={formBlocked}
                          onClick={() => ask(prompt)}
                        >
                          {prompt}
                        </Button>
                      ))}
                    </EmptyContent>
                  </Empty>
                ) : (
                  messages.map((message) => (
                    <MessageScrollerItem
                      key={message.id}
                      messageId={message.id}
                      scrollAnchor={message.role === "user"}
                    >
                      {message.role === "user" ? (
                        <Message align="end">
                          <MessageContent>
                            <Bubble align="end" variant="muted">
                              <BubbleContent className="whitespace-pre-line">
                                {textOf(message)}
                              </BubbleContent>
                            </Bubble>
                          </MessageContent>
                        </Message>
                      ) : (
                        <AssistantMessage
                          message={message}
                          businessId={businessId}
                          currentRevision={inputRevision}
                        />
                      )}
                    </MessageScrollerItem>
                  ))
                )}
                {status === "submitted" ? (
                  <MessageScrollerItem messageId="pending">
                    <Message>
                      <MessageContent>
                        <p
                          role="status"
                          className="animate-pulse text-muted-foreground motion-reduce:animate-none"
                        >
                          Checking saved analysis and authorised passages…
                        </p>
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                ) : null}
                {error ? (
                  <Alert variant="destructive">
                    <HugeiconsIcon icon={Alert02Icon} />
                    <AlertTitle>Question could not be answered</AlertTitle>
                    <AlertDescription>{qaErrorMessage(error)}</AlertDescription>
                    <AlertAction>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={formBlocked}
                        onClick={() => void regenerate()}
                      >
                        Retry
                      </Button>
                    </AlertAction>
                  </Alert>
                ) : null}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>

        <form
          onSubmit={submit}
          aria-busy={busy}
          className="border-t border-border p-3"
        >
          <InputGroup className="mx-auto max-w-3xl">
            <InputGroupTextarea
              ref={inputRef}
              id="qa-question"
              aria-label="Question"
              aria-invalid={inputError ? true : undefined}
              aria-describedby={inputError ? "qa-question-error" : undefined}
              value={question}
              onChange={(event) => {
                setQuestion(event.target.value);
                if (inputError) setInputError(null);
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              maxLength={500}
              rows={2}
              disabled={formBlocked}
              placeholder="What is blocking interest coverage?"
              autoComplete="off"
            />
            <InputGroupAddon align="block-end">
              <Select<string>
                items={yearItems}
                value={activeYearFilter}
                disabled={formBlocked}
                onValueChange={(value) => {
                  if (value !== null) setYearFilter(value);
                }}
              >
                <SelectTrigger
                  size="sm"
                  id="qa-year-filter"
                  aria-label="Year scope"
                >
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
              {messages.length > 0 ? (
                <InputGroupButton
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() => setMessages([])}
                >
                  <HugeiconsIcon icon={Delete02Icon} />
                  Clear answers
                </InputGroupButton>
              ) : null}
              {busy ? (
                <InputGroupButton
                  type="button"
                  variant="default"
                  size="icon-sm"
                  className="ml-auto rounded-full"
                  onClick={() => void stop()}
                >
                  <HugeiconsIcon icon={StopIcon} />
                  <span className="sr-only">Stop</span>
                </InputGroupButton>
              ) : (
                <InputGroupButton
                  type="submit"
                  variant="default"
                  size="icon-sm"
                  className="ml-auto rounded-full"
                  disabled={formBlocked}
                >
                  <HugeiconsIcon icon={ArrowUp02Icon} />
                  <span className="sr-only">Ask question</span>
                </InputGroupButton>
              )}
            </InputGroupAddon>
          </InputGroup>
          {inputError ? (
            <p
              id="qa-question-error"
              role="alert"
              className="mx-auto mt-2 max-w-3xl text-sm text-destructive"
            >
              {inputError}
            </p>
          ) : null}
        </form>
      </Card>
    </section>
  );
}

function AssistantMessage({
  message,
  businessId,
  currentRevision,
}: {
  message: QAMessage;
  businessId: string;
  currentRevision: number;
}) {
  const qa = metadataOf(message);
  const text = textOf(message);
  if (!qa) {
    return (
      <Message>
        <MessageContent>
          <p className="whitespace-pre-line">{text}</p>
        </MessageContent>
      </Message>
    );
  }
  const citedFin = qa.financial_citations.filter((c) => c.cited);
  const citedDocs = qa.document_citations.filter((c) => c.cited);
  const uncitedFin = qa.financial_citations.filter((c) => !c.cited);
  const otherDocs = qa.document_citations.filter((c) => !c.cited);
  const byId = new Map<string, FinancialCitation | DocumentCitation>(
    [...qa.financial_citations, ...qa.document_citations].map((c) => [
      c.citation_id,
      c,
    ]),
  );

  return (
    <Message>
      <MessageContent className="gap-3">
        <MessageHeader className="flex-wrap gap-1.5 px-0">
          <Badge variant={qa.mode === "model" ? "secondary" : "outline"}>
            {qa.mode === "model"
              ? "Gemma 4"
              : qa.mode === "deterministic"
                ? "Deterministic answer"
                : "Template fallback"}
          </Badge>
          <Badge variant="outline">Input revision {qa.input_revision}</Badge>
          {qa.input_revision < currentRevision ? (
            <Badge variant="destructive">
              Superseded by Rev {currentRevision}
            </Badge>
          ) : null}
        </MessageHeader>

        {qa.mode === "fallback" && qa.fallback_reason ? (
          <Alert>
            <HugeiconsIcon icon={InformationCircleIcon} />
            <AlertTitle>Explanation model unavailable</AlertTitle>
            <AlertDescription>{qa.fallback_reason}</AlertDescription>
          </Alert>
        ) : null}

        <div className="text-sm leading-relaxed whitespace-pre-line">
          {text.split(/(\[[FD][1-9][0-9]*\])/).map((segment, index) => {
            const citation = byId.get(segment.slice(1, -1));
            return citation ? (
              <CitationChip
                key={index}
                citation={citation}
                businessId={businessId}
              />
            ) : (
              <Fragment key={index}>{segment}</Fragment>
            );
          })}
        </div>

        {qa.retrieval_note ? (
          <p className="text-xs text-muted-foreground">{qa.retrieval_note}</p>
        ) : null}

        {citedFin.length + citedDocs.length > 0 ? (
          <Trace>
            <TraceCollapsible>
              <TraceCollapsibleTrigger>
                <TraceLine>
                  <TraceIcon>
                    <HugeiconsIcon icon={File02Icon} />
                  </TraceIcon>
                  <TraceTitle>
                    Used {citedFin.length + citedDocs.length}{" "}
                    {citedFin.length + citedDocs.length === 1
                      ? "source"
                      : "sources"}
                  </TraceTitle>
                </TraceLine>
              </TraceCollapsibleTrigger>
              <TraceCollapsibleContent>
                <ul className="flex flex-col gap-2">
                  {citedFin.map((cit) => (
                    <FinancialSource
                      key={cit.citation_id}
                      citation={cit}
                      ruleVersion={qa.rule_version}
                    />
                  ))}
                  {citedDocs.map((doc) => (
                    <DocumentSource
                      key={doc.citation_id}
                      citation={doc}
                      businessId={businessId}
                    />
                  ))}
                </ul>
              </TraceCollapsibleContent>
            </TraceCollapsible>
          </Trace>
        ) : null}

        {uncitedFin.length + otherDocs.length > 0 ? (
          <Trace>
            <TraceCollapsible>
              <TraceCollapsibleTrigger>
                <TraceLine>
                  <TraceTitle>
                    Also checked ({uncitedFin.length} financial
                    {otherDocs.length > 0
                      ? `, ${otherDocs.length} document`
                      : ""}
                    )
                  </TraceTitle>
                </TraceLine>
              </TraceCollapsibleTrigger>
              <TraceCollapsibleContent>
                <ul className="flex flex-col gap-2">
                  {uncitedFin.map((cit) => (
                    <FinancialSource
                      key={cit.citation_id}
                      citation={cit}
                      ruleVersion={qa.rule_version}
                    />
                  ))}
                  {otherDocs.map((doc) => (
                    <DocumentSource
                      key={doc.citation_id}
                      citation={doc}
                      businessId={businessId}
                    />
                  ))}
                </ul>
              </TraceCollapsibleContent>
            </TraceCollapsible>
          </Trace>
        ) : null}

        {qa.limitations.length > 0 ? (
          <MessageFooter className="px-0 font-normal">
            {qa.limitations[qa.limitations.length - 1]}
          </MessageFooter>
        ) : null}
      </MessageContent>
    </Message>
  );
}

function CitationChip({
  citation,
  businessId,
}: {
  citation: FinancialCitation | DocumentCitation;
  businessId: string;
}) {
  const isDocument = "excerpt" in citation;
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={10}
        closeDelay={100}
        render={
          <Button
            type="button"
            variant="secondary"
            size="xs"
            className="mx-0.5 h-5 px-1.5 align-baseline font-mono"
          />
        }
      >
        [{citation.citation_id}]
      </HoverCardTrigger>
      <HoverCardContent className="flex w-72 flex-col gap-1.5 text-sm">
        {isDocument ? (
          <>
            <p className="font-medium">
              {citation.filename}, p. {citation.page_number}
            </p>
            <p className="text-muted-foreground">
              &ldquo;{citation.excerpt}&rdquo;
            </p>
            <a
              href={documentFileUrl(
                businessId,
                citation.document_id,
                citation.page_number,
              )}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-muted-foreground underline-offset-4 hover:underline"
            >
              Open PDF page {citation.page_number}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </>
        ) : (
          <>
            <p className="font-medium">{citation.label}</p>
            <p className="text-muted-foreground">{citation.summary}</p>
          </>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

function FinancialSource({
  citation,
  ruleVersion,
}: {
  citation: FinancialCitation;
  ruleVersion: string;
}) {
  return (
    <li className="flex flex-col gap-1 text-xs">
      <span className="flex flex-wrap items-center gap-1.5 text-foreground">
        <span className="font-mono">[{citation.citation_id}]</span>
        <span className="font-medium">{citation.label}</span>
        {citation.year_start !== null ? (
          <span>{financialYearLabel(citation.year_start)}</span>
        ) : null}
        <EvidenceBadge state={citation.state} />
        {citation.value_display ? (
          <span className="tabular-nums">{citation.value_display}</span>
        ) : null}
      </span>
      {citation.origins.length > 0 ? (
        <span>{citation.origins.join("; ")}</span>
      ) : null}
      {citation.reasons.map((reason) => (
        <span key={reason}>{reason}</span>
      ))}
      <span className="sr-only">Rules {ruleVersion}</span>
    </li>
  );
}

function DocumentSource({
  citation,
  businessId,
}: {
  citation: DocumentCitation;
  businessId: string;
}) {
  return (
    <li className="flex flex-col gap-1 text-xs">
      <a
        href={documentFileUrl(
          businessId,
          citation.document_id,
          citation.page_number,
        )}
        target="_blank"
        rel="noreferrer"
        className="flex flex-wrap items-center gap-1.5 font-medium text-foreground underline-offset-4 hover:underline"
      >
        <span className="font-mono">[{citation.citation_id}]</span>
        {citation.filename}, p. {citation.page_number}
        {citation.section ? (
          <span className="font-normal text-muted-foreground">
            {citation.section}
          </span>
        ) : null}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
      <span className="line-clamp-3">&ldquo;{citation.excerpt}&rdquo;</span>
    </li>
  );
}
