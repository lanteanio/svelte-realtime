import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Point at an extracted npm tarball to verify the shipped examples too.
const root = process.env.SVELTE_REALTIME_PACKED_ROOT || fileURLToPath(new URL('..', import.meta.url));
const files = ['README.md', 'src/server.js', 'src/server.d.ts'];

describe('documented extension imports', () => {
 it.each(files)('%s resolves its named imports through the installed package exports', async (file) => {
  const text = readFileSync(resolve(root, file), 'utf8');
  const imports = [...text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](svelte-adapter-uws-extensions[^'"]*)['"]/g)];
  expect(imports.length).toBeGreaterThan(0);
  for (const [, names, specifier] of imports) {
   const exports = await import(/* @vite-ignore */ specifier);
   for (const item of names.split(',')) {
    const name = item.trim().split(/\s+as\s+/)[0];
    expect.soft(exports, file + ': ' + specifier + ' exports ' + name).toHaveProperty(name);
   }
  }
 });
});
