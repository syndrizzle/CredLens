# CredLens Contribution Log

Prepared: `2026-11-21` (Task **P5-05**). Grounded in repository Git history (`git shortlog -sn --all` and `git log`) and the append-only task log in [PROJECT_SPEC.md](PROJECT_SPEC.md).

## Repository commit summary (as of `2026-11-21`)

| Git author | Commits | Primary delivered areas in Git history |
| --- | ---: | --- |
| **Sahil Nihalani** | 22 | Project scaffold (`init`, `shadcn`, Ponytail/agent rules, `PROJECT_SPEC.md`), Phase 1 backend & calculation engine (`P1-02`, `P1-03`, `P1-05`), Phase 2 Neon connectivity (`P2-00`), persistence schema (`P2-01`), preparation actions (`P2-03`), migration target guards (`P2-05-F1`), Phase 3 bounded PDF processing & recovery (`P3-01-F1`), frozen PDF corpus (`P3-02-FX`), page-linked source review & P3-04 verification (`P3-03`, `P3-04`), Phase 4 local model trial & `pgvector` retrieval (`P4-01`, `P4-02`, live `P4-04` closeout), Phase 5 live verification, frozen 60-question eval pack, A/B/C ablation & final delivery (`P5-02` live fix, `P5-03`, `P5-04`, `P5-05`). |
| **Samir Chowdhary** | 11 | Phase 1 manual-entry UI & workflow verification (`P1-04`, `P1-06`), Phase 2 local accounts/sessions (`P2-02`), revision history & run metadata (`P2-04`, `P2-04-F1`), Phase 3 initial PDF pipeline & candidate extraction (`P3-01`, `P3-02`), Phase 4 evidence-grounded Q&A & guardrail hardening (`P4-03`, `P4-04`), Phase 5 printable versioned preparation reports, workspace deletion & audit log (`P5-01`, `P5-02`). |
| **T3 Code** *(automated/agent commit author)* | 37 | Agent-assisted review, fix, and formatting commits executed during team sessions across Phases 1–5. |

## Phase-by-phase milestone ownership

| Phase | Scope | Key deliverables |
| --- | --- | --- |
| **Phase 0** (`P0-01`–`P0-04`) | Foundation & living spec | React/Vite/Tailwind/`base-nova` shadcn scaffold, TypeScript fix, `AGENTS.md` + `docs/PROJECT_SPEC.md`. |
| **Phase 1** (`P1-01`–`P1-06`) | Manual-entry financial workflow | `docs/FINANCIAL_CONTRACT.md`, FastAPI schemas, 6 `Decimal` indicators + 4 evidence states, manual entry/review UI, browser walkthrough. |
| **Phase 2** (`P2-00`–`P2-05`) | Persistence, auth & revisions | Neon PostgreSQL + Alembic migrations, `scrypt`/cookie sessions, ordered preparation actions, optimistic concurrency (`409`) & run supersession, 28-case Phase 2 access matrix. |
| **Phase 3** (`P3-01`–`P3-04`) | Digital PDF upload & source review | Bounded `pdfplumber` worker (`20 MB` / `50 pages` / advisory lock), frozen 13-PDF corpus, `pdf-extraction-v2`, `SourceReview.tsx`, server-verified document origins, unmocked live walkthrough & 28-case file-access matrix. |
| **Phase 4** (`P4-01`–`P4-04`) | Local retrieval & Q&A | Local Ollama (`v0.40.16`, `qwen3:4b-instruct`) & CPU `all-MiniLM-L6-v2` trial, `pgvector` `document_chunks` with pre-retrieval ownership filters, `POST /qa` + `WorkspaceQA.tsx` + template fallback, live prompt-injection & 18-case access verification. |
| **Phase 5** (`P5-01`–`P5-05`) | Reports, deletion, evaluation & delivery | Printable versioned preparation reports (`@media print`), staged workspace deletion + `audit_events` (`b8e4f1a9c305`), frozen `eval-pack-v1` (60 questions + 4 fictional businesses + Layout C holdout), live A/B/C ablation (`docs/EVALUATION_RESULTS.md`), final `README.md` & contribution log. |

*Note for Group 36 final submission:* Coding-agent assistance (Devin / T3 Code / Codex) was used under student direction across implementation, testing, and documentation. Any non-Git contributions by team members (such as proposal drafting, presentation slides, or external/peer review checks) should be appended to this file before final academic submission.
