import { describe, expect, test } from "bun:test";
import fixture from "../backend/tests/fixtures/aster_components.json";
import {
  COMPLETED_YEARS,
  FINANCIAL_FIELDS,
  applyCandidatesToForm,
  countCandidateOverwrites,
  createEmptyForm,
  createExampleForm,
  createPeriod,
  countReview,
  detachDocumentSource,
  financialYearLabel,
  firstErrorId,
  hasEntries,
  hasErrors,
  immediatePrior,
  isDocumentFigure,
  latestCompletedYearStart,
  nextPeriodYear,
  presentFigures,
  resetBrokenComparability,
  resetReview,
  sortedPeriods,
  validateForm,
  type CandidateImport,
  confirmPresent,
} from "../src/features/manual-entry/model";

const latest = latestCompletedYearStart();

function validForm() {
  return {
    businessName: "Aster Components (fictional)",
    periods: [createPeriod(latest)],
  };
}

describe("financial years", () => {
  test("uses the latest completed April-March year", () => {
    expect(latestCompletedYearStart(new Date("2026-11-10T00:00:00Z"))).toBe(
      2025,
    );
    expect(latestCompletedYearStart(new Date("2026-04-01T00:00:00Z"))).toBe(
      2025,
    );
  });

  test("treats January to March as the prior completed year", () => {
    expect(latestCompletedYearStart(new Date("2026-01-15T00:00:00Z"))).toBe(
      2024,
    );
    expect(latestCompletedYearStart(new Date("2026-03-31T18:00:00Z"))).toBe(
      2024,
    );
  });

  test("respects the Asia/Kolkata April boundary", () => {
    // 2026-03-31 23:30 IST: still FY 2025-26 in progress.
    expect(latestCompletedYearStart(new Date("2026-03-31T18:00:00Z"))).toBe(
      2024,
    );
    // 2026-04-01 01:30 IST: FY 2026-27 starts, so FY 2025-26 is complete.
    expect(latestCompletedYearStart(new Date("2026-03-31T20:00:00Z"))).toBe(
      2025,
    );
  });

  test("labels and orders completed years", () => {
    expect(financialYearLabel(2024)).toBe("FY 2024-25");
    expect(financialYearLabel(1999)).toBe("FY 1999-00");
    expect(financialYearLabel(2009)).toBe("FY 2009-10");
    expect(COMPLETED_YEARS[0]).toBe(latest);
    expect(COMPLETED_YEARS.at(-1)).toBe(2000);
  });

  test("defaults to one period for the latest completed year", () => {
    const form = createEmptyForm();
    expect(form.businessName).toBe("");
    expect(form.periods).toHaveLength(1);
    expect(form.periods[0].yearStart).toBe(latest);
    expect(form.periods[0].unit).toBe("rupees");
  });

  test("adds the nearest unused prior year", () => {
    expect(nextPeriodYear([createPeriod(latest)])).toBe(latest - 1);
    expect(
      nextPeriodYear([createPeriod(latest), createPeriod(latest - 1)]),
    ).toBe(latest - 2);
    expect(
      nextPeriodYear([createPeriod(latest), createPeriod(latest - 2)]),
    ).toBe(latest - 3);
  });

  test("sorts periods without mutating the draft", () => {
    const periods = [createPeriod(latest), createPeriod(latest - 1)];
    expect(sortedPeriods(periods).map((period) => period.yearStart)).toEqual([
      latest - 1,
      latest,
    ]);
    expect(periods[0].yearStart).toBe(latest);
  });

  test("finds only an immediately preceding period", () => {
    const prior = createPeriod(latest - 1);
    const current = createPeriod(latest);
    expect(immediatePrior([prior, current], current)).toBe(prior);
    expect(immediatePrior([current], current)).toBeUndefined();
  });

  test("resets comparability when the immediate prior disappears", () => {
    const prior = createPeriod(latest - 1);
    const current = { ...createPeriod(latest), comparableToPrior: true };
    expect(
      resetBrokenComparability([prior, current])[1].comparableToPrior,
    ).toBe(true);
    expect(resetBrokenComparability([current])[0].comparableToPrior).toBe(
      false,
    );
  });
});

