// @ts-check

export const VIRTUAL_PREFIX = '\0live:';

export const REGISTRY_ID = '\0live:__registry';

// Public specifier server code (the injected hooks import, the dev loaders)
// uses for the registry; resolveId maps it to REGISTRY_ID in the server graph.
export const REGISTRY_PUBLIC_ID = '/@svelte-realtime-registry';

// Browser-loadable module that boots the development tools.
export const DEVTOOLS_PUBLIC_ID = '/@svelte-realtime-devtools';
export const DEVTOOLS_ID = '\0live-devtools';

// Server-graph module that re-exports svelte-realtime/server. An environment
// runner internalizes its entry points, so importing the runtime through this
// module keeps it a dependency that HMR clears together with the registry.
export const SERVER_PUBLIC_ID = '/@svelte-realtime-server';
export const SERVER_ID = '\0live-server';
