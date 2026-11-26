import { createRootRoute, createRoute, createRouter, useLocation } from "@tanstack/react-router";

import { Workspace } from "@/features/workspace/Workspace";
import { SECTIONS } from "./sections";

const AUTH_PATHS = { "/login": "login", "/signup": "register" } as const;

// Routes only pick the visible page; Workspace keeps every section mounted so drafts, answers and report state survive navigation.
const rootRoute = createRootRoute({
  component: function Root() {
    const pathname = useLocation({ select: (location) => location.pathname });
    const authMode = AUTH_PATHS[pathname as keyof typeof AUTH_PATHS];
    return (
      <Workspace
        authMode={authMode}
        section={authMode ? undefined : (SECTIONS.find((item) => item.path === pathname)?.id ?? "overview")}
      />
    );
  },
});

const router = createRouter({
  routeTree: rootRoute.addChildren(
    [...SECTIONS.map((item) => item.path), ...Object.keys(AUTH_PATHS)].map((path) =>
      createRoute({ getParentRoute: () => rootRoute, path }),
    ),
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export { router };
