export type FinancialFieldKey =
  | "revenue"
  | "profit_after_tax"
  | "ebit"
  | "interest_expense"
  | "current_assets"
  | "current_liabilities"
  | "total_assets"
  | "total_liabilities"
  | "total_equity"
  | "short_term_borrowings"
  | "long_term_borrowings"
  | "current_maturities";

export type Unit = "rupees" | "thousands" | "lakhs" | "crores";

export type FigureDraft = {
  raw: string;
  reviewed: boolean;
  revision?: number;
};

export type PeriodDraft = {
  id: string;
  yearStart: number;
  unit: Unit;
  comparableToPrior: boolean;
  figures: Record<FinancialFieldKey, FigureDraft>;
};

export type FormDraft = {
  businessName: string;
  periods: PeriodDraft[];
};

export type FormErrors = {
  businessName?: string;
  years: Record<string, string>;
  figures: Record<string, string>;
};

export type FieldDefinition = {
  key: FinancialFieldKey;
  label: string;
  hint: string;
};

export const FIELD_GROUPS: readonly {
  title: string;
  fields: readonly FieldDefinition[];
}[] = [
  {
    title: "Profit and loss",
    fields: [
      {
        key: "revenue",
        label: "Revenue from operations",
        hint: "Exclude other income.",
      },
      {
        key: "profit_after_tax",
        label: "Profit or loss after tax",
        hint: "Enter a loss as a negative amount.",
      },
      {
        key: "ebit",
        label: "Earnings before interest and tax (EBIT)",
        hint: "Supplied directly; do not substitute EBITDA.",
      },
      {
        key: "interest_expense",
        label: "Interest expense",
        hint: "Do not substitute all finance costs.",
      },
    ],
  },
  {
    title: "Balance sheet",
    fields: [
      {
        key: "current_assets",
        label: "Total current assets",
        hint: "At year end.",
      },
      {
        key: "current_liabilities",
        label: "Total current liabilities",
        hint: "Include current borrowing maturities.",
      },
      {
        key: "total_assets",
        label: "Total assets",
        hint: "At year end.",
      },
      {
        key: "total_liabilities",
        label: "Total liabilities",
        hint: "All liabilities excluding equity, not just borrowings.",
      },
      {
        key: "total_equity",
        label: "Total equity",
        hint: "Negative equity is kept and flagged for review.",
      },
    ],
  },
  {
    title: "Borrowings",
    fields: [
      {
        key: "short_term_borrowings",
        label: "Short-term borrowings",
        hint: "Interest-bearing; exclude current maturities and leases.",
      },
      {
        key: "long_term_borrowings",
        label: "Long-term borrowings",
        hint: "Interest-bearing; exclude current maturities and leases.",
      },
      {
        key: "current_maturities",
        label: "Current maturities",
        hint: "Long-term borrowing maturities counted here once; exclude leases.",
      },
    ],
  },
];

export const FINANCIAL_FIELDS = FIELD_GROUPS.flatMap((group) => group.fields);

export const UNIT_ITEMS: readonly { value: Unit; label: string }[] = [
  { value: "rupees", label: "Rupees" },
  { value: "thousands", label: "Thousands" },
  { value: "lakhs", label: "Lakhs" },
  { value: "crores", label: "Crores" },
];

export function unitLabel(unit: Unit): string {
  return UNIT_ITEMS.find((item) => item.value === unit)?.label ?? unit;
}

export function financialYearLabel(yearStart: number): string {
  return `FY ${yearStart}-${String((yearStart + 1) % 100).padStart(2, "0")}`;
}

export function latestCompletedYearStart(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "numeric",
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  // The year that starts this April is still in progress; the prior one is the latest complete.
  return month >= 4 ? year - 1 : year - 2;
}

const EARLIEST_YEAR_START = 2000;
const LATEST_COMPLETED_YEAR = latestCompletedYearStart();

export const COMPLETED_YEARS = Array.from(
  { length: Math.max(1, LATEST_COMPLETED_YEAR - EARLIEST_YEAR_START + 1) },
  (_, index) => LATEST_COMPLETED_YEAR - index,
);

