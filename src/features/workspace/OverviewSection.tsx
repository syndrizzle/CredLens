import { PageHeader } from "@/components/page-header";
import { AnalysisOverview } from "@/features/analysis/AnalysisOverview";
import { financialYearLabel } from "@/features/manual-entry/model";
import { useWorkspace } from "@/features/workspace/use-workspace";
import { GetStarted } from "./GetStarted";

function OverviewSection() {
  const { periods, displayedAnalysis, reveal, handleJumpToField } = useWorkspace();
  const years = periods.map((period) => financialYearLabel(period.yearStart));

  return (
    <>
      <PageHeader title="Overview" description={years.length > 1 ? `${years[0]} to ${years.at(-1)}` : years[0]} />
      <GetStarted />
      {displayedAnalysis ? (
        <AnalysisOverview
          data={displayedAnalysis}
          onOpenFinding={(year, indicator) => reveal(`finding-${year}-${indicator}`, "analysis", "start")}
          onOpenInput={handleJumpToField}
          onOpenAllActions={() => reveal("preparation-actions", "analysis", "start")}
        />
      ) : null}
    </>
  );
}

export { OverviewSection };
