#!/usr/bin/env node
// Classify, compile, API-check and inventory README examples by content.
import { isScriptEntry } from './script-entry.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import MarkdownIt from 'markdown-it';
import { compile as compileSvelte } from 'svelte/compiler';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'docs', 'code-blocks.v1.json');
const markdown = new MarkdownIt({ html: true, linkify: true, typographer: false });
const documents = ['README.md'];
const COMPILER_CHANNEL = new Map([
	['js', 'acorn'],
	['ts', 'typescript'],
	['svelte', 'svelte'],
	['json', 'json'],
	['yaml', 'yaml']
]);
const LANGUAGE_ALIASES = new Map([
	['javascript', 'js'],
	['typescript', 'ts'],
	['yml', 'yaml'],
	['shell', 'sh'],
	['text', 'plain']
]);
const COMMAND_LANGUAGES = new Set(['bash', 'sh']);
const CONFIG_LANGUAGES = new Set(['dockerfile', 'ini', 'nginx', 'sql']);
const OUTPUT_LANGUAGES = new Set(['plain']);
const PACKED_VERIFICATION = 'test/packed-readme-examples.test.js';
const NODE_BUILTINS = new Set(builtinModules);
const MARKER_PATTERN = /^<!--\s*doc-code:\s*([a-z-]+)((?:\s+[a-z]+="[^"]*")*)\s*-->$/;
const MARKER_DIRECTIVES = new Map([
	['fragment', ['reason']],
	['ambient', ['names']],
	['no-run', ['reason']]
]);
const NO_RUN_VOCABULARY = ['external-service', 'requires-browser', 'app-context'];

/**
 * Standard globals a runnable block may reference. Pinned explicitly (rather
 * than read from globalThis) so classification is deterministic across Node
 * versions. Node-runnable names only: browser-only globals (window, document,
 * localStorage, ...) are deliberately absent, so a block using them is not
 * classed runnable.
 */
const STANDARD_AMBIENT = new Set([
	'console', 'JSON', 'Math', 'Date', 'URL', 'URLSearchParams', 'URLPattern',
	'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate',
	'clearImmediate', 'queueMicrotask', 'structuredClone', 'crypto', 'fetch',
	'performance', 'process', 'Buffer', 'TextEncoder', 'TextDecoder',
	'AbortController', 'AbortSignal', 'Promise', 'Symbol', 'Object', 'Array',
	'String', 'Number', 'Boolean', 'BigInt', 'Map', 'Set', 'WeakMap', 'WeakSet',
	'WeakRef', 'FinalizationRegistry', 'Proxy', 'Reflect', 'RegExp', 'Error',
	'TypeError', 'RangeError', 'SyntaxError', 'EvalError', 'ReferenceError',
	'URIError', 'AggregateError', 'Function', 'ArrayBuffer', 'SharedArrayBuffer',
	'DataView', 'Atomics', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
	'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array',
	'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Intl', 'globalThis',
	'undefined', 'NaN', 'Infinity', 'isNaN', 'isFinite', 'parseInt',
	'parseFloat', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI',
	'decodeURI', 'atob', 'btoa', 'Blob', 'File', 'FormData', 'Headers',
	'Request', 'Response', 'Event', 'EventTarget', 'MessageChannel',
	'MessagePort', 'MessageEvent', 'BroadcastChannel', 'ReadableStream',
	'WritableStream', 'TransformStream', 'CompressionStream',
	'DecompressionStream', 'DOMException', 'reportError'
]);

/** Universal object-protocol members exempt from the declaration-text check. */
const UNIVERSAL_MEMBERS = new Set([
	'then', 'catch', 'finally', 'toString', 'valueOf', 'call', 'apply', 'bind',
	'hasOwnProperty', 'name', 'length', 'constructor'
]);

function normalized(source) {
	return source.replace(/\r\n?/g, '\n');
}

function languageOf(info) {
	const language = info.trim().split(/\s+/, 1)[0].toLowerCase() || 'plain';
	return LANGUAGE_ALIASES.get(language) || language;
}

function fingerprint(language, content) {
	return createHash('sha256').update(language).update('\0').update(normalized(content)).digest('hex');
}

let cachedPackage = null;
function packageMeta(rootDirectory) {
	if (rootDirectory === root && cachedPackage) return cachedPackage;
	const meta = JSON.parse(readFileSync(join(rootDirectory, 'package.json'), 'utf8'));
	if (rootDirectory === root) cachedPackage = meta;
	return meta;
}

function parseMarkerLine(line) {
	const trimmed = line.replace(/^[>\s]+/, '').trim();
	const match = MARKER_PATTERN.exec(trimmed);
	if (!match) return trimmed.includes('doc-code:') ? { error: 'malformed doc-code marker: ' + trimmed } : null;
	const directive = match[1];
	const expected = MARKER_DIRECTIVES.get(directive);
	if (!expected) return { error: 'unknown doc-code directive: ' + directive };
	const attributes = {};
	for (const pair of match[2].matchAll(/([a-z]+)="([^"]*)"/g)) attributes[pair[1]] = pair[2];
	for (const required of expected) {
		if (!attributes[required] || !attributes[required].trim()) {
			return { error: 'doc-code ' + directive + ' marker requires ' + required + '="..."' };
		}
	}
	return { directive, attributes };
}

/**
 * @param {string} source
 * @param {string} document
 */
export function inventoryMarkdown(source, document = 'README.md') {
	const text = normalized(source);
	const lines = text.split('\n');
	const tokens = markdown.parse(text, {});
	const headings = [];
	const occurrences = new Map();
	const blocks = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.type === 'heading_open') {
			const level = Number(token.tag.slice(1));
			headings.length = level;
			headings[level - 1] = tokens[index + 1]?.content?.trim() || token.tag;
			continue;
		}
		if (token.type !== 'fence') continue;
		const language = languageOf(token.info);
		const digest = fingerprint(language, token.content);
		const occurrence = (occurrences.get(digest) || 0) + 1;
		occurrences.set(digest, occurrence);
		const fenceLine = token.map?.[0] || 0;
		const marker = fenceLine > 0 ? parseMarkerLine(lines[fenceLine - 1] || '') : null;
		blocks.push({
			document,
			fingerprint: digest,
			occurrence,
			language,
			line: fenceLine + 1,
			section: headings.filter(Boolean).join(' > ') || 'Document',
			content: normalized(token.content),
			marker
		});
	}
	return blocks;
}

