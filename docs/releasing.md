# Releasing

This package follows the ecosystem [release lifecycle](https://github.com/lanteanio/svelte-adapter-uws/blob/dev/docs/releasing.md).
The local workflow and ledger below bind that lifecycle to the realtime package;
a green local check alone does not authorize publication or channel promotion.

## Branch roles and freeze

- `dev` integrates work and supplies `next` prereleases.
- `main` supplies stable `latest` releases after a reviewed promotion.
- `hotfix/<stable-version>/<slug>` starts from the exact stable Git identity
  recorded in the ledger, never from whichever branch tip happens to be current.

Record the selected adapter, extensions and realtime full Git SHAs, exact
package versions, protocol revision and native-addon spec in the release
handoff. Freeze those source commits for qualification. Any source, version,
lockfile or generated-file change selects a new candidate and restarts the
required checks. A subsequent ledger-only bookkeeping commit can describe a
frozen source commit without becoming the artifact's source identity.

Before tagging, require clean candidate checkouts, reconciled migration notes,
changelogs, declarations and generated files, plus each repository's complete
required verification lanes. Run this package's `npm run verify:release` and
qualify the exact sibling heads together through the adapter-owned packed
cross-repository consumer. Retain its pinned SHAs, installed dependency tree,
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

The initial reconstruction records missing historical tags as `legacy-none`.
If a later direct publication has no tag, record `legacy-none` with a factual
note rather than creating a retrospective tag. `legacy-unrecorded` as a Git
head is accepted only for the observed `0.5.13` registry omission. New missing
metadata requires explicit investigation and a reviewed policy change.

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
pointer if public routing never began. Record that failed routing separately;
never describe an existing npm version as an unpublished aborted candidate.

If any public pointer already moved, stop the coordinated release and restore
the affected known-good pointers using the rollback procedure below. Do not
continue with a partially promoted tuple, overwrite a version, move a release
tag or use `npm unpublish` as recovery. Fix forward with a new version.

For a stable hotfix, fork the exact recorded stable commit or immutable tag,
make the smallest fix with a regression test, and prepare the next stable
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
that do not apply. A correction event references the original event and keeps
both facts visible. When a new version fails validation, retain its published
row and route back to a verified earlier artifact; never replace a published
version's contents or move its Git tag. Deprecation also preserves the row.

Choose a rollback target that previously occupied the affected channel and is
supported by retained consumer evidence. Verify its exact npm Git head,
integrity and shasum against the immutable ledger row. After authorization,
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

`npm run check:release` verifies table shape, published metadata, exact changelog
headings, unpublished markers and append-only rows against local `HEAD`.
`npm run check` and `npm run verify:docs` include this check. For a complete
branch review, run `npm run check:release -- --baseline-ref <base-commit>`.
The package verification workflow uses the pull request base or previous push
commit via `RELEASE_LEDGER_BASE` and fetches history; manual workflow runs compare
against `HEAD`. An unavailable baseline fails with a Git error instead of
silently dropping the history check. A baseline predating the ledger permits
the initial reconstruction.

The gate checks table shape, immutable published identities and append-only
history; maintainers review candidate and routing transition evidence. It does
not enforce every lifecycle decision above. The gate uses checked-in records
and Git only. It cannot discover a new npm
publication, verify a live dist-tag, or prove that a recorded candidate workflow
ran. Maintainers must append registry facts after every publication and review
candidate and routing evidence. No check command publishes, tags, or reroutes a
package. The original reconstruction used registry metadata for all 150 known
versions and confirmed that local and remote release-tag lists were empty.