describe("validation", () => {
  test("accepts a valid blank form; missing figures stay missing", () => {
    const form = validForm();
    expect(hasErrors(validateForm(form))).toBe(false);
    expect(countReview(form.periods)).toEqual({ present: 0, reviewed: 0 });
  });

  test("requires a business name", () => {
    const form = validForm();
    form.businessName = "   ";
    const errors = validateForm(form);
    expect(errors.businessName).toBe("Enter the business name.");
    expect(hasErrors(errors)).toBe(true);
    expect(firstErrorId(errors, form)).toBe("business-name");
  });

  test("rejects duplicate and incomplete years", () => {
    const form = validForm();
    form.periods.push(createPeriod(latest), createPeriod(latest));
    form.periods[0].yearStart = latest + 1;
    const errors = validateForm(form);
    expect(errors.years[form.periods[0].id]).toBe(
      "Choose a completed April–March financial year.",
    );
    expect(errors.years[form.periods[2].id]).toBe(
      "Each financial year can appear only once.",
    );
    expect(firstErrorId(errors, form)).toBe(`year-${form.periods[0].id}`);
  });

  test("rejects amounts the backend would reject", () => {
    const form = validForm();
    const period = form.periods[0];
    period.figures.revenue.raw = "12,000";
    period.figures.ebit.raw = "1.234";
    period.figures.total_assets.raw = "1234567890123456";
    period.figures.profit_after_tax.raw = "-900000";
    period.figures.interest_expense.raw = "+12.30";
    period.figures.current_assets.raw = "   ";

    const errors = validateForm(form);
    expect(errors.figures[`${period.id}:revenue`]).toContain("plain amount");
    expect(errors.figures[`${period.id}:ebit`]).toContain("plain amount");
    expect(errors.figures[`${period.id}:total_assets`]).toContain(
      "plain amount",
    );
    expect(errors.figures[`${period.id}:profit_after_tax`]).toBeUndefined();
    expect(errors.figures[`${period.id}:interest_expense`]).toBeUndefined();
    expect(errors.figures[`${period.id}:current_assets`]).toBeUndefined();
    expect(firstErrorId(errors, form)).toBe(`figure-${period.id}-revenue`);
  });

  test("tracks present figures and resets review without losing values", () => {
    const period = createPeriod(latest, {
      revenue: "10000000.00",
      ebit: "1500000.00",
    });
    period.figures.revenue.reviewed = true;

    expect(presentFigures(period).map((field) => field.key)).toEqual([
      "revenue",
      "ebit",
    ]);
    expect(countReview([period])).toEqual({ present: 2, reviewed: 1 });

    const reset = resetReview(period.figures);
    expect(reset.revenue).toEqual({ raw: "10000000.00", reviewed: false });
    expect(reset.ebit).toEqual({ raw: "1500000.00", reviewed: false });
    expect(period.figures.revenue.reviewed).toBe(true);
  });

  test("confirms present figures only and keeps blanks missing", () => {
    const form = createExampleForm();
    form.periods[0]!.figures.interest_expense = { raw: "", reviewed: false };
    const confirmed = confirmPresent(form.periods);
    expect(confirmed[0]!.figures.revenue.reviewed).toBe(true);
    expect(confirmed[0]!.figures.interest_expense).toEqual({ raw: "", reviewed: false });
    expect(countReview(confirmed)).toEqual({ present: 23, reviewed: 23 });
    expect(form.periods[0]!.figures.revenue.reviewed).toBe(false);
  });

  test("detects entries before replacing the example", () => {
    expect(hasEntries(createEmptyForm())).toBe(false);
    expect(hasEntries({ ...createEmptyForm(), businessName: "Aster" })).toBe(
      true,
    );
    expect(
      hasEntries({
        ...createEmptyForm(),
        periods: [createPeriod(latest, { revenue: "1.00" })],
      }),
    ).toBe(true);
    expect(
      hasEntries({
        ...createEmptyForm(),
        periods: [createPeriod(latest), createPeriod(latest - 1)],
      }),
    ).toBe(true);
    expect(
      hasEntries({
        ...createEmptyForm(),
        periods: [{ ...createPeriod(latest), comparableToPrior: true }],
      }),
    ).toBe(true);
  });

  test("year-only and unit-only drafts need replacement confirmation", () => {
    const form = createEmptyForm();
    form.periods[0]!.yearStart -= 1;
    expect(hasEntries(form)).toBe(true);
    form.periods[0]!.yearStart += 1;
    form.periods[0]!.unit = "lakhs";
    expect(hasEntries(form)).toBe(true);
  });
});

