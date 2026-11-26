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
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { useWorkspace } from "./use-workspace";

function WorkspaceSwitcher() {
  const {
    session,
    guest,
    form,
    businesses,
    activeWorkspace,
    savedClean,
    actionsDisabled,
    documentBusy,
    requestReplacement,
    setConfirmDeleteWorkspace,
    setReplacement,
  } = useWorkspace();
  const { isMobile } = useSidebar();
  const name = form.businessName.trim() || "Untitled business";

  if (!session) {
    if (!guest) return null;
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" render={<div />} className="hover:bg-transparent active:bg-transparent">
            <span className="flex size-8 shrink-0 items-center justify-center"><HugeiconsIcon icon={Building03Icon} /></span>
            <span className="grid min-w-0 flex-1 text-left leading-tight">
              <span className="truncate font-medium">{name}</span>
              <span className="truncate text-xs text-muted-foreground">Demo, not saved</span>
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            id="workspace-switcher"
            disabled={actionsDisabled}
            render={<SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-accent" />}
          >
            <span className="flex size-8 shrink-0 items-center justify-center"><HugeiconsIcon icon={Building03Icon} /></span>
            <span className="grid min-w-0 flex-1 text-left leading-tight">
              <span className="truncate font-medium">{name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {!activeWorkspace ? "Not saved yet" : savedClean ? `Saved, revision ${activeWorkspace.revision}` : "Unsaved changes"}
              </span>
            </span>
            <HugeiconsIcon icon={UnfoldMoreIcon} className="ml-auto" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side={isMobile ? "bottom" : "right"} className="w-72">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Businesses</DropdownMenuLabel>
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
              New business
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
                Delete business
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export { WorkspaceSwitcher };
