import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Alert02Icon,
  Delete02Icon,
} from "@hugeicons/core-free-icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
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
  UNIT_ITEMS,
  YEAR_ITEMS,
  financialYearLabel,
  hasErrors,
  immediatePrior,
  isDocumentFigure,
  type FieldDefinition,
  type FigureSource,
  type FormErrors,
  type PeriodDraft,
  type Unit,
} from "./model";
import { useWorkspace } from "@/features/workspace/use-workspace";

function FiguresSection() {
  const {
    form,
    showErrors,
    confirmExample,
    setConfirmExample,
    actionsDisabled,
    periods,
    errors,
    counts,
    allPresentReviewed,
    handleOpenReview,
    updateBusinessName,
    updateFigure,
    toggleFigureReview,
    updatePeriodYear,
    updatePeriodUnit,
    updateComparable,
    addPeriod,
    removePeriod,
    loadExample,
    applyExample,
    handleSubmit,
  } = useWorkspace();

  const inspect = (source: FigureSource) => {
    if (!source.document_id) return;
    void handleOpenReview(source.document_id, source.page_number, {
      page: source.page_number,
      table: source.table_index,
      row: source.row_index,
      col: source.column_index,
    });
  };

  return (
    <>
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
            <CardTitle>Business</CardTitle>
            <CardDescription>
              INR · Standalone basis · April–March financial years
            </CardDescription>
            <CardAction>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={loadExample}
              >
                Load fictional example
              </Button>
            </CardAction>
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
                  errors.businessName
                    ? "business-name-error"
                    : "business-name-hint"
                }
              />
              {errors.businessName ? (
                <p
                  id="business-name-error"
                  className="text-sm text-destructive"
                >
                  {errors.businessName}
                </p>
              ) : (
                <p
                  id="business-name-hint"
                  className="text-xs text-muted-foreground"
                >
                  Context only; not used in any calculation.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="pb-0">
          <CardHeader>
            <CardTitle>
              <h2 id="periods-heading">Financial years</h2>
            </CardTitle>
            <CardDescription>
              Up to three completed years. Leave a figure blank if it is
              missing.
            </CardDescription>
            <CardAction>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addPeriod}
                disabled={form.periods.length >= 3}
              >
                <HugeiconsIcon icon={Add01Icon} data-icon="inline-start" />
                Add year
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="px-0">
            {/* relative: Base UI's hidden checkbox inputs are absolutely positioned and would widen the page past this scroller. */}
            <div className="relative overflow-x-auto">
              <table
                aria-labelledby="periods-heading"
                className="w-full min-w-xl border-collapse text-sm"
              >
                <thead>
                  <tr className="border-y border-border bg-muted/40 align-top">
                    <th
                      scope="col"
                      className="sticky left-0 z-10 w-56 bg-muted px-4 py-3 text-left font-medium md:bg-transparent"
                    >
                      Figure
                    </th>
                    {periods.map((period) => (
                      <th
                        key={period.id}
                        scope="col"
                        className="min-w-52 px-3 py-3 text-left font-normal"
                      >
                        <YearHeader
                          period={period}
                          periods={form.periods}
                          errors={errors}
                          disabled={actionsDisabled}
                          canRemove={form.periods.length > 1}
                          onRemove={() => removePeriod(period.id)}
                          onYearChange={(yearStart) =>
                            updatePeriodYear(period.id, yearStart)
                          }
                          onUnitChange={(unit) =>
                            updatePeriodUnit(period.id, unit)
                          }
                          onComparableChange={(checked) =>
                            updateComparable(period.id, checked)
                          }
                        />
                      </th>
                    ))}
                  </tr>
                </thead>
                {FIELD_GROUPS.map((group) => (
                  <tbody key={group.title}>
                    <tr>
                      <th
                        scope="rowgroup"
                        colSpan={periods.length + 1}
                        className="sticky left-0 px-4 pt-5 pb-2 text-left text-xs font-medium text-muted-foreground"
                      >
                        {group.title}
                      </th>
                    </tr>
                    {group.fields.map((field) => (
                      <tr
                        key={field.key}
                        className="border-t border-border/60 align-top"
                      >
                        <th
                          scope="row"
                          className="sticky left-0 z-10 bg-card px-4 py-3 text-left font-normal"
                        >
                          <span className="block font-medium">
                            {field.label}
                          </span>
                          <span
                            id={`hint-${field.key}`}
                            className="block text-xs text-muted-foreground"
                          >
                            {field.hint}
                          </span>
                        </th>
                        {periods.map((period) => (
                          <td key={period.id} className="px-3 py-3">
                            <FigureCell
                              period={period}
                              field={field}
                              error={
                                errors.figures[`${period.id}:${field.key}`]
                              }
                              disabled={actionsDisabled}
                              onValueChange={(raw) =>
                                updateFigure(period.id, field.key, raw)
                              }
                              onToggleReview={(checked) =>
                                toggleFigureReview(
                                  period.id,
                                  field.key,
                                  checked,
                                )
                              }
                              onInspectSource={inspect}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                    {group.title === "Borrowings" ? (
                      <tr>
                        <td
                          colSpan={periods.length + 1}
                          className="px-4 pb-4 text-xs text-muted-foreground"
                        >
                          Enter all three components, using 0 where none exist.
                          Leases are excluded and current maturities are counted
                          once.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                ))}
              </table>
            </div>
          </CardContent>
          <CardFooter className="flex-wrap justify-between gap-3 border-t border-border py-4">
            <p className="text-sm text-muted-foreground">
              {counts.present === 0
                ? "No figures entered yet."
                : `${counts.reviewed} of ${counts.present} present figures confirmed.`}
            </p>
            <Button
              type="submit"
              disabled={counts.present === 0 || allPresentReviewed}
            >
              Confirm present figures
            </Button>
          </CardFooter>
        </Card>
      </form>

      <AlertDialog
        open={confirmExample}
        onOpenChange={(open) => {
          if (!open) setConfirmExample(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace current entries?</AlertDialogTitle>
            <AlertDialogDescription>
              The business name, years, units and figures you entered will be
              replaced with Aster Components (fictional), FY 2023-24 and FY
              2024-25. Example figures start unreviewed and are not a lending
              benchmark.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionsDisabled}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={actionsDisabled}
              onClick={applyExample}
            >
              Replace entries
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

type YearHeaderProps = {
  period: PeriodDraft;
  periods: PeriodDraft[];
  errors: FormErrors;
  disabled: boolean;
  canRemove: boolean;
  onRemove: () => void;
  onYearChange: (yearStart: number) => void;
  onUnitChange: (unit: Unit) => void;
  onComparableChange: (checked: boolean) => void;
};

function YearHeader({
  period,
  periods,
  errors,
  disabled,
  canRemove,
  onRemove,
  onYearChange,
  onUnitChange,
  onComparableChange,
}: YearHeaderProps) {
  const prior = immediatePrior(periods, period);
  const usedYears = new Set(
    periods
      .filter((candidate) => candidate.id !== period.id)
      .map((candidate) => candidate.yearStart),
  );
  const yearError = errors.years[period.id];
  const label = financialYearLabel(period.yearStart);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <Label htmlFor={`year-${period.id}`} className="sr-only">
          Financial year
        </Label>
        <Select<number>
          disabled={disabled}
          id={`year-${period.id}`}
          items={YEAR_ITEMS}
          value={period.yearStart}
          onValueChange={(value) => {
            if (value !== null) onYearChange(value);
          }}
        >
          <SelectTrigger
            className="flex-1 font-medium"
            aria-invalid={yearError ? true : undefined}
            aria-describedby={
              yearError ? `year-${period.id}-error` : `year-${period.id}-hint`
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
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label={`Remove ${label}`}
        >
          <HugeiconsIcon icon={Delete02Icon} />
        </Button>
      </div>
      {yearError ? (
        <p id={`year-${period.id}-error`} className="text-sm text-destructive">
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
      <Label htmlFor={`unit-${period.id}`} className="sr-only">
        Amount unit for {label}
      </Label>
      <Select<Unit>
        disabled={disabled}
        id={`unit-${period.id}`}
        items={UNIT_ITEMS}
        value={period.unit}
        onValueChange={(value) => {
          if (value !== null) onUnitChange(value);
        }}
      >
        <SelectTrigger className="w-full" size="sm">
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
      {prior ? (
        <div className="flex items-start gap-2">
          <Checkbox
            id={`comparable-${period.id}`}
            checked={period.comparableToPrior}
            onCheckedChange={(checked) => onComparableChange(checked === true)}
          />
          <Label
            htmlFor={`comparable-${period.id}`}
            className="text-xs leading-snug font-normal"
          >
            Comparable with {financialYearLabel(prior.yearStart)}
          </Label>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No preceding year: revenue growth not assessed.
        </p>
      )}
    </div>
  );
}

type FigureCellProps = {
  period: PeriodDraft;
  field: FieldDefinition;
  error: string | undefined;
  disabled: boolean;
  onValueChange: (raw: string) => void;
  onToggleReview: (checked: boolean) => void;
  onInspectSource: (source: FigureSource) => void;
};

function FigureCell({
  period,
  field,
  error,
  disabled,
  onValueChange,
  onToggleReview,
  onInspectSource,
}: FigureCellProps) {
  const figure = period.figures[field.key];
  const inputId = `figure-${period.id}-${field.key}`;
  const confirmId = `confirm-${period.id}-${field.key}`;
  const errorId = `${inputId}-error`;
  const hasValue = figure.raw.trim() !== "";
  const source = isDocumentFigure(figure) ? figure.source! : null;
  const year = financialYearLabel(period.yearStart);

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={inputId} className="sr-only">
        {field.label}, {year}
      </Label>
      <Input
        id={inputId}
        value={figure.raw}
        onChange={(event) => onValueChange(event.target.value)}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        maxLength={64}
        className="text-right tabular-nums"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `hint-${field.key} ${errorId}` : `hint-${field.key}`}
      />
      {hasValue ? (
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
          <div className="flex items-center gap-1.5">
            <Checkbox
              id={confirmId}
              disabled={disabled}
              checked={figure.reviewed}
              onCheckedChange={(checked) => onToggleReview(checked === true)}
            />
            <Label
              htmlFor={confirmId}
              className="text-xs font-normal text-muted-foreground"
            >
              Confirmed
              <span className="sr-only">
                : {field.label}, {year}
              </span>
            </Label>
          </div>
          {source?.document_id ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto p-0 text-xs"
              disabled={disabled}
              aria-label={`Inspect PDF p. ${source.page_number} (${source.filename})`}
              onClick={() => onInspectSource(source)}
            >
              PDF p. {source.page_number}
            </Button>
          ) : (
            <span className="text-muted-foreground">
              {source ? `PDF removed · p. ${source.page_number}` : "Manual"}
            </span>
          )}
        </div>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export { FiguresSection };
