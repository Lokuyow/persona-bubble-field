import { expect, test } from '@playwright/test';
import { finalizeEvent } from 'nostr-tools/pure';
import { buildWorldStateEventTemplate } from '../../src/lib/nostrProtocol';
import { finishDialogEntrance, finishDialogExit } from './helpers/dialogMotion';
import { CHANNEL_ID, fixtureSecret, openReadyRelayWorld, readRelayGameState } from './helpers/relayHarness';

for (const scenario of [
	{ width: 1280, height: 800, reducedMotion: 'no-preference' },
	{ width: 390, height: 800, reducedMotion: 'no-preference' },
	{ width: 320, height: 568, reducedMotion: 'no-preference' },
	{ width: 390, height: 800, reducedMotion: 'reduce' }
] as const) {
	test(`keeps work startup readable and dismissible at ${scenario.width}px with ${scenario.reducedMotion} motion`, async ({ page }) => {
		await page.setViewportSize({ width: scenario.width, height: scenario.height });
		await page.emulateMedia({ reducedMotion: scenario.reducedMotion });
		await page.clock.install();
		await openReadyRelayWorld(page, 1);
		const event = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 11, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000) + 1
		}), fixtureSecret(19));
		await page.evaluate((event) => {
			(window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event);
		}, event);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
		const terminal = page.getByRole('button', { name: '作業端末' });
		await terminal.click();
		const dialog = page.getByRole('dialog');
		const feedback = dialog.locator('.mending-startup-feedback');
		await expect(feedback).toContainText('作業を開始しました');
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ mendingJob: expect.any(Object) });
		await finishDialogEntrance(dialog);
		const geometry = await dialog.evaluate((root) => {
			const feedback = root.querySelector<HTMLElement>('.mending-startup-feedback')!;
			const rect = (element: Element) => {
				const { left, right, top, bottom } = element.getBoundingClientRect();
				return { left, right, top, bottom };
			};
			return {
				dialog: rect(root), feedback: rect(feedback), message: rect(feedback.lastElementChild!),
				body: [...root.querySelectorAll('.result-card, .status-group, .action-group')].map(rect),
				header: [...root.querySelectorAll('.mending-dialog-title, .owned-points, button[aria-label="閉じる"]')]
					.filter((element) => element.getClientRects().length > 0).map(rect),
				inHeader: root.querySelector('.terminal-dialog-header')!.contains(feedback),
				scrollWidth: root.scrollWidth, clientWidth: root.clientWidth
			};
		});
		expect(geometry.inHeader).toBe(true);
		expect(geometry.feedback.left).toBeGreaterThanOrEqual(geometry.dialog.left);
		expect(geometry.feedback.right).toBeLessThanOrEqual(geometry.dialog.right);
		expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
		for (const region of geometry.body) expect(geometry.feedback.bottom).toBeLessThanOrEqual(region.top);
		for (const control of geometry.header) {
			expect(geometry.message.right <= control.left || geometry.message.left >= control.right ||
				geometry.message.bottom <= control.top || geometry.message.top >= control.bottom).toBe(true);
		}
		if (scenario.reducedMotion === 'reduce') {
			const moves = await feedback.evaluate((element) => element.getAnimations({ subtree: true }).some((animation) =>
				(animation.effect as KeyframeEffect).getKeyframes().some((frame) => 'transform' in frame || 'strokeDashoffset' in frame)
			));
			expect(moves).toBe(false);
		}
		await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
		await finishDialogExit(dialog, false);
		await expect(terminal).toBeFocused();
		await terminal.click();
		await expect(dialog).toBeVisible();
		await expect(feedback).toHaveCount(0);
	});
}
