import { expect, test, type Locator, type Page } from '@playwright/test';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import { finalizeEvent, getPublicKey, verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure';
import {
	buildWorldStateEventTemplate,
	WORLD_STATE_KIND,
	buildDeathTraceEventTemplate,
	buildTraceReplyTemplate,
	buildWorldMessageTemplate,
	parseTraceReplyCandidate,
	parseWorldMessage,
	validateTraceReplyCandidate
} from '../../src/lib/nostrProtocol';
import { buildRealtimeControlEventTemplate, finalizeRealtimeEvent } from '../../src/lib/realtimeEvents';
import { SPEECH_SHORTCUT_IDS } from '../../src/lib/speechSubmission';
import { characterPicturePath } from '../../src/lib/character';
import { requireCharacterFromPubkey, resolveCharacterFromPubkey } from '../../src/lib/characterAssignment';
import { deriveBip85NostrEntropy } from '../../src/lib/bip85';
import { ADJUSTMENT_TERMINAL, MENDING_TERMINAL } from '../../src/lib/fieldFacilities';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { installFieldFrameSampling, readFieldFrames, sampleRenderedField } from './helpers/fieldFrames';
import { CHANNEL_ID, AUTHORITATIVE_RELAYS, fixtureSecret, testEvents, isDeathTraceEvent, installDelayedRelay, relayState, dragRelayJoystick, publishedMessages, waitForPublishedMessageCount, pauseAtCurrentBrowserTime, startSelectedRun, openReadyRelayWorld, openClearReadyWorld, installPromptApiStub, seedRelayAccount, readRelayGameState, overwriteRelayGameState, overwriteRelayMendingBuild, seedUnavailablePersona, installDeathTransitionFailure, armDeathTransitionFailure, moveRelaySelfTo } from './helpers/relayHarness';


test.describe('Relay startup', () => {

	test('keeps an offline mending job alive across browser reopen after its stored expiry', async ({ page }) => {
		const startTime = Date.now();
		const hour = 60 * 60 * 1000;
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey, startTime + 2 * 60 * 1000);
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
			relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		const atTerminal = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 11, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), atTerminal);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
		await page.getByRole('button', { name: '作業端末' }).click();
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ mendingJob: expect.any(Object) });
		const started = await readRelayGameState(page);

		await page.clock.setSystemTime(startTime + 2 * 60 * 1000 + 10 * 1000);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
			relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await expect(page.locator('.lifespan-hud')).toBeVisible();
		const reopened = await readRelayGameState(page);
		expect(reopened).toMatchObject({ personaPubkey: pubkey, lifespanExpiresAtMs: started.lifespanExpiresAtMs, mendingJob: expect.any(Object) });
	});

	test('closes a stale completed mending dialog before its reward can be collected', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey);
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
			relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await moveRelaySelfTo(page, { x: 11, y: 3 });
		const terminal = page.getByRole('button', { name: '作業端末' });
		await terminal.click();
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ mendingJob: expect.any(Object) });
		const started = await readRelayGameState(page);
		const job = started.mendingJob as { startedAtMs: number };
		await page.getByRole('button', { name: '閉じる', exact: true }).click();
		await page.clock.setSystemTime(job.startedAtMs + 5 * 60 * 1000);
		const currentTerminalPosition = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 11, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), currentTerminalPosition);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
		await terminal.click();
		await expect(page.getByRole('button', { name: '成果を受け取る' })).toBeVisible();
		await page.clock.runFor(1_001);
		const moved = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 0, y: 0 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), moved);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		const stale = await readRelayGameState(page);
		expect(stale).toMatchObject({ points: 0, mendingJob: expect.any(Object) });
	});

	test('converges two tabs on one mending start and collection', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		const other = await page.context().newPage();
		const clients = [page, other] as const;
		try {
			await Promise.all(clients.map((client) => client.clock.install({ time: startTime })));
			await Promise.all(clients.map(async (client) => {
				await installHostOwnedStub(client);
				await installDelayedRelay(client, { primaryEvents: testEvents(startTime) });
			}));
			await seedRelayAccount(page, secret, pubkey);
			await Promise.all(clients.map(async (client) => {
				await client.goto('/');
				await expect(client.locator('.action-dock')).toBeVisible();
				await client.evaluate(() => {
					const relay = (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
					relay.releasePrimary();
				});
				await expect(client.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
			}));
			const injectTerminalPosition = async (client: Page) => {
				const event = finalizeEvent(buildWorldStateEventTemplate({
					channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 11, y: 3 }, slot: 1,
					createdAt: Math.floor(await client.evaluate(() => Date.now()) / 1000)
				}), secret);
				await client.evaluate((position) => (window as typeof window & {
					__relayStartupTest: { injectPosition(event: object): void }
				}).__relayStartupTest.injectPosition(position), event);
				await expect(client.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
			};
			await Promise.all(clients.map(injectTerminalPosition));
			await Promise.all(clients.map(async (client) => {
				await client.getByRole('button', { name: '作業端末' }).click();
				await expect(client.getByRole('dialog')).toBeVisible();
			}));
			await expect.poll(() => readRelayGameState(page)).toMatchObject({ mendingJob: expect.any(Object) });
			const started = await readRelayGameState(page);
			expect(started.mendingJob).toEqual(expect.any(Object));

			const completedAt = (started.mendingJob as { startedAtMs: number }).startedAtMs + 5 * 60 * 1000;
			await Promise.all(clients.map((client) => client.clock.setSystemTime(completedAt)));
			await Promise.all(clients.map(injectTerminalPosition));
			for (const client of clients) {
				const close = client.getByRole('button', { name: '閉じる', exact: true });
				if (await close.isVisible()) await close.click();
				await client.getByRole('button', { name: '作業端末' }).click();
				await expect(client.getByRole('button', { name: '成果を受け取る' })).toBeVisible();
			}
			await Promise.all(clients.map((client) => client.getByRole('button', { name: '成果を受け取る' }).click()));
			await expect.poll(() => readRelayGameState(page)).toMatchObject({ points: 5, mendingJob: expect.any(Object) });
			const collected = await readRelayGameState(page);
			expect(collected).toMatchObject({ points: 5, mendingJob: expect.any(Object) });
		} finally {
			await other.close();
		}
	});

	test('reloads an old terminal mutation after another tab selects the next identity', async ({ page }) => {
		const secret = fixtureSecret(63);
		const oldPubkey = getPublicKey(secret);
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { persistAcrossReload: true });
		await seedRelayAccount(page, secret, oldPubkey);
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
			relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${oldPubkey}"]`)).toBeVisible();
		const atTerminal = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 11, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), atTerminal);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
		await page.evaluate(() => {
			let release: (() => void) | null = null;
			let started = false;
			(window as typeof window & { __personaBubbleFieldTestHooks: { started: () => boolean; release: () => void; beforeMendingMutation: (operation: 'start' | 'collect') => Promise<void> } }).__personaBubbleFieldTestHooks = {
				started: () => started,
				release: () => { release?.(); release = null; },
				beforeMendingMutation: async (operation) => {
					if (operation !== 'start') return;
					started = true;
					await new Promise<void>((resolve) => { release = resolve; });
				}
			};
		});
		await page.getByRole('button', { name: '作業端末' }).click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __personaBubbleFieldTestHooks: { started: () => boolean } }).__personaBubbleFieldTestHooks.started())).toBe(true);
		const oldPublishedCount = (await relayState(page)).state.published.length;

		const reincarnator = await page.context().newPage();
		try {
			await installHostOwnedStub(reincarnator);
			await installDelayedRelay(reincarnator);
			await reincarnator.goto('/');
			await reincarnator.evaluate(() => {
				const relay = (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
				relay.releasePrimary();
			});
			await expect(reincarnator.locator(`.participant[data-self="true"][data-participant-id="${oldPubkey}"]`)).toBeVisible();
			await overwriteRelayGameState(reincarnator, { version: 4, personaPubkey: oldPubkey, lifespanExpiresAtMs: Date.now() - 1, points: 0,
				abilities: { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 }, mendingJob: null });
			await reincarnator.reload({ waitUntil: 'domcontentloaded' });
			await expect(reincarnator.getByRole('dialog')).toBeVisible();
			await expect(reincarnator.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
			await reincarnator.getByRole('button', { name: /を選ぶ$/ }).first().click();
			await startSelectedRun(reincarnator);
			await expect(reincarnator.getByRole('dialog')).toHaveCount(0);
			await reincarnator.evaluate(() => {
				const relay = (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
				relay.releasePrimary();
			});
			await expect.poll(async () => (await readRelayGameState(reincarnator)).personaPubkey).not.toBe(oldPubkey);

			const reloaded = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
			await page.evaluate(() => (window as typeof window & { __personaBubbleFieldTestHooks: { release: () => void } }).__personaBubbleFieldTestHooks.release());
			await reloaded;
			await page.waitForLoadState('load');
			await expect(page.locator('.action-dock')).toBeVisible();
			await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __relayStartupTest?: unknown }).__relayStartupTest))).toBe(true);
			await page.evaluate(() => {
				const relay = (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
				relay.releasePrimary();
			});
			const newPubkey = (await readRelayGameState(page)).personaPubkey;
			expect(newPubkey).not.toBe(oldPubkey);
			await expect(page.locator(`.participant[data-self="true"][data-participant-id="${newPubkey}"]`)).toBeVisible();
			const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
			await editor.fill('new persona after superseded mending');
			await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
			await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 42 && event.pubkey === newPubkey)).toBe(true);
			const observed = await page.evaluate(() => {
				const state = (window as typeof window & { __relayStartupTest: { state: { previousPublished: Array<{ kind: number; pubkey: string }>; published: Array<{ kind: number; pubkey: string }>; previousClosedSubscriptions: unknown[] } } }).__relayStartupTest.state;
				return { published: [...state.previousPublished, ...state.published], closed: state.previousClosedSubscriptions };
			});
			expect(observed.closed.length).toBeGreaterThan(0);
			const postSupersession = observed.published.slice(oldPublishedCount);
			expect(postSupersession.filter((event) => [WORLD_STATE_KIND, 42, 1111].includes(event.kind))).not.toContainEqual(expect.objectContaining({ pubkey: oldPubkey }));
			// The new Run's confirmed position is restored from its journal; this tab need not re-enter.
			expect(postSupersession.filter((event) => event.kind === WORLD_STATE_KIND && event.pubkey === newPubkey)).toHaveLength(0);
			expect(postSupersession).toContainEqual(expect.objectContaining({ kind: 42, pubkey: newPubkey }));
		} finally {
			await reincarnator.close();
		}
	});

	test('fails closed to a public read-only world when a mending mutation finds corrupt storage', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey);
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
			relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await moveRelaySelfTo(page, { x: 11, y: 3 });
		await overwriteRelayGameState(page, { version: 99 });
		const before = (await publishedMessages(page)).length;
		await page.getByRole('button', { name: '作業端末' }).click();
		await expect(page.locator('.participant[data-self="true"]')).toHaveCount(0);
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await editor.fill('must remain read-only after corrupt mending');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect.poll(async () => (await publishedMessages(page)).length).toBe(before);
	});
});
