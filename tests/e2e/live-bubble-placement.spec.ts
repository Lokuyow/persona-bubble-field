import { expect, test, type Page } from '@playwright/test';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { finalizeEvent } from 'nostr-tools/pure';
import { buildWorldMessageTemplate, buildWorldStateEventTemplate } from '../../src/lib/nostrProtocol';
import { CHANNEL_ID, fixtureSecret, openReadyRelayWorld, installVirtualKeyboardStub } from './helpers/relayHarness';


async function readPlacement(page: Page) {
	return page.evaluate(() => {
		const viewport = document.querySelector('.field-viewport')!.getBoundingClientRect();
		const rect = (element: Element) => {
			const r = element.getBoundingClientRect();
			return { x: r.x, y: r.y, width: r.width, height: r.height };
		};
		const intersection = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) =>
			Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
			Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
		const characters = [...document.querySelectorAll('.participant')].map(rect);
		const ui = [...document.querySelectorAll('[data-top-status-hud], [data-field-status-huds], .action-dock')].map(rect);
		return [...document.querySelectorAll<HTMLElement>('.bubble')].map((bubble) => {
			const body = rect(bubble);
			const surface = bubble.dataset.speechType === 'monologue' ? bubble.querySelector('.bubble-surface') : null;
			const footprint = surface ? rect(surface) : body;
			const id = bubble.dataset.bubbleParticipantId;
			const speaker = id ? document.querySelector(`.participant[data-participant-id="${id}"]`) : null;
			const style = getComputedStyle(bubble);
			return { body, speaker: speaker ? rect(speaker) : null, type: bubble.dataset.speechType,
				contained: footprint.x >= viewport.left && footprint.y >= viewport.top &&
					footprint.x + footprint.width <= viewport.right && footprint.y + footprint.height <= viewport.bottom,
				characterOverlap: characters.reduce((sum, character) => sum + intersection(footprint, character), 0),
				uiOverlap: ui.reduce((sum, obstacle) => sum + intersection(footprint, obstacle), 0),
				seam: { x: Number.parseFloat(style.getPropertyValue('--tail-seam-x')), y: Number.parseFloat(style.getPropertyValue('--tail-seam-y')) }
			};
		});
	});
}

test('prefers a 40px body-to-character gap in unobstructed screen space', async ({ page }) => {
	await installHostOwnedStub(page);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/?devWorld=1&devScenario=speech-normal-sizes');
	await expect(page.locator('.bubble')).toHaveCount(3);
	await expect.poll(async () => {
		const short = (await readPlacement(page)).find((bubble) => bubble.body.width < 100);
		if (!short?.speaker) return null;
		return short.speaker.y - short.body.y - short.body.height;
	}).toBeCloseTo(40, 1);
});

for (const width of [1440, 390, 320, 700, 701]) {
	test(`contains live footprints and avoids characters across resize at ${width}px`, async ({ page }) => {
		await installHostOwnedStub(page);
		await page.setViewportSize({ width, height: 900 });
		await page.goto('/?devWorld=1&devScenario=speech-types');
		await expect(page.locator('.bubble')).not.toHaveCount(0);
		const expectPlacement = async () => {
			await expect.poll(async () => {
				const bubbles = await readPlacement(page);
				return bubbles.length > 0 && bubbles.every((bubble) => bubble.contained && bubble.characterOverlap === 0 && bubble.uiOverlap === 0);
			}).toBe(true);
		};
		await expectPlacement();
		await page.setViewportSize({ width, height: 760 });
		await expectPlacement();
		await page.setViewportSize({ width: 900, height: width });
		await expectPlacement();
	});
}

