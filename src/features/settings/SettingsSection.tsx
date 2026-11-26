import { useEffect, useEffectEvent } from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { useWorkspace } from "@/features/workspace/use-workspace";

function SettingsSection({ active }: { active: boolean }) {
  const {
    session,
    activeWorkspace,
    actionsDisabled,
    documentBusy,
    workspaceBusy,
    auditLoading,
    auditError,
    auditEvents,
    loadAuditLog,
    requestReplacement,
    setConfirmDeleteWorkspace,
    setReplacement,
  } = useWorkspace();
  const onOpen = useEffectEvent(() => void loadAuditLog());
  useEffect(() => {
    if (active && session) onOpen();
  }, [active, session]);
  if (!session) return null;

  return (
    <>
      <PageHeader title="Settings" />

      <Card>
        <CardHeader>
          <CardTitle><h2>Account</h2></CardTitle>
          <CardDescription>{session.email}</CardDescription>
          <CardAction>
            <Button type="button" variant="outline" disabled={actionsDisabled} onClick={() => requestReplacement({ type: "signout" })}>
              Sign out
            </Button>
          </CardAction>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle><h2>Activity</h2></CardTitle>
          <CardDescription>Who did what and when. Financial figures are never logged.</CardDescription>
          <CardAction>
            <Button
              type="button"
              variant="outline"
              onClick={() => void loadAuditLog()}
              disabled={workspaceBusy || auditLoading}
            >
              {auditLoading ? <Spinner /> : null}
              Refresh
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
            {auditError ? (
              <p role="alert" className="text-sm text-destructive">{auditError}</p>
            ) : auditEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground">{auditLoading ? "Loading activity…" : "No activity recorded yet."}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Action</TableHead>
                    <TableHead>Details</TableHead>
                    <TableHead className="text-right">Time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {auditEvents.slice(0, 15).map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="font-mono text-xs">{event.action}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {event.details
                          ? Object.entries(event.details).map(([key, value]) => `${key}=${String(value)}`).join(", ")
                          : event.resource_type}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        <time dateTime={event.created_at}>{formatDateTime(event.created_at)}</time>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
        </CardContent>
      </Card>

      {activeWorkspace ? (
        <Card className="ring-destructive/30">
          <CardHeader>
            <CardTitle><h2>Danger zone</h2></CardTitle>
          </CardHeader>
          <CardContent>
            <Item variant="outline">
              <ItemContent>
                <ItemTitle>Delete {activeWorkspace.form.businessName}</ItemTitle>
                <ItemDescription>
                  Removes its figures, history, PDFs, analysis runs and reports.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={actionsDisabled || documentBusy}
                  onClick={() => {
                    setConfirmDeleteWorkspace(true);
                    setReplacement(null);
                  }}
                >
                  Delete business
                </Button>
              </ItemActions>
            </Item>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

export { SettingsSection };
