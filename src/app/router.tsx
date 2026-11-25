import { createRootRoute, createRoute, createRouter, useLocation } from "@tanstack/react-router";

import { ManualEntry } from "@/features/manual-entry/ManualEntry";
import { SECTIONS } from "./sections";

// shortcut: one long-lived workspace component reads the section from the URL so drafts survive navigation; P6-05 moves each section into its own route component.
const rootRoute = createRootRoute({
  component: function Root() {
    const pathname = useLocation({ select: (location) => location.pathname });
    return <ManualEntry section={SECTIONS.find((item) => item.path === pathname)?.id ?? "overview"} />;
  },
});

const router = createRouter({
  routeTree: rootRoute.addChildren(
    SECTIONS.map((item) => createRoute({ getParentRoute: () => rootRoute, path: item.path })),
  ),
});

export { router };
