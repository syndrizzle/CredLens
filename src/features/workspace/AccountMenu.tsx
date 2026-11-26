import { Link } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { Logout01Icon, Settings01Icon, UnfoldMoreIcon, UserAdd01Icon } from "@hugeicons/core-free-icons";
import { ThemeSubmenu } from "@/components/theme";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { useWorkspace } from "./use-workspace";

function AccountMenu() {
  const { session, actionsDisabled, requestReplacement, leaveGuest } = useWorkspace();
  const { isMobile } = useSidebar();
  const label = session?.email ?? "Guest";
  const identity = (
    <>
      <Avatar className="size-8 rounded-lg">
        <AvatarFallback className="rounded-lg">{label.slice(0, 2).toUpperCase()}</AvatarFallback>
      </Avatar>
      <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
        <span className="truncate font-medium">{label}</span>
        <span className="truncate text-xs text-muted-foreground">{session ? "Signed in" : "Demo mode"}</span>
      </span>
    </>
  );

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            id="account-menu"
            disabled={actionsDisabled}
            render={<SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-accent" />}
          >
            {identity}
            <HugeiconsIcon icon={UnfoldMoreIcon} className="ml-auto" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side={isMobile ? "bottom" : "right"} align="end" className="min-w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="flex items-center gap-2 p-1.5 font-normal text-foreground">
                {identity}
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <ThemeSubmenu />
              {session ? (
                <DropdownMenuItem render={<Link to="/settings" />}>
                  <HugeiconsIcon icon={Settings01Icon} />
                  Settings
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => leaveGuest("/signup")}>
                  <HugeiconsIcon icon={UserAdd01Icon} />
                  Create account
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => (session ? requestReplacement({ type: "signout" }) : leaveGuest("/login"))}
            >
              <HugeiconsIcon icon={Logout01Icon} />
              {session ? "Sign out" : "Exit demo"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export { AccountMenu };
