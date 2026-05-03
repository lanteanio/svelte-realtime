import adapter from 'svelte-adapter-uws';

export default {
	kit: {
		adapter: adapter({
			websocket: { allowedOrigins: '*' }
		})
	}
};
