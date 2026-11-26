import type { ComponentProps, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";

import { Logo } from "@/components/logo";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
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
  businessName: string;
  switcher: ReactNode;
  account: ReactNode;
  actions: ReactNode;
  badges?: Partial<Record<Section, ReactNode>>;
  children: ReactNode;
};

const GROUPS = ["main", "Data", "Insights", "footer"] as const;

// The phone sheet does not close on navigation by itself and would cover the page.
function SidebarLink({ onClick, ...props }: ComponentProps<typeof Link>) {
  const { setOpenMobile } = useSidebar();
  return (
    <Link
      {...props}
      onClick={(event) => {
        onClick?.(event);
        setOpenMobile(false);
      }}
    />
  );
}

function AppShell({
  section,
  businessName,
  switcher,
  account,
  actions,
  badges,
  children,
}: AppShellProps) {
  return (
    <TooltipProvider>
      <SidebarProvider className="print:block print:min-h-0 print:bg-white">
        <a
          href="#main-content"
          className="sr-only rounded-md bg-background px-3 py-2 text-sm font-medium shadow-sm ring-1 ring-ring focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
        >
          Skip to content
        </a>
        <Sidebar collapsible="icon" variant="inset">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton size="lg" tooltip="CredLens" render={<SidebarLink to="/" />}>
                  <span className="flex size-8 shrink-0 items-center justify-center text-foreground">
                    <Logo className="size-5!" />
                  </span>
                  <span className="font-heading text-lg font-semibold tracking-tight">CredLens</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            {switcher}
          </SidebarHeader>
          <SidebarContent>
            <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col">
              {GROUPS.map((group) => (
                <SidebarGroup
                  key={group}
                  className={group === "footer" ? "mt-auto" : undefined}
                >
                  {group === "main" || group === "footer" ? null : (
                    <SidebarGroupLabel>{group}</SidebarGroupLabel>
                  )}
                  <SidebarMenu>
                    {SECTIONS.filter((item) => item.group === group).map(
                      (item) => (
                        <SidebarMenuItem key={item.id}>
                          <SidebarMenuButton
                            isActive={item.id === section}
                            tooltip={item.title}
                            render={<SidebarLink to={item.path} />}
                          >
                            <HugeiconsIcon icon={item.icon} />
                            <span>{item.title}</span>
                          </SidebarMenuButton>
                          {badges?.[item.id] ? (
                            <SidebarMenuBadge>
                              {badges[item.id]}
                            </SidebarMenuBadge>
                          ) : null}
                        </SidebarMenuItem>
                      ),
                    )}
                  </SidebarMenu>
                </SidebarGroup>
              ))}
            </nav>
          </SidebarContent>
          <SidebarFooter>{account}</SidebarFooter>
          <SidebarRail />
        </Sidebar>
        <SidebarInset
          id="main-content"
          tabIndex={-1}
          className="min-w-0 outline-none print:m-0 print:rounded-none print:shadow-none"
        >
          <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/80 px-4 backdrop-blur-md [@media(prefers-reduced-transparency:reduce)]:bg-background [@media(prefers-reduced-transparency:reduce)]:backdrop-blur-none md:rounded-t-xl print:hidden">
            <SidebarTrigger className="-ml-1" />
            <Separator
              orientation="vertical"
              className="mr-2 data-vertical:h-4 data-vertical:self-center"
            />
            <Breadcrumb className="min-w-0">
              <BreadcrumbList className="flex-nowrap">
                <BreadcrumbItem className="hidden min-w-0 md:inline-flex">
                  <BreadcrumbLink className="truncate" render={<Link to="/" />}>
                    {businessName}
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem>
                  <BreadcrumbPage>
                    {SECTIONS.find((item) => item.id === section)?.title ??
                      "CredLens"}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {actions}
            </div>
          </header>
          <div className="flex-1 px-4 py-6 md:px-8 lg:py-8 print:p-0">
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

export { AppShell };
