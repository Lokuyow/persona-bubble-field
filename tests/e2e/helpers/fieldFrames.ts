import type { Page } from '@playwright/test';

type Rect = { x: number; y: number; width: number; height: number };
export type FieldFrame = {
	source: 'frame' | 'mutation';
	visible: boolean;
	scene: Rect;
	viewport: Rect;
	area: Rect;
	composer: Rect | null;
	transform: string;
};

export async function installFieldFrameSampling(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const state = window as typeof window & { __fieldFrames: FieldFrame[] };
		state.__fieldFrames = [];
		const rect = (element: Element): Rect => {
			const { x, y, width, height } = element.getBoundingClientRect();
			return { x, y, width, height };
		};
		const sample = (source: FieldFrame['source']) => {
			const scene = document.querySelector('.field-scene');
			const viewport = document.querySelector('.field-viewport');
			const area = document.querySelector('.field-area');
			if (!scene || !viewport || !area) return;
			const style = getComputedStyle(scene);
			const composer = document.querySelector('.composer-dock');
			state.__fieldFrames.push({ source, visible: style.visibility === 'visible' && style.display !== 'none',
				scene: rect(scene), viewport: rect(viewport), area: rect(area),
				composer: composer ? rect(composer) : null, transform: style.transform });
		};
		const frame = () => { sample('frame'); requestAnimationFrame(frame); };
		requestAnimationFrame(frame);
		new MutationObserver(() => sample('mutation')).observe(document, {
			subtree: true, attributes: true, attributeFilter: ['class', 'style']
		});
	});
}

export async function readFieldFrames(page: Page): Promise<FieldFrame[]> {
	return page.evaluate(() => (window as typeof window & { __fieldFrames: FieldFrame[] }).__fieldFrames);
}

// Two rendering opportunities ensure the last DOM update has a frame sample.
export async function sampleRenderedField(page: Page): Promise<FieldFrame[]> {
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
	return readFieldFrames(page);
}
