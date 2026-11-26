import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Building03Icon, Delete02Icon, UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useWorkspace } from "./use-workspace";

function WorkspaceSwitcher() {
  const {
    session,
    businesses,
    activeWorkspace,
    actionsDisabled,
    documentBusy,
    requestReplacement,
    setConfirmDeleteWorkspace,
    setReplacement,
  } = useWorkspace();
  if (!session) return null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            id="workspace-switcher"
            disabled={actionsDisabled}
            render={<SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-accent" />}
          >
            <HugeiconsIcon icon={Building03Icon} />
            <span className="grid min-w-0 flex-1 text-left leading-tight">
              <span className="truncate font-medium">
                {activeWorkspace?.form.businessName || "No workspace open"}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {activeWorkspace ? `Revision ${activeWorkspace.revision}` : `${businesses.length} saved`}
              </span>
            </span>
            <HugeiconsIcon icon={UnfoldMoreIcon} className="ml-auto" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Saved businesses</DropdownMenuLabel>
              {businesses.length === 0 ? (
                <DropdownMenuItem disabled>No saved businesses yet</DropdownMenuItem>
              ) : (
                <DropdownMenuRadioGroup
                  value={activeWorkspace?.id ?? ""}
                  onValueChange={(id: string) => requestReplacement({ type: "load", id })}
                >
                  {businesses.map((item) => (
                    <DropdownMenuRadioItem key={item.id} value={item.id} closeOnClick>
                      <span className="truncate">{item.business_name}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">Rev {item.input_revision}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => requestReplacement({ type: "new" })}>
              <HugeiconsIcon icon={Add01Icon} />
              New workspace
            </DropdownMenuItem>
            {activeWorkspace ? (
              <DropdownMenuItem
                variant="destructive"
                disabled={documentBusy}
                onClick={() => {
                  setConfirmDeleteWorkspace(true);
                  setReplacement(null);
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} />
                Delete workspace
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export { WorkspaceSwitcher };
