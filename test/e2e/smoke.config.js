import { defineConfig } from '@playwright/test';
import full from './playwright.config.js';

export default defineConfig({
	...full,
	projects: full.projects.filter((project) => /^multi-page-(dev|prod)$/.test(project.name)),
	grep: /cross-client created: A publishes, B sees$/,
	reporter: 'line'
});
