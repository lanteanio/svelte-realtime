import { defineEnvVars } from '@sveltejs/kit/env';
export const variables = defineEnvVars({ KIT_COMPAT_SECRET: { schema: value => value } });
