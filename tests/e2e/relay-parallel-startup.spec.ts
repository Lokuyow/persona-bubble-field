import { expect, test, type Page } from '@playwright/test';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { buildWorldStateEventTemplate, WORLD_STATE_KIND } from '../../src/lib/nostrProtocol';
import {
	AUTHORITATIVE_RELAYS, CHANNEL_ID, fixtureSecret, installDelayedRelay, isRealtimeRequest, relayState,
	requestKind, seedRelayAccount, testEvents
} from './helpers/relayHarness';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';

async function holdRootDecryption(page: Page) {
	await page.addInitScript(() => {
		const pending: Array<() => void> = [];
		let released = sessionStorage.getItem('root-decrypt-barrier-released') === 'true';
		const decrypt = SubtleCrypto.prototype.decrypt;
		SubtleCrypto.prototype.decrypt = function (...args) {
			if (released) return decrypt.apply(this, args);
			return new Promise<ArrayBuffer>((resolve, reject) => {
				pending.push(() => { void decrypt.apply(this, args).then(resolve, reject); });
			});
		};
		Object.assign(window, { __rootDecryptBarrier: { release: () => {
			released = true;
			sessionStorage.setItem('root-decrypt-barrier-released', 'true');
			pending.splice(0).forEach((resume) => resume());
		} } });
	});
}

async function releaseRootDecryption(page: Page) {
	await page.evaluate(() => (window as typeof window & { __rootDecryptBarrier: { release(): void } }).__rootDecryptBarrier.release());
}

async function waitForPrimary(page: Page) {
	await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
		AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
		[42, WORLD_STATE_KIND].includes(requestKind(request)!))).toBe(true);
}

test('starts world read before restored Root decryption and writes self only after restoration', async ({ page }) => {
	const secret = fixtureSecret(23);
	const selfPubkey = getPublicKey(secret);
	const events = testEvents();
	await installHostOwnedStub(page);
	await installDelayedRelay(page, { primaryEvents: events, deferPrimaryEvents: true, deferTraceRoots: true });
	await seedRelayAccount(page, secret, selfPubkey);
	await holdRootDecryption(page);
	await page.goto('/');
	await expect.poll(async () => (await relayState(page)).state.requests.filter((request) => [40, 41].includes(requestKind(request)!)).length).toBe(8);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
	await waitForPrimary(page);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimaryEvents(): void } }).__relayStartupTest.releasePrimaryEvents());
	await expect(page.locator(`.participant[data-participant-id="${events.position.pubkey}"]`)).toBeVisible();
	expect((await relayState(page)).state.published.filter((event) => event.pubkey === selfPubkey)).toHaveLength(0);
	expect((await relayState(page)).state.requests.filter(isRealtimeRequest)).toHaveLength(0);
	await releaseRootDecryption(page);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toBeVisible();
	await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === WORLD_STATE_KIND && event.pubkey === selfPubkey)).toBe(true);
	expect((await relayState(page)).state.requests.filter((request) => [40, 41].includes(requestKind(request)!))).toHaveLength(8);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseTraceRoots(): void } }).__relayStartupTest.releaseTraceRoots());
	await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).length).toBeGreaterThan(0);
});

test('keeps a queued Composer submission until the anonymous reader becomes the persona writer', async ({ page }) => {
	const secret = fixtureSecret(23);
	const selfPubkey = getPublicKey(secret);
	await installHostOwnedStub(page);
	await seedRelayAccount(page, secret, selfPubkey);
	const events = testEvents();
	const selfPosition = finalizeEvent(buildWorldStateEventTemplate({
		channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' },
		position: { x: 7, y: 3 }, slot: 0, createdAt: Math.floor(Date.now() / 1000)
	}), secret);
	await installDelayedRelay(page, { primaryEvents: { message: events.message, position: selfPosition }, deferPrimaryEvents: true });
	await holdRootDecryption(page);
	await page.goto('/');
	await expect.poll(async () => (await relayState(page)).state.requests.filter((request) => [40, 41].includes(requestKind(request)!)).length).toBe(8);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
	await waitForPrimary(page);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimaryEvents(): void } }).__relayStartupTest.releasePrimaryEvents());
	await expect(page.locator(`.participant[data-participant-id="${selfPubkey}"]`)).toBeVisible();
	const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
	await editor.fill('queued for owned writer');
	await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	expect((await relayState(page)).state.published.filter((event) => event.pubkey === selfPubkey)).toHaveLength(0);
	await releaseRootDecryption(page);
	await expect.poll(async () => new Set((await relayState(page)).state.published.filter((event) =>
		event.kind === 42 && event.pubkey === selfPubkey && event.content === 'queued for owned writer').map((event) => event.id)).size).toBe(1);
});

