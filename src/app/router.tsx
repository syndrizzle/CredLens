import { useEffect } from "react";
import { createRootRoute, createRoute, createRouter, useLocation } from "@tanstack/react-router";

import { Workspace } from "@/features/workspace/Workspace";
import { SECTIONS } from "./sections";

const AUTH_PATHS = { "/login": "login", "/signup": "register" } as const;
const AUTH_TITLES = { login: "Sign in", register: "Create account" } as const;
const HOME_TITLE = document.title;

// Routes only pick the visible page; Workspace keeps every section mounted so drafts, answers and report state survive navigation.
const rootRoute = createRootRoute({
  component: function Root() {
    const pathname = useLocation({ select: (location) => location.pathname });
    const authMode = AUTH_PATHS[pathname as keyof typeof AUTH_PATHS];
    const page = authMode ? undefined : (SECTIONS.find((item) => item.path === pathname) ?? SECTIONS[0]);
    useEffect(() => {
      const name = authMode ? AUTH_TITLES[authMode] : page?.id === "overview" ? null : page?.title;
      document.title = name ? `${name} · CredLens` : HOME_TITLE;
    }, [authMode, page]);
    return <Workspace authMode={authMode} section={page?.id} />;
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