export const YEAR_ITEMS = COMPLETED_YEARS.map((year) => ({
  value: year,
  label: financialYearLabel(year),
}));

let periodSequence = 0;

function nextPeriodId(): string {
  periodSequence += 1;
  return `period-${periodSequence}`;
}

export function createPeriod(
  yearStart: number,
  figures: Partial<Record<FinancialFieldKey, string>> = {},
): PeriodDraft {
  return {
    id: nextPeriodId(),
    yearStart,
    unit: "rupees",
    comparableToPrior: false,
    figures: Object.fromEntries(
      FINANCIAL_FIELDS.map((field) => [
        field.key,
        { raw: figures[field.key] ?? "", reviewed: false },
      ]),
    ) as Record<FinancialFieldKey, FigureDraft>,
  };
}

export function createEmptyForm(): FormDraft {
  return {
    businessName: "",
    periods: [createPeriod(latestCompletedYearStart())],
  };
}

export function nextPeriodYear(periods: PeriodDraft[]): number {
  const used = new Set(periods.map((period) => period.yearStart));
  const earliest = Math.min(...periods.map((period) => period.yearStart));
  const prior = earliest - 1;
  if (COMPLETED_YEARS.includes(prior) && !used.has(prior)) return prior;
  return COMPLETED_YEARS.find((year) => !used.has(year)) ?? COMPLETED_YEARS[0];
}

export function resetReview(
  figures: PeriodDraft["figures"],
): PeriodDraft["figures"] {
  return Object.fromEntries(
    FINANCIAL_FIELDS.map((field) => [
      field.key,
      { ...figures[field.key], reviewed: false },
    ]),
  ) as PeriodDraft["figures"];
}

export function sortedPeriods(periods: PeriodDraft[]): PeriodDraft[] {
  return [...periods].sort((a, b) => a.yearStart - b.yearStart);
}

export function immediatePrior(
  periods: PeriodDraft[],
  period: PeriodDraft,
): PeriodDraft | undefined {
  return periods.find(
    (candidate) => candidate.yearStart === period.yearStart - 1,
  );
}

export function resetBrokenComparability(
  periods: PeriodDraft[],
): PeriodDraft[] {
  return periods.map((period) =>
    period.comparableToPrior && !immediatePrior(periods, period)
      ? { ...period, comparableToPrior: false }
      : period,
  );
}

export function presentFigures(period: PeriodDraft): FieldDefinition[] {
  return FINANCIAL_FIELDS.filter(
    (field) => period.figures[field.key].raw.trim() !== "",
  );
}

export function countReview(periods: PeriodDraft[]): {
  present: number;
  reviewed: number;
} {
  let present = 0;
  let reviewed = 0;
  for (const period of periods) {
    for (const field of FINANCIAL_FIELDS) {
      const figure = period.figures[field.key];
      if (!figure.raw.trim()) continue;
      present += 1;
      if (figure.reviewed) reviewed += 1;
    }
  }
  return { present, reviewed };
}

export function hasEntries(form: FormDraft): boolean {
  return (
    form.businessName.trim() !== "" ||
    form.periods.length > 1 ||
    form.periods.some(
      (period) =>
        period.yearStart !== latestCompletedYearStart() ||
        period.unit !== "rupees" ||
        period.comparableToPrior ||
        Object.values(period.figures).some(
          (figure) => figure.raw.trim() !== "",
        ),
    )
  );
}

const DECIMAL_PATTERN = /^[+-]?[0-9]{1,15}(?:\.[0-9]{1,2})?$/;