function diagnosticText(diagnostic) {
	return ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
}

function transpileTs(content) {
	return ts.transpileModule(content, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
	}).outputText;
}

/** Return null when a standalone block parses, otherwise its first error. */
export function syntaxProblem(block) {
	try {
		if (block.language === 'js') {
			acorn.parse(block.content, {
				ecmaVersion: 'latest',
				sourceType: 'module',
				allowHashBang: true
			});
		} else if (block.language === 'ts') {
			const result = ts.transpileModule(block.content, {
				compilerOptions: {
					target: ts.ScriptTarget.ES2022,
					module: ts.ModuleKind.ESNext
				},
				fileName: 'readme-snippet.ts',
				reportDiagnostics: true
			});
			const error = result.diagnostics?.find((item) => item.category === ts.DiagnosticCategory.Error);
			if (error) return diagnosticText(error);
			acorn.parse(result.outputText, { ecmaVersion: 'latest', sourceType: 'module' });
		} else if (block.language === 'svelte') {
			compileSvelte(block.content, { filename: 'README-snippet.svelte', generate: false });
		} else if (block.language === 'json') {
			JSON.parse(block.content);
		} else if (block.language === 'yaml') {
			parseYaml(block.content, { uniqueKeys: true });
		}
		return null;
	} catch (error) {
		return error instanceof Error ? error.message.split('\n', 1)[0] : String(error);
	}
}

// ---------------------------------------------------------------------------
// Static module analysis (imports + free identifiers) for the runnable gate.
// ---------------------------------------------------------------------------

function walkAst(node, parent, key, visit) {
	if (!node || typeof node.type !== 'string') return;
	visit(node, parent, key);
	for (const [childKey, value] of Object.entries(node)) {
		if (childKey === 'type' || childKey === 'loc' || childKey === 'range') continue;
		if (Array.isArray(value)) {
			for (const item of value) walkAst(item, node, childKey, visit);
		} else if (value && typeof value === 'object') {
			walkAst(value, node, childKey, visit);
		}
	}
}

function patternNames(pattern, into) {
	walkAst(pattern, null, null, (node, parent, key) => {
		if (node.type !== 'Identifier') return;
		if (parent?.type === 'Property' && key === 'key' && !parent.computed) return;
		if (parent?.type === 'MemberExpression') return;
		if (parent?.type === 'AssignmentPattern' && key === 'right') return;
		into.add(node.name);
	});
}

/**
 * Compute a JS/TS block's import specifiers and free (undeclared) identifiers.
 * TS content is transpiled (type semantics are checked separately by
 * typeCheckProblem). Declaration collection is scope-flat: a name declared
 * anywhere in the block counts as bound, which can only under-report frees;
 * execution in the packed harness is the final oracle.
 */
