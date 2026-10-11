#!/usr/bin/env node
// Derive review evidence from package scripts and root-package CI steps.
import { isScriptEntry } from './script-entry.js';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function expandScript(name, scripts, stack = []) {
	if (stack.includes(name)) throw new Error(`recursive npm script: ${[...stack, name].join(' -> ')}`);
	if (!Object.hasOwn(scripts, name)) throw new Error(`missing npm script: ${name}`);
	const next = [...stack, name];
	const commands = [];
	for (const hook of [`pre${name}`, name, `post${name}`]) {
		if (!Object.hasOwn(scripts, hook)) continue;
		for (const part of scripts[hook].split(/\s*&&\s*|\r?\n/).filter(Boolean)) {
			const match = /^npm(?:\.cmd)? (?:run(?:-script)? )?([\w:-]+)$/.exec(part.trim());
			if (match) commands.push(...expandScript(match[1], scripts, next));
			else commands.push(part.trim());
		}
	}
	return commands;
}

export function automaticTriggers(on) {
	const events = typeof on === 'string' ? { [on]: null } : Array.isArray(on) ? Object.fromEntries(on.map(name => [name, null])) : on || {};
	if (Object.hasOwn(events, 'pull_request')) return true;
	if (!Object.hasOwn(events, 'push')) return false;
	const push = events.push || {};
	return Object.hasOwn(push, 'branches') || Object.hasOwn(push, 'branches-ignore') || (!Object.hasOwn(push, 'tags') && !Object.hasOwn(push, 'tags-ignore'));
}
export function validateLaneTable(contributing, scripts) {
	const section = contributing.split('## Choose verification by the changed surface')[1]?.split('\n## ')[0] || '';
	const table = section.split('\n').filter(line => line.startsWith('|')).join('\n');
	const required = Object.keys(scripts).filter(name => name.startsWith('verify:') || ['smoke', 'test:smooth-stack', 'test:chaos:parallel'].includes(name));
	const missing = required.filter(name => !table.includes('npm run ' + name + String.fromCharCode(96)));
	if (missing.length) throw new Error('Verification table is missing lanes: ' + missing.join(', '));
}
export function buildInventory(pkg, workflows) {
	const scripts = Object.fromEntries(Object.keys(pkg.scripts).sort().map((name) => [name, expandScript(name, pkg.scripts)]));
	const hosted = [];
	for (const [file, workflow] of Object.entries(workflows).sort()) {
		for (const [job, config] of Object.entries(workflow.jobs || {})) {
			for (const [index, step] of (config.steps || []).entries()) {
				if (typeof step.run !== 'string') continue;
				const cwd = step['working-directory'] ?? config.defaults?.run?.['working-directory'] ?? workflow.defaults?.run?.['working-directory'] ?? '.';
				if (!['.', './', '${{ github.workspace }}'].includes(cwd)) continue;
				const commands = [];
				for (const part of step.run.split(/\s*&&\s*|\r?\n/).filter(Boolean)) {
					const line = part.trim();
					// Explicit prefix commands target another package even in a root step.
					if (/--(?:prefix|workspace)(?:[ =]|$)/.test(line)) continue;
					const match = /^npm(?:\.cmd)? (?:run(?:-script)? )?([\w:-]+)$/.exec(line);
					if (match && Object.hasOwn(pkg.scripts, match[1])) commands.push(...expandScript(match[1], pkg.scripts));
					else commands.push(line);
				}
				if (commands.length) hosted.push({ workflow: file, automatic: automaticTriggers(workflow.on), job, step: step.name || String(index + 1), commands });
			}
		}
	}
	const allHosted = new Set(hosted.filter(step => step.automatic).flatMap((step) => step.commands));
	const notFullyHosted = Object.keys(scripts).filter((name) => /^(check|test|sim:|verify:|smoke$)/.test(name) && scripts[name].some((command) => !allHosted.has(command)));
	return { schemaVersion: 2, scripts, workflowTriggers: Object.fromEntries(Object.entries(workflows).sort().map(([file, workflow]) => [file, workflow.on ?? null])), hosted, notFullyHosted };
}

export function renderInventory(pkg, workflows) { return JSON.stringify(buildInventory(pkg, workflows), null, 2) + '\n'; }
function main() {
	const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
	const workflows = Object.fromEntries(readdirSync(resolve(root, '.github/workflows')).filter((file) => /\.ya?ml$/.test(file)).map((file) => [file, parse(readFileSync(resolve(root, '.github/workflows', file), 'utf8'))]));
	validateLaneTable(readFileSync(resolve(root, 'CONTRIBUTING.md'), 'utf8').replace(/\r\n/g, '\n'), pkg.scripts);
	const output = renderInventory(pkg, workflows);
	const target = resolve(root, 'docs/verification.v1.json');
	if (process.argv.includes('--write')) writeFileSync(target, output);
	if (readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== output) throw new Error('Verification inventory is stale: run npm run generate:verification and review the changed CI coverage.');
	console.log(`verification inventory: ${Object.keys(pkg.scripts).length} scripts and ${Object.keys(workflows).length} workflows agree`);
}
if (isScriptEntry(import.meta.url)) {
	try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
