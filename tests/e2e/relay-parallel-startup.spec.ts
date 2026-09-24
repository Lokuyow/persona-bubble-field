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
	await expect.poll(async () => (await relayState(page)).state.requests.filter((request) =>
		request.filter.limit === undefined && [42, WORLD_STATE_KIND].includes(requestKind(request)!)).length).toBe(10);
}

test('starts fixed-authority world reads before Root decryption and writes self only after restoration', async ({ page }) => {
	const secret = fixtureSecret(23);
	const selfPubkey = getPublicKey(secret);
	const events = testEvents();
	await installHostOwnedStub(page);
	await installDelayedRelay(page, { primaryEvents: events, deferPrimaryEvents: true, deferTraceRoots: true });
	await seedRelayAccount(page, secret, selfPubkey);
	await holdRootDecryption(page);
	await page.goto('/');
	await waitForPrimary(page);
	const requests = (await relayState(page)).state.requests;
	expect(requests.filter((request) => [40, 41].includes(requestKind(request)!))).toHaveLength(0);
	expect(new Set(requests.map((request) => request.url))).toEqual(new Set(AUTHORITATIVE_RELAYS));
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimaryEvents(): void } }).__relayStartupTest.releasePrimaryEvents());
	await expect(page.locator(`.participant[data-participant-id="${events.position.pubkey}"]`)).toBeVisible();
	expect((await relayState(page)).state.published.filter((event) => event.pubkey === selfPubkey)).toHaveLength(0);
	expect((await relayState(page)).state.requests.filter(isRealtimeRequest)).toHaveLength(0);
	await releaseRootDecryption(page);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toBeVisible();
	await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === WORLD_STATE_KIND && event.pubkey === selfPubkey)).toBe(true);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseTraceRoots(): void } }).__relayStartupTest.releaseTraceRoots());
	await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).length).toBeGreaterThan(0);
});

test('writes restored self after three paired EOSEs and keeps late primaries for canonical handoff', async ({ page }) => {
	const secret = fixtureSecret(23);
	const selfPubkey = getPublicKey(secret);
	await page.clock.install({ time: Date.now() });
	await installHostOwnedStub(page);
	await installDelayedRelay(page, { deferTraceRoots: true });
	await seedRelayAccount(page, secret, selfPubkey);
	await page.goto('/');
	await waitForPrimary(page);
	await page.evaluate((urls) => (window as typeof window & {
		__relayStartupTest: { releasePrimaryRelays(urls: string[]): void }
	}).__relayStartupTest.releasePrimaryRelays(urls), AUTHORITATIVE_RELAYS.slice(0, 3));
	await page.clock.runFor(1_100);
	await expect.poll(async () => (await relayState(page)).state.published.some((event) =>
		event.kind === WORLD_STATE_KIND && event.pubkey === selfPubkey)).toBe(true);
	const beforeHandoff = await relayState(page);
	expect(beforeHandoff.state.requests.filter(isRealtimeRequest)).toHaveLength(0);
	expect(beforeHandoff.state.requests.filter((request) => request.filter.limit === 1000)).toHaveLength(0);
	await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toHaveCount(1);
	const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
	await editor.fill('early writer remains usable');
	await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
	await expect.poll(async () => (await relayState(page)).state.published.some((event) =>
		event.kind === 42 && event.pubkey === selfPubkey && event.content === 'early writer remains usable')).toBe(true);
	await page.evaluate(() => (window as typeof window & {
		__relayStartupTest: { releasePrimary(): void; releaseTraceRoots(): void }
	}).__relayStartupTest.releasePrimary());
	await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toHaveCount(1);
	await page.evaluate(() => (window as typeof window & {
		__relayStartupTest: { releaseTraceRoots(): void }
	}).__relayStartupTest.releaseTraceRoots());
	await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).length).toBeGreaterThan(0);
});

