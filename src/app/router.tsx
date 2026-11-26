import { createRootRoute, createRoute, createRouter, useLocation } from "@tanstack/react-router";

import { Workspace } from "@/features/workspace/Workspace";
import { SECTIONS } from "./sections";

// Routes only pick the visible section; Workspace keeps every section mounted so drafts, Q&A answers and report state survive navigation.
const rootRoute = createRootRoute({
  component: function Root() {
    const pathname = useLocation({ select: (location) => location.pathname });
    return <Workspace section={SECTIONS.find((item) => item.path === pathname)?.id ?? "overview"} />;
  },
});

const router = createRouter({
  routeTree: rootRoute.addChildren(
    SECTIONS.map((item) => createRoute({ getParentRoute: () => rootRoute, path: item.path })),
  ),
});

export { router };
