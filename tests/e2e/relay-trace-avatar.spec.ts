import { expect, test } from '@playwright/test';
import { finalizeEvent } from 'nostr-tools/pure';
import { buildWorldMessageTemplate, WORLD_STATE_KIND } from '../../src/lib/nostrProtocol';
import { requireWorldCharacterFromPubkey } from '../../src/lib/worldCharacterAssignment';
import {
	CHANNEL_ID,
	AUTHORITATIVE_RELAYS,
	fixtureSecret,
	installDelayedRelay,
	relayState,
	seedRelayAccount,
	selectRelayTraceCell,
	traceRuntimeEvents
} from './helpers/relayHarness';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';

function createSecondRoot(position: { x: number; y: number }) {
	const channel = { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' };
	const secret = fixtureSecret(31);
	const createdAt = Math.floor(Date.now() / 1000);
	let root = finalizeEvent(buildWorldMessageTemplate({
		channel,
		content: 'second avatar root 0',
		speechType: 'normal',
		position,
		createdAt
	}), secret);
	for (let attempt = 1; BigInt(`0x${root.id}`) % 5n !== 0n; attempt += 1) {
		root = finalizeEvent(buildWorldMessageTemplate({
			channel,
			content: `second avatar root ${attempt}`,
			speechType: 'normal',
			position,
			createdAt
		}), secret);
	}
	return root;
}

test('switches Trace root avatars only after that image loads and keeps failures neutral', async ({ page }) => {
	const trace = traceRuntimeEvents();
	const secondRoot = createSecondRoot({ x: 4, y: 3 });
	const firstCharacter = requireWorldCharacterFromPubkey(trace.root.pubkey);
	const secondCharacter = requireWorldCharacterFromPubkey(secondRoot.pubkey);
	expect(secondCharacter.characterId).not.toBe(firstCharacter.characterId);

	await installHostOwnedStub(page);
	await installDelayedRelay(page, {
		deferPrimaryEvents: true,
		primaryEvents: { message: trace.message, position: trace.selfPosition },
		traceRoots: [trace.root, secondRoot],
		deferTraceRoots: true
	});
	await seedRelayAccount(page, trace.selfSecret, trace.selfPubkey);
	await page.goto('/');
	await page.locator('.chatter-toggle').click();
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
	await page.evaluate(() => (window as typeof window & {
		__relayStartupTest: { releaseTraceRoots(): void }
	}).__relayStartupTest.releaseTraceRoots());
	await expect(page.locator('[data-trace-marker-position="4,2"]')).toBeVisible();
	await expect(page.locator('[data-trace-marker-position="4,3"]')).toBeVisible();

	let releaseSecondImage!: () => void;
	const secondImageGate = new Promise<void>((resolve) => { releaseSecondImage = resolve; });
	let secondImageWasRequested = false;
	let failSecondImage = false;
	const secondImageRoute = `**/${secondCharacter.picture}`;
	await page.route(secondImageRoute, async (route) => {
		secondImageWasRequested = true;
		await secondImageGate;
		if (failSecondImage) await route.abort();
		else await route.continue();
	});

	await selectRelayTraceCell(page, '4,2');
	const firstGhost = page.locator(`[data-trace-ghost-root-id="${trace.root.id}"]`);
	const firstAvatar = firstGhost.locator('.avatar');
	const firstTrigger = firstGhost.locator('.trace-ghost-profile-trigger');
	await expect(firstGhost.locator('.trace-ghost-name')).toHaveText(firstCharacter.name);
	await expect(firstAvatar).toHaveAttribute('data-status', 'loaded');
	await expect.poll(
		() => firstTrigger.evaluate((trigger) => getComputedStyle(trigger).animationName),
		{ timeout: 3_000 }
	).not.toBe('none');
	await expect(firstAvatar.locator('img')).toHaveCSS('animation-name', 'none');
	await expect.poll(() => firstAvatar.locator('img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

	await selectRelayTraceCell(page, '4,3');
	await expect.poll(() => secondImageWasRequested, { timeout: 3_000 }).toBe(true);
	const secondGhost = page.locator(`[data-trace-ghost-root-id="${secondRoot.id}"]`);
	const secondAvatar = secondGhost.locator('.avatar');
	const secondImage = secondAvatar.locator('img');
	const secondTrigger = secondGhost.locator('.trace-ghost-profile-trigger');
	const secondName = secondGhost.locator('.trace-ghost-name');
	await expect(secondName).toHaveText(secondCharacter.name);
	await expect(page.locator(`[data-trace-ghost-root-id="${trace.root.id}"]`)).toHaveCount(0);
	await expect(secondAvatar).toHaveAttribute('data-status', 'loading');
	await expect.poll(() => secondImage.getAttribute('src')).toContain(secondCharacter.picture);
	await expect(secondImage).toHaveCSS('display', 'none');
	await expect(secondAvatar.locator('[data-avatar-fallback]')).toHaveText('');
	await expect(secondImage).toHaveJSProperty('naturalWidth', 0);
	await expect(secondTrigger).toHaveCSS('visibility', 'hidden');
	await expect(secondAvatar).toHaveCSS('visibility', 'hidden');
	await expect(secondName).toHaveCSS('visibility', 'hidden');

	failSecondImage = true;
	releaseSecondImage();
	await expect(secondAvatar).toHaveAttribute('data-status', 'error');
	await expect(secondImage).toHaveCSS('display', 'none');
	await expect(secondAvatar.locator('[data-avatar-fallback]')).toHaveText('');
	await expect(secondTrigger).toHaveCSS('visibility', 'visible');
	await expect(secondName).toHaveCSS('visibility', 'visible');
	await expect.poll(() => secondTrigger.evaluate((trigger) => getComputedStyle(trigger).animationName)).not.toBe('none');

	failSecondImage = false;
	await selectRelayTraceCell(page, '4,2');
	await expect(page.locator(`[data-trace-ghost-root-id="${trace.root.id}"] .avatar`)).toHaveAttribute('data-status', 'loaded');
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await selectRelayTraceCell(page, '4,3');
	await expect(secondAvatar).toHaveAttribute('data-status', 'loaded');
	await expect.poll(() => secondImage.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
	await expect(secondTrigger).toHaveCSS('visibility', 'visible');
	await expect(secondName).toHaveCSS('visibility', 'visible');
	await expect(secondImage).toHaveCSS('animation-name', 'none');
	await expect(secondTrigger).toHaveCSS('animation-name', 'none');

	await selectRelayTraceCell(page, '4,2');
	await selectRelayTraceCell(page, '4,3');
	await expect(secondAvatar).toHaveAttribute('data-status', 'loaded');
	await page.unroute(secondImageRoute);
});
