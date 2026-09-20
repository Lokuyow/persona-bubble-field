export type RunTransitionNotice = 'dead' | 'cleared';

const STORAGE_KEY = 'persona-bubble-field:run-transition-notice:v1';

function isRunTransitionNotice(value: string | null): value is RunTransitionNotice {
	return value === 'dead' || value === 'cleared';
}

export function storeRunTransitionNotice(notice: RunTransitionNotice): void {
	try {
		globalThis.sessionStorage?.setItem(STORAGE_KEY, notice);
	} catch {
		// A presentation hint must never affect the lifecycle transition.
	}
}

export function consumeRunTransitionNotice(): RunTransitionNotice | null {
	try {
		const storage = globalThis.sessionStorage;
		if (!storage) return null;
		const value = storage.getItem(STORAGE_KEY);
		try { storage.removeItem(STORAGE_KEY); } catch { /* best effort */ }
		return isRunTransitionNotice(value) ? value : null;
	} catch {
		return null;
	}
}
