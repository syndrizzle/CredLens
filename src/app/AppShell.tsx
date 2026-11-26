import { useEffect, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";

import { Logo } from "@/components/logo";
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
  useSidebar,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SECTIONS, type Section } from "./sections";

type AppShellProps = {
  section?: Section;
  switcher: ReactNode;
  account: ReactNode;
  actions: ReactNode;
  children: ReactNode;
};

// The mobile sheet does not close on navigation by itself and would cover the new section.
function CloseSheetOnNavigate({ section }: { section?: Section }) {
  const { setOpenMobile } = useSidebar();
  useEffect(() => setOpenMobile(false), [section, setOpenMobile]);
  return null;
}

function AppShell({ section, switcher, account, actions, children }: AppShellProps) {
  return (
    <TooltipProvider>
      <SidebarProvider className="print:block print:min-h-0 print:bg-white">
        <CloseSheetOnNavigate section={section} />
        <a
          href="#main-content"
          className="sr-only rounded-md bg-background px-3 py-2 text-sm font-medium shadow-sm ring-1 ring-ring focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
        >
          Skip to content
        </a>
        <Sidebar collapsible="icon" variant="inset">
          <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton size="lg" tooltip="CredLens" render={<Link to="/" />}>
                  <span className="flex size-8 shrink-0 items-center justify-center text-foreground">
                    <Logo className="size-6!" />
                  </span>
                  <span className="font-heading text-base font-semibold">CredLens</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            {switcher}
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
          <SidebarFooter>{account}</SidebarFooter>
          </nav>
          <SidebarRail />
        </Sidebar>
        <SidebarInset id="main-content" tabIndex={-1} className="min-w-0 outline-none print:m-0 print:rounded-none print:shadow-none">
          <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/80 px-4 backdrop-blur-md [@media(prefers-reduced-transparency:reduce)]:bg-background [@media(prefers-reduced-transparency:reduce)]:backdrop-blur-none md:rounded-t-xl print:hidden">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mx-1 h-4 data-vertical:self-center" />
            <h1 className="truncate text-sm font-medium">
              {SECTIONS.find((item) => item.id === section)?.title ?? "CredLens"}
            </h1>
            <div className="ml-auto flex items-center gap-2">
              {actions}
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
