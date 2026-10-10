# Contributing

Start with a small reproducible outcome and the smallest change that proves it.
Use the [bug report](https://github.com/lanteanio/svelte-realtime/issues/new?template=bug_report.yml)
or [feature request](https://github.com/lanteanio/svelte-realtime/issues/new?template=feature_request.yml)
form. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Local setup

Use Node 22 or newer and npm. Clone the repository, run `npm ci`, and run
`npm run check`. The package ships source directly; there is no root build step.
`npm test` runs the checks first, then the unit suite.
`npm run check:publish` packs the package and checks every public export with
publint and Are The Types Wrong in ESM-only mode. CommonJS and legacy Node 10
resolution are outside this ESM package contract; ESM and bundler findings fail. For one test while editing,
use `npx vitest run test/<name>.test.js`; the focused command does not replace
`npm test` before review. On Windows PowerShell use `npm.cmd` and `npx.cmd` if
execution policy blocks the PowerShell shims.

The browser suites require `npx playwright install chromium`. DevTools uses
`npm run test:devtools`. Application E2E tests use `npm ci --prefix test/fixture`
then `npm run test:e2e`. The fixture starts its own development and production
servers. Tests that use the native adapter require a supported uWebSockets.js
binary. State your Node version, OS, architecture, addon availability, exact
commands and omitted checks in the pull request; a skipped native test is not
evidence of native runtime coverage.

DevTools and generated counter browser checks share 320x568, 768x1024, and
1440x900 viewports. `test:devtools` renders a real adapter smooth channel through
`SmoothEntity` and waits for normal inspector refresh ticks after commands,
resynchronization, and teardown. `test:scaffold` compiles the CLI page template
and checks rendered counts, failure/retry controls, and accessibility.

## Changes and review evidence

Use concise imperative commit subjects describing behavior. A conventional-commit
prefix and a Signed-off-by trailer are optional; no DCO signoff is required.
Do not include credentials or private deployment information in commits or logs.
A pull request explains the problem, resulting behavior, reproduction, verification
commands and results, compatibility impact, and a practical rollback.

Fixes need a regression that fails before the fix when practical. Documentation
and mechanical changes can use the relevant deterministic check. Public API
changes update declarations and examples with runtime behavior. Wire changes
also update `protocol.schema.json` and relevant vectors. Hot-path changes include
before/after measurements and the exact harness. Record intentional limitations
and checks that could not run rather than treating them as passes.

Add user-visible changes under `CHANGELOG.md` Unreleased. Describe compatibility
impact using semver: fixes preserve the contract, additions preserve existing
calls, and breaking changes require migration guidance. Maintainers choose the
release version and prerelease tag; do not bump the version merely to open a PR.
Keep dependency changes and their root or fixture lockfiles together. Use npm to
update lockfiles, review the resolved diff, and do not hand-edit generated lock data.

Generated error and onboarding references declare their generator in their
headers. Run `npm run generate:errors` or the documented onboarding generator,
then review the generated diff. Update simulation goldens only for an intentional
behavior change, recording the seed and rationale. Never bless a failing result
just to make a check green.

The client convergence corpus runs with `npx vitest run test/optimistic-convergence.test.js`.
A failure prints its seed, operations and delivery trace. Set
`REALTIME_CLIENT_SEED` to that value and rerun the command to reproduce it
(PowerShell: `$env:REALTIME_CLIENT_SEED='svti-client-sim-12'`). It uses the DST
seeded RNG and fixed epoch with two to four independent stream stores, a model
server, and a controlled shared transport. Per-topic events retain wire order;
replicas receive different prefixes, reconnect recovery forms, buffered events,
and acknowledgement/rollback schedules. This covers client optimistic CRUD
convergence, not adapter prediction or CRDT convergence.

## Formatting

`.editorconfig` is the formatting contract. Preserve the surrounding indentation
where a file has no explicit indent rule. npm JSON files use two spaces; the
formatting checker and its tests use tabs. Markdown permits trailing spaces for
hard breaks. `npm run check:format` reads the ordered EditorConfig sections and
checks tracked text without rewriting files. It checks UTF-8, final newlines,
trailing whitespace, declared indentation and committed line endings from
`git ls-files --eol`, so a CRLF working copy does not produce false failures.
New files must be added to the Git index before this tracked-file check sees them.

## Small first contributions

The following bounded changes are useful starting points after confirming the
problem on the current branch: a broken documentation link with a link-check
regression, an error message with a minimal reproduction, or a missing example
for an existing typed API. Choose an issue only after confirming its acceptance
criteria and that nobody else is implementing it. A maintainer applies a
`good first issue` label only when scope, expected behavior, relevant files,
verification and an available reviewer are explicit; the label is not a promise
that arbitrary open issues are suitable for beginners.

## Backlog and review contract

Relay Kanban is the workspace source of truth for ownership, dependencies and
status. GitHub issues and PRs are linked evidence, not a second independent
implementation queue. Use the owning project and task UUID when updating Relay;
short task keys can repeat across projects. Claim the task before implementation,
record progress and handoffs, and release the claim when work pauses or finishes.

Ready means the item states a user-visible outcome, owning repository and files,
acceptance criteria, a reproduction or verification plan, dependencies and any
unresolved decision. Record risk, cost of delay and estimated scope. Separate a
support question from an actionable defect or feature before scheduling it.
An unresolved product or compatibility decision stays in backlog.

| State | Entry and exit rule |
| --- | --- |
| backlog | Demand is recorded; refine scope, ownership and decisions until Ready. |
| todo | Ready and ordered; a contributor can claim it without guessing acceptance. |
| in_progress | Claimed implementation has an owner and current evidence. |
| in_review | Implementation is integrated on the review branch, relevant checks pass, and an independent reviewer can assess it. |
| done | Independent review and maintainer acceptance are recorded; required release or follow-up work has an explicit owner. |

Done requires the accepted behavior, a regression where meaningful, relevant
verification lanes, synchronized documentation/types/wire artifacts, changelog
and compatibility notes where applicable, and recorded independent review.
Code written or a green isolated test alone does not satisfy Done. Review may
return an item to todo or in_progress with concrete unmet acceptance criteria.

Use a provisional limit of three implementation items per repository. Finish or
unblock existing work before starting another item. Coordinated parallel work
may exceed this limit when the session owner explicitly assigns independent
scopes and records who owns shared files and integration. The exception does not
remove task claims or review requirements.

A blocked item keeps its actual state and records the blocking task or decision,
responsible owner, next action and evidence needed to resume. Populate blockedBy
for task dependencies; file a task in the owning project for another repository.
Do not keep a claim while waiting for an external owner. Recheck the blocker
before resuming, and record why an abandoned approach no longer applies.

Order Ready work by safety and correctness risk, then cost of delay, then effort
and dependency impact. Explain the ordering with concrete user impact; a numeric
priority alone does not justify interrupting claimed work. Reassess the
provisional WIP limit during backlog planning using blocked and review queues.
At that planning point, items without fresh evidence for 30 days require a
reproduction and ownership check before returning to todo. This is a stale-item
rule, not a promise of scheduled triage or automatic closure. Reopen a closed
item only with new evidence or a clearly unmet acceptance criterion.

## Choose verification by the changed surface

Run a focused regression while editing, then select the following lanes. Times
are rough planning ranges on a warm development machine, not CI time budgets;
first dependency and browser downloads take longer. CI uses the same scripts.

| Change | Required evidence | Approximate warm duration |
| --- | --- | --- |
| Docs, error text, contributor guidance | `npm run verify:docs` | seconds |
| Public exports, declarations, generator, dependency | `npm run verify:fast` and affected unit tests | 1-3 minutes |
| Server, protocol, scheduling, auth | `npm run verify:unit` and `npm run verify:sim` | 2-10 minutes |
| Client or DevTools DOM | unit lane and `npm run verify:devtools` | 2-10 minutes |
| CLI example UI | unit lane and `npm run verify:scaffold` | 1-3 minutes |
| Browser transport, reconnect, Svelte integration | `npm run verify:browser` | 5-15 minutes |
| Production lifecycle or shutdown hooks | `npm run test:lifecycle` | 1-3 minutes |
| Cluster recovery or Redis routing | `npm run verify:chaos` | 5-20 minutes |
| Broad refactor or release candidate | `npm run verify:full` | 10-30 minutes |

`verify:pr` composes unit (including pretest), deterministic simulation/fuzz and
DevTools and scaffold browser checks. `verify:full` adds application E2E and all chaos tests.
Install fixture dependencies and Chromium as above before browser or full lanes.
Chaos additionally needs a working Docker daemon (`docker info`) for Redis.
Each invocation owns a UUID context and fixture under the OS temporary directory,
a separate Compose project and Redis container, and results under
`test/chaos/test-results/<uuid>`. Install fixture dependencies before launching
concurrent runs; each run copies source and builds independently while sharing
installed dependencies. `npm run test:chaos:parallel` starts two invocations,
requires both private fixtures to serve simultaneously, exercises cross-instance
publication in both, and verifies cleanup and unchanged tracked files. CI runs
this check before recovery. Failed cleanup retains its temporary ownership record
for diagnosis; do not remove a run directory until its recorded resources stop.
Do not claim the full lane passed when a required service or native runtime was
unavailable: record the failed prerequisite and exact omitted command in the PR.
Maintainers must accept the limitation or require another environment before merge.

[The generated verification inventory](docs/verification.v1.json) expands package
scripts including npm pre/post hooks and every root-package workflow command.
`notFullyHosted` explicitly lists checks whose full command set is not in CI;
the application E2E lane and the complete chaos lane need contributor evidence
(the recovery CI job runs its named recovery spec and the parallel isolation check). The inventory excludes
steps targeting another working directory or npm prefix. Any script or workflow
change must run `npm run generate:verification` and include the reviewed diff;
`npm run check:verification` fails when the inventory no longer matches reality.

`npm run test:lifecycle` packs the current checkout, installs that tarball into
an isolated fixture, and builds production. Docker runs the built server under
Linux Node24 and delivers real SIGTERM signals. The check requires initialization,
refuses new RPC work during drain, verifies a completed call is flushed before
teardown, and verifies an unfinished call exits within its drain budget. Both
cases require clean process exit and a graceful WebSocket close. It uses the
pinned `node:24.13.1-trixie-slim` image (pulled when absent); the optional
`REALTIME_LIFECYCLE_NODE_IMAGE` override must provide a compatible Linux native
runtime. The chaos CI job runs this packed artifact check before browser tests.

`npm run test:smooth-stack` exercises real smooth sockets against the installed
adapter and the pinned historical `0.6.0-next.61` package. The installed path
must use one binary batch per tick; the historical path must deliver equivalent
per-entity frames. Both broadcast and per-viewer interest delivery verify binary
and JSON payloads plus author exclusion. The check downloads the historical npm
archive into a temporary directory and reuses installed native/peer dependencies;
it does not change the supported adapter floor or the workspace dependency graph.
Native support is required, and skipped cases fail the gate. CI runs the matrix.

## First-success checkpoint

After root `npm ci`, run `npm run smoke`. The command prints Node, npm, OS,
architecture and actual fixture package versions, installs the locked fixture
dependencies and Chromium, starts development and production servers on free
ports, and opens two independent browser contexts against each server. An RPC
from one client must update the other client's subscribed data. Production is
built before starting its server. The command exits nonzero on install, build,
startup or assertion failure and stops started servers even if the second server
fails to start. It owns no Redis or other external service.

A warm run usually takes 30-90 seconds; first downloads take longer and need
network access. On Linux install browser OS dependencies first with
`npx playwright install --with-deps chromium` (CI does this). A missing native
addon is a failed prerequisite, never a skipped success. The smoke job runs the
same `npm run smoke` command on pull requests. This checkpoint complements the
full browser and chaos suites; it does not replace them.

## Documentation links

`npm run check:links` checks rendered Markdown and HTML links without network
requests, including GitHub heading slugs, duplicate headings, compatibility
anchors, exact-case paths, tracked targets and files available in the npm package.
Use a relative link for a packaged file. For repository-only source, use its
GitHub `blob/dev` route; new source and its link must be staged together. Stable
`blob/main` links use the committed `docs/main-source-tree.v1.json` snapshot.
After a stable promotion, fetch the new main ref and run
`node scripts/check-links.js --write-main-tree`, then review that diff.

`npm run check:links:external` performs bounded HTTP requests and reports redirects,
hard errors and HTML titles/headings that indicate a soft 404. Its read-only CI
workflow runs weekly and manually, separately from the deterministic PR gate.
Network availability is therefore not a prerequisite for editing local docs.
When a redirect is intentional, update the link to the final canonical route.

## README example coverage

Every fenced README block has a content fingerprint and classification in
[docs/code-blocks.v1.json](docs/code-blocks.v1.json). `npm run check:examples`
requires complete coverage and compiles JavaScript, TypeScript, Svelte, JSON and
YAML examples, checking this package's imports and documented member names.
`npm run test:examples` extracts an actual npm tarball and executes every
`executed/packed-runtime` block through its public exports. Dependencies come
from the installed root tree; the tested package comes only from the tarball.
The ordinary unit suite and `verify:docs` both run that execution harness.

A Svelte browser component is compiled, never labelled Node-executed: it needs
an application mount. Tutorial blocks compile and check package API references,
but application imports and ambient values remain the host's responsibility.
Commands, configuration/SQL and output blocks are explicitly inventoried as
manual channels. Syntax-only blocks list the missing ambient identifiers or
lifecycle reason instead of claiming standalone execution.

After an intentional example change, run `npm run generate:examples`, review the
classification diff, then `npm run verify:docs`. Prose inserted before a block
does not change its identity. An invalid standalone excerpt needs an adjacent
`<!-- doc-code: fragment reason="..." -->` marker. The fragment ceiling is pinned;
growth additionally requires the reviewed `--accept-fragment-count` generator
flag. Fix runnable examples instead of weakening their classification. Browser
or service-dependent examples may use a `doc-code: no-run` marker with the exact
reason prefix `requires-browser`, `external-service`, or `app-context`.

## README entry ownership and size

[docs/documentation.v1.json](docs/documentation.v1.json) owns the eight ordered
reader paths: package identity, first success and compatibility stay in README;
tutorial, how-to, reference, explanation and operations route to the owned site.
`npm run generate:documentation` renders the routing table and compatibility
commands from the manifest and the CLI-owned tuple in `src/cli-utils.js`.
The generator never increases the README size allowance. After changing generated
commands, run `npm run generate:examples` to refresh their code-fence inventory.

`entryBudgetLines` caps the line where the routing block ends.
`readmeMaxLines` independently caps the entire README and is pinned at the current
length. Adding one line fails the size gate. Move extended content into package
docs or the owning site and lower the ratchet as content moves. A size increase
is an explicit reviewed contract change, not silent headroom. The manifest routes
readers; it does not claim that the site's information architecture is complete.
