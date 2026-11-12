# CredLens

## Temporary development setup

This section will be replaced with the project description, features, and user-facing documentation when CredLens is ready.

The repository uses [Ponytail](https://github.com/DietrichGebert/ponytail) rules alongside CredLens-specific guidance in [AGENTS.md](AGENTS.md). No plugin installation or per-developer skills setup is required for this instruction-only configuration.

| Agent | Repository entry point |
| --- | --- |
| Codex and other AGENTS.md-aware agents | Root `AGENTS.md` |
| Claude Code | `CLAUDE.md` imports `AGENTS.md` |
| Gemini CLI | `GEMINI.md` imports `AGENTS.md` |
| Cursor | `.cursor/rules/project.mdc` directs the agent to `AGENTS.md` |
| GitHub Copilot | `.github/copilot-instructions.md` directs the agent to `AGENTS.md` |

Once these files are committed and pushed, teammates receive them on clone or pull. Start a fresh agent session in the repository with project instructions enabled. Before the first task, ask the agent to identify the instruction files it loaded and summarize the Ponytail rules, shadcn preference, and current development phase. For another tool, configure its project instructions to read `AGENTS.md`.

Keep shared rules in `AGENTS.md` and adapters small. The Ponytail rules are pinned to revision `96608e078b2d5ea607c5c3b8b5a54d1c1fba6846`; their [MIT license](docs/third-party/ponytail-LICENSE.txt) is included. Update them manually while preserving CredLens requirements.

These instructions guide model behaviour; they do not enforce checks or guarantee correctness. Optional Ponytail skills, slash commands, lifecycle hooks, and mode switching are not installed.

## Run the Phase 1 workflow locally

Set up the Python environment using [backend/README.md](backend/README.md), then run these in separate terminals from the repository root:

```bash
# Terminal 1
cd backend
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

```bash
# Terminal 2
bun install --frozen-lockfile
bun run dev
```

Open the URL Vite prints. Its development proxy forwards `/api` to the local backend on port 8000. Load the labelled fictional example, review/confirm figures, then select **Analyse figures**. Unconfirmed/missing inputs show their own evidence states; edits hide outdated results until re-analysis. Entries and results are unsaved.

Run `bun test` (requires the configured `backend/.venv`, as integration tests invoke Python), `bun run lint`, and `bun run build`. Full backend tests: `cd backend && .venv/bin/python -m pytest -q`. The Vite proxy is for development; production hosting/routing remains future scope.

## Frontend template

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
