import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function resolveNpmCli({ execPath = process.execPath, npmExecPath = process.env.npm_execpath } = {}) {
	const bin = dirname(execPath);
	const candidates = [npmExecPath, join(bin, 'node_modules/npm/bin/npm-cli.js'), join(bin, '../lib/node_modules/npm/bin/npm-cli.js')];
	// Unix distributions also expose npm through a symlink beside node.
	const executable = join(bin, 'npm');
	if (existsSync(executable)) {
		const target = realpathSync(executable);
		if (target.endsWith('npm-cli.js')) candidates.push(target);
	}
	const cli = candidates.find(candidate => candidate && existsSync(candidate));
	if (!cli) throw new Error('Cannot locate npm-cli.js beside Node. Install npm or run this check through npm exec.');
	return cli;
}
