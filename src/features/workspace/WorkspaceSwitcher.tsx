import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Delete02Icon, UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { Logo } from "@/components/logo";
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

function BusinessMark() {
  return (
    <span className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
      <Logo className="size-5" />
    </span>
  );
}

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
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" render={<div />} className="hover:bg-transparent active:bg-transparent">
            <BusinessMark />
            <span className="grid min-w-0 flex-1 text-left leading-tight">
              <span className="truncate font-medium">{guest ? name : "CredLens"}</span>
              <span className="truncate text-xs text-muted-foreground">{guest ? "Demo, not saved" : ""}</span>
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
            <BusinessMark />
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
