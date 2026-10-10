import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Match the actual files so entry guards work through directory links and aliases. */
export function isScriptEntry(moduleUrl, invokedPath = process.argv[1]) {
	if (!invokedPath) return false;
	try {
		const invoked = realpathSync(invokedPath);
		const current = realpathSync(fileURLToPath(moduleUrl));
		return process.platform === 'win32'
			? invoked.toLowerCase() === current.toLowerCase()
			: invoked === current;
	} catch {
		return false;
	}
}
