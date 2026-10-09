import { engine } from 'animejs/engine';
import { createScope } from 'animejs/scope';
import type { Scope } from 'animejs/scope';

const REDUCED_MOTION_MEDIA_QUERY = '(prefers-reduced-motion: reduce)';

engine.pauseOnDocumentHidden = false;

export function createPresentationScope(root: HTMLElement): Scope {
	return createScope({
		root,
		mediaQueries: { reducedMotion: REDUCED_MOTION_MEDIA_QUERY }
	});
}
