import { expect, test } from '@playwright/test';
import {
	WORLD_STATE_KIND
} from '../../src/lib/nostrProtocol';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { AUTHORITATIVE_RELAYS, traceRuntimeEvents, installDelayedRelay, relayState, relayFieldCellCenter, pauseAtCurrentBrowserTime, seedRelayAccount } from './helpers/relayHarness';




test.describe('Relay startup', () => {
	test('presents accepted Relay direct replies and preserves cached presentation across refresh', async ({ page }) => {
		const trace = traceRuntimeEvents();
		await installHostOwnedStub(page);
		await installDelayedRelay(page, {
			deferPrimaryEvents: true,
			primaryEvents: { message: trace.message, position: trace.selfPosition },
			traceRoots: [trace.root],
			traceReplies: [trace.direct, trace.selfDirect, trace.deeper, trace.greatGrandchild, trace.invalid],
			deferTraceRoots: true,
			deferTraceReplies: true
		});
		await seedRelayAccount(page, trace.selfSecret, trace.selfPubkey);
		await page.goto('/');
		const hideTimeline = page.locator('.chatter-toggle');
		await hideTimeline.click();

		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releaseMetadata(): void }
		}).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => {
			const requests = (await relayState(page)).state.requests;
			return [42, WORLD_STATE_KIND].every((kind) => requests.some((request) =>
				AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
				(request.filter.kinds as number[])[0] === kind && request.filter.limit !== 1000
			));
		}).toBe(true);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releasePrimaryEvents(): void; releasePrimary(): void }
		}).__relayStartupTest.releasePrimaryEvents());
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releasePrimary(): void }
		}).__relayStartupTest.releasePrimary());
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			(request.filter.kinds as number[] | undefined)?.includes(42) && request.filter.limit === 1000
		)).toBe(true);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releaseTraceRoots(): void }
		}).__relayStartupTest.releaseTraceRoots());
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toBeVisible();

		await page.locator('[data-cell-position="4,2"]').click();
		await expect(page.locator(`[data-trace-root-id="${trace.root.id}"]`)).toContainText('Relay trace root');
		await expect(page.locator('.trace-reply-status')).toHaveCount(0);
		await expect(page.getByText('Relay direct reply')).toHaveCount(0);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releaseTraceReplies(): void }
		}).__relayStartupTest.releaseTraceReplies());
		await expect(page.locator(`[data-trace-reply-id="${trace.direct.id}"]`)).toContainText('Relay direct reply');
		const selfReplyBubble = page.locator(`[data-trace-reply-id="${trace.selfDirect.id}"]`);
		await expect(selfReplyBubble).toContainText('Relay own direct reply');
		await expect(page.locator(`[data-trace-reply-ghost-id="${trace.selfDirect.id}"]`)).toHaveCount(0);
		await expect(page.locator(`[data-trace-tail-reply-id]`)).toHaveCount(0);
		const publishedPositionIds = async () => new Set(
			(await relayState(page)).state.published.filter((event) => event.kind === WORLD_STATE_KIND).map((event) => event.id)
		).size;
		const positionsBeforeCurrentSwitch = await publishedPositionIds();
		await page.clock.install({ time: Date.now() });
		await pauseAtCurrentBrowserTime(page);
		const now = await page.evaluate(() => Date.now());
		await page.clock.setFixedTime(Math.floor(now / 1000) * 1000 + 1000);
		await page.evaluate(() => {
			(window as typeof window & {
				__relayStartupTest: { state: { deferPositionPublishes: boolean } }
			}).__relayStartupTest.state.deferPositionPublishes = true;
		});
		await selfReplyBubble.locator('.trace-reply-content-button').click();
		await expect(page.locator(`[data-trace-current-reply-id="${trace.selfDirect.id}"]`)).toContainText('Relay own direct reply');
		await expect(page.getByText('Relay deeper branch reply')).toHaveCount(0);
		await expect(page.getByText('Relay invalid reply')).toHaveCount(0);
		await expect(page.locator('.trace-reply-status')).toHaveCount(0);
		await expect.poll(publishedPositionIds).toBe(positionsBeforeCurrentSwitch + 1);
		await page.locator(`[data-trace-root-id="${trace.root.id}"]`).click();
		await expect(page.locator(`[data-trace-root-id="${trace.root.id}"]`)).toHaveAttribute('data-trace-current-kind', 'root');
		await expect(page.locator(`[data-trace-current-reply-id="${trace.selfDirect.id}"]`)).toHaveCount(0);
		await expect(page.getByLabel('Reply preview', { exact: true })).toContainText('Relay trace root');
		await expect.poll(publishedPositionIds).toBe(positionsBeforeCurrentSwitch + 1);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releasePublishes(kind: number): void }
		}).__relayStartupTest.releasePublishes(30079));

		await page.evaluate((event) => (window as typeof window & {
			__relayStartupTest: { injectTraceReply(event: object): void }
		}).__relayStartupTest.injectTraceReply(event), trace.live);
		await expect(page.locator(`[data-trace-reply-id="${trace.live.id}"]`)).toContainText('Relay live direct reply');

		const replyRequestCount = async () => (await relayState(page)).state.requests.filter((request) =>
			request.filters.some((filter) => (filter.kinds as number[] | undefined)?.includes(1111))
		).length;
		const requestsBeforeReopen = await replyRequestCount();
		if (await hideTimeline.isVisible()) await hideTimeline.click();
		const blankCell = await relayFieldCellCenter(page, { x: 3, y: 4 });
		await page.mouse.click(blankCell.x, blankCell.y);
		await expect(page.locator('[data-trace-reply-id]')).toHaveCount(0);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { deferTraceReplies(): void }
		}).__relayStartupTest.deferTraceReplies());
		await page.locator('[data-cell-position="4,2"]').click();
		await expect(page.locator(`[data-trace-reply-id="${trace.direct.id}"]`)).toContainText('Relay direct reply');
		await expect(page.locator(`[data-trace-reply-id="${trace.live.id}"]`)).toContainText('Relay live direct reply');
		await expect(page.locator('.trace-reply-status')).toHaveCount(0);
		await expect.poll(replyRequestCount).toBeGreaterThan(requestsBeforeReopen);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releaseTraceReplies(): void }
		}).__relayStartupTest.releaseTraceReplies());
		await expect(page.locator('.trace-reply-status')).toHaveCount(0);
		await expect(page.locator(`[data-trace-reply-id="${trace.direct.id}"]`)).toBeVisible();
		const activeReplyCountBeforeCurrentSwitch = await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { activeTraceReplyCount(): number }
		}).__relayStartupTest.activeTraceReplyCount());
		expect(activeReplyCountBeforeCurrentSwitch).toBeGreaterThan(0);

		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { deferTraceReplies(): void }
		}).__relayStartupTest.deferTraceReplies());
		await page.locator(`[data-trace-reply-id="${trace.direct.id}"]`).locator('.trace-reply-content-button').click();
		await expect(page.locator(`[data-trace-current-reply-id="${trace.direct.id}"]`)).toContainText('Relay direct reply');
		await expect(page.locator(`[data-trace-root-id="${trace.root.id}"]`)).toContainText('Relay trace root');
		await expect(page.locator(`[data-trace-reply-id="${trace.deeper.id}"]`)).toContainText('Relay deeper branch reply');
		await expect(page.locator(`[data-trace-reply-id="${trace.selfDirect.id}"]`)).toHaveCount(0);
		await expect(page.locator(`[data-trace-reply-id="${trace.live.id}"]`)).toHaveCount(0);
		await expect(page.locator('.trace-reply-status')).toHaveCount(0);
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			request.filters.some((filter) =>
				(filter.kinds as number[] | undefined)?.includes(1111) &&
				(filter['#E'] as string[] | undefined)?.includes(trace.root.id) &&
				!('#e' in filter)
			) && request.filters.some((filter) =>
				(filter.kinds as number[] | undefined)?.includes(1111) &&
				!('#E' in filter) &&
				(filter['#e'] as string[] | undefined)?.includes(trace.direct.id)
			)
		)).toBe(true);
		await expect.poll(() => page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { activeTraceReplyCount(): number }
		}).__relayStartupTest.activeTraceReplyCount())).toBe(activeReplyCountBeforeCurrentSwitch);

		await page.evaluate((event) => (window as typeof window & {
			__relayStartupTest: { injectClosedTraceReply(event: object): void }
		}).__relayStartupTest.injectClosedTraceReply(event), trace.staleOldGeneration);
		await expect(page.getByText('Relay stale old-generation child')).toHaveCount(0);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releaseTraceReplies(): void }
		}).__relayStartupTest.releaseTraceReplies());
		await expect(page.locator('.trace-reply-status')).toHaveCount(0);
		await page.evaluate((event) => (window as typeof window & {
			__relayStartupTest: { injectTraceReply(event: object): void }
		}).__relayStartupTest.injectTraceReply(event), trace.currentLive);
		await expect(page.locator(`[data-trace-reply-id="${trace.currentLive.id}"]`)).toContainText('Relay live current child');

		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { deferTraceReplies(): void }
		}).__relayStartupTest.deferTraceReplies());
		await page.locator(`[data-trace-reply-id="${trace.deeper.id}"]`).locator('.trace-reply-content-button').click();
		await expect(page.locator(`[data-trace-current-reply-id="${trace.deeper.id}"]`)).toContainText('Relay deeper branch reply');
		await expect(page.locator(`[data-trace-parent-id="${trace.direct.id}"]`)).toContainText('Relay direct reply');
		await expect(page.locator(`[data-trace-reply-id="${trace.greatGrandchild.id}"]`)).toContainText('Relay great-grandchild reply');
		await expect(page.locator(`[data-trace-reply-id="${trace.currentLive.id}"]`)).toHaveCount(0);
		await expect(page.locator('.trace-reply-status')).toHaveCount(0);
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			request.filters.some((filter) =>
				(filter['#e'] as string[] | undefined)?.includes(trace.deeper.id)
			)
		)).toBe(true);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releaseTraceReplies(): void }
		}).__relayStartupTest.releaseTraceReplies());
		await expect(page.locator('.trace-reply-status')).toHaveCount(0);
		await page.locator(`[data-trace-parent-id="${trace.direct.id}"]`).locator('.trace-reply-content-button').click();
		await expect(page.locator(`[data-trace-current-reply-id="${trace.direct.id}"]`)).toBeVisible();
		await expect(page.locator(`[data-trace-reply-id="${trace.deeper.id}"]`)).toBeVisible();
	});
});