test('accepts an early self echo before OK and ignores its later acknowledgements', async ({ page }) => {
	const secret = fixtureSecret(23);
	const selfPubkey = getPublicKey(secret);
	await page.clock.install({ time: Date.now() });
	await installHostOwnedStub(page);
	await installDelayedRelay(page);
	await seedRelayAccount(page, secret, selfPubkey);
	await page.goto('/');
	await waitForPrimary(page);
	await page.evaluate(() => (window as typeof window & {
		__relayStartupTest: { deferPositionPublishes(): void }
	}).__relayStartupTest.deferPositionPublishes());
	await page.evaluate((urls) => (window as typeof window & {
		__relayStartupTest: { releasePrimaryRelays(urls: string[]): void }
	}).__relayStartupTest.releasePrimaryRelays(urls), AUTHORITATIVE_RELAYS.slice(0, 3));
	await page.clock.runFor(1_100);
	await expect.poll(async () => (await relayState(page)).state.published.find((event) =>
		event.kind === WORLD_STATE_KIND && event.pubkey === selfPubkey)).toBeTruthy();
	await page.evaluate((pubkey) => {
		const relay = (window as typeof window & { __relayStartupTest: {
			state: { published: Array<{ kind: number; pubkey?: string }> }; injectPosition(event: object): void
		} }).__relayStartupTest;
		relay.injectPosition(relay.state.published.find((event) => event.kind === 30079 && event.pubkey === pubkey)!);
	}, selfPubkey);
	await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toHaveCount(1);
	await page.evaluate(() => (window as typeof window & {
		__relayStartupTest: { releasePublishes(kind: number): void; releasePrimary(): void }
	}).__relayStartupTest.releasePublishes(30079));
	await page.evaluate(() => (window as typeof window & {
		__relayStartupTest: { releasePrimary(): void }
	}).__relayStartupTest.releasePrimary());
	await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toHaveCount(1);
});

test('uses completed bootstrap self evidence without a fresh-second wait or redundant entry', async ({ page }) => {
	const secret = fixtureSecret(23);
	const selfPubkey = getPublicKey(secret);
	const selfPosition = finalizeEvent(buildWorldStateEventTemplate({
		channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' },
		position: { x: 7, y: 3 }, slot: 0, createdAt: Math.floor(Date.now() / 1000)
	}), secret);
	await page.clock.install({ time: Date.now() });
	await installHostOwnedStub(page);
	await installDelayedRelay(page, { primaryEvents: { ...testEvents(), position: selfPosition } });
	await seedRelayAccount(page, secret, selfPubkey);
	await page.goto('/');
	await waitForPrimary(page);
	await page.evaluate(() => (window as typeof window & {
		__relayStartupTest: { releasePrimary(): void }
	}).__relayStartupTest.releasePrimary());
	await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toBeVisible();
	expect((await relayState(page)).state.published.filter((event) =>
		event.kind === WORLD_STATE_KIND && event.pubkey === selfPubkey)).toHaveLength(0);
});

test('keeps a journal-confirmed self position through late canonical handoff on reload', async ({ page }) => {
	const secret = fixtureSecret(23);
	const selfPubkey = getPublicKey(secret);
	await installHostOwnedStub(page);
	await installDelayedRelay(page, { persistAcrossReload: true });
	await seedRelayAccount(page, secret, selfPubkey);
	await page.goto('/');
	await waitForPrimary(page);
	await page.evaluate(() => (window as typeof window & {
		__relayStartupTest: { releasePrimary(): void }
	}).__relayStartupTest.releasePrimary());
	await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toBeVisible();
	await expect.poll(async () => (await relayState(page)).state.published.some((event) =>
		event.kind === WORLD_STATE_KIND && event.pubkey === selfPubkey)).toBe(true);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await waitForPrimary(page);
	await page.evaluate((urls) => (window as typeof window & {
		__relayStartupTest: { releasePrimaryRelays(urls: string[]): void }
	}).__relayStartupTest.releasePrimaryRelays(urls), AUTHORITATIVE_RELAYS.slice(0, 3));
	await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toBeVisible();
	await page.evaluate(() => (window as typeof window & {
		__relayStartupTest: { releasePrimary(): void }
	}).__relayStartupTest.releasePrimary());
	await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toHaveCount(1);
	expect((await relayState(page)).state.published.filter((event) =>
		event.kind === WORLD_STATE_KIND && event.pubkey === selfPubkey)).toHaveLength(0);
});

