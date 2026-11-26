import { documentFileUrl } from "@/features/analysis/api";
import { SourceReview } from "./SourceReview";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useWorkspace } from "@/features/workspace/use-workspace";

function DocumentsSection() {
  const {
    form,
    session,
    activeWorkspace,
    documentBusy,
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

  return (
    <>
      {session && activeWorkspace ? (
        <Card>
          <CardHeader>
            <CardTitle><h2>Source PDF documents</h2></CardTitle>
            <CardDescription>
              Digital statements up to 20 MB and 50 pages. Scanned or image-only PDFs are rejected, and one file is processed at a time.
            </CardDescription>
            <CardAction>
              <Button type="button" variant="ghost" size="sm" disabled={actionsDisabled} onClick={() => void handleRefreshDocuments()}>
                Refresh document status
              </Button>
            </CardAction>
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
                onClick={() => void handleUploadDocument()}
                disabled={actionsDisabled || !selectedPdf}
              >
                {documentBusy ? "Processing PDF…" : "Upload PDF"}
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
                            className={buttonVariants({ variant: "ghost", size: "sm" })}
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
  );
}

export { DocumentsSection };
