import { describe, expect, it } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { anchorsOf, checkLink, linksOf } from '../scripts/check-links.js';
import { crawlUrl, looksLikeSoft404 } from '../scripts/check-external-links.js';
import { PROCESS_TEST_TIMEOUT } from './process-fixtures.js';

describe('documentation link gates', () => {
	it('checks source fragments against the dev index and published main snapshot', () => {
		for (const ref of ['dev', 'main']) {
			const url = `https://github.com/lanteanio/svelte-realtime/blob/${ref}/README.md`;
			expect(checkLink('README.md', url + '#merge-strategies', new Map())).toBeNull();
			expect(checkLink('README.md', url + '#missing-source-fragment', new Map())).toContain('no source heading');
			expect(checkLink('README.md', url + '#%ZZ', new Map())).toContain('malformed source anchor');
			expect(checkLink('README.md', url + '#L1-L3', new Map())).toBeNull();
		}
	}, PROCESS_TEST_TIMEOUT);
	it('matches GitHub punctuation, Unicode and colliding duplicate slugs', () => {
		const anchors = anchorsOf('## A & B\n## A & B\n## A--B-1\n## A & B\n## Cafe\u0301 and _code_\n<a id="compatibility-old"></a>\n```md\n## Hidden\n```');
		expect([...anchors]).toEqual(['a--b', 'a--b-1', 'a--b-1-1', 'a--b-2', 'cafe\u0301-and-code', 'compatibility-old']);
	});
	it('collects rendered Markdown and HTML links but ignores code examples', () => {
		expect(linksOf('[a](#first) [b][ref]\n\n[ref]: target.md\n<a href="#old">old</a>\n`[fake](#no)`\n```md\n[no](#no)\n```').map((entry) => entry.target)).toEqual(['#first', 'target.md', '#old']);
	});
	it('rejects missing anchors, unpublished routes and untracked targets', () => {
		const docs = new Map([['README.md', { anchors: new Set(['valid']) }]]);
		expect(checkLink('README.md', '#valid', docs)).toBeNull();
		expect(checkLink('README.md', '#missing', docs)).toContain('no heading');
		expect(checkLink('README.md', 'https://github.com/lanteanio/svelte-realtime/blob/dev/untracked.txt', docs)).toContain('absent from the staged tree');
		const file = new URL('../untracked-link-test.txt', import.meta.url);
		writeFileSync(file, 'temporary\n');
		try { expect(checkLink('README.md', 'untracked-link-test.txt', docs)).toContain('not tracked'); }
		finally { unlinkSync(file); }
	}, PROCESS_TEST_TIMEOUT);
	it('reports redirects, soft 404s and hard failures separately from successful pages', async () => {
		const fetchImpl = async (url) => {
			const pathname = new URL(url).pathname;
			if (pathname === '/redirect') return new Response(null, { status: 302, headers: { location: '/ok' } });
			if (pathname === '/soft') return new Response('<title>Page not found</title>', { headers: { 'content-type': 'text/html' } });
			return new Response('<title>Guide</title>', { status: pathname === '/bad' ? 404 : 200 });
		};
		const check = (path) => crawlUrl('https://example.com/' + path, { fetchImpl });
		expect((await check('ok')).ok).toBe(true);
		expect((await check('redirect')).kind).toBe('redirect');
		expect((await check('soft')).kind).toBe('soft-404');
		expect((await check('bad')).kind).toBe('http-error');
		expect(looksLikeSoft404('<h1>Guide to HTTP 404 responses</h1>')).toBe(false);
	});
	it('accepts a GitHub sign-in wall only in front of a public repository', async () => {
		const signIn = (url) => new Response(null, { status: 302, headers: { location: 'https://github.com/login?return_to=' + encodeURIComponent(url) } });
		const fetchImpl = async (url) => {
			const { pathname } = new URL(url);
			if (pathname === '/login') return new Response('<title>Sign in</title>', { headers: { 'content-type': 'text/html' } });
			if (pathname.endsWith('/new')) return signIn(url);
			if (pathname === '/owner/repo/elsewhere') return new Response(null, { status: 302, headers: { location: 'https://github.com/login?return_to=https%3A%2F%2Fgithub.com%2Fother' } });
			return new Response('<title>Repo</title>', { status: pathname.startsWith('/owner/gone') ? 404 : 200 });
		};
		const check = (path) => crawlUrl('https://github.com/' + path, { fetchImpl });
		expect(await check('owner/repo/issues/new')).toMatchObject({ ok: true, kind: 'sign-in' });
		expect(await check('owner/gone/issues/new')).toMatchObject({ ok: false, kind: 'http-error' });
		expect(await check('owner/repo/elsewhere')).toMatchObject({ ok: false, kind: 'redirect' });
	});
	it('does not follow a GitHub sign-in wall that is not in front of a repository', async () => {
		let requests = 0;
		const fetchImpl = async (url) => {
			if (++requests > 20) throw new Error('crawl did not stop');
			const { pathname } = new URL(url);
			if (pathname === '/login') return new Response('<title>Sign in</title>', { headers: { 'content-type': 'text/html' } });
			if (pathname === '/orgs/acme') return new Response('<title>acme</title>', { headers: { 'content-type': 'text/html' } });
			return new Response(null, { status: 302, headers: { location: 'https://github.com/login?return_to=' + encodeURIComponent(url) } });
		};
		const check = async (path) => {
			requests = 0;
			const result = await crawlUrl('https://github.com/' + path, { fetchImpl });
			return { ...result, requests };
		};
		expect(await check('settings/tokens')).toMatchObject({ ok: false, kind: 'redirect', requests: 2 });
		expect(await check('orgs/acme/teams')).toMatchObject({ ok: false, kind: 'redirect', requests: 2 });
		expect(await check('owner/repo')).toMatchObject({ ok: false, kind: 'redirect', requests: 2 });
	});
});
