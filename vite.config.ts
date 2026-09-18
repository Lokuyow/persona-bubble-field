import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import Icons from 'unplugin-icons/vite';
import { FileSystemIconLoader } from 'unplugin-icons/loaders';

export default defineConfig({
	plugins: [sveltekit(), Icons({
		compiler: 'svelte',
		customCollections: {
			hako: FileSystemIconLoader('./src/lib/icons/hako')
		}
	})]
});
