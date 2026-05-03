// @ts-check

export const VALID_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const VALID_TEMPLATES = ['minimal', 'example', 'demo'];

/**
 * @param {string} [ua]
 * @returns {'npm' | 'pnpm' | 'yarn' | 'bun'}
 */
export function detectAgent(ua) {
	const agent = ua ?? '';
	if (agent.startsWith('pnpm')) return 'pnpm';
	if (agent.startsWith('yarn')) return 'yarn';
	if (agent.startsWith('bun')) return 'bun';
	return 'npm';
}

/**
 * Parse and validate CLI arguments. Returns an object or an error string.
 * Parses in one pass so that flag values (e.g. --template minimal) are consumed
 * and not mistaken for positional args.
 * @param {string[]} argv - arguments (without node/script prefix)
 * @param {{ dirExists?: (name: string) => boolean }} [opts]
 * @returns {{ help: true } | { error: string } | { name?: string, template?: string }}
 */
export function parseArgs(argv, opts) {
	const positional = [];
	let template;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];

		if (arg === '--help' || arg === '-h') {
			return { help: true };
		}

		if (arg === '--template') {
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('-')) {
				if (next === '--help' || next === '-h') return { help: true };
				return { error: '--template requires a value: minimal, example, or demo.' };
			}
			template = argv[++i];
			if (!VALID_TEMPLATES.includes(template)) {
				return { error: `Unknown template: "${template}". Use minimal, example, or demo.` };
			}
			continue;
		}

		if (arg.startsWith('--template=')) {
			template = arg.slice('--template='.length);
			if (!template) {
				return { error: '--template requires a value: minimal, example, or demo.' };
			}
			if (!VALID_TEMPLATES.includes(template)) {
				return { error: `Unknown template: "${template}". Use minimal, example, or demo.` };
			}
			continue;
		}

		if (arg.startsWith('-')) continue;

		positional.push(arg);
	}

	const name = positional[0];
	if (name !== undefined) {
		if (!VALID_NAME_RE.test(name)) {
			return { error: `Invalid project name: "${name}". Use only letters, numbers, hyphens, and underscores.` };
		}
		if (opts?.dirExists?.(name)) {
			return { error: `Directory "${name}" already exists.` };
		}
	}

	return { name, template };
}
