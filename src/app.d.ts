// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import 'unplugin-icons/types/svelte';

declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		interface PageState {
			profileTarget?: { kind: 'pubkey'; pubkey: string } | { kind: 'dev-character'; characterId: string };
		}
		// interface Platform {}
	}
}

export {};
