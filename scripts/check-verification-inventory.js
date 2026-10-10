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
				if (commands.length) hosted.push({ workflow: file, job, step: step.name || String(index + 1), commands });
			}
		}
	}
	const allHosted = new Set(hosted.flatMap((step) => step.commands));
	const notFullyHosted = Object.keys(scripts).filter((name) => /^(check|test|sim:|verify:)/.test(name) && scripts[name].some((command) => !allHosted.has(command)));
	return { schemaVersion: 1, scripts, hosted, notFullyHosted };
}

export function renderInventory(pkg, workflows) { return JSON.stringify(buildInventory(pkg, workflows), null, 2) + '\n'; }
function main() {
	const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
	const workflows = Object.fromEntries(readdirSync(resolve(root, '.github/workflows')).filter((file) => /\.ya?ml$/.test(file)).map((file) => [file, parse(readFileSync(resolve(root, '.github/workflows', file), 'utf8'))]));
	const output = renderInventory(pkg, workflows);
	const target = resolve(root, 'docs/verification.v1.json');
	if (process.argv.includes('--write')) writeFileSync(target, output);
	if (readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== output) throw new Error('Verification inventory is stale: run npm run generate:verification and review the changed CI coverage.');
	console.log(`verification inventory: ${Object.keys(pkg.scripts).length} scripts and ${Object.keys(workflows).length} workflows agree`);
}
if (isScriptEntry(import.meta.url)) {
	try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