test('uses side and lower positions with seams on the facing body edge', async ({ page }) => {
	await installHostOwnedStub(page);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/?devWorld=1&devScenario=speech-obstacles');
	await expect(page.locator('.bubble')).toHaveCount(2);
	// Cover the free screen space above the field with a measured HUD obstacle.
	await page.locator('[data-field-status-huds]').evaluate((element) => {
		const hud = element as HTMLElement;
		const speaker = document.querySelector('.participant[data-position="4,2"]')!.getBoundingClientRect();
		hud.style.width = `${window.innerWidth}px`;
		hud.style.top = '0px';
		hud.style.left = '0px';
		hud.style.height = `${speaker.y}px`;
	});
	await expect.poll(async () => (await readPlacement(page)).every((bubble) => bubble.uiOverlap === 0)).toBe(true);
	await expect.poll(async () => (await readPlacement(page)).every((bubble) => bubble.contained && bubble.characterOverlap === 0)).toBe(true);
	const bubbles = await readPlacement(page);
	const side = bubbles.find((bubble) => bubble.body.width < 100)!;
	const lower = bubbles.find((bubble) => bubble !== side)!;
	expect(side.speaker).not.toBeNull();
	expect(lower.speaker).not.toBeNull();
	expect(side.body.x + side.body.width <= side.speaker!.x || side.body.x >= side.speaker!.x + side.speaker!.width).toBe(true);
	expect(Math.min(Math.abs(side.seam.x), Math.abs(side.seam.x - side.body.width))).toBeCloseTo(0, 5);
	expect(lower.body.y).toBeGreaterThanOrEqual(lower.speaker!.y + lower.speaker!.height);
	expect(lower.seam.y).toBe(0);
});
// Keep the production projection and animation path; only transport and time are local doubles.
test('minimally corrects a retained offscreen merged anchor for a moving character and Dock', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	// Observe completed footprint corrections independently of the moving path.
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.clock.install({ time: Date.now() });
	await installVirtualKeyboardStub(page);
	await openReadyRelayWorld(page);
	const now = await page.evaluate(() => Date.now());
	await page.clock.pauseAt(now + 1_000);
	const channel = { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' };
	const second = Math.floor((now + 1_000) / 1000);
	const revisions = new Map<number, number>();
	const inject = async (label: number, position: { x: number; y: number }, content?: string) => {
		const revision = (revisions.get(label) ?? 0) + 1;
		revisions.set(label, revision);
		const createdAt = second + revision;
		const event = finalizeEvent(content ? buildWorldMessageTemplate({ channel, createdAt, position, content, speechType: 'normal' }) :
			buildWorldStateEventTemplate({ channel, createdAt, position, slot: 0 }), fixtureSecret(label));
		await page.evaluate(async ({ event, message }) => {
			const relay = (window as unknown as { __relayStartupTest: { injectMessage(event: object): void; injectPosition(event: object): Promise<void> } }).__relayStartupTest;
			if (message) relay.injectMessage(event); else await relay.injectPosition(event);
		}, { event, message: Boolean(content) });
		await page.clock.runFor(500);
		return event;
	};
	const [selfX, selfY] = (await page.locator('.participant[data-self="true"]').getAttribute('data-position'))!.split(',').map(Number);
	// Leave a visible logical row above the held body for the approaching character.
	const memberPosition = { x: selfX, y: Math.max(2, selfY) };
	await inject(20, memberPosition);
	await inject(21, memberPosition);
	await inject(20, memberPosition, 'retained anchor');
	await inject(21, memberPosition, 'retained anchor');
	const bubble = page.locator('.bubble-merged');
	await expect(bubble).toBeVisible();
	const offscreenPosition = { x: selfX < 8 ? 15 : 0, y: selfY };
	await inject(20, offscreenPosition);
	await inject(21, offscreenPosition);
	await expect(bubble.locator('.bubble-tail-connection')).toHaveCount(0);
	const held = (await bubble.boundingBox())!;
	const geometry = await page.locator('.field-grid').evaluate((element) => {
		const grid = element.getBoundingClientRect();
		const cell = document.querySelector('.participant')!.getBoundingClientRect().width;
		return { x: grid.x, y: grid.y, cell };
	});
	const cell = { x: Math.floor((held.x + held.width / 2 - geometry.x) / geometry.cell),
		y: Math.floor((held.y + held.height / 2 - geometry.y) / geometry.cell) };
	await inject(19, cell);
	await expect.poll(async () => (await readPlacement(page)).find((item) => item.body.width === held.width)?.characterOverlap).toBe(0);
	const corrected = (await bubble.boundingBox())!;
	expect(corrected).not.toEqual(held);
	// One approaching cell requires a nearby edge correction, not a fresh far-off speaker placement.
	expect(Math.hypot(corrected.x - held.x, corrected.y - held.y)).toBeLessThanOrEqual(geometry.cell + held.height);
	await inject(19, offscreenPosition);
	expect(await bubble.boundingBox()).toEqual(corrected);
	const fieldBefore = await page.locator('.field-area').boundingBox();
	const selfBefore = await page.locator('.participant[data-self="true"]').boundingBox();
	await page.evaluate(() => (window as unknown as { __virtualKeyboardTest: { setBottomInset(value: number): void } }).__virtualKeyboardTest.setBottomInset(400));
	await page.clock.runFor(100);
	await expect.poll(async () => (await readPlacement(page)).every((item) => item.contained && item.uiOverlap === 0 && item.characterOverlap === 0)).toBe(true);
	expect(await page.locator('.field-area').boundingBox()).toEqual(fieldBefore);
	expect(await page.locator('.participant[data-self="true"]').boundingBox()).toEqual(selfBefore);
	await page.setViewportSize({ width: 320, height: 700 });
	await page.clock.runFor(100);
	await expect.poll(async () => (await readPlacement(page)).every((item) => item.contained && item.uiOverlap === 0)).toBe(true);
});
