import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Progress, ProgressLabel } from "@/components/ui/progress";
import { useWorkspace } from "./use-workspace";

type Step = { title: string; detail: string; done: boolean; action: ReactNode };

function GetStarted() {
  const {
    session,
    activeWorkspace,
    savedClean,
    counts,
    allPresentReviewed,
    displayedAnalysis,
    analysisOutdated,
    analysis,
    workspaceBusy,
    loadExample,
    analyseFigures,
    leaveGuest,
  } = useWorkspace();

  const analysed = Boolean(displayedAnalysis) && !analysisOutdated;
  const steps: Step[] = [
    {
      title: "Add your figures",
      detail: "Upload a statement PDF, load the fictional example, or type them in.",
      done: counts.present > 0,
      action: (
        <>
          {session && activeWorkspace ? (
            <Link to="/documents" className={buttonVariants({ size: "sm" })}>
              Upload a PDF
            </Link>
          ) : null}
          <Button type="button" size="sm" variant={session && activeWorkspace ? "outline" : "default"} onClick={loadExample}>
            Load fictional example
          </Button>
          <Link to="/figures" className={buttonVariants({ size: "sm", variant: "ghost" })}>
            Enter figures
          </Link>
        </>
      ),
    },
    {
      title: "Confirm the figures",
      detail: "Check each amount against your statements and mark it confirmed.",
      done: counts.present > 0 && allPresentReviewed,
      action: (
        <Link to="/figures" className={buttonVariants({ size: "sm" })}>
          Review figures
        </Link>
      ),
    },
    {
      title: "Run the analysis",
      detail: "Six indicators, with anything missing or unconfirmed shown as a gap.",
      done: analysed,
      action: (
        <Button
          type="button"
          size="sm"
          disabled={analysis.loading || workspaceBusy}
          onClick={() => void analyseFigures()}
        >
          {analysis.loading || workspaceBusy ? "Analysing…" : "Analyse figures"}
        </Button>
      ),
    },
    {
      title: "Save and share a report",
      detail: session
        ? "Save the business, then create a printable report for your accountant or lender."
        : "Create an account to save the business and create a printable report.",
      done: savedClean && Boolean(activeWorkspace?.runs.length),
      action: session ? (
        <Link to="/reports" className={buttonVariants({ size: "sm" })}>
          Open reports
        </Link>
      ) : (
        <Button type="button" size="sm" onClick={() => leaveGuest("/signup")}>
          Create account
        </Button>
      ),
    },
  ];
  const current = steps.findIndex((step) => !step.done);
  if (current === -1) return null;
  const done = steps.filter((step) => step.done).length;
  const step = steps[current]!;

  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-4">
        <Progress value={(done / steps.length) * 100} aria-label="Setup progress">
          <ProgressLabel>Getting started</ProgressLabel>
          <span className="ml-auto text-sm text-muted-foreground tabular-nums">
            {done} of {steps.length} done
          </span>
        </Progress>
        <ol className="sr-only">
          {steps.map((item) => (
            <li key={item.title}>{item.title}{item.done ? " (done)" : item === step ? " (next)" : ""}</li>
          ))}
        </ol>
        <Item variant="muted" aria-current="step">
          <ItemContent>
            <ItemTitle>
              <h2>{step.title}</h2>
            </ItemTitle>
            <ItemDescription>{step.detail}</ItemDescription>
          </ItemContent>
          <ItemActions className="flex-wrap">{step.action}</ItemActions>
        </Item>
      </CardContent>
    </Card>
  );
}

export { GetStarted };
