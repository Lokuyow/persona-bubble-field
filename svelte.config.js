import adapter from '@sveltejs/adapter-static';

const basePath = process.env.BASE_PATH ?? '';
const isGitHubPagesBuild = basePath === '/persona-bubble-field';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter({
			fallback: '404.html'
		}),
		paths: {
			base: basePath,
			relative: !isGitHubPagesBuild
		}
	}
};

export default config;
