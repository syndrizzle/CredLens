import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useWorkspace } from "./use-workspace";

function WorkspaceDialogs() {
  const {
    activeWorkspace,
    actionsDisabled,
    workspaceBusy,
    replacement,
    setReplacement,
    replaceDraft,
    confirmDeleteWorkspace,
    setConfirmDeleteWorkspace,
    handleDeleteWorkspace,
  } = useWorkspace();

  return (
    <>
      <AlertDialog open={replacement !== null} onOpenChange={(open) => { if (!open) setReplacement(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved entries?</AlertDialogTitle>
            <AlertDialogDescription>
              Continuing will replace your current draft. Save it first if you want to keep it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionsDisabled}>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={actionsDisabled}
              onClick={() => replacement && replaceDraft(replacement)}
            >
              Discard and continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmDeleteWorkspace && activeWorkspace !== null}
        onOpenChange={(open) => { if (!open) setConfirmDeleteWorkspace(false); }}
      >
        <AlertDialogContent className="data-[size=default]:sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete &ldquo;{activeWorkspace?.form.businessName}&rdquo; and all active data?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This immediately removes saved figures, revision history, uploaded PDFs, extraction snapshots, retrieval chunks and embeddings, analysis runs, reports and assistant answers.
            </AlertDialogDescription>
            <AlertDialogDescription className="text-xs">
              Backup limitation: external PostgreSQL host backups or point-in-time recovery snapshots follow database-host retention policies and are not immediately purged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={workspaceBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={workspaceBusy}
              onClick={() => void handleDeleteWorkspace()}
            >
              Delete business permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export { WorkspaceDialogs };