export function analyzeModule(block) {
	let source = block.content;
	if (block.language === 'ts') source = transpileTs(source);
	let program;
	try {
		program = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
	} catch (error) {
		return { problem: error instanceof Error ? error.message.split('\n', 1)[0] : String(error) };
	}
	const imports = [];
	if (block.language === 'ts') {
		const original = ts.createSourceFile('README.ts', block.content, ts.ScriptTarget.Latest, true);
		for (const statement of original.statements) {
			if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) imports.push(statement.moduleSpecifier.text);
		}
	}
	let dynamicImport = false;
	const declared = new Set();
	const referenced = new Set();
	walkAst(program, null, null, (node, parent, key) => {
		switch (node.type) {
			case 'ImportDeclaration':
				imports.push(node.source.value);
				break;
			case 'ImportExpression':
				if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
					imports.push(node.source.value);
				} else {
					dynamicImport = true;
				}
				break;
			case 'ExportNamedDeclaration':
			case 'ExportAllDeclaration':
				if (node.source) imports.push(node.source.value);
				break;
			case 'ImportDefaultSpecifier':
			case 'ImportSpecifier':
			case 'ImportNamespaceSpecifier':
				declared.add(node.local.name);
				break;
			case 'VariableDeclarator':
				patternNames(node.id, declared);
				break;
			case 'FunctionDeclaration':
			case 'FunctionExpression':
			case 'ArrowFunctionExpression':
				if (node.id) declared.add(node.id.name);
				for (const param of node.params) patternNames(param, declared);
				break;
			case 'ClassDeclaration':
			case 'ClassExpression':
				if (node.id) declared.add(node.id.name);
				break;
			case 'CatchClause':
				if (node.param) patternNames(node.param, declared);
				break;
			case 'Identifier': {
				if (!parent) break;
				if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) break;
				if (parent.type === 'Property' && key === 'key' && !parent.computed) break;
				if ((parent.type === 'PropertyDefinition' || parent.type === 'MethodDefinition') &&
					key === 'key' && !parent.computed) break;
				if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' ||
					parent.type === 'ImportNamespaceSpecifier') break;
				if (parent.type === 'ExportSpecifier') break;
				if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' ||
					parent.type === 'ContinueStatement') break;
				if (parent.type === 'MetaProperty') break;
				referenced.add(node.name);
				break;
			}
		}
	});
	const free = [...referenced].filter((name) => !declared.has(name) && !STANDARD_AMBIENT.has(name)).sort();
	const runtimeSource = source
		.replace(/^\s*export\s*\{\s*\}\s*;?\s*$/gm, '')
		.replace(/^\s*import[^\n]*$/gm, '')
		// The TS transpiler injects a bare "use strict" directive even when a
		// block is types-only; a directive alone is not runtime code.
		.replace(/^\s*(['"])use strict\1;?\s*$/gm, '')
		.trim();
	return { imports, free, dynamicImport, hasRuntimeCode: runtimeSource.length > 0 };
}

function isPackageSpecifier(specifier, packageName) {
	return specifier === packageName || specifier.startsWith(packageName + '/');
}

function isBuiltinSpecifier(specifier) {
	return specifier.startsWith('node:') || NODE_BUILTINS.has(specifier);
}

function splitSpecifiers(imports, packageName) {
	const appContext = [];
	for (const specifier of imports) {
		if (isPackageSpecifier(specifier, packageName) || isBuiltinSpecifier(specifier)) continue;
		appContext.push(specifier);
	}
	return { appContext };
}

// ---------------------------------------------------------------------------
// Package declaration surface (existence of imports, and of member accesses).
// ---------------------------------------------------------------------------

function declarationTarget(pkg, specifier) {
	const key = specifier === pkg.name
		? '.'
		: specifier.startsWith(pkg.name + '/') ? './' + specifier.slice(pkg.name.length + 1) : null;
	if (key === null) return null;
	const exported = pkg.exports?.[key];
	if (typeof exported === 'string') return exported;
	return exported?.types || null;
}

function declarationExports(source) {
	const file = ts.createSourceFile('package-entry.d.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const names = new Set();
	let hasDefault = false;
	const exported = (statement) => statement.modifiers?.some((modifier) =>
		modifier.kind === ts.SyntaxKind.ExportKeyword
	);
	for (const statement of file.statements) {
		if (ts.isExportAssignment(statement)) {
			hasDefault = true;
			continue;
		}
		if (ts.isExportDeclaration(statement) && statement.exportClause &&
			ts.isNamedExports(statement.exportClause)) {
			for (const element of statement.exportClause.elements) names.add(element.name.text);
			continue;
		}
		if (!exported(statement)) continue;
		if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
			hasDefault = true;
		}
		if (statement.name?.text) names.add(statement.name.text);
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
			}
		}
	}
	return { names, hasDefault };
}

const exportNamesCache = new Map();
function packageExportNames(directory) {
	if (exportNamesCache.has(directory)) return exportNamesCache.get(directory);
	const pkg = packageMeta(directory), names = new Set();
	for (const key of Object.keys(pkg.exports || {})) {
		const text = declarationClosureText(pkg.name + (key === '.' ? '' : key.slice(1)), directory);
		if (text) for (const name of declarationExports(text).names) names.add(name);
	}
	exportNamesCache.set(directory, names);
	return names;
}

