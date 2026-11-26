import { documentFileUrl, type DocumentSummary } from "@/features/analysis/api";
import { SourceReview } from "./SourceReview";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  MoreHorizontalIcon,
  Upload04Icon,
} from "@hugeicons/core-free-icons";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "@/lib/format";
import { useWorkspace } from "@/features/workspace/use-workspace";

function statusBadge(doc: DocumentSummary) {
  if (doc.status === "ready") return <Badge variant="secondary">Ready</Badge>;
  if (doc.status === "failed")
    return <Badge variant="destructive">Failed</Badge>;
  return <Badge variant="outline">Processing</Badge>;
}

function DocumentsSection() {
  const {
    form,
    session,
    activeWorkspace,
    documentBusy,
    documentError,
    setDocumentError,
    activeReview,
    setActiveReview,
    reviewPage,
    setReviewPage,
    highlightedCell,
    setHighlightedCell,
    applyWarnings,
    fileInputRef,
    actionsDisabled,
    handleRefreshDocuments,
    handleUploadDocument,
    handleRetryDocument,
    handleOpenReview,
    handleRunExtraction,
    handleApplyCandidates,
    handleJumpToField,
    handleDeleteDocument,
  } = useWorkspace();
  if (!session || !activeWorkspace) return null;
  const documents = activeWorkspace.documents;
  const chooseFile = () => fileInputRef.current?.click();

  return (
    <>
      <PageHeader
        title="Documents"
        description="Digital statement PDFs, up to 20 MB and 50 pages each. Scanned PDFs can't be read."
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              disabled={actionsDisabled}
              onClick={() => void handleRefreshDocuments()}
            >
              Refresh document status
            </Button>
            <Button
              type="button"
              disabled={actionsDisabled}
              onClick={chooseFile}
            >
              {documentBusy ? (
                <Spinner />
              ) : (
                <HugeiconsIcon icon={Upload04Icon} />
              )}
              {documentBusy ? "Processing PDF…" : "Upload PDF"}
            </Button>
          </>
        }
      />
      <input
        ref={fileInputRef}
        id="pdf-upload-input"
        type="file"
        accept=".pdf,application/pdf"
        className="sr-only"
        tabIndex={-1}
        aria-label="Financial statement PDF"
        disabled={actionsDisabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset so choosing the same file again after a failure still uploads.
          event.target.value = "";
          setDocumentError(null);
          if (file) void handleUploadDocument(file);
        }}
      />

      {documentError ? (
        <Alert variant="destructive">
          <HugeiconsIcon icon={Alert02Icon} />
          <AlertTitle>PDF upload or processing failed</AlertTitle>
          <AlertDescription className="col-start-2">
            {documentError} Refresh document status before retrying an
            interrupted request.
          </AlertDescription>
        </Alert>
      ) : null}

      {documents.length === 0 ? (
        <Empty className="border border-dashed border-border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Upload04Icon} />
            </EmptyMedia>
            <EmptyTitle>No statements yet</EmptyTitle>
            <EmptyDescription>
              Upload a balance sheet or profit and loss PDF. CredLens finds the
              figures and shows you where each one came from.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              type="button"
              disabled={actionsDisabled}
              onClick={chooseFile}
            >
              Upload PDF
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <Card className="py-0">
          <Table aria-label="Uploaded PDF documents">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">File</TableHead>
                <TableHead className="hidden sm:table-cell">Status</TableHead>
                <TableHead className="hidden text-right sm:table-cell">
                  Pages
                </TableHead>
                <TableHead className="hidden text-right md:table-cell">
                  Size
                </TableHead>
                <TableHead className="hidden md:table-cell">Uploaded</TableHead>
                <TableHead className="pr-4 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.map((doc) => {
                const pendingRemoval = doc.error_code === "deletion_pending";
                return (
                  <TableRow key={doc.id}>
                    <TableCell className="max-w-40 pl-4 whitespace-normal sm:max-w-72">
                      <p className="truncate font-medium">{doc.filename}</p>
                      <div className="mt-1 sm:hidden">{statusBadge(doc)}</div>
                      {doc.error_message ? (
                        <p className="text-xs text-destructive">
                          {doc.error_message}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">{statusBadge(doc)}</TableCell>
                    <TableCell className="hidden text-right tabular-nums sm:table-cell">
                      {doc.page_count !== null
                        ? `${doc.page_count} ${doc.page_count === 1 ? "page" : "pages"}`
                        : "–"}
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums md:table-cell">
                      {Math.max(1, Math.round(doc.byte_size / 1024))} KB
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      <time dateTime={doc.created_at}>
                        {formatDate(doc.created_at)}
                      </time>
                    </TableCell>
                    <TableCell className="pr-4">
                      <div className="flex items-center justify-end gap-1">
                        {doc.status === "ready" ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={actionsDisabled}
                            onClick={() => void handleOpenReview(doc.id)}
                          >
                            {activeReview?.id === doc.id ? (
                              "Reviewing"
                            ) : (
                              <>
                                Review
                                <span className="max-sm:sr-only"> extracted figures</span>
                              </>
                            )}
                          </Button>
                        ) : doc.status === "failed" && !pendingRemoval ? (
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
                        {pendingRemoval ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={actionsDisabled}
                            onClick={() =>
                              void handleDeleteDocument(doc.id, doc.filename)
                            }
                          >
                            Remove
                          </Button>
                        ) : (
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              disabled={actionsDisabled}
                              render={
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`More actions for ${doc.filename}`}
                                />
                              }
                            >
                              <HugeiconsIcon icon={MoreHorizontalIcon} />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              align="end"
                              className="min-w-40"
                            >
                              {doc.status === "ready" ? (
                                <>
                                  <DropdownMenuItem
                                    render={
                                      <a
                                        href={documentFileUrl(
                                          activeWorkspace.id,
                                          doc.id,
                                        )}
                                        target="_blank"
                                        rel="noreferrer"
                                      />
                                    }
                                  >
                                    View PDF
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                </>
                              ) : null}
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() =>
                                  void handleDeleteDocument(
                                    doc.id,
                                    doc.filename,
                                  )
                                }
                              >
                                Remove
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      {activeReview ? (
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
  );
}

export { DocumentsSection };
