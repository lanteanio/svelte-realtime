# Recording releases

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
   target channel and review evidence. Do not invent integrity or publish times.
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

## Routing and rollback records

A dist-tag is mutable routing, not an artifact identity. Verify its observed
value before and after a separately authorized change, and append a `routed`
or `rollback` event with a unique event ID, full UTC timestamp, package,
channel, from-version, to-version and evidence. Use `-` for correction fields
that do not apply. A correction event references the original event and keeps
both facts visible. When a new version fails validation, retain its published
row and route back to a verified earlier artifact; never replace a published
version's contents or move its Git tag. Deprecation also preserves the row.

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

The gate uses checked-in records and Git only. It cannot discover a new npm
publication, verify a live dist-tag, or prove that a recorded candidate workflow
ran. Maintainers must append registry facts after every publication and review
candidate and routing evidence. No check command publishes, tags, or reroutes a
package. The original reconstruction used registry metadata for all 150 known
versions and confirmed that local and remote release-tag lists were empty.
