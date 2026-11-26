import { fetchAuditEvents } from "@/features/analysis/api";
import { HugeiconsIcon } from "@hugeicons/react";
import { InformationCircleIcon } from "@hugeicons/core-free-icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Link } from "@tanstack/react-router";
import { AnalysisOverview } from "@/features/analysis/AnalysisOverview";
import { useWorkspace } from "@/features/workspace/use-workspace";

function OverviewSection() {
  const {
    displayedAnalysis,
    reveal,
    handleJumpToField,
    session,
    authMode,
    setAuthMode,
    email,
    setEmail,
    password,
    setPassword,
    authError,
    setAuthError,
    authBusy,
    checkingSession,
    workspaceBusy,
    auditOpen,
    auditLoading,
    setAuditLoading,
    auditError,
    setAuditError,
    auditEvents,
    setAuditEvents,
    handleAuth,
    handleToggleAuditLog,
  } = useWorkspace();

  return (
    <>
      {displayedAnalysis ? (
        <AnalysisOverview
          data={displayedAnalysis}
          onOpenFinding={(year, indicator) => reveal(`finding-${year}-${indicator}`, "analysis", "start")}
          onOpenInput={handleJumpToField}
        />
      ) : (
        <Empty className="border border-dashed border-border">
          <EmptyHeader>
            <EmptyTitle>No analysis yet</EmptyTitle>
            <EmptyDescription>
              Enter or load figures, confirm them, then run the analysis.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center">
            <Link to="/figures" className={buttonVariants({ variant: "outline" })}>
              Go to Figures
            </Link>
            <Link to="/analysis" className={buttonVariants({ variant: "ghost" })}>
              Go to Analysis
            </Link>
          </EmptyContent>
        </Empty>
      )}

      {!session ? (
        <Card>
          <CardHeader>
            <CardTitle><h2>Sign in to save workspaces</h2></CardTitle>
            <CardDescription>
              Workspaces, documents and analysis runs are scoped to your local account.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {checkingSession ? <p role="status" className="text-sm text-muted-foreground">Checking saved session…</p> : null}
        <form onSubmit={handleAuth} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="auth-email">Email</Label>
              <Input
                id="auth-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="auth-password">Password</Label>
              <Input
                id="auth-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={
                  authMode === "register"
                    ? "new-password"
                    : "current-password"
                }
                minLength={12}
                maxLength={128}
                required
              />
              <p className="text-xs text-muted-foreground">
                Use 12 to 128 characters.
              </p>
            </div>
          </div>
          {authError ? (
            <p role="alert" className="text-sm text-destructive">
              {authError}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={authBusy}>
              {authBusy
                ? "Submitting…"
                : authMode === "register"
                  ? "Create account"
                  : "Sign in"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setAuthMode((current) =>
                  current === "login" ? "register" : "login",
                );
                setAuthError(null);
              }}
            >
              {authMode === "login"
                ? "Need an account? Create one"
                : "Already have an account? Sign in"}
            </Button>
          </div>
        </form>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle><h2>Activity</h2></CardTitle>
            <CardDescription>Actor, action and time only; no financial payloads.</CardDescription>
            <CardAction>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void handleToggleAuditLog()}
                disabled={workspaceBusy || auditLoading}
              >
                {auditOpen ? "Hide activity log" : "Activity log"}
              </Button>
            </CardAction>
          </CardHeader>
          {auditOpen ? (
            <CardContent>
          <div className="space-y-2 rounded-lg border border-border p-3 text-xs">
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium text-foreground">Recent activity</p>
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={auditLoading}
                onClick={async () => {
                  setAuditLoading(true);
                  setAuditError(null);
                  try {
                    setAuditEvents(await fetchAuditEvents());
                  } catch (error) {
                    setAuditError(
                      error instanceof Error
                        ? error.message
                        : "Could not load activity log.",
                    );
                  } finally {
                    setAuditLoading(false);
                  }
                }}
              >
                {auditLoading ? "Loading…" : "Refresh log"}
              </Button>
            </div>
            {auditError ? (
              <p role="alert" className="text-destructive">
                {auditError}
              </p>
            ) : auditEvents.length === 0 ? (
              <p className="text-muted-foreground">
                {auditLoading
                  ? "Loading activity log…"
                  : "No activity recorded yet."}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {auditEvents.slice(0, 15).map((event) => (
                  <li
                    key={event.id}
                    className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-1.5"
                  >
                    <span className="font-mono text-foreground">
                      {event.action} · {event.resource_type}
                      {event.details
                        ? ` (${Object.entries(event.details)
                            .map(([k, v]) => `${k}=${String(v)}`)
                            .join(", ")})`
                        : ""}
                    </span>
                    <span className="text-muted-foreground">
                      {event.created_at}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
            </CardContent>
          ) : null}
        </Card>
      )}

      {!session ? (
        <Alert role="status">
          <HugeiconsIcon icon={InformationCircleIcon} />
          <AlertTitle>Prototype data is not saved</AlertTitle>
          <AlertDescription className="col-start-2">
            Without signing in, reloading the page clears every entry. Use
            fictional data until private-data protection is verified. Figures
            are confirmed manually and are not authenticated.
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

export { OverviewSection };
