import { HugeiconsIcon } from "@hugeicons/react";
import { Login01Icon, Logout01Icon, UnfoldMoreIcon, UserCircleIcon } from "@hugeicons/core-free-icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useWorkspace } from "./use-workspace";

function AccountMenu() {
  const { session, checkingSession, actionsDisabled, reveal, requestReplacement } = useWorkspace();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        {session ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              id="account-menu"
              disabled={actionsDisabled}
              render={<SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-accent" />}
            >
              <HugeiconsIcon icon={UserCircleIcon} />
              <span className="min-w-0 flex-1 truncate text-left">{session.email}</span>
              <HugeiconsIcon icon={UnfoldMoreIcon} className="ml-auto" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="min-w-56">
              <DropdownMenuItem onClick={() => requestReplacement({ type: "signout" })}>
                <HugeiconsIcon icon={Logout01Icon} />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <SidebarMenuButton
            tooltip="Sign in"
            disabled={checkingSession}
            onClick={() => reveal("auth-email", "overview")}
          >
            <HugeiconsIcon icon={Login01Icon} />
            <span>Sign in</span>
          </SidebarMenuButton>
        )}
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export { AccountMenu };