test('re-enters a reused Identity after a rejected exit even when its old Relay position is active', async ({ page }) => {
	const secret = fixtureSecret(19);
	const selfPubkey = getPublicKey(secret);
	const oldPosition = finalizeEvent(buildWorldStateEventTemplate({
		channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' },
		position: { x: 7, y: 3 }, slot: 0, createdAt: Math.floor(Date.now() / 1000) - 1
	}), secret);
	await installHostOwnedStub(page);
	await installDelayedRelay(page, { primaryEvents: { ...testEvents(), position: oldPosition }, persistAcrossReload: true });
	await seedRelayAccount(page, secret, selfPubkey, Date.now() + 7 * 24 * 60 * 60 * 1000, 100_000);
	await page.goto('/');
	await waitForPrimary(page);
	await page.evaluate(() => (window as typeof window & {
		__relayStartupTest: { releasePrimary(): void; rejectPositionPublishes(): void }
	}).__relayStartupTest.releasePrimary());
	await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toBeVisible();
	await page.evaluate(() => (window as typeof window & {
		__relayStartupTest: { rejectPositionPublishes(): void }
	}).__relayStartupTest.rejectPositionPublishes());
	await page.getByRole('button', { name: '自分のプロフィールを開く' }).click();
	await page.getByRole('dialog').getByRole('button', { name: '脱出', exact: true }).click();
	await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
	const exits = await page.evaluate((pubkey) => {
		const state = (window as typeof window & { __relayStartupTest: { state: {
			published: Array<{ kind: number; pubkey?: string; created_at: number; tags: string[][] }>;
			previousPublished: Array<{ kind: number; pubkey?: string; created_at: number; tags: string[][] }>;
		} } }).__relayStartupTest.state;
		return [...state.previousPublished, ...state.published].filter((event) =>
			event.kind === 30079 && event.pubkey === pubkey &&
			event.tags.some((tag) => tag[0] === 'd' && tag[1]?.endsWith(':exit')));
	}, selfPubkey);
	expect(exits.length).toBeGreaterThan(0);
	await page.getByRole('region', { name: '再利用可能なIdentity' }).getByRole('button', { name: /を使う$/ }).click();
	const rootBuildToggle = page.getByRole('region', { name: 'Root build' }).getByRole('button', { name: /Root build/ });
	if (await rootBuildToggle.getAttribute('aria-expanded') === 'false') await rootBuildToggle.click();
	await page.getByRole('button', { name: '推論加速を上げる' }).click();
	await page.getByRole('button', { name: '開始' }).click();
	await page.evaluate(() => (window as typeof window & {
		__relayStartupTest: { releasePrimary(): void }
	}).__relayStartupTest.releasePrimary());
	await expect.poll(async () => (await relayState(page)).state.published.find((event) =>
		event.kind === WORLD_STATE_KIND && event.pubkey === selfPubkey &&
		event.tags.some((tag) => tag[0] === 'd' && !tag[1]?.endsWith(':exit')))?.created_at).toBeGreaterThan(exits[0].created_at);
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

test('retains primary evidence received before field geometry becomes ready', async ({ page }) => {
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
	await waitForPrimary(page);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimaryEvents(): void } }).__relayStartupTest.releasePrimaryEvents());
	await expect(page.locator('.field-viewport.initial-field-geometry-ready')).toHaveCount(0);
	await expect(page.locator(`.participant[data-participant-id="${events.position.pubkey}"]`)).toHaveCount(1);
	const requestsBeforeGeometry = (await relayState(page)).state.requests.length;
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
	expect((await relayState(page)).state.requests).toHaveLength(requestsBeforeGeometry);
});

test('keeps validated evidence after every primary pair closes without metadata fallback', async ({ page }) => {
	const events = testEvents();
	await installHostOwnedStub(page);
	await installDelayedRelay(page, { primaryEvents: events, deferPrimaryEvents: true, primaryTerminal: 'closed' });
	await page.goto('/');
	await waitForPrimary(page);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimaryEvents(): void; releasePrimary(): void } }).__relayStartupTest.releasePrimaryEvents());
	await expect(page.locator(`.participant[data-participant-id="${events.position.pubkey}"]`)).toBeVisible();
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	await expect(page.locator(`.participant[data-participant-id="${events.position.pubkey}"]`)).toBeVisible();
	const state = await relayState(page);
	expect(state.state.requests.filter((request) => [40, 41].includes(requestKind(request)!))).toHaveLength(0);
	expect(new Set(state.state.requests.map((request) => request.url))).toEqual(new Set(AUTHORITATIVE_RELAYS));
	expect(state.state.requests.filter((request) => request.filter.limit === undefined && [42, WORLD_STATE_KIND].includes(requestKind(request)!))).toHaveLength(10);
});

test('does not use the early reader for an already expired persona terminal exit', async ({ page }) => {
	const secret = fixtureSecret(23);
	const selfPubkey = getPublicKey(secret);
	await installHostOwnedStub(page);
	await installDelayedRelay(page, { persistAcrossReload: true });
	await seedRelayAccount(page, secret, selfPubkey, Date.now() - 1000);
	await holdRootDecryption(page);
	await page.goto('/');
	await waitForPrimary(page);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	await releaseRootDecryption(page);
	await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
	const published = await page.evaluate(() => {
		const state = (window as typeof window & { __relayStartupTest: { state: { published: Array<{ pubkey?: string; kind: number }>; previousPublished: Array<{ pubkey?: string; kind: number }> } } }).__relayStartupTest.state;
		return [...state.published, ...state.previousPublished];
	});
	expect(published.filter((event) => event.pubkey === selfPubkey && event.kind === WORLD_STATE_KIND)).toHaveLength(0);
});
