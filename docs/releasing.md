# Releasing

This package follows the ecosystem [release lifecycle](https://github.com/lanteanio/svelte-adapter-uws/blob/dev/docs/releasing.md).
The local workflow and ledger below bind that lifecycle to the realtime package;
a green local check alone does not authorize publication or channel promotion.

## Realtime package scope

The 0.6 line serves SvelteKit application developers who need importable
`$live` RPCs and reactive subscriptions, with generated client bindings and
observable connection, retry and cleanup behavior. Its release evidence must
cover those application boundaries alongside the ecosystem
[stable-promotion contract](https://github.com/lanteanio/svelte-adapter-uws/blob/dev/docs/releasing.md#stable-promotion).

The package does not provide an HTTP server, authentication provider, database
engine or reference application UI. The adapter owns transport; optional
extensions supply durable and clustered infrastructure. Applications still own
authorization, persistence policy and reconciliation after an uncertain write;
reconnection alone does not establish exactly-once delivery.

Before promoting this package, attach the following evidence at the frozen
source heads, in addition to the coordinated checks below:

- Run `node scripts/check-manual-setup.js --fresh-install` at the supported
  Node floor. The literal documented app must install, build, exchange updates
  between two browser tabs, retain state across reload and demonstrate its
  documented reset after a server restart, with no uncaught browser errors.
- Run the declaration and generated-client gates in `npm run check`, the Vite
  integration suite and the packed consumer. Public imports, room members,
  cleanup hooks and declarations must agree in development and production;
  browser output must not include server implementations.
- Run the client/offline, stream lifecycle, simulation and browser chaos lanes
  through `npm run verify:release`. Exercise interruption, timeout, reconnect,
  replay and final cleanup, including the configured queue limits and typed
  failure paths. Record the actual platform/tuple, test counts and logs; zero
  failed required checks is the acceptance measure, and skipped checks require
  completion before promotion.

This evidence is collected for the release decision; the existence of these
instructions does not establish that the current candidate is ready for
`latest`. Keep the evidence linked to the immutable candidate identity.

## Branch roles and freeze

- `dev` integrates work and supplies `next` prereleases.
- `main` supplies stable `latest` releases after a reviewed promotion.
- `hotfix/<stable-version>/<slug>` starts from the exact stable Git identity
  recorded in the ledger, never from whichever branch tip happens to be current.
- Every ledger append, including stable and hotfix rows, is committed on `dev`.
  `main` and hotfix branches receive the manifest only by merging `dev`, so
  each branch's ledger stays a prefix of `dev`'s and merges in either direction
  pass the history audit. A row committed on `main` while `dev` appended its own
  makes the next merge fail that audit with no recovery short of rewriting
  pushed history.

Record the selected adapter, extensions and realtime full Git SHAs, exact
package versions, protocol revision and native-addon spec in the release
handoff. Freeze those source commits for qualification. Any source, version,
lockfile or generated-file change selects a new candidate and restarts the
required checks. A subsequent ledger-only bookkeeping commit can describe a
frozen source commit without becoming the artifact's source identity.

Before tagging, require clean candidate checkouts, reconciled migration notes,
changelogs, declarations and generated files, plus each repository's complete
required verification lanes. Run this package's `npm run verify:release` and
qualify the exact sibling heads together through the extensions-owned packed
consumer. From a sibling extensions checkout with dependencies installed, run
`npm run gate:cross-repo -- --quick --require-clean --strict`. All discovered input
checkouts must be clean; skipped required evidence fails. For isolated worktrees,
add `--repo <absolute-path>` for each selected checkout. The default command without
these flags permits working-tree edits and does not establish committed identities.
Retain its pinned SHAs, installed dependency tree,
logs, tarball digests and results. A skipped or unavailable required lane blocks
release; it is not a pass. Test the published exact versions again before any
public channel moves.

Capture the current `latest`, `next` and quarantine `candidate` pointers for
all three packages before publication. Verify that the proposed versions and
immutable tags do not already exist. Keep the known-good package tuple and its
consumer evidence with this record for rollback.

## Trusted publication workflow

The tag-only `.github/workflows/release.yml` publishes an annotated
`svelte-realtime@<version>` tag from the correct source lineage: prereleases
from `dev` to `next`, stable releases from `main` to `latest`. The identity gate
binds package name, canonical version, tag object, event revision, checkout and
repository URL. A dirty checkout or unrelated source lineage fails closed.

Before enabling publication, configure the npm trusted publisher for
`lanteanio/svelte-realtime`, workflow `release.yml`, environment `npm-release`.
Protect that environment with required reviewers and restrict its deployment
tags to `svelte-realtime@*`. Protect the source branches and release tags against
unreviewed changes and tag replacement. These account settings require separate
verification; checked-in workflow tests do not prove they are configured.
There is no token fallback and no manual-dispatch publication path.

The `verify` job has only `contents: read`. It installs locked root and fixture
dependencies, Chromium, and checks Docker before `npm run verify:release` runs
the unit, simulation, DevTools, scaffold, browser, chaos, lifecycle, smooth-stack
and smoke checks. `prepublishOnly` runs the full check chain, and source identity
is checked again afterward so test or lifecycle mutations cannot enter the pack.
The job packs one
retained tarball and exports its SHA-256 digest separately from the artifact.

The protected `publish` job alone has `id-token: write`. It installs no project
dependencies, runs no repository scripts, compares the downloaded tarball with
the verification digest, and publishes those exact bytes with npm provenance,
`--ignore-scripts`, and the quarantine tag `candidate`. Pinned Node, npm and
full-commit action references are part of the checked contract.

The workflow never routes a candidate to `next` or `latest`. After publication,
verify the exact npm version, integrity and source attestation; test the packed
consumer and record publication in the ledger. A maintainer then authorizes a
separate dist-tag promotion. Failed candidates remain recorded and quarantined.
Publication, tag creation, public routing and registry rollback each require
the maintainer's authorization.

`scripts/check-release-workflow.js` closes the workflow's job, step, permission,
command and npm-script inventories. Intentional script changes update that
guard in the same change, alongside the generated verification inventory.

## Artifact records

The [release manifest](release-manifest.md) is the artifact ledger. Its three
append-only tables follow the adapter's candidate, publication and routing
format. The [changelog](https://github.com/lanteanio/svelte-realtime/blob/dev/CHANGELOG.md) describes behavior and must have one
heading for every published version. `Unreleased` contains work awaiting a
release; a dated candidate heading starts with
`*Not published to npm; release candidate.*`. A superseded unpublished heading
starts with `*Not published to npm; superseded before release.*`.

## Consumer release notes

The `Unreleased` block, and every dated release after `0.6.0-next.91`, starts
with one bounded consumer summary before its engineering detail. Earlier
releases are records and are not rewritten to fit this template. Each summary
entry uses this exact shape, between the
`<!-- consumer-release-summary:start -->` and
`<!-- consumer-release-summary:end -->` markers under a `### Consumer summary`
heading:

```markdown
- **Added: capability.** One outcome sentence whose complete lead is 40-60 words.
  - **Affects:** The consumers or operators whose behavior can change.
  - **Action:** A concrete next step, or an explicit statement that none is needed.
  - **Requires:** Runtime, configuration, dependency, or evidence prerequisites.
  - **Compatibility:** Breaking, additive, or unchanged behavior at the boundary.
  - **Detail:** [Added engineering detail](#added).
```

Use `Added`, `Changed`, or `Fixed` to match the linked engineering section.
Keep failure history, implementation mechanics and test inventories out of the
lead; the lead states one consumer outcome. The summary covers exactly the
`### Added`, `### Changed` and `### Fixed` sections the block contains, and an
entry may not point at a section the block does not have. Engineering bullets
in governed blocks are bounded to 2000 characters each; split an oversized
bullet into focused bullets rather than raising the bound.

In a dated block, the release-status marker described under
[artifact records](#artifact-records) is the one line allowed before the
summary markers: the ledger check reads it as the block's first line, and the
summary must follow it directly. The Unreleased block carries no marker. The
generated release page states the marker's meaning instead of repeating it.

When a release after `0.6.0-next.91` is dated, `node scripts/check-release-notes.js --write`
generates `docs/releases/<version>.md`, whose detail links pin the release's
own heading anchor, and removes the page of any earlier release. `README.md`
and `MIGRATION.md` must both link `./docs/releases/<version>.md` for the
current release. `npm run check:release` runs this gate after the ledger check.

## Candidate and publication records

1. Choose the version and channel after review: stable versions target `latest`,
   prereleases target `next`. Record a `proposed` candidate event with its full
   Git head, planned `svelte-realtime@<version>` tag, canonical UTC timestamp,
   target channel and review evidence. Record the proposal only after the
   frozen source commit exists, in a separate bookkeeping commit: a commit
   cannot contain its own full SHA. The release tag names the frozen source
   commit, not the later ledger-only commit. Do not invent integrity or publish
   times.
2. Record `tagged` only after the immutable tag actually exists. Do not move an
   existing release tag. An abandoned candidate receives an `aborted` event;
   its changelog heading stays explicitly marked as not published.
3. After separately authorized publication, obtain exact-version npm metadata
   using `npm view svelte-realtime@<version> --json` and publication time from
   `npm view svelte-realtime time --json`. Verify the artifact's version, Git head,
   tag and integrity against the reviewed candidate and its packed artifact.
   Append a `published` candidate event and the complete published row together.
   Remove that version's not-published marker, preserving its changelog heading.
4. If publication returned an error, query the exact version before deciding
   whether it was accepted. An accepted artifact gets a published row even when
   verification or later routing fails. A version absent from npm gets no row.

Record full UTC instants such as `2026-10-10T10:24:32.518Z`. Candidate events
repeat the proposal's head, tag and channel. Proposed and tagged events precede
publication; the published event records when publication was verified, which
cannot precede npm's publication instant. Preserve existing rows byte for byte
apart from Markdown whitespace. Use a correction event with evidence if an
existing fact was recorded incorrectly; do not rewrite the old identity.

Historical releases without a release tag are recorded as `legacy-none`.
If a later direct publication has no tag, record `legacy-none` with a factual
note rather than creating a retrospective tag, and append the `routed` event
for the public pointer that `npm publish` moved through `publishConfig.tag`.
Such a publication may go from `proposed` straight to `published` because no
tag exists to record; a tagged publication always passes through `tagged`.

When the registry omits `gitHead`, record `legacy-unrecorded` as the Git head
and append a source reconstruction row naming the commit whose committed bytes
pack to the recorded shasum and integrity. Find and prove it with
`node scripts/verify-release-source.js <version> --head <commit>`; the script
checks the commit out without line-ending conversion into a temporary
directory and runs `npm pack --dry-run --ignore-scripts` there. A row without a
matching commit cannot be recorded; investigate the publication instead.

## Coordinated publication and promotion

Publish immutable candidate versions in dependency order: adapter, extensions,
then realtime. Each repository uses its own protected trusted-publisher
identity and retains the verified tarball. Quarantine publication changes the
`candidate` pointer, so append its observed old/new routing event alongside
that version's immutable published row. Do not route any package to `next` or
`latest` until every candidate exists and the complete exact-version consumer
passes. Then record each actual pointer move immediately, and restore or clear
the quarantine pointer to its captured prior value with a separate observation.

Stable promotion requires evidence before a release version is selected:

- All required static, unit, simulation, browser, real-runtime and packed
  consumer checks pass at the frozen heads on the supported platform floors.
- The canonical compatibility row names the exact qualified package tuple,
  native-addon spec and protocol revision exercised by the consumer.
- The documented wire contract is frozen, with no pending incompatible change;
  mixed-version and rollback behavior passes the ecosystem
  [coordinated protocol runbook](https://github.com/lanteanio/svelte-adapter-uws/blob/dev/docs/operations/v1/coordinated-release.md).
- README, migration guidance, public exports, declarations and generated client
  surfaces describe the promoted bytes. Known reachable defects have either
  been fixed or have an explicit documented workaround accepted in review.
- Published identities, candidate outcomes and observed channel changes are
  reconciled in the ledger, and the previous compatible tuple is recoverable.

Merge the reviewed prerelease lineage into `main`, preserving the reviewed
history. Prepare stable package versions and migration guidance there, update
same-repository source links from `blob/dev` to `blob/main`, and rerun the full
freeze and preflight on the resulting stable commit. Prerelease results do not
substitute for this run. Use the same proposed, tagged, quarantine publication,
registry verification and ledger transaction as a prerelease, then move
`latest` only after the exact-version consumer passes. Return to `dev` and
refresh its published-main link snapshot with
`node scripts/check-links.js --write-main-tree` after the stable tree is
available. These steps describe separately authorized maintainer actions; a
review handoff does not perform them.

## Abort and stable hotfix

Before publication, append an `aborted` candidate event when an input changes
or a required check fails. Keep any created release tag immutable and use a new
version for its replacement. If publication is ambiguous, query the exact npm
version first. An accepted publication remains an immutable published fact:
record it and its quarantine route, then restore the captured quarantine
pointer with a `routing-aborted` event if public routing never began. Record that failed routing separately;
never describe an existing npm version as an unpublished aborted candidate.

If any public pointer already moved, stop the coordinated release and restore
the affected known-good pointers using the rollback procedure below. Do not
continue with a partially promoted tuple, overwrite a version, move a release
tag or use `npm unpublish` as recovery. Fix forward with a new version.

For a stable hotfix, fork the exact recorded stable commit or immutable tag:
the row's Git head, or for `legacy-unrecorded` its source reconstruction.
Run `node scripts/verify-release-source.js <version>` first; it must repack the
fork point to the recorded shasum. Make the smallest fix with a regression test, and prepare the next stable
patch version with migration notes. Review and merge that fix into `main`
before tagging, so the stable workflow can verify its source lineage. Repeat
the complete stable and cross-package preflight, quarantine publication,
exact-version consumer verification and ledger recording before moving
`latest`. Merge or cherry-pick the same logical fix back into `dev`, resolving
version and changelog differences explicitly. The handoff names both commits;
a successful stable release does not excuse leaving the integration line
vulnerable.

## Routing and rollback records

A dist-tag is mutable routing, not an artifact identity. Verify its observed
value before and after a separately authorized change, and append a `routed`
or `rollback` event with a unique event ID, full UTC timestamp, package,
channel, from-version, to-version and evidence. Use `-` for correction fields
that do not apply and `none` for an absent pointer. A correction event references the original event and keeps
both facts visible. When a new version fails validation, retain its published
row and route back to a verified earlier artifact; never replace a published
version's contents or move its Git tag. Deprecation also preserves the row.

Choose a rollback target that previously occupied the affected channel and is
supported by retained consumer evidence. Verify its exact npm integrity and
shasum against the immutable ledger row; every row records both, including
legacy rows, so the artifact is identified even where the registry omitted its
Git head. Its source, when needed, is the row's Git head or source
reconstruction, proven with `node scripts/verify-release-source.js <version>`. After authorization,
restore the pointer with `npm dist-tag add <package>@<known-good-version> <channel>`,
observe the complete channel map and install that exact restored tuple in a
clean consumer. Record each confirmed rollback immediately with the bad and
restored versions, UTC time, incident evidence and planned fix-forward version.
Restore all affected siblings when a peer floor or wire contract changed;
rollback of a single package requires evidence that the remaining tuple works.

A dist-tag rollback changes future installations, not deployed applications or
cached browser assets. Deployment recovery must also restore a compatible
application/client tuple through the coordinated protocol runbook. Use the
retained known-good tarball; do not rebuild it or assume an old tag will pass
checks against today's external state.

## Offline verification

`npm run check:release` verifies table shape, published metadata, source
reconstructions, exact changelog headings, unpublished markers and append-only
rows throughout the complete local Git history. It replays the candidate event
log and the routing log: one Git head, planned tag and channel per candidate,
legal state transitions, a published row bound to its candidate, a quarantine
route for every tagged publication and a recorded route for every later
untagged one, continuous pointers that advance SemVer, rollback only to an
identity that previously occupied the channel and never forward again, and
corrections that extend the latest fact they replace. Every ledger change
must preserve each parent's existing rows as a prefix, including changes later
reverted or merged. The working copy must also preserve `HEAD`. A committed rewrite therefore remains a failure
after an unrelated commit or a later release tag.
`npm run check` and `npm run verify:docs` include this check. An additional
branch baseline can be checked with `npm run check:release -- --baseline-ref
<base-commit>`; package verification supplies the pull request base or previous
push via `RELEASE_LEDGER_BASE`. Baselines predating the ledger permit its first
addition, but do not bypass the committed-history audit. Verification and
release workflows fetch full history. Shallow checkouts, source archives without
`.git`, and unavailable baselines fail closed; use a complete Git checkout.

The gate uses checked-in records and Git only. It cannot discover a new npm
publication, verify a live dist-tag, or prove that a recorded candidate workflow
ran. Maintainers must append registry facts after every publication and review
candidate and routing evidence. No check command publishes, tags, or reroutes a
package. Historical artifact metadata and missing release tags are recorded
in the manifest.
