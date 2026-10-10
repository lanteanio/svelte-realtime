// @ts-check
import { parse } from '@babel/parser';

/** Collect declared bindings, including nested destructuring patterns.
 * @param {any} node
 * @param {Set<string>} names
 */
function collectBindings(node, names) {
	if (!node) return;
	if (node.type === 'Identifier') names.add(node.name);
	else if (node.type === 'ObjectPattern') {
		for (const property of node.properties) collectBindings(property.type === 'RestElement' ? property.argument : property.value, names);
	} else if (node.type === 'ArrayPattern') {
		for (const element of node.elements) collectBindings(element, names);
	} else if (node.type === 'AssignmentPattern') collectBindings(node.left, names);
	else if (node.type === 'RestElement') collectBindings(node.argument, names);
}

/**
 * Check runtime exports without executing hooks or importing their dependencies.
 * null means the host compiler must decide (unsupported syntax or a star export).
 * @param {string} source
 * @param {string} filename
 * @returns {boolean | null}
 */
export function _exportsMessage(source, filename) {
	let body;
	try {
		body = parse(source, {
			sourceType: 'module',
			plugins: filename.endsWith('.ts') ? ['typescript'] : [],
			attachComment: false
		}).program.body;
	} catch {
		// Vite reports syntax errors. Do not replace them with a false claim
		// that a valid handler is missing when this parser cannot analyze it.
		return null;
	}
	const typeBindings = new Set();
	const valueBindings = new Set();
	for (const statement of body) {
		if (statement.type === 'ImportDeclaration') {
			for (const specifier of statement.specifiers) {
				const typeOnly = statement.importKind === 'type' || (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type');
				(typeOnly ? typeBindings : valueBindings).add(specifier.local.name);
			}
			continue;
		}
		const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
		if (!declaration) continue;
		const typeOnly = declaration.declare || declaration.type === 'TSTypeAliasDeclaration' || declaration.type === 'TSInterfaceDeclaration' || declaration.type === 'TSDeclareFunction';
		const names = typeOnly ? typeBindings : valueBindings;
		if (declaration.type === 'VariableDeclaration') {
			for (const binding of declaration.declarations) collectBindings(binding.id, names);
		} else if ('id' in declaration) collectBindings(declaration.id, names);
	}
	let unknown = false;
	for (const statement of body) {
		if (statement.type === 'ExportAllDeclaration' && statement.exportKind !== 'type') unknown = true;
		if (statement.type !== 'ExportNamedDeclaration' || statement.exportKind === 'type') continue;
		const declaration = statement.declaration;
		if (declaration && !declaration.declare) {
			const names = new Set();
			if (declaration.type === 'VariableDeclaration') {
				for (const binding of declaration.declarations) collectBindings(binding.id, names);
			} else if ('id' in declaration) collectBindings(declaration.id, names);
			if (names.has('message') && valueBindings.has('message')) return true;
		}
		for (const specifier of statement.specifiers) {
			if (specifier.type !== 'ExportSpecifier' || specifier.exportKind === 'type') continue;
			const name = specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value;
			if (name !== 'message') continue;
			if (statement.source || !typeBindings.has(specifier.local.name) || valueBindings.has(specifier.local.name)) return true;
		}
	}
	return unknown ? null : false;
}