export function validateForm(form: FormDraft): FormErrors {
  const errors: FormErrors = { years: {}, figures: {} };
  const businessName = form.businessName.trim();
  if (!businessName) {
    errors.businessName = "Enter the business name.";
  } else if (businessName.length > 120) {
    errors.businessName = "Use 120 characters or fewer.";
  }

  const seen = new Set<number>();
  const latest = latestCompletedYearStart();
  for (const period of form.periods) {
    if (seen.has(period.yearStart)) {
      errors.years[period.id] = "Each financial year can appear only once.";
    }
    seen.add(period.yearStart);
    if (period.yearStart > latest) {
      errors.years[period.id] =
        "Choose a completed April–March financial year.";
    }
    for (const field of FINANCIAL_FIELDS) {
      const raw = period.figures[field.key].raw.trim();
      if (!raw) continue;
      if (!DECIMAL_PATTERN.test(raw)) {
        errors.figures[`${period.id}:${field.key}`] =
          "Enter a plain amount such as 1250000.00. No commas or symbols.";
      }
    }
  }

  return errors;
}

export function hasErrors(errors: FormErrors): boolean {
  return (
    Boolean(errors.businessName) ||
    Object.keys(errors.years).length > 0 ||
    Object.keys(errors.figures).length > 0
  );
}

export function firstErrorId(
  errors: FormErrors,
  form: FormDraft,
): string | undefined {
  if (errors.businessName) return "business-name";
  const yearPeriod = form.periods.find((period) => errors.years[period.id]);
  if (yearPeriod) return `year-${yearPeriod.id}`;
  for (const period of form.periods) {
    for (const field of FINANCIAL_FIELDS) {
      if (errors.figures[`${period.id}:${field.key}`]) {
        return `figure-${period.id}-${field.key}`;
      }
    }
  }
  return undefined;
}

const EXAMPLE_FIGURES: Record<
  number,
  Partial<Record<FinancialFieldKey, string>>
> = {
  2023: {
    revenue: "10000000.00",
    profit_after_tax: "900000.00",
    ebit: "1500000.00",
    interest_expense: "300000.00",
    current_assets: "4000000.00",
    current_liabilities: "2000000.00",
    total_assets: "10000000.00",
    total_liabilities: "4000000.00",
    total_equity: "6000000.00",
    short_term_borrowings: "500000.00",
    long_term_borrowings: "1000000.00",
    current_maturities: "300000.00",
  },
  2024: {
    revenue: "12000000.00",
    profit_after_tax: "600000.00",
    ebit: "1200000.00",
    interest_expense: "400000.00",
    current_assets: "5000000.00",
    current_liabilities: "2500000.00",
    total_assets: "12000000.00",
    total_liabilities: "5000000.00",
    total_equity: "7000000.00",
    short_term_borrowings: "600000.00",
    long_term_borrowings: "1200000.00",
    current_maturities: "300000.00",
  },
};

export function createExampleForm(): FormDraft {
  return {
    businessName: "Aster Components (fictional)",
    periods: [
      {
        ...createPeriod(2023, EXAMPLE_FIGURES[2023]),
        comparableToPrior: false,
      },
      {
        ...createPeriod(2024, EXAMPLE_FIGURES[2024]),
        comparableToPrior: true,
      },
    ],
  };
}

export type RequestPayload = {
  business_name: string;
  currency: "INR";
  basis: "standalone";
  periods: {
    year_start: number;
    unit: Unit;
    comparable_to_prior: boolean;
    values: Partial<
      Record<
        FinancialFieldKey,
        {
          raw: string | null;
          reviewed: boolean;
          revision: number;
          origin: "manual";
        }
      >
    >;
  }[];
};

export function formFromRequest(request: RequestPayload): FormDraft {
  return {
    businessName: request.business_name,
    periods: request.periods.map((period) => ({
      id: nextPeriodId(),
      yearStart: period.year_start,
      unit: period.unit,
      comparableToPrior: period.comparable_to_prior,
      figures: Object.fromEntries(
        FINANCIAL_FIELDS.map((field) => {
          const item = period.values[field.key];
          const raw = item?.raw ?? "";
          return [
            field.key,
            {
              raw,
              reviewed: Boolean(raw.trim()) && Boolean(item?.reviewed),
              revision: item?.revision ?? 1,
            },
          ];
        }),
      ) as Record<FinancialFieldKey, FigureDraft>,
    })),
  };
}
