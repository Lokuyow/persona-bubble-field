import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { build } from 'vite';

const PAGES_BASE_PATH = '/persona-bubble-field';
const BACKGROUND_ASSET_PATH = `${PAGES_BASE_PATH}/field/prototype-danchi-courtyard.webp`;

process.env.BASE_PATH = PAGES_BASE_PATH;

await build();

const html = (await readFile(new URL('../build/index.html', import.meta.url), 'utf8'))
	.replaceAll('&quot;', '"');

if (!html.includes(`--field-background-image: url("${BACKGROUND_ASSET_PATH}");`)) {
	throw new Error(
		`Pages SSR field background must use the root-relative asset URL ${BACKGROUND_ASSET_PATH}.`
	);
}

if (html.includes('./field/prototype-danchi-courtyard.webp')) {
	throw new Error('Pages SSR field background must not use a stylesheet-relative asset URL.');
}

await access(new URL('../build/field/prototype-danchi-courtyard.webp', import.meta.url), fsConstants.F_OK);
