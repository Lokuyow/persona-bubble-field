import { expect, test } from '@playwright/test';
import { ADJUSTMENT_TERMINAL, MENDING_TERMINAL } from '../../src/lib/fieldFacilities';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { traceRuntimeEvents, installDelayedRelay, seedRelayAccount } from './helpers/relayHarness';

test.describe('Relay startup', () => {
	test('suppresses Trace presentation and investigation on fixed facility cells', async ({ page }) => {
		const mendingTrace = traceRuntimeEvents(MENDING_TERMINAL.position);
		const adjustmentTrace = traceRuntimeEvents(ADJUSTMENT_TERMINAL.position);
		const ordinaryTrace = traceRuntimeEvents();
		await page.clock.setFixedTime(Date.now());
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize({ width: 1100, height: 850 });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, {
			primaryEvents: { message: ordinaryTrace.message, position: ordinaryTrace.selfPosition },
			traceRoots: [mendingTrace.root, adjustmentTrace.root, ordinaryTrace.root]
		});
		await seedRelayAccount(page, ordinaryTrace.selfSecret, ordinaryTrace.selfPubkey);
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});

		await expect(page.locator('[data-trace-marker-position="12,3"]')).toHaveCount(0);
		await expect(page.locator('[data-trace-marker-position="14,3"]')).toHaveCount(0);
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toBeVisible();
		await expect(page.locator('[data-cell-position="12,3"][aria-label*="痕跡"]')).toHaveCount(0);
		await expect(page.locator('[data-cell-position="14,3"][aria-label*="痕跡"]')).toHaveCount(0);
		await expect(page.locator('[data-cell-position="4,2"][aria-label*="痕跡"]')).toHaveCount(1);
		await expect(page.locator('[data-cell-position="12,3"][aria-label="作業端末"]')).toHaveCount(1);
		await expect(page.locator('[data-cell-position="14,3"][aria-label="能力強化端末"]')).toHaveCount(1);

		await page.locator('[data-cell-position="12,3"][aria-label="作業端末"]').click();
		await expect(page.locator('.trace-proximity-feedback')).toContainText('近づくと端末を使える');
		await expect(page.locator('[data-field-action-menu]')).toHaveCount(0);
	});
});