function scriptSource(block) {
	if (block.language !== 'svelte') return block.content;
	return [...block.content.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
		.map((match) => match[1])
		.join('\n');
}

/**
 * The declaration text behind a package specifier, including the transitive
 * closure of relative .d.ts files it imports or re-exports, so a member
 * declared one file over still counts as present.
 */
function declarationClosureText(specifier, rootDirectory) {
	const pkg = packageMeta(rootDirectory);
	const target = declarationTarget(pkg, specifier);
	if (target === null) return null;
	const entry = join(rootDirectory, target.replace(/^\.\//, ''));
	if (!existsSync(entry)) return null;
	const visited = new Set();
	const queue = [entry];
	let text = '';
	while (queue.length) {
		const path = queue.pop();
		if (visited.has(path)) continue;
		visited.add(path);
		if (!existsSync(path)) continue;
		const source = readFileSync(path, 'utf8');
		text += source + '\n';
		const base = dirname(path);
		for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
			const relative = match[1];
			const candidates = [
				join(base, relative),
				join(base, relative.replace(/\.js$/, '.d.ts')),
				join(base, relative + '.d.ts'),
				join(base, relative, 'index.d.ts')
			];
			const found = candidates.find((candidate) => candidate.endsWith('.d.ts') && existsSync(candidate));
			if (found) queue.push(found);
		}
	}
	return text;
}

/** Verify imports from this package against the declaration behind exports. */
export function packageImportProblems(block, rootDirectory = root) {
	const pkg = packageMeta(rootDirectory);
	const source = scriptSource(block);
	if (!source.trim()) return [];
	const file = ts.createSourceFile('README-imports.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const problems = [];
	for (const statement of file.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const specifier = statement.moduleSpecifier.text;
		if (!isPackageSpecifier(specifier, pkg.name)) continue;
		const target = declarationTarget(pkg, specifier);
		if (target === null) {
			problems.push('package subpath is not exported: ' + specifier);
			continue;
		}
		const declarationPath = join(rootDirectory, target.replace(/^\.\//, ''));
		if (!existsSync(declarationPath)) {
			problems.push('package declaration is missing for ' + specifier + ': ' + target);
			continue;
		}
		const available = declarationExports(readFileSync(declarationPath, 'utf8'));
		const clause = statement.importClause;
		if (!clause) continue;
		if (clause.name && !available.hasDefault) {
			problems.push(specifier + ' has no declared default export');
		}
		if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
			for (const element of clause.namedBindings.elements) {
				const imported = (element.propertyName || element.name).text;
				if (!available.names.has(imported)) {
					problems.push(specifier + ' has no declared export ' + imported);
				}
			}
		}
	}
	return problems;
}

/**
 * API-surface gate: every member accessed or destructured off a binding that
 * was imported from this package must appear in the corresponding subpath's
 * declaration text (transitive over its relative .d.ts imports). A README
 * example calling a removed or renamed helper fails here.
 */
export function memberSurfaceProblems(block, rootDirectory = root) {
	const pkg = packageMeta(rootDirectory);
	const source = scriptSource(block);
	if (!source.trim()) return [];
	const file = ts.createSourceFile('README-members.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const bindings = new Map();
	for (const statement of file.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const specifier = statement.moduleSpecifier.text;
		if (!isPackageSpecifier(specifier, pkg.name)) continue;
		const clause = statement.importClause;
		if (!clause) continue;
		if (clause.name) bindings.set(clause.name.text, specifier);
		if (clause.namedBindings) {
			if (ts.isNamespaceImport(clause.namedBindings)) {
				bindings.set(clause.namedBindings.name.text, specifier);
			} else {
				for (const element of clause.namedBindings.elements) {
					bindings.set(element.name.text, specifier);
				}
			}
		}
	}
	if (bindings.size === 0) return [];
	const accessed = new Map();
	const record = (binding, member) => {
		if (UNIVERSAL_MEMBERS.has(member)) return;
		const specifier = bindings.get(binding);
		if (!accessed.has(specifier)) accessed.set(specifier, new Set());
		accessed.get(specifier).add(member);
	};
	const visit = (node) => {
		if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
			bindings.has(node.expression.text)) {
			record(node.expression.text, node.name.text);
		} else if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) &&
			bindings.has(node.expression.text) && ts.isStringLiteral(node.argumentExpression)) {
			record(node.expression.text, node.argumentExpression.text);
		} else if (ts.isVariableDeclaration(node) && node.initializer &&
			ts.isIdentifier(node.initializer) && bindings.has(node.initializer.text) &&
			ts.isObjectBindingPattern(node.name)) {
			for (const element of node.name.elements) {
				const property = element.propertyName && ts.isIdentifier(element.propertyName)
					? element.propertyName.text
					: ts.isIdentifier(element.name) ? element.name.text : null;
				if (property) record(node.initializer.text, property);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	const problems = [];
	for (const [specifier, members] of accessed) {
		const text = declarationClosureText(specifier, rootDirectory);
		if (text === null) continue; // packageImportProblems already reports it
		for (const member of [...members].sort()) {
			if (!new RegExp('\\b' + member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(text)) {
				problems.push(specifier + ' declaration does not mention member ' + member);
			}
		}
	}
	return problems;
}

// ---------------------------------------------------------------------------
// Real TypeScript checking for the 'typescript' channel.
// ---------------------------------------------------------------------------

let previousProgram = null;

/**
 * Type-check a TS block with a real program: package imports resolve to this
 * repo's own .d.ts files, node builtins to @types/node, third-party modules to
 * node_modules. Ambient identifiers a block legitimately gets from app context
 * must be declared via <!-- doc-code: ambient names="..." -->; tutorial blocks
 * may import unresolvable app modules, which are shimmed as any.
 */
export function typeCheckProblem(block, { ambientNames = [], tutorial = false } = {}, rootDirectory = root) {
	const pkg = packageMeta(rootDirectory);
	const virtualDirectory = join(rootDirectory, '.doc-code-virtual');
	const blockPath = join(virtualDirectory, 'block.ts');
	const ambientPath = join(virtualDirectory, 'ambient.d.ts');
	const virtualFiles = new Map([[normalizePath(blockPath), block.content]]);
	if (ambientNames.length) {
		virtualFiles.set(
			normalizePath(ambientPath),
			ambientNames.map((name) => 'declare const ' + name + ': any;').join('\n') + '\n'
		);
	}
	const options = {
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		esModuleInterop: true,
		types: existsSync(join(rootDirectory, 'node_modules', '@types', 'node')) ? ['node'] : [],
		lib: ['lib.es2023.d.ts', 'lib.dom.d.ts']
	};
	const host = ts.createCompilerHost(options, true);
	const realFileExists = host.fileExists.bind(host);
	const realReadFile = host.readFile.bind(host);
	host.fileExists = (path) => virtualFiles.has(normalizePath(path)) || realFileExists(path);
	host.readFile = (path) => virtualFiles.get(normalizePath(path)) ?? realReadFile(path);
	const realGetSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (path, languageVersionOrOptions, onError, shouldCreate) => {
		const virtual = virtualFiles.get(normalizePath(path));
		if (virtual !== undefined) {
			return ts.createSourceFile(path, virtual, languageVersionOrOptions, true, ts.ScriptKind.TS);
		}
		return realGetSourceFile(path, languageVersionOrOptions, onError, shouldCreate);
	};
	let shimCounter = 0;
	host.resolveModuleNameLiterals = (literals, containingFile, redirected, compilerOptions) => literals.map((literal) => {
		const specifier = literal.text;
		if (isPackageSpecifier(specifier, pkg.name)) {
			const target = declarationTarget(pkg, specifier);
			if (target !== null) {
				const declarationPath = join(rootDirectory, target.replace(/^\.\//, ''));
				if (existsSync(declarationPath)) {
					return {
						resolvedModule: {
							resolvedFileName: declarationPath,
							extension: ts.Extension.Dts,
							isExternalLibraryImport: false
						}
					};
				}
			}
			return { resolvedModule: undefined };
		}
		const resolved = ts.resolveModuleName(specifier, containingFile, compilerOptions, host, undefined, redirected);
		if (resolved.resolvedModule) return { resolvedModule: resolved.resolvedModule };
		if (tutorial) {
			const shimPath = join(virtualDirectory, 'shim-' + shimCounter++ + '.d.ts');
			virtualFiles.set(normalizePath(shimPath), tutorialShim(block.content, specifier));
			return {
				resolvedModule: {
					resolvedFileName: shimPath,
					extension: ts.Extension.Dts,
					isExternalLibraryImport: true
				}
			};
		}
		return { resolvedModule: undefined };
	});
	const rootNames = [blockPath];
	if (ambientNames.length) rootNames.push(ambientPath);
	const program = ts.createProgram({ rootNames, options, host, oldProgram: previousProgram ?? undefined });
	previousProgram = program;
	const blockSource = program.getSourceFile(blockPath);
	const diagnostics = [
		...program.getSyntacticDiagnostics(blockSource),
		...program.getSemanticDiagnostics(blockSource)
	].filter((item) => item.category === ts.DiagnosticCategory.Error);
	if (!diagnostics.length) return null;
	const first = diagnostics[0];
	let position = '';
	if (first.file && typeof first.start === 'number') {
		const where = first.file.getLineAndCharacterOfPosition(first.start);
		position = ' (' + (where.line + 1) + ':' + (where.character + 1) + ')';
	}
	return 'TS' + first.code + position + ': ' + diagnosticText(first);
}

function normalizePath(path) {
	return path.replace(/\\/g, '/').toLowerCase();
}

function tutorialShim(blockContent, specifier) {
	const file = ts.createSourceFile('shim-scan.ts', blockContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	for (const statement of file.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		if (statement.moduleSpecifier.text !== specifier) continue;
		const clause = statement.importClause;
		if (!clause) return 'export {};\n';
		if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
			return 'declare const shim: any;\nexport = shim;\n';
		}
		const lines = [];
		if (clause.name) lines.push('declare const shimDefault: any;', 'export default shimDefault;');
		if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
			for (const element of clause.namedBindings.elements) {
				const name = (element.propertyName || element.name).text;
				lines.push('export const ' + name + ': any;', 'export type ' + name + ' = any;');
			}
		}
		return lines.join('\n') + '\n';
	}
	return 'export {};\n';
}

// ---------------------------------------------------------------------------
// Classification.
// ---------------------------------------------------------------------------

/**
 * Classify one inventoried block. Returns { record } on success or
 * { errors: [...] } when the block cannot be classified without human action
 * (unmarked parse failure, marker misuse, unknown language).
 */
export function classifyBlock(block, rootDirectory = root) {
	const pkg = packageMeta(rootDirectory);
	const where = block.document + ':' + block.line;
	const marker = block.marker;
	if (marker?.error) return { errors: [where + ': ' + marker.error] };
	if (COMMAND_LANGUAGES.has(block.language)) {
		return { record: { classification: 'command', channel: 'manual-command' } };
	}
	if (CONFIG_LANGUAGES.has(block.language)) {
		return { record: { classification: 'config', channel: 'manual-config' } };
	}
	if (OUTPUT_LANGUAGES.has(block.language)) {
		return { record: { classification: 'output', channel: 'reviewed-output' } };
	}
	const compiler = COMPILER_CHANNEL.get(block.language);
	if (!compiler) {
		return { errors: [where + ': no compiler channel for language ' + block.language + '; use a supported language or fence it as output'] };
	}
	const problem = syntaxProblem(block);
	if (marker?.directive === 'fragment') {
		if (problem === null) {
			return { errors: [where + ': fragment marker on a block that parses standalone; remove the marker'] };
		}
		return {
			record: {
				classification: 'fragment',
				channel: 'reviewed-fragment',
				reason: marker.attributes.reason.slice(0, 240)
			}
		};
	}
	if (problem !== null) {
		return {
			errors: [
				where + ': ' + compiler + ' failed: ' + problem +
				' (a deliberate excerpt needs <!-- doc-code: fragment reason="..." --> on the line above the fence)'
			]
		};
	}
	if (block.language === 'json' || block.language === 'yaml') {
		return { record: { classification: 'syntax', channel: compiler } };
	}
	if (marker?.directive === 'no-run') {
		const reason = marker.attributes.reason;
		if (!NO_RUN_VOCABULARY.some((token) => reason === token || reason.startsWith(token + ':') || reason.startsWith(token + ' '))) {
			return { errors: [where + ': no-run reason must start with one of: ' + NO_RUN_VOCABULARY.join(', ')] };
		}
		return { record: { classification: 'syntax', channel: compiler, reason: 'not runnable: ' + reason } };
	}
	if (block.language === 'svelte') {
		const scriptBlock = { language: 'ts', content: scriptSource(block) };
		const analysis = scriptBlock.content.trim() ? analyzeModule(scriptBlock) : { imports: [] };
		const { appContext } = splitSpecifiers(analysis.imports || [], pkg.name);
		if (appContext.length) {
			return {
				record: {
					classification: 'tutorial',
					channel: 'app-context',
					reason: 'app-context imports: ' + appContext.join(', ')
				}
			};
		}
		return { record: { classification: 'syntax', channel: compiler, reason: 'not runnable: browser-component' } };
	}
	const analysis = analyzeModule(block);
	if (analysis.problem) {
		return { errors: [where + ': ' + compiler + ' failed: ' + analysis.problem] };
	}
	const declaredAmbient = marker?.directive === 'ambient' ? marker.attributes.names.split(/\s*,\s*|\s+/) : [];
	const missingImports = analysis.free.filter(name => packageExportNames(rootDirectory).has(name) && !declaredAmbient.includes(name));
	if (missingImports.length) return { errors: [where + ': package exports need imports or explicit ambient names: ' + missingImports.join(', ')] };
	const { appContext } = splitSpecifiers(analysis.imports, pkg.name);
	if (appContext.length || analysis.dynamicImport) {
		const detail = appContext.length ? appContext.join(', ') : 'dynamic import';
		return {
			record: {
				classification: 'tutorial',
				channel: 'app-context',
				reason: 'app-context imports: ' + detail
			}
		};
	}
	if (marker?.directive === 'ambient') {
		return {
			record: {
				classification: 'syntax',
				channel: compiler,
				reason: 'not runnable: ambient-identifiers ' + marker.attributes.names
			}
		};
	}
	if (analysis.free.length) {
		return {
			record: {
				classification: 'syntax',
				channel: compiler,
				reason: 'not runnable: ambient-identifiers ' + analysis.free.join(', ')
			}
		};
	}
	if (!analysis.hasRuntimeCode) {
		return {
			record: {
				classification: 'syntax',
				channel: compiler,
				reason: 'not runnable: type-declarations-only'
			}
		};
	}
	return {
		record: {
			classification: 'executed',
			channel: 'packed-runtime',
			verification: PACKED_VERIFICATION
		}
	};
}

function ambientNamesOf(block) {
	if (block.marker?.directive !== 'ambient') return [];
	return block.marker.attributes.names.split(',').map((name) => name.trim()).filter(Boolean);
}

function summarize(records) {
	const classifications = {};
	const channels = {};
	const notRunnable = {};
	for (const record of records) {
		classifications[record.classification] = (classifications[record.classification] || 0) + 1;
		channels[record.channel] = (channels[record.channel] || 0) + 1;
		if (record.classification === 'tutorial') {
			notRunnable['app-context'] = (notRunnable['app-context'] || 0) + 1;
		} else if (typeof record.reason === 'string' && record.reason.startsWith('not runnable: ')) {
			const token = record.reason.slice('not runnable: '.length).split(/[\s:]/, 1)[0];
			notRunnable[token] = (notRunnable[token] || 0) + 1;
		}
	}
	return { classifications, channels, notRunnable };
}

export function buildManifest(sources, { previousManifest = null, acceptFragmentCount = false, acceptExecutedCount = false } = {}, rootDirectory = root) {
	const blocks = [];
	const errors = [];
	for (const document of documents) {
		const source = sources[document];
		if (typeof source !== 'string') throw new Error('missing documentation source: ' + document);
		for (const block of inventoryMarkdown(source, document)) {
			const outcome = classifyBlock(block, rootDirectory);
			if (outcome.errors) {
				errors.push(...outcome.errors);
				continue;
			}
			blocks.push({
				document: block.document,
				fingerprint: block.fingerprint,
				occurrence: block.occurrence,
				language: block.language,
				section: block.section,
				...outcome.record
			});
		}
	}
	if (errors.length) {
		const failure = new Error('cannot classify README fences:\n' + errors.map((item) => '  x ' + item).join('\n'));
		failure.problems = errors;
		throw failure;
	}
	const fragments = blocks.filter((block) => block.classification === 'fragment').length;
	const previousCeiling = Number.isInteger(previousManifest?.fragmentCeiling)
		? previousManifest.fragmentCeiling
		: null;
	if (previousCeiling !== null && fragments > previousCeiling && !acceptFragmentCount) {
		const failure = new Error(
			'fragment count ' + fragments + ' exceeds the pinned ceiling ' + previousCeiling +
			'; growing the fragment set is a reviewed act - rerun with --accept-fragment-count to pin the new count'
		);
		failure.problems = [failure.message];
		throw failure;
	}
	const executed = blocks.filter(block => block.classification === 'executed').length;
	const previousFloor = previousManifest?.executedFloor ?? previousManifest?.summary?.classifications?.executed ?? 0;
	if (executed < previousFloor && !acceptExecutedCount) throw new Error('executed count ' + executed + ' is below the pinned floor ' + previousFloor + '; use --accept-executed-count for an intentional reviewed reduction');
	return {
		schemaVersion: 2,
		documents,
		fragmentCeiling: fragments,
		executedFloor: executed,
		summary: { total: blocks.length, ...summarize(blocks) },
		blocks
	};
}

function blockKey(block) {
	return block.document + ':' + block.fingerprint + ':' + block.occurrence;
}

export function validateManifest(manifest, sources, rootDirectory = root) {
	const errors = [];
	if (manifest?.schemaVersion !== 2) errors.push('manifest schemaVersion must be 2');
	if (JSON.stringify(manifest?.documents) !== JSON.stringify(documents)) {
		errors.push('manifest documents must be exactly: ' + documents.join(', '));
	}
	if (!Number.isInteger(manifest?.fragmentCeiling) || manifest.fragmentCeiling < 0) {
		errors.push('manifest fragmentCeiling must be a non-negative integer');
	}
	if (!Number.isInteger(manifest?.executedFloor) || manifest.executedFloor < 0) errors.push('manifest executedFloor must be a non-negative integer');
	const records = new Map();
	for (const record of manifest?.blocks || []) {
		const key = blockKey(record);
		if (records.has(key)) errors.push('duplicate manifest record: ' + key);
		else records.set(key, record);
	}
	const seen = new Set();
	let fragmentCount = 0;
	let executedCount = 0;
	for (const document of documents) {
		const source = sources[document];
		if (typeof source !== 'string') {
			errors.push('missing documentation source: ' + document);
			continue;
		}
		for (const block of inventoryMarkdown(source, document)) {
			const key = blockKey(block);
			seen.add(key);
			const record = records.get(key);
			if (!record) {
				errors.push(`${document}:${block.line}: unclassified ${block.language} fence in ${block.section}`);
				continue;
			}
			const outcome = classifyBlock(block, rootDirectory);
			if (outcome.errors) {
				errors.push(...outcome.errors);
				continue;
			}
			const expected = outcome.record;
			if (expected.classification === 'fragment') fragmentCount++;
			if (expected.classification === 'executed') executedCount++;
			// Content fingerprints identify examples independently of surrounding prose.
			for (const field of ['language', 'section']) {
				if (record[field] !== block[field]) {
					errors.push(
						`${key}: ${field} is stale (recorded ${JSON.stringify(record[field] ?? null)}, ` +
						`actual ${JSON.stringify(block[field])}); rerun node scripts/check-doc-code.js --write`
					);
				}
			}
			for (const field of ['classification', 'channel', 'reason']) {
				if ((record[field] ?? null) !== (expected[field] ?? null)) {
					errors.push(`${key}: ${field} must be ${expected[field] ?? 'absent'}`);
				}
			}
			if (expected.verification) {
				if (record.verification !== expected.verification) errors.push(`${key}: executed verification is stale`);
				else if (!existsSync(join(rootDirectory, record.verification))) {
					errors.push(`${key}: verification target does not exist: ${record.verification}`);
				}
			}
			if (expected.classification === 'syntax' || expected.classification === 'executed' ||
				expected.classification === 'tutorial') {
				for (const importProblem of packageImportProblems(block, rootDirectory)) {
					errors.push(`${document}:${block.line}: ${importProblem}`);
				}
				for (const memberProblem of memberSurfaceProblems(block, rootDirectory)) {
					errors.push(`${document}:${block.line}: ${memberProblem}`);
				}
				if (block.language === 'ts') {
					const typeProblem = typeCheckProblem(block, {
						ambientNames: ambientNamesOf(block),
						tutorial: expected.classification === 'tutorial'
					}, rootDirectory);
					if (typeProblem !== null) {
						errors.push(`${document}:${block.line}: typescript failed: ${typeProblem}`);
					}
				}
			}
		}
	}
	if (Number.isInteger(manifest?.fragmentCeiling) && fragmentCount > manifest.fragmentCeiling) {
		errors.push(
			'fragment count ' + fragmentCount + ' exceeds the pinned ceiling ' + manifest.fragmentCeiling +
			'; growing the fragment set is a reviewed act (see --accept-fragment-count)'
		);
	}
	if (executedCount < manifest?.executedFloor) errors.push('executed count ' + executedCount + ' is below the pinned floor ' + manifest.executedFloor);
	if (manifest?.summary) {
		const recomputed = { total: manifest.blocks?.length || 0, ...summarize(manifest.blocks || []) };
		if (JSON.stringify(manifest.summary) !== JSON.stringify(recomputed)) {
			errors.push('manifest summary is stale; rerun node scripts/check-doc-code.js --write');
		}
	} else {
		errors.push('manifest summary is missing');
	}
	for (const key of records.keys()) {
		if (!seen.has(key)) errors.push('manifest record has no matching fence: ' + key);
	}
	return errors;
}

export function coverageOf(manifest) {
	const classifications = {};
	const channels = {};
	for (const block of manifest.blocks || []) {
		classifications[block.classification] = (classifications[block.classification] || 0) + 1;
		channels[block.channel] = (channels[block.channel] || 0) + 1;
	}
	return { total: manifest.blocks?.length || 0, classifications, channels };
}

function loadSources(rootDirectory = root) {
	return Object.fromEntries(documents.map((document) => [
		document,
		readFileSync(join(rootDirectory, document), 'utf8')
	]));
}

function main() {
	const sources = loadSources();
	if (process.argv.includes('--write')) {
		let previousManifest = null;
		if (existsSync(manifestPath)) {
			try {
				previousManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
			} catch {
				previousManifest = null;
			}
		}
		let manifest;
		try {
			manifest = buildManifest(sources, {
				previousManifest,
				acceptFragmentCount: process.argv.includes('--accept-fragment-count'),
				acceptExecutedCount: process.argv.includes('--accept-executed-count')
			});
		} catch (error) {
			console.error('check-doc-code --write FAILED:');
			for (const problem of error.problems || [error.message]) console.error('  x ' + problem);
			process.exitCode = 1;
			return;
		}
		writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
		const summary = manifest.summary;
		console.log(
			'check-doc-code: classified ' + summary.total + ' README fences; classes ' +
			Object.entries(summary.classifications).map(([name, count]) => name + '=' + count).join(', ')
		);
		return;
	}
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	const errors = validateManifest(manifest, sources);
	if (errors.length) {
		console.error('check-doc-code FAILED:');
		for (const error of errors) console.error('  x ' + error);
		console.error('Review the changed fences, then run node scripts/check-doc-code.js --write.');
		process.exitCode = 1;
		return;
	}
	const coverage = coverageOf(manifest);
	console.log(
		'check-doc-code: ' + coverage.total + ' README fences classified; classes ' +
		Object.entries(coverage.classifications).map(([name, count]) => name + '=' + count).join(', ') +
		'; channels ' + Object.entries(coverage.channels).map(([name, count]) => name + '=' + count).join(', ') +
		'; not runnable ' + Object.entries(manifest.summary?.notRunnable || {}).map(([name, count]) => name + '=' + count).join(', ')
	);
}

if (isScriptEntry(import.meta.url)) main();
