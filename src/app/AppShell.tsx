import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";

import { ModeToggle } from "@/components/theme";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SECTIONS, type Section } from "./sections";

type AppShellProps = {
  section?: Section;
  email: string | null;
  status: ReactNode;
  children: ReactNode;
};

function AppShell({ section, email, status, children }: AppShellProps) {
  return (
    <TooltipProvider>
      <SidebarProvider className="print:block print:min-h-0 print:bg-white">
        <Sidebar collapsible="icon" variant="inset">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton size="lg" tooltip="CredLens" render={<Link to="/" />}>
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary font-heading text-sm font-semibold text-primary-foreground">
                    C
                  </span>
                  <span className="font-heading text-base font-semibold">CredLens</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarMenu>
                {SECTIONS.map((item) => (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      isActive={item.id === section}
                      tooltip={item.title}
                      render={<Link to={item.path} />}
                    >
                      <HugeiconsIcon icon={item.icon} />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>
          {email ? (
            <SidebarFooter className="group-data-[collapsible=icon]:hidden">
              <p className="truncate px-2 text-xs text-muted-foreground">{email}</p>
            </SidebarFooter>
          ) : null}
          <SidebarRail />
        </Sidebar>
        <SidebarInset className="min-w-0 print:m-0 print:rounded-none print:shadow-none">
          <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/80 px-4 backdrop-blur-md md:rounded-t-xl print:hidden">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mx-1 h-4 data-vertical:self-center" />
            <h1 className="truncate text-sm font-medium">
              {SECTIONS.find((item) => item.id === section)?.title ?? "CredLens"}
            </h1>
            <div className="ml-auto flex items-center gap-2">
              {status}
              <ModeToggle />
            </div>
          </header>
          <div className="flex-1 px-4 py-6 md:px-6 lg:py-8 print:p-0">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

export { AppShell };
