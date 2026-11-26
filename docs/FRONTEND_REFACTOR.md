# Frontend refactor decision log (P8-15)

Untangle pass over `src/` (2026-11-26), with the user's Comments and Tests extras. Behaviour must stay the same apart from bugs the refactor fixes.

## Fixes and the problems they solve

- One `EvidenceBadge` for the four evidence states, so every screen shows a state the same way.
  - `features/analysis/AnalysisResults.tsx:156`, `:338`, `features/analysis/AnalysisOverview.tsx:114` and `features/qa/WorkspaceQA.tsx:649` each map the state to a badge variant inline (`Supported` secondary, everything else outline).
  - `features/reports/PreparationReport.tsx:49` has its own `stateVariant` that makes `Needs review` destructive, so the same finding looks different on Reports than everywhere else.
- One date formatter module, so every timestamp reads the same way.
  - `features/settings/SettingsSection.tsx:10`, `features/documents/DocumentsSection.tsx:40` and `features/reports/PreparationReport.tsx:94` each build their own `Intl.DateTimeFormat("en-IN", ...)`.
- Keep the source-cell type with the documents API types, not in a component file.
  - `features/workspace/use-workspace.ts:29` imports `HighlightedCell` from `features/documents/SourceReview.tsx`, so the state controller depends on a UI file.
- Put what an account-only page offers on its `SECTIONS` entry.
  - `features/workspace/Workspace.tsx` keeps `ACCOUNT_PURPOSE` keyed by section id beside the `account` flag in `app/sections.ts`; adding a page means editing both, and nothing says so.

## Outcome

- `features/analysis/EvidenceBadge.tsx` renders every evidence state. Behaviour change (a fix): Reports no longer shows `Needs review` in the destructive colour, so a finding looks the same on every page. The state is still written out in full.
- `lib/format.ts` (`formatDate`, `formatDateTime`) replaces three local `Intl.DateTimeFormat` instances.
- `HighlightedCell` lives with the document types in `features/analysis/api.ts`; `use-workspace.ts` no longer imports a component file.
- `SECTIONS` entries carry `requires` (`null`, `"account"`, `"business"`) and `offers`; `Workspace.tsx` derives the locked page from them, and `ACCOUNT_PURPOSE` is gone.
- Comments: removed four that restated the code (`page-header.tsx`, `logo.tsx`, `use-workspace.ts`). The rest explain constraints outside the code (backend contracts, Base UI quirks, `index.html`, D-10) and stay.
- Tests: all 47 Bun tests and the 71 browser checks exercise behaviour (validation, auth and ownership errors, conflicts, evidence states, provenance). None repeat the implementation or can't fail, so none were removed. All pass after the refactor.

## Considered and kept

- `features/analysis/api.ts` holds every API client and type (846 lines). Splitting it per feature would move code without changing what changes together: every client shares `request`, the error mapping and the runtime validators, and tests import them as one module.
- `use-workspace.ts` imports `@/app/sections`, the stable page list, to navigate; that dependency points at something that changes less.
