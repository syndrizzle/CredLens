import { useState, type FormEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  AiSparklesIcon,
  Alert02Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FIELD_GROUPS,
  FINANCIAL_FIELDS,
  UNIT_ITEMS,
  YEAR_ITEMS,
  countReview,
  createEmptyForm,
  createExampleForm,
  createPeriod,
  financialYearLabel,
  firstErrorId,
  hasEntries,
  hasErrors,
  immediatePrior,
  nextPeriodYear,
  presentFigures,
  resetBrokenComparability,
  resetReview,
  sortedPeriods,
  unitLabel,
  validateForm,
  type FieldDefinition,
  type FinancialFieldKey,
  type FormDraft,
  type FormErrors,
  type PeriodDraft,
  type Unit,
} from "./model";

const EMPTY_ERRORS: FormErrors = { years: {}, figures: {} };

function ManualEntry() {
  const [form, setForm] = useState<FormDraft>(createEmptyForm);
  const [showErrors, setShowErrors] = useState(false);
  const [confirmExample, setConfirmExample] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const periods = sortedPeriods(form.periods);
  const errors = showErrors ? validateForm(form) : EMPTY_ERRORS;
  const counts = countReview(form.periods);
  const allPresentReviewed =
    counts.present > 0 && counts.reviewed === counts.present;

  function updateBusinessName(businessName: string) {
    setForm((current) => ({ ...current, businessName }));
    setNotice(null);
  }

  function updateFigure(
    periodId: string,
    field: FinancialFieldKey,
    raw: string,
  ) {
    setForm((current) => ({
      ...current,
      periods: current.periods.map((period) =>
        period.id === periodId
          ? {
              ...period,
              figures: {
                ...period.figures,
                [field]: { raw, reviewed: false },
              },
            }
          : period,
      ),
    }));
    setNotice(null);
  }

  function updatePeriodYear(periodId: string, yearStart: number) {
    setForm((current) => {
      const nextPeriods = current.periods.map((period) =>
        period.id === periodId
          ? {
              ...period,
              yearStart,
              comparableToPrior: false,
              figures: resetReview(period.figures),
            }
          : period,
      );
      return {
        ...current,
        periods: resetBrokenComparability(nextPeriods),
      };
    });
    setNotice(
      "Financial year changed. Entered amounts were kept and marked unreviewed.",
    );
  }

  function updatePeriodUnit(periodId: string, unit: Unit) {
    setForm((current) => ({
      ...current,
      periods: current.periods.map((period) =>
        period.id === periodId
          ? { ...period, unit, figures: resetReview(period.figures) }
          : period,
      ),
    }));
    setNotice(
      "Unit changed. Entered amounts were kept and marked unreviewed.",
    );
  }

  function updateComparable(periodId: string, comparableToPrior: boolean) {
    setForm((current) => ({
      ...current,
      periods: current.periods.map((period) =>
        period.id === periodId ? { ...period, comparableToPrior } : period,
      ),
    }));
    setNotice(null);
  }

  function addPeriod() {
    setForm((current) => {
      if (current.periods.length >= 3) return current;
      return {
        ...current,
        periods: [...current.periods, createPeriod(nextPeriodYear(current.periods))],
      };
    });
    setNotice(null);
  }

  function removePeriod(periodId: string) {
    setForm((current) => {
      if (current.periods.length <= 1) return current;
      const remaining = current.periods.filter(
        (period) => period.id !== periodId,
      );
      return {
        ...current,
        periods: resetBrokenComparability(remaining),
      };
    });
    setNotice(null);
  }

  function loadExample() {
    if (hasEntries(form)) {
      setConfirmExample(true);
      return;
    }
    applyExample();
  }

  function applyExample() {
    setForm(createExampleForm());
    setShowErrors(false);
    setConfirmExample(false);
    setNotice(
      "Loaded the fictional example. Figures are unreviewed; check them before confirming.",
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (counts.present === 0) {
      setNotice("Enter at least one figure before confirming.");
      return;
    }

    const nextErrors = validateForm(form);
    if (hasErrors(nextErrors)) {
      setShowErrors(true);
      setNotice(null);
      const target = firstErrorId(nextErrors, form);
      if (target) {
        requestAnimationFrame(() => document.getElementById(target)?.focus());
      }
      return;
    }

    setShowErrors(false);
    setForm((current) => ({
      ...current,
      periods: current.periods.map((period) => ({
        ...period,
        figures: Object.fromEntries(
          FINANCIAL_FIELDS.map((field) => {
            const figure = period.figures[field.key];
            return [
              field.key,
              { ...figure, reviewed: figure.raw.trim() !== "" },
            ];
          }),
        ) as PeriodDraft["figures"],
      })),
    }));
    setNotice(
      `Confirmed ${counts.present} present ${
        counts.present === 1 ? "figure" : "figures"
      }. Editing a figure marks it unreviewed.`,
    );
  }

  return (
    <main className="min-h-screen bg-muted/30">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 lg:py-12">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium text-primary">CredLens</p>
            <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
              Financial health review
            </h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Enter one to three completed financial years, check the figures,
              and confirm them. This is a local prototype for fictional data.
            </p>
          </div>
          <Badge variant="outline">Not saved</Badge>
        </header>

        <Alert role="status">
          <HugeiconsIcon icon={InformationCircleIcon} />
          <AlertTitle>Prototype data is not saved</AlertTitle>
          <AlertDescription className="col-start-2">
            Reloading the page clears every entry. Use fictional data only.
            Figures are confirmed manually and are not authenticated.
          </AlertDescription>
        </Alert>

        {showErrors && hasErrors(errors) ? (
          <Alert variant="destructive">
            <HugeiconsIcon icon={Alert02Icon} />
            <AlertTitle>Check the highlighted fields</AlertTitle>
            <AlertDescription className="col-start-2">
              Your entries are kept. Fix the fields marked below, then confirm
              again.
            </AlertDescription>
          </Alert>
        ) : null}

        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Start with a fictional example</CardTitle>
              <CardDescription>
                Aster Components (fictional) · FY 2023-24 and FY 2024-25 · INR
                rupees. Example only; not a real business or lending benchmark.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button type="button" variant="outline" onClick={loadExample}>
                <HugeiconsIcon icon={AiSparklesIcon} data-icon="inline-start" />
                Load fictional example
              </Button>
              <p className="text-xs text-muted-foreground">
                Loading replaces current entries after confirmation. Example
                figures start unreviewed.
              </p>
              {confirmExample ? (
                <div className="rounded-lg border border-border bg-muted/50 p-3">
                  <p className="text-sm font-medium">Replace current entries?</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    This will replace the business name, years, units, and figures
                    you have entered.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={applyExample}
                    >
                      Replace entries
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmExample(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Business details</CardTitle>
              <CardDescription>
                Currency INR · Standalone basis · April–March financial years
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="max-w-md space-y-2">
                <Label htmlFor="business-name">Business name</Label>
                <Input
                  id="business-name"
                  value={form.businessName}
                  onChange={(event) => updateBusinessName(event.target.value)}
                  maxLength={120}
                  autoComplete="organization"
                  aria-invalid={errors.businessName ? true : undefined}
                  aria-describedby={
                    errors.businessName ? "business-name-error" : undefined
                  }
                />
                {errors.businessName ? (
                  <p id="business-name-error" className="text-sm text-destructive">
                    {errors.businessName}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    The name is context only; it is not used in any calculation.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <section className="space-y-4" aria-labelledby="periods-heading">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="space-y-1">
                <h2
                  id="periods-heading"
                  className="font-heading text-2xl font-semibold"
                >
                  Financial years
                </h2>
                <p className="text-sm text-muted-foreground">
                  Add one to three completed years. Leave any figure blank if it
                  is missing.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={addPeriod}
                disabled={form.periods.length >= 3}
              >
                <HugeiconsIcon icon={Add01Icon} data-icon="inline-start" />
                Add year
              </Button>
            </div>

            {periods.map((period) => (
              <PeriodCard
                key={period.id}
                period={period}
                periods={form.periods}
                errors={errors}
                canRemove={form.periods.length > 1}
                onRemove={() => removePeriod(period.id)}
                onYearChange={(yearStart) =>
                  updatePeriodYear(period.id, yearStart)
                }
                onUnitChange={(unit) => updatePeriodUnit(period.id, unit)}
                onComparableChange={(checked) =>
                  updateComparable(period.id, checked)
                }
                onFigureChange={(field, raw) =>
                  updateFigure(period.id, field, raw)
                }
              />
            ))}
          </section>

          <Card>
            <CardHeader>
              <CardTitle>Review and confirm</CardTitle>
              <CardDescription>
                Check the business, year, unit, and entered amounts. Confirmation
                means you checked the entry; it does not authenticate the figures.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
                <p>
                  <span className="font-medium">Business:</span>{" "}
                  {form.businessName.trim() || "Not entered"}
                </p>
                <p className="text-muted-foreground">
                  INR · Standalone basis · April–March years
                </p>
              </div>

              {periods.map((period) => (
                <ReviewPeriod key={period.id} period={period} />
              ))}

              <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
                <Button
                  type="submit"
                  disabled={counts.present === 0 || allPresentReviewed}
                >
                  <HugeiconsIcon
                    icon={CheckmarkCircle02Icon}
                    data-icon="inline-start"
                  />
                  Confirm present figures
                </Button>
                <p className="text-sm text-muted-foreground">
                  {counts.present === 0
                    ? "No figures entered yet."
                    : `${counts.reviewed} of ${counts.present} present figures confirmed.`}
                </p>
              </div>

              {notice ? (
                <p
                  role="status"
                  aria-live="polite"
                  className="text-sm font-medium text-foreground"
                >
                  {notice}
                </p>
              ) : null}
            </CardContent>
          </Card>
        </form>

        <footer className="space-y-1 pb-4 text-xs text-muted-foreground">
          <p>
            Phase 1 prototype · Financial rules are provisional pending
            finance-reviewer validation.
          </p>
          <p>
            Cash generation is not assessed; no cash-flow statement is entered
            in this workflow. Borrowings exclude leases and count current
            maturities once.
          </p>
        </footer>
      </div>
    </main>
  );
}

type PeriodCardProps = {
  period: PeriodDraft;
  periods: PeriodDraft[];
  errors: FormErrors;
  canRemove: boolean;
  onRemove: () => void;
  onYearChange: (yearStart: number) => void;
  onUnitChange: (unit: Unit) => void;
  onComparableChange: (checked: boolean) => void;
  onFigureChange: (field: FinancialFieldKey, raw: string) => void;
};

function PeriodCard({
  period,
  periods,
  errors,
  canRemove,
  onRemove,
  onYearChange,
  onUnitChange,
  onComparableChange,
  onFigureChange,
}: PeriodCardProps) {
  const prior = immediatePrior(periods, period);
  const usedYears = new Set(
    periods
      .filter((candidate) => candidate.id !== period.id)
      .map((candidate) => candidate.yearStart),
  );
  const yearError = errors.years[period.id];
  const presentCount = presentFigures(period).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{financialYearLabel(period.yearStart)}</CardTitle>
        <CardDescription>
          {unitLabel(period.unit)} · {presentCount} of {FINANCIAL_FIELDS.length}{" "}
          figures entered
        </CardDescription>
        <CardAction>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRemove}
            disabled={!canRemove}
            aria-label={`Remove ${financialYearLabel(period.yearStart)}`}
          >
            <HugeiconsIcon icon={Delete02Icon} data-icon="inline-start" />
            Remove
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`year-${period.id}`}>Financial year</Label>
            <Select<number>
              id={`year-${period.id}`}
              items={YEAR_ITEMS}
              value={period.yearStart}
              onValueChange={(value) => {
                if (value !== null) onYearChange(value);
              }}
            >
              <SelectTrigger
                className="w-full"
                aria-invalid={yearError ? true : undefined}
                aria-describedby={
                  yearError
                    ? `year-${period.id}-error`
                    : `year-${period.id}-hint`
                }
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {YEAR_ITEMS.map((item) => (
                  <SelectItem
                    key={item.value}
                    value={item.value}
                    disabled={usedYears.has(item.value)}
                  >
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {yearError ? (
              <p
                id={`year-${period.id}-error`}
                className="text-sm text-destructive"
              >
                {yearError}
              </p>
            ) : (
              <p
                id={`year-${period.id}-hint`}
                className="text-xs text-muted-foreground"
              >
                1 April {period.yearStart} – 31 March {period.yearStart + 1}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor={`unit-${period.id}`}>Amount unit</Label>
            <Select<Unit>
              id={`unit-${period.id}`}
              items={UNIT_ITEMS}
              value={period.unit}
              onValueChange={(value) => {
                if (value !== null) onUnitChange(value);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UNIT_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              All amounts for this year use this unit.
            </p>
          </div>
        </div>

        {prior ? (
          <div className="flex items-start gap-2">
            <Checkbox
              id={`comparable-${period.id}`}
              checked={period.comparableToPrior}
              onCheckedChange={(checked) =>
                onComparableChange(checked === true)
              }
            />
            <div className="space-y-1">
              <Label
                htmlFor={`comparable-${period.id}`}
                className="leading-snug"
              >
                Comparable with {financialYearLabel(prior.yearStart)}
              </Label>
              <p className="text-xs text-muted-foreground">
                Confirm both years use a consistent standalone basis.
                Unconfirmed comparability blocks revenue growth only.
              </p>
            </div>
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
            No immediately preceding year entered. Revenue growth will be not
            assessed for this year.
          </p>
        )}

        {FIELD_GROUPS.map((group) => (
          <fieldset key={group.title} className="space-y-3">
            <legend className="text-sm font-medium">{group.title}</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              {group.fields.map((field) => (
                <FigureField
                  key={field.key}
                  periodId={period.id}
                  field={field}
                  figure={period.figures[field.key]}
                  error={errors.figures[`${period.id}:${field.key}`]}
                  onValueChange={(raw) => onFigureChange(field.key, raw)}
                />
              ))}
            </div>
            {group.title === "Borrowings" ? (
              <p className="text-xs text-muted-foreground">
                Enter all three components, using 0 where none exist. Leases are
                excluded and current maturities are counted once.
              </p>
            ) : null}
          </fieldset>
        ))}
      </CardContent>
    </Card>
  );
}

type FigureFieldProps = {
  periodId: string;
  field: FieldDefinition;
  figure: { raw: string; reviewed: boolean };
  error: string | undefined;
  onValueChange: (raw: string) => void;
};

function FigureField({
  periodId,
  field,
  figure,
  error,
  onValueChange,
}: FigureFieldProps) {
  const inputId = `figure-${periodId}-${field.key}`;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy = error ? `${hintId} ${errorId}` : hintId;

  return (
    <div className="space-y-1.5">
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-2">
        <Label htmlFor={inputId} className="leading-snug">
          {field.label}
        </Label>
        {figure.raw.trim() ? (
          <Badge variant={figure.reviewed ? "secondary" : "outline"}>
            {figure.reviewed ? "Confirmed" : "Unreviewed"}
          </Badge>
        ) : null}
      </div>
      <Input
        id={inputId}
        value={figure.raw}
        onChange={(event) => onValueChange(event.target.value)}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        maxLength={64}
        placeholder="Leave blank if missing"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
      <p id={hintId} className="text-xs text-muted-foreground">
        {field.hint}
      </p>
      {error ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ReviewPeriod({ period }: { period: PeriodDraft }) {
  const present = presentFigures(period);
  const reviewed = present.filter(
    (field) => period.figures[field.key].reviewed,
  ).length;
  const missing = FINANCIAL_FIELDS.length - present.length;

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-heading text-base font-medium">
          {financialYearLabel(period.yearStart)}
        </h3>
        <p className="text-xs text-muted-foreground">
          {unitLabel(period.unit)} · {reviewed} of {present.length} present
          figures confirmed
        </p>
      </div>

      {present.length > 0 ? (
        <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
          {present.map((field) => {
            const figure = period.figures[field.key];
            return (
              <div
                key={field.key}
                className="flex items-start justify-between gap-3"
              >
                <dt className="text-sm text-muted-foreground">
                  {field.label}
                </dt>
                <dd className="flex shrink-0 flex-col items-end gap-1 text-right">
                  <span className="font-mono text-sm tabular-nums">
                    {figure.raw.trim()} {unitLabel(period.unit).toLowerCase()}
                  </span>
                  <Badge variant={figure.reviewed ? "secondary" : "outline"}>
                    {figure.reviewed ? "Confirmed" : "Unreviewed"}
                  </Badge>
                </dd>
              </div>
            );
          })}
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">
          No figures entered for this year.
        </p>
      )}

      {missing > 0 ? (
        <p className="text-xs text-muted-foreground">
          {missing} {missing === 1 ? "figure is" : "figures are"} not entered.
          Missing values are allowed and block only dependent indicators.
        </p>
      ) : null}
    </div>
  );
}

export { ManualEntry };
