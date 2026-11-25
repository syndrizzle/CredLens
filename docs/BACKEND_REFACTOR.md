# Backend refactor decision log

The review covers the FastAPI backend, migrations, and backend tests. The existing API, stored financial rules, transaction boundaries, frozen fixtures, and evaluation results are the compatibility baseline.

| Decision | Problems addressed |
| --- | --- |
| Keep workspace and document ownership predicates in one place. | Workspace persistence, document processing, Q&A, and retrieval each implement their own business and/or document ownership check. Errors must still identify an absent business before an absent document. |
| Give persisted analysis history one ordering and freshness rule. Load history metadata separately from requested values. | Workspace reads, analysis-run reads, and reports repeat the same rules and fetch unnecessary historical JSON. Revision rank determines freshness, while chronological rank determines report numbers. Writer row locks and coherent reads still matter. |
| Keep the PDF worker protocol and upload validation separate from stored document jobs. | The child wraps a snapshot in a tuple and duplicates its counts. The parent validates the snapshot twice, then callers depend on tuple unpacking or a raw dict. Retry and extraction repeat the processing-state transition. Recovery still requires bounded parsing, committed metadata before writes, and a durable deletion intent before unlinking. |
| Let Q&A own answer policy and use a separate loopback model client. | Model configuration and HTTP error handling are intermixed with evidence and fallback logic. Prompt, fallback and model routing each map the same question independently. |
| Group schemas by feature and share input rules and resource limits. | The single schema module obscures which contracts belong together. INR multipliers, retrieval filters, PDF size and text budgets, and audit action names have duplicate definitions. |
| Keep HTTP transaction and error mapping at the request boundary. | Protected routes repeat authorization and lookup wrapping. PDF work and inference need the authorization transaction to end before starting external work. |
| Resolve each backend setting from the process or the project env file. | Database access previously populated the process environment as a side effect. PDF storage and model behavior could depend on which service ran first. |
| Verify observable behavior and keep rationale that records an external constraint. | Several tests patch unused names, assert generated fixture internals against the same implementation, or rely on statements that happen to run before a write lock. Resource-limit, interrupted-job, fixture-version, offline and rollback tests are deliberate safeguards. |

The worker and parent share an extraction snapshot. Raw tables carry their own heading and footer evidence, and the parser carries resolved table context by name. Both the child and the application keep their input bounds. Migration files keep the bounds in use at the time the migrations were written.

The workspace input snapshot reads the business, periods and figures together. The run catalog reads the workspace revision and run metadata together. A workspace response checks that those two reads agree. A write holds the workspace row lock while saving the analysis snapshot. Reports load only the selected run’s input and result payloads.

The Q&A renderer and citation verifier use the same evidence selection. The full set of workspace citations remains available for inspection. The local transport rejects redirects and uses a direct loopback connection.

Independent reviews found and verified corrections to directory pruning and env-file interpolation precedence. The API comparison matched all 23 paths and 42 schemas. All 18 frozen PDF snapshots matched field for field. On the model rerun, the full variant passed 59/60, with 24/24 blocked findings and 12/12 refusals. Q13 overlooked the lease disclosure. A focused replay also missed it, including replies that cited page 3. The before-and-after comparison returned the same six ranked passages for Q13, including the disclosure. The earlier evaluation artifacts remain the record of their original runs.

All 243 backend tests passed with zero skips across three fresh databases on one disposable Neon branch. Each database passed Alembic upgrade and drift checks. The evidence suite exercised live Ollama, MiniLM and `pgvector`. The frontend passed 44 tests and 64 mocked browser checks, along with build and lint with the existing warnings. `pip check` and `git diff --check` passed. The disposable branch was deleted and the local Ollama daemon was stopped.