test('keeps pre-geometry evidence until measured layout can reveal one participant', async ({ page }) => {
	const events = testEvents();
	await page.addInitScript(() => {
		let released = false;
		const measure = Element.prototype.getBoundingClientRect;
		Element.prototype.getBoundingClientRect = function () {
			if (!released && this.classList.contains('field-viewport')) return new DOMRect(0, 0, 0, 0);
			return measure.call(this);
		};
		Object.assign(window, { __geometryBarrier: { release: () => { released = true; } } });
	});
	await installHostOwnedStub(page);
	await installDelayedRelay(page, { primaryEvents: events, deferPrimaryEvents: true });
	await page.goto('/');
	await expect.poll(async () => (await relayState(page)).state.requests.filter((request) => [40, 41].includes(requestKind(request)!)).length).toBe(8);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
	await waitForPrimary(page);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimaryEvents(): void } }).__relayStartupTest.releasePrimaryEvents());
	await expect(page.locator('.field-viewport.initial-field-geometry-ready')).toHaveCount(0);
	await expect(page.locator(`.participant[data-participant-id="${events.position.pubkey}"]`)).toHaveCount(1);
	const requestsBeforeGeometry = (await relayState(page)).state.requests.filter((request) => [40, 41, 42, WORLD_STATE_KIND].includes(requestKind(request)!)).length;
	await page.evaluate(() => (window as typeof window & { __geometryBarrier: { release(): void } }).__geometryBarrier.release());
	await page.setViewportSize({ width: 1279, height: 720 });
	await expect(page.locator('.field-viewport.initial-field-geometry-ready')).toBeVisible();
	await expect(page.locator(`.participant[data-participant-id="${events.position.pubkey}"]`)).toBeVisible();
	await expect(page.locator(`.participant[data-participant-id="${events.position.pubkey}"]`)).toHaveCount(1);
	const layout = await page.locator(`.participant[data-participant-id="${events.position.pubkey}"]`).evaluate((element) => {
		const bounds = element.getBoundingClientRect();
		return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height };
	});
	expect(Object.values(layout).every(Number.isFinite)).toBe(true);
	expect(layout.right).toBeGreaterThan(0);
	expect(layout.bottom).toBeGreaterThan(0);
	expect(layout.left).toBeLessThan(1279);
	expect(layout.top).toBeLessThan(720);
	expect((await relayState(page)).state.requests.filter((request) => [40, 41, 42, WORLD_STATE_KIND].includes(requestKind(request)!))).toHaveLength(requestsBeforeGeometry);
});

test('clears failed early anonymous attempt when restored persona falls back to signed startup', async ({ page }) => {
	const secret = fixtureSecret(23);
	const selfPubkey = getPublicKey(secret);
	await installHostOwnedStub(page);
	await installDelayedRelay(page);
	await seedRelayAccount(page, secret, selfPubkey);
	await holdRootDecryption(page);
	await page.goto('/');
	await expect.poll(async () => (await relayState(page)).state.requests.filter((request) => [40, 41].includes(requestKind(request)!)).length).toBe(8);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { failMetadataDiscovery(): void } }).__relayStartupTest.failMetadataDiscovery());
	await releaseRootDecryption(page);
	await expect.poll(async () => (await relayState(page)).state.requests.filter((request) => [40, 41].includes(requestKind(request)!)).length).toBeGreaterThan(8);
	await page.evaluate(() => {
		const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
		relay.releaseMetadata(); relay.releasePrimary();
	});
	await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toBeVisible();
	const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
	await editor.fill('signed startup recovered');
	await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
	await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 42 && event.pubkey === selfPubkey && event.content === 'signed startup recovered')).toBe(true);
});

test('does not use the early reader for an already expired persona terminal exit', async ({ page }) => {
	const secret = fixtureSecret(23);
	const selfPubkey = getPublicKey(secret);
	await installHostOwnedStub(page);
	await installDelayedRelay(page, { persistAcrossReload: true });
	await seedRelayAccount(page, secret, selfPubkey, Date.now() - 1000);
	await holdRootDecryption(page);
	await page.goto('/');
	await expect.poll(async () => (await relayState(page)).state.requests.filter((request) => [40, 41].includes(requestKind(request)!)).length).toBe(8);
	await page.evaluate(() => {
		const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
		relay.releaseMetadata(); relay.releasePrimary();
	});
	await waitForPrimary(page);
	await releaseRootDecryption(page);
	await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
	const published = await page.evaluate(() => {
		const state = (window as typeof window & { __relayStartupTest: { state: { published: Array<{ pubkey?: string; kind: number }>; previousPublished: Array<{ pubkey?: string; kind: number }> } } }).__relayStartupTest.state;
		return [...state.published, ...state.previousPublished];
	});
	expect(published.filter((event) => event.pubkey === selfPubkey && event.kind === WORLD_STATE_KIND)).toHaveLength(0);
});