describe("fictional example", () => {
  test("loads two unreviewed, complete periods", () => {
    const form = createExampleForm();
    expect(form.businessName).toBe("Aster Components (fictional)");
    expect(form.periods.map((period) => period.yearStart)).toEqual([
      2023, 2024,
    ]);
    expect(form.periods.map((period) => period.comparableToPrior)).toEqual([
      false,
      true,
    ]);
    expect(form.periods.every((period) => period.unit === "rupees")).toBe(true);
    expect(countReview(form.periods)).toEqual({ present: 24, reviewed: 0 });
    expect(hasErrors(validateForm(form))).toBe(false);

    for (const period of form.periods) {
      for (const field of FINANCIAL_FIELDS) {
        expect(period.figures[field.key].raw).not.toBe("");
      }
    }
  });

  test("matches the backend analysis fixture", () => {
    const form = createExampleForm();
    const request = fixture.request;

    expect(form.businessName).toBe(request.business_name);
    expect(form.periods.map((period) => period.yearStart)).toEqual(
      request.periods.map((period) => period.year_start),
    );

    for (const [index, period] of form.periods.entries()) {
      const source = request.periods[index];
      expect(period.unit).toBe(source.unit);
      expect(period.comparableToPrior).toBe(source.comparable_to_prior);
      for (const field of FINANCIAL_FIELDS) {
        expect(period.figures[field.key].raw).toBe(
          source.values[field.key].raw,
        );
        expect(period.figures[field.key].reviewed).toBe(
          source.values[field.key].reviewed,
        );
      }
    }
  });
});

describe("document candidate import and provenance", () => {
  const sampleCandidate = (
    overrides: Partial<CandidateImport> = {},
  ): CandidateImport => ({
    field: "revenue",
    yearStart: 2024,
    unit: "rupees",
    amount: "12000000.00",
    source: {
      document_id: "doc-1",
      filename: "aster-reference.pdf",
      page_number: 1,
      table_index: 1,
      row_index: 2,
      column_index: 3,
      label: "Revenue from operations",
      raw_token: "1,20,00,000.00",
    },
    ...overrides,
  });

  test("applies candidates replacing empty placeholder period, leaving figures unreviewed", () => {
    const empty = { ...createEmptyForm(), businessName: "Aster" };
    const result = applyCandidatesToForm(empty, [
      sampleCandidate({ yearStart: 2023, amount: "10000000.00" }),
      sampleCandidate({ yearStart: 2024, amount: "12000000.00" }),
    ]);
    expect(result.applied).toBe(2);
    expect(result.overwritten).toBe(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.form.periods.map((p) => p.yearStart)).toEqual([2023, 2024]);
    const rev24 = result.form.periods[1]!.figures.revenue;
    expect(rev24.raw).toBe("12000000.00");
    expect(rev24.reviewed).toBe(false);
    expect(isDocumentFigure(rev24)).toBe(true);
    expect(rev24.source?.page_number).toBe(1);
  });

  test("counts overwrites and skips unit-conflicting or over-3-year candidates without silent coercion", () => {
    const form = createExampleForm();
    expect(countCandidateOverwrites(form, [sampleCandidate()])).toBe(1);

    const unitMismatch = applyCandidatesToForm(form, [
      sampleCandidate({ unit: "lakhs", amount: "120.00" }),
    ]);
    expect(unitMismatch.applied).toBe(0);
    expect(unitMismatch.skipped).toHaveLength(1);
    expect(unitMismatch.skipped[0]!.reason).toContain("Rupees");

    const threeYears = {
      businessName: "Aster",
      periods: [createPeriod(2022), createPeriod(2023), createPeriod(2024)],
    };
    const overCap = applyCandidatesToForm(threeYears, [
      sampleCandidate({ yearStart: 2021 }),
    ]);
    expect(overCap.applied).toBe(0);
    expect(overCap.skipped[0]!.reason).toContain("3 financial years");
  });

  test("resetReview converts document figures to manual and detachDocumentSource clears only removed doc IDs", () => {
    const applied = applyCandidatesToForm(createEmptyForm(), [
      sampleCandidate(),
      sampleCandidate({
        field: "ebit",
        amount: "1200000.00",
        source: {
          ...sampleCandidate().source,
          document_id: "doc-2",
          row_index: 4,
        },
      }),
    ]).form;

    const untouched = detachDocumentSource(applied, "doc-other");
    expect(untouched).toBe(applied);

    const detached = detachDocumentSource(applied, "doc-1");
    expect(detached.periods[0]!.figures.revenue.source?.document_id).toBeNull();
    expect(detached.periods[0]!.figures.revenue.source?.filename).toBe(
      "aster-reference.pdf",
    );
    expect(detached.periods[0]!.figures.ebit.source?.document_id).toBe("doc-2");

    const reset = resetReview(applied.periods[0]!.figures);
    expect(isDocumentFigure(reset.revenue)).toBe(false);
    expect(reset.revenue.origin).toBeUndefined();
    expect(reset.revenue.source).toBeUndefined();
    expect(reset.revenue.reviewed).toBe(false);
  });
});
