#!/usr/bin/env node
/**
 * Scheduled external-documentation crawler.
 *
 * The ordinary link gate stays deterministic and offline. This companion is
 * deliberately scheduled/manual: it performs bounded GETs, follows redirects
 * itself so a stale non-canonical URL is visible, and detects both HTTP errors
 * and common HTML soft-404 pages.
 */
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentationFiles, linksOf } from './check-links.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 6;
const DEFAULT_BODY_LIMIT = 256 * 1024;

function normalizedHttpUrl(target) {
	const url = new URL(target.startsWith('//') ? 'https:' + target : target);
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	if (url.username || url.password) throw new Error('credentials are not allowed in documentation URLs');
	url.hash = '';
	return url.href;
}

/** External Markdown links, excluding fenced and inline-code examples. */
export function externalLinksOf(text) {
	const external = [];
	for (const link of linksOf(text)) {
		if (!/^(?:https?:)?\/\//i.test(link.target)) continue;
		try {
			const url = normalizedHttpUrl(link.target);
			if (url) external.push({ ...link, url, failure: null });
		} catch (error) {
			external.push({ ...link, url: null, failure: error.message });
		}
	}
	return external;
}

/**
 * @param {{ relative: string, text: string }[]} documents
 */
export function collectExternalUrls(documents) {
	const urls = new Map();
	const invalid = [];
	for (const document of documents) {
		for (const link of externalLinksOf(document.text)) {
			const source = { relative: document.relative, line: link.line, target: link.target };
			if (link.failure || !link.url) {
				invalid.push({ ...source, failure: link.failure || 'invalid external URL' });
				continue;
			}
			if (!urls.has(link.url)) urls.set(link.url, []);
			urls.get(link.url).push(source);
		}
	}
	return { urls, invalid };
}

function ipv4Problem(hostname) {
	const bytes = hostname.split('.').map(Number);
	if (bytes.length !== 4 || bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
		return 'invalid IPv4 address';
	}
	const [a, b] = bytes;
	if (a === 0 || a === 10 || a === 127 || a >= 224) return 'non-public IPv4 address';
	if (a === 169 && b === 254) return 'link-local IPv4 address';
	if (a === 172 && b >= 16 && b <= 31) return 'private IPv4 address';
	if (a === 192 && b === 168) return 'private IPv4 address';
	if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT IPv4 address';
	return null;
}

export function publicUrlProblem(value) {
	let url;
	try { url = new URL(value); } catch { return 'invalid URL'; }
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'URL is not HTTP(S)';
	if (url.username || url.password) return 'URL contains credentials';
	let hostname = url.hostname.toLowerCase().replace(/\.$/, '');
	if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
	if (hostname === 'localhost' || hostname.endsWith('.localhost') ||
		hostname.endsWith('.local') || hostname.endsWith('.internal')) return 'non-public hostname';
	const family = isIP(hostname);
	if (family === 4) return ipv4Problem(hostname);
	if (family === 6) {
		const compact = hostname.replace(/^0+(?=[0-9a-f])/g, '');
		const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(compact);
		if (mapped) {
			const high = Number.parseInt(mapped[1], 16);
			const low = Number.parseInt(mapped[2], 16);
			return ipv4Problem(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
		}
		if (compact === '::' || compact === '::1' || /^(?:fc|fd|fe[89ab])/i.test(compact)) {
			return 'non-public IPv6 address';
		}
	}
	return null;
}

async function boundedText(response, limit) {
	if (!response.body) return '';
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = '';
	let bytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
		const remaining = limit - (bytes - value.byteLength);
		if (remaining > 0) text += decoder.decode(value.subarray(0, remaining), { stream: true });
		if (bytes >= limit) {
			await reader.cancel('external link body inspection limit reached');
			break;
		}
	}
	return text + decoder.decode();
}

function visibleText(fragment) {
	return fragment
		.replace(/<[^>]*>/g, ' ')
		.replace(/&(?:nbsp|#160);/gi, ' ')
		.replace(/&(?:apos|#39);/gi, "'")
		.replace(/&(?:quot|#34);/gi, '"')
		.replace(/&amp;/gi, '&')
		.replace(/\s+/g, ' ')
		.trim();
}

export function looksLikeSoft404(html) {
	const candidates = [
		...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi),
		...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi),
		...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)
	].map((match) => visibleText(match[1]));
	const pageMissing = "(?:(?:(?:this|that|the) )?page(?: you requested)? (?:not found|cannot be found|can['\u2019]t be found|could not be found|was not found|is unavailable|does not exist|doesn['\u2019]t exist)|page not found|not found|gone)";
	const notFound = new RegExp(
		'^(?:oops[!,: -]* )?(?:(?:error )?(?:404|410)(?:(?:\\s*[-:|\\u00b7]\\s*|\\s+)(?:' + pageMissing + '))?|' + pageMissing + ')' +
		'(?:\\s*[-:|\\u00b7]\\s*[^]*)?$',
		'i'
	);
	return candidates.some((candidate) => notFound.test(candidate));
}

/** Crawl one URL with manual, bounded redirect handling. */
export async function crawlUrl(startUrl, options = {}) {
	const fetchImpl = options.fetchImpl || globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	const allowPrivate = options.allowPrivate === true;
	const redirects = [];
	const seen = new Set();
	let current = normalizedHttpUrl(startUrl);
	if (!current) return { ok: false, kind: 'invalid-url', url: startUrl, redirects, detail: 'URL is not HTTP(S)' };

	for (;;) {
		if (!allowPrivate) {
			const problem = publicUrlProblem(current);
			if (problem) return { ok: false, kind: 'unsafe-url', url: startUrl, finalUrl: current, redirects, detail: problem };
		}
		if (seen.has(current)) {
			return { ok: false, kind: 'redirect-loop', url: startUrl, finalUrl: current, redirects, detail: 'redirect loop' };
		}
		seen.add(current);

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
		let response;
		try {
			response = await fetchImpl(current, {
				method: 'GET',
				redirect: 'manual',
				signal: controller.signal,
				headers: {
					accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.2',
					'user-agent': 'svelte-adapter-uws-doc-link-check/1'
				}
			});
		} catch (error) {
			clearTimeout(timer);
			return {
				ok: false,
				kind: controller.signal.aborted ? 'timeout' : 'network-error',
				url: startUrl,
				finalUrl: current,
				redirects,
				detail: error?.message || String(error)
			};
		}

		if (response.status >= 300 && response.status < 400) {
			clearTimeout(timer);
			await response.body?.cancel();
			const location = response.headers.get('location');
			if (!location) return { ok: false, kind: 'redirect-without-location', url: startUrl, finalUrl: current, status: response.status, redirects, detail: 'redirect has no Location header' };
			if (redirects.length >= maxRedirects) return { ok: false, kind: 'redirect-limit', url: startUrl, finalUrl: current, status: response.status, redirects, detail: `more than ${maxRedirects} redirects` };
			let next;
			try { next = normalizedHttpUrl(new URL(location, current).href); } catch { next = null; }
			if (!next) return { ok: false, kind: 'invalid-redirect', url: startUrl, finalUrl: current, status: response.status, redirects, detail: `invalid redirect target: ${location}` };
			redirects.push({ from: current, status: response.status, to: next });
			current = next;
			continue;
		}

		let body = '';
		try { body = await boundedText(response, bodyLimit); }
		catch (error) {
			clearTimeout(timer);
			return { ok: false, kind: 'network-error', url: startUrl, finalUrl: current, status: response.status, redirects, detail: error?.message || String(error) };
		}
		clearTimeout(timer);
		if (response.status >= 400) {
			return { ok: false, kind: 'http-error', url: startUrl, finalUrl: current, status: response.status, redirects, detail: `HTTP ${response.status}` };
		}
		const contentType = response.headers.get('content-type') || '';
		const html = /text\/html|application\/xhtml\+xml/i.test(contentType) || /^\s*(?:<!doctype\s+html|<html\b)/i.test(body);
		if (html && looksLikeSoft404(body)) {
			return { ok: false, kind: 'soft-404', url: startUrl, finalUrl: current, status: response.status, redirects, detail: `HTTP ${response.status} page title/heading reports not found` };
		}
		if (redirects.length) {
			return { ok: false, kind: 'redirect', url: startUrl, finalUrl: current, status: response.status, redirects, detail: `redirects to ${current}` };
		}
		return { ok: true, kind: 'ok', url: startUrl, finalUrl: current, status: response.status, redirects, detail: `HTTP ${response.status}` };
	}
}

export async function crawlExternalLinks(urls, options = {}) {
	const list = [...urls];
	const results = new Array(list.length);
	let cursor = 0;
	const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 16));
	async function worker() {
		for (;;) {
			const index = cursor++;
			if (index >= list.length) return;
			results[index] = await crawlUrl(list[index], options);
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, () => worker()));
	return results;
}

function numberFlag(name, fallback) {
	const prefix = `--${name}=`;
	const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) throw new Error(`${prefix}<positive integer> required`);
	return value;
}

async function main() {
	const documents = documentationFiles().map((relative) => ({
		relative,
		text: readFileSync(path.join(root, ...relative.split('/')), 'utf8')
	}));
	const { urls, invalid } = collectExternalUrls(documents);
	const results = await crawlExternalLinks(urls.keys(), {
		concurrency: numberFlag('concurrency', 4),
		timeoutMs: numberFlag('timeout-ms', DEFAULT_TIMEOUT_MS),
		maxRedirects: numberFlag('max-redirects', DEFAULT_MAX_REDIRECTS)
	});
	const failed = results.filter((result) => !result.ok);
	console.log(`check-external-links: ${documents.length} documents, ${urls.size} unique HTTP(S) targets`);
	for (const entry of invalid) console.error(`  x ${entry.relative}:${entry.line} ${entry.target} - ${entry.failure}`);
	for (const result of failed) {
		const sources = urls.get(result.url) || [];
		console.error(`  x ${result.url} - ${result.kind}: ${result.detail}`);
		for (const source of sources) console.error(`      ${source.relative}:${source.line}`);
		for (const hop of result.redirects) console.error(`      ${hop.status} ${hop.from} -> ${hop.to}`);
	}
	if (invalid.length || failed.length) {
		console.error(`check-external-links FAILED: ${invalid.length} invalid and ${failed.length} unreachable/redirected/soft-404 target(s)`);
		process.exit(1);
	}
	console.log('  OK - every external documentation target resolves directly without a soft 404.');
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
	main().catch((error) => {
		console.error(`check-external-links FAILED: ${error.message}`);
		process.exitCode = 1;
	});
}
