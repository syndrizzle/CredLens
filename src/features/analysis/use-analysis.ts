import { useEffect, useState } from "react";
import type { FormDraft } from "../manual-entry/model";
import { fetchAnalysis, type AnalysisResponse } from "./api";

export function useAnalysis(form: FormDraft) {
  const [submitted, setSubmitted] = useState<{ form: FormDraft } | null>(null);
  const [outcome, setOutcome] = useState<{
    submission: typeof submitted; data?: AnalysisResponse; error?: string;
  } | null>(null);
  useEffect(() => {
    if (!submitted || submitted.form !== form) return;
    const controller = new AbortController();
    fetchAnalysis(form, controller.signal).then(
      data => { if (!controller.signal.aborted) setOutcome({ submission: submitted, data }); },
      error => { if (!controller.signal.aborted) setOutcome({ submission: submitted, error: error instanceof TypeError ? "Could not reach the local backend. Check that it is running, then retry." : error instanceof Error && error.name === "TimeoutError" ? "Analysis timed out. Please retry." : error instanceof Error ? error.message : "Analysis failed. Please retry." }); },
    );
    return () => controller.abort();
  }, [submitted, form]);
  const stale = submitted !== null && submitted.form !== form;
  const current = !stale && outcome?.submission === submitted ? outcome : null;
  return {
    data: current?.data, error: current?.error, stale,
    loading: submitted !== null && !stale && !current,
    run: () => setSubmitted({ form }),
  };
}
