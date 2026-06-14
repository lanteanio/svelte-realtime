// @ts-check

/**
 * True outside production - gates dev-only warnings and diagnostics that must
 * compile out of the hot path in production builds. Shared by the modules
 * server.js is split into.
 * @type {boolean}
 */
export const _IS_DEV = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';
