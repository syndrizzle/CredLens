# P2-01 persistence contract

The user selected FastAPI-managed accounts for P2-02. P2-01 creates internal owner UUIDs; credentials and sessions are added in P2-02.

Scope: Alembic migrations and a backend persistence module. The current HTTP analysis route remains stateless until P2-02 can enforce authenticated ownership. User flow in this task is a reproducible fictional-fixture loader, save, disconnect, reload, and inspect a saved analysis. Browser save/load comes with protected workspaces.

- Owners: internal UUID, creation time; no fake credentials.
- Businesses: owner foreign key, name, INR/standalone basis, input revision.
- Periods: business foreign key, unique start year, unit, exact multiplier, comparability confirmation.
- Figures: period/field key, raw text or null, exact normalized INR numeric or null, manual origin, reviewed flag, revision. Omitted fields remain omitted.
- Analysis runs: business foreign key, input revision, rule version, timestamp, full input snapshot and result JSONB. Results include all six findings, input/revision evidence, reasons, balance checks, and limitations. Decimal values remain strings inside JSON. No separate findings table until independent querying requires it.

Creation is atomic in a caller-owned transaction. Reads and analysis operations require an owner ID and filter ownership in the database. Unknown and other-owner records both raise the same not-found error. The authenticated owner will come from the server session in P2-02, never browser-submitted ownership. P2-01 creates records and new analysis runs; correction history, optimistic conflict handling, and superseding outputs remain P2-04. No update/delete HTTP endpoints are exposed here.

Acceptance: migration upgrade/downgrade/upgrade on a disposable Neon branch, Alembic metadata consistency, saved fixture matches original after reconnect, exact raw/normalized values and missing/zero distinction survive, saved results match deterministic output, wrong-owner reads fail, and failed transactions leave no partial business. Use direct DATABASE_URL_UNPOOLED for migrations and application DATABASE_URL for normal queries. Apply the additive migration to production only after branch checks pass. Run fixture tests on the disposable branch; production receives empty application tables.
