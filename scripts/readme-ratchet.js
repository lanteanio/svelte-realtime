import { execFileSync } from 'node:child_process';

const path = 'docs/documentation.v1.json';
const records = manifest => manifest?.readmeGrowth ?? [];

export function validateGrowthRecords(manifest) {
	if (!Object.hasOwn(manifest, 'readmeGrowth')) return [];
	if (!Array.isArray(manifest.readmeGrowth)) return ['readmeGrowth must be an array'];
	const failures = [];
	for (const record of manifest.readmeGrowth) {
		if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== 2 || !Number.isInteger(record.from) || !Number.isInteger(record.to) || record.from < 1 || record.to <= record.from) failures.push('README growth records require positive from/to limits with to greater than from');
	}
	return failures;
}

export function validateReadmeGrowth(manifest, baseline) {
	if (!baseline) return [];
	const failures = [...validateGrowthRecords(manifest), ...validateGrowthRecords(baseline)];
	if (Object.hasOwn(baseline, 'readmeGrowth') && !Object.hasOwn(manifest, 'readmeGrowth')) failures.push('Committed README growth records cannot be edited or removed');
	if (failures.length) return failures;
	const current = records(manifest), previous = records(baseline);
	if (current.length < previous.length || previous.some((record, index) => record.from !== current[index]?.from || record.to !== current[index]?.to)) failures.push('Committed README growth records cannot be edited or removed');
	const added = current.slice(previous.length);
	if (manifest.readmeMaxLines > baseline.readmeMaxLines) {
		if (added.length !== 1 || added[0].from !== baseline.readmeMaxLines || added[0].to !== manifest.readmeMaxLines) failures.push('Increasing the committed limit requires an accepted README growth record; run npm run generate:documentation -- --accept-readme-growth for an intentional reviewed increase');
	} else if (added.length) failures.push('A README growth record must describe an increase above the committed limit');
	return failures;
}

export function readReadmeBaselines(directory) {
	const options = { cwd: directory, encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
	const git = (...args) => execFileSync('git', args, options);
	if (git('rev-parse', '--is-shallow-repository').trim() === 'true') throw new Error('README growth validation requires full Git history; fetch with --unshallow');
	const commits = git('log', '--first-parent', '--format=%H', '--', path).trim().split(/\r?\n/).filter(Boolean);
	const refs = ['HEAD', ...commits].map(commit => commit + ':' + path);
	const output = execFileSync('git', ['cat-file', '--batch'], { ...options, encoding: undefined, input: refs.join('\n') + '\n' });
	let offset = 0;
	const manifests = refs.map(() => {
		const end = output.indexOf(10, offset);
		const match = /^\S+ blob (\d+)$/.exec(output.subarray(offset, end).toString('utf8'));
		if (!match) throw new Error('Cannot read committed README growth history');
		const size = Number(match[1]);
		offset = end + 1;
		const manifest = JSON.parse(output.subarray(offset, offset + size).toString('utf8'));
		offset += size + 1;
		return manifest;
	});
	return { head: manifests[0], history: manifests.slice(1) };
}

export function resizeReadmeManifest(manifest, baseline, lines, acceptGrowth) {
	const grows = lines > baseline.readmeMaxLines;
	if (grows && !acceptGrowth && (manifest.readmeMaxLines !== lines || validateReadmeGrowth(manifest, baseline).length)) throw new Error('Increasing the committed limit requires an accepted README growth record; pass --accept-readme-growth with --write');
	return {
		...manifest,
		readmeMaxLines: lines,
		readmeGrowth: [...records(baseline), ...(grows ? [{ from: baseline.readmeMaxLines, to: lines }] : [])]
	};
}
