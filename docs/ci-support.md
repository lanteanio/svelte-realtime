# Runtime and peer coverage

CI tests the current checkout on Linux (Ubuntu 24.04). The package and recovery workflows run on pull requests, pushes to main/dev and nightly schedules. The release workflow retains its Windows verification.

`docs/ci-support.v1.json` records upstream lifecycle data and compatible peer majors. `node scripts/check-ci-support.js` derives both matrices from that table and the package/fixture manifests. It refuses stale dates, an EOL Node baseline, omitted majors, disconnected matrices and skipped runtime commands. The table was checked on 2026-11-01 and must be checked again by 2027-01-01.

| Node leg | Upstream end of support |
| --- | --- |
| 22.23.2 | 2027-04-30 |
| 22.x | 2027-04-30 |
| 24.x | 2028-04-30 |
| 26.x | 2029-04-30 |

The exact patch is the baseline; `.x` selects the newest patch in each maintained major admitted by `engines.node` (`>=22.0.0`). Every leg runs the unit, simulation, browser/DevTools, scaffold, native smooth-stack, smoke, locked Kit, production lifecycle and recovery-chaos checks. Native preflight is required before the unit suite. A missing native binary fails the leg.

| SvelteKit major | Svelte major | Vite major | Vite plugin major |
| --- | --- | --- | --- |
| 2 | 4 | 5 | 3 |
| 2 | 5 | 5 | 4 |
| 2 | 5 | 6 | 5 |
| 2 | 5 | 7 | 6 |
| 2 | 5 | 8 | 7 |
| 3 | 5 | 8 | 7 |

Each row runs at its lowest jointly valid peer versions and at its latest versions, crossed with every maintained Node major (36 jobs). The adapter version is selected inside the declared `^0.6.0-next.96` peer range. Registry metadata and peer/engine constraints determine the exact tuple at run time. A floor uses the lowest Kit, then plugin, Vite, Svelte and adapter versions that jointly satisfy every peer range; it never installs an invalid graph with `--force` or `--legacy-peer-deps`. A declared package floor below a companion peer minimum is therefore exercised at that effective minimum. Each job retains the exact requested and installed versions, logs and runtime reports.

Svelte 5 rows run real production and development servers, cold WebSocket RPC, browser stores, shared HTTP/WebSocket state, DevTools and HMR. Kit 3 also tests wrapped and omitted adapter configurations. The existing adapter-version-specific runtime exceptions remain visible in the Kit reports. Svelte 4 rows build and type-check a production application, exercise store operations, and verify RPC and updates in two browsers plus reload.

Upstream has no dated EOL schedule for Svelte, SvelteKit or the adapter, so their dates are null in the table. Vite uses a rolling policy: 6/7/8 receive updates as of the recorded date; Vite 5 is explicitly legacy compatibility coverage required by the supported Svelte 4 path. That legacy row does not claim upstream security support. Published package ranges remain unchanged.

For one installed consumer, run `node scripts/run-peer-compat.js --combination kit2-svelte5-vite6 --edge floor` after installing root dependencies and Playwright Chromium. This creates an isolated application under `test-results`, resolves exact registry versions, installs with strict peer and engine checks, and retains its evidence there. Use `--edge latest` for the other boundary.
