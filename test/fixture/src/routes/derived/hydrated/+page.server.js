export async function load({ platform }) {
	const { hydratedStats } = await import('$live/derived');
	return { stats: await hydratedStats.load(platform) };
}
