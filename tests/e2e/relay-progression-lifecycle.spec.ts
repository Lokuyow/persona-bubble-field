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
import {
	buildRiftActionTemplate,
	buildRiftCommitAction,
	buildRiftRevealAction,
	buildManualRiftInstanceId,
	deriveRiftHolePositions,
	getRiftRoundSchedule,
	getRiftSchedule,
	getRiftScheduleForInstance,
	RIFT_CONSULTATION_MS,
	RIFT_PROTOCOL_KEY,
	type RiftAction
} from '../../src/lib/rift';
import { buildRealtimeControlEventTemplate, finalizeRealtimeEvent } from '../../src/lib/realtimeEvents';
import { SPEECH_SHORTCUT_IDS } from '../../src/lib/speechSubmission';
import { characterPicturePath } from '../../src/lib/character';
import { requireCharacterFromPubkey, resolveCharacterFromPubkey } from '../../src/lib/characterAssignment';
import { deriveBip85NostrEntropy } from '../../src/lib/bip85';
import { ADJUSTMENT_TERMINAL, MENDING_TERMINAL } from '../../src/lib/fieldFacilities';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { installFieldFrameSampling, readFieldFrames, sampleRenderedField } from './helpers/fieldFrames';
import { CHANNEL_ID, AUTHORITATIVE_RELAYS, fixtureSecret, testEvents, isDeathTraceEvent, installDelayedRelay, relayState, dragRelayJoystick, publishedMessages, waitForPublishedMessageCount, pauseAtCurrentBrowserTime, startSelectedRun, openReadyRelayWorld, openClearReadyWorld, installPromptApiStub, seedRelayAccount, readRelayGameState, overwriteRelayGameState, overwriteRelayMendingBuild, seedUnavailablePersona, installDeathTransitionFailure, armDeathTransitionFailure, moveRelaySelfTo } from './helpers/relayHarness';

async function waitForDeathLastWords(page: Page, canonicalPosition?: string | null): Promise<void> {
	const presentation = page.locator('[data-death-presentation]');
	await expect(presentation).toBeVisible();
	await expect(presentation).toHaveAttribute('data-death-phase', 'intro');
	await expect(presentation.getByRole('heading', { name: '死亡' })).toBeVisible();
	await expect(presentation.locator('textarea')).toHaveCount(0);
	await expect(presentation.getByRole('button')).toHaveCount(0);
	await expect(page.locator('.field-viewport.death-presentation-active')).toHaveCount(1);
	await expect(page.locator('.participant[data-self="true"]')).toHaveCount(0);
	const tombstone = page.locator('[data-death-presentation-tombstone]');
	await expect(tombstone).toHaveCount(1);
	if (canonicalPosition) await expect(tombstone).toHaveAttribute('data-death-presentation-tombstone-position', canonicalPosition);
	await page.clock.runFor(2_500);
	await expect(presentation).toHaveAttribute('data-death-phase', 'last-words');
	await expect(presentation.locator('textarea')).toBeVisible();
	await expect(presentation.locator('.death-presentation-card')).toBeFocused();
}


test.describe('Relay startup', () => {

	test('publishes a World State exit after normal clear and advances to Identity selection', async ({ page }) => {
		const { pubkey } = await openClearReadyWorld(page);
		const position = await page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`).getAttribute('data-position');
		expect(position).toMatch(/^\d+,\d+$/);
		await page.getByRole('button', { name: '自分のプロフィールを開く' }).click();
		const profile = page.getByRole('dialog');
		await expect(profile.getByRole('button', { name: '脱出', exact: true })).toBeEnabled();
		await profile.getByRole('button', { name: '脱出', exact: true }).click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		await expect(page.getByText('脱出しました', { exact: true })).toBeVisible();
		await expect(page.getByText('現在のRunを終了し、Root Pointを1獲得しました。', { exact: true })).toBeVisible();
		await page.reload();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByText('脱出しました', { exact: true })).toHaveCount(0);
		const lifecycle = await page.evaluate(async () => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('persona-bubble-field-account');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				const transaction = database.transaction('persona-bubble-field-player-state');
				const request = transaction.objectStore('persona-bubble-field-player-state').get('player-lifecycle');
				return await new Promise<{ rootPoints: number; mode: string; status: string; outcome: string }>((resolve, reject) => {
					transaction.oncomplete = () => {
						const state = request.result as { rootPoints: number; mode: { kind: string; pendingSelection?: { reusableIdentities?: Array<{ pubkey: string }> } }; identities: Array<{ pubkey: string; status: string; runHistory: Array<{ outcome: string }> }> };
						const identity = state.identities[0];
						resolve({ rootPoints: state.rootPoints, mode: state.mode.kind, status: identity.status, outcome: identity.runHistory.at(-1)?.outcome ?? '' });
					};
					transaction.onerror = () => reject(transaction.error);
				});
			} finally { database.close(); }
		});
		expect(lifecycle).toMatchObject({ rootPoints: 1, mode: 'selecting', status: 'cleared', outcome: 'cleared' });
		const exits = await page.evaluate((expectedPubkey) => {
			const state = (window as typeof window & { __relayStartupTest: { state: { previousPublished: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][] }>; published: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][] }> } } }).__relayStartupTest.state;
			return [...new Map([...state.previousPublished, ...state.published]
				.filter((event) => event.kind === 30079 && event.pubkey === expectedPubkey && event.tags.some((tag) => tag[0] === 'd' && tag[1]?.endsWith(':exit')))
				.map((event) => [event.id, event])).values()];
		}, pubkey);
		expect(exits).toHaveLength(1);
		expect(exits[0]?.content).toBe(position?.replace(',', ':'));
	});

	test('keeps normal clear committed when terminal exit publication is rejected', async ({ page }) => {
		const { pubkey } = await openClearReadyWorld(page);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { rejectPositionPublishes(): void } }).__relayStartupTest.rejectPositionPublishes());
		await page.getByRole('button', { name: '自分のプロフィールを開く' }).click();
		await page.getByRole('dialog').getByRole('button', { name: '脱出', exact: true }).click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		const lifecycle = await page.evaluate(async () => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('persona-bubble-field-account');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				const transaction = database.transaction('persona-bubble-field-player-state');
				const request = transaction.objectStore('persona-bubble-field-player-state').get('player-lifecycle');
				return await new Promise<{ rootPoints: number; mode: string; status: string }>((resolve, reject) => {
					transaction.oncomplete = () => {
						const state = request.result as { rootPoints: number; mode: { kind: string }; identities: Array<{ status: string }> };
						resolve({ rootPoints: state.rootPoints, mode: state.mode.kind, status: state.identities[0]?.status ?? '' });
					};
					transaction.onerror = () => reject(transaction.error);
				});
			} finally { database.close(); }
		});
		expect(lifecycle).toEqual({ rootPoints: 1, mode: 'selecting', status: 'cleared' });
	});

	test('moves an expired persona to the next identity selection', async ({ page }) => {
		const secret = fixtureSecret(51);
		const pubkey = getPublicKey(secret);
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await seedRelayAccount(page, secret, pubkey);
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();

		await overwriteRelayGameState(page, {
			version: 4,
			personaPubkey: pubkey,
			lifespanExpiresAtMs: Date.now() - 1,
			points: 321,
			abilities: { inferenceEfficiency: 100, contextCapacity: 100, hallucinationSuppression: 100 },
			mendingJob: null
		});
		await page.reload({ waitUntil: 'domcontentloaded' });

		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.locator('[data-death-presentation]')).toHaveCount(0);
		await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		const previousCharacterId = requireCharacterFromPubkey(pubkey).characterId;
		const pendingCharacterIds = await page.evaluate(async () => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('persona-bubble-field-account');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				const request = database.transaction('persona-bubble-field-player-state').objectStore('persona-bubble-field-player-state').get('player-lifecycle');
				return await new Promise<string[]>((resolve, reject) => {
					request.onsuccess = () => resolve((request.result as { mode: { pendingSelection: { candidates: Array<{ characterId: string }> } } }).mode.pendingSelection.candidates.map((candidate) => candidate.characterId));
					request.onerror = () => reject(request.error);
				});
			} finally { database.close(); }
		});
		expect(pendingCharacterIds).not.toContain(previousCharacterId);
		await page.getByRole('button', { name: /を選ぶ$/ }).first().click();
		await startSelectedRun(page);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		const reset = await page.evaluate(async () => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('persona-bubble-field-account');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				return await new Promise<{ pubkey: string; game: { personaPubkey: string; points: number; abilities: Record<string, number> } }>((resolve, reject) => {
					const tx = database.transaction('persona-bubble-field-player-state');
					const playerRequest = tx.objectStore('persona-bubble-field-player-state').get('player-lifecycle');
					tx.oncomplete = () => {
						const lifecycle = playerRequest.result as { mode: { activeRun: { identity: { pubkey: string }; gameState: { personaPubkey: string; points: number; pointProgressTicks: number; abilities: Record<string, number> } } } };
						resolve({ pubkey: lifecycle.mode.activeRun.identity.pubkey, game: lifecycle.mode.activeRun.gameState });
					};
					tx.onerror = () => reject(tx.error);
				});
			} finally { database.close(); }
		});
		expect(reset.pubkey).not.toBe(pubkey);
		expect(reset.game).toMatchObject({ personaPubkey: reset.pubkey, points: 0, pointProgressTicks: 0,
			abilities: { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 } });
		await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __relayStartupTest?: unknown }).__relayStartupTest))).toBe(true);
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${reset.pubkey}"]`)).toBeVisible();
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		const before = (await publishedMessages(page)).length;
		await editor.fill('after identity transition');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await waitForPublishedMessageCount(page, before + 1);
		const event = await page.evaluate((message) => {
			const published = (window as typeof window & { __relayStartupTest: { state: { published: Array<{ kind: number; content: string; pubkey?: string }> } } }).__relayStartupTest.state.published;
			return published.find((candidate) => candidate.kind === 42 && candidate.content === message);
		}, 'after identity transition');
		expect(event?.pubkey).toBe(reset.pubkey);
	});

	test('keeps public read-only updates after runtime death transition fails', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(59);
		const pubkey = getPublicKey(secret);
		const events = testEvents();
		await page.clock.install({ time: startTime });
		await installDeathTransitionFailure(page);
		await installPromptApiStub(page);
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: events });
		await seedRelayAccount(page, secret, pubkey);
		await overwriteRelayGameState(page, { version: 4, personaPubkey: pubkey, lifespanExpiresAtMs: startTime + 30_000, points: 0, pointProgressTicks: 0, mendingJob: null,
			abilities: { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 } });
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
			relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await pauseAtCurrentBrowserTime(page);
		const initialRequestCount = (await relayState(page)).state.requests.length;
		await armDeathTransitionFailure(page);
		await page.clock.runFor(31_000);
		await expect.poll(() => page.evaluate(() => (window as typeof window & {
			__personaLifecycleFailureTest: { injected(): number }
		}).__personaLifecycleFailureTest.injected())).toBe(1);
		await expect(page.locator('.participant[data-self="true"]')).toHaveCount(0);
		expect((await relayState(page)).state.published.some((event) => event.kind === WORLD_STATE_KIND && event.tags.some((tag) => tag[0] === 'd' && tag[1]?.endsWith(':exit')))).toBe(false);
		await expect.poll(async () => (await relayState(page)).state.requests.length).toBeGreaterThan(initialRequestCount);

		const live = testEvents(startTime + 31_000);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectMessage(event: object): void } }).__relayStartupTest.injectMessage(event), live.message);
		await expect(page.locator(`.bubble[data-bubble-id="${live.message.id}"]`)).toBeVisible();

		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		const beforeComposer = (await publishedMessages(page)).length;
		await editor.fill('blocked after runtime death');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect.poll(async () => (await publishedMessages(page)).length).toBe(beforeComposer);
		await expect(editor).toHaveValue('blocked after runtime death');

		await editor.fill('');
		const candidateButton = page.getByRole('button', { name: 'AI発言候補を生成' });
		await expect(candidateButton).toBeEnabled();
		await candidateButton.click();
		const primary = page.locator('.suggestion-primary').first();
		await expect(primary).toBeVisible();
		const beforeCandidate = (await publishedMessages(page)).length;
		await primary.click();
		await expect.poll(async () => (await publishedMessages(page)).length).toBe(beforeCandidate);
		await expect(page.locator('.suggestion-panel')).toBeVisible();
	});

	test('moves an active Relay session to identity selection when its deadline is crossed', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(55);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await seedRelayAccount(page, secret, pubkey);
		await overwriteRelayGameState(page, { version: 4, personaPubkey: pubkey, lifespanExpiresAtMs: startTime + 30_000, points: 0, pointProgressTicks: 0, mendingJob: null,
			abilities: { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 } });
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await pauseAtCurrentBrowserTime(page);
		const canonicalPosition = await page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`).getAttribute('data-position');

		await page.clock.runFor(31_000);
		await waitForDeathLastWords(page, canonicalPosition);
		await page.locator('[data-death-presentation]').getByRole('button', { name: '残さず進む' }).click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		await page.getByRole('button', { name: /を選ぶ$/ }).first().click();
		await startSelectedRun(page);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		const persistedPubkey = async () => page.evaluate(async () => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('persona-bubble-field-account');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				return await new Promise<string>((resolve, reject) => {
					const request = database.transaction('persona-bubble-field-player-state').objectStore('persona-bubble-field-player-state').get('player-lifecycle');
					request.onsuccess = () => resolve((request.result as { mode: { kind: 'running'; activeRun: { identity: { pubkey: string } } } }).mode.activeRun.identity.pubkey);
					request.onerror = () => reject(request.error);
				});
			} finally { database.close(); }
		});
		await expect.poll(persistedPubkey).not.toBe(pubkey);
		const newPubkey = await persistedPubkey();
		expect(newPubkey).not.toBe(pubkey);

		await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __relayStartupTest?: unknown }).__relayStartupTest))).toBe(true);
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${newPubkey}"]`)).toBeVisible();
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toHaveCount(0);

		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await editor.fill('runtime identity transition message');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await waitForPublishedMessageCount(page, 1);
		const event = await page.evaluate(() => {
			const published = (window as typeof window & { __relayStartupTest: { state: { published: Array<{ kind: number; content: string; pubkey?: string }> } } }).__relayStartupTest.state.published;
			return published.find((candidate) => candidate.kind === 42 && candidate.content === 'runtime identity transition message');
		});
		expect(event?.pubkey).toBe(newPubkey);
	});

	test('uses an immediate reduced-motion death presentation and still advances after skip', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(61);
		const pubkey = getPublicKey(secret);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime), persistAcrossReload: true });
		await seedRelayAccount(page, secret, pubkey, startTime + 30_000);
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await pauseAtCurrentBrowserTime(page);
		await page.clock.runFor(31_000);
		const presentation = page.locator('[data-death-presentation]');
		await expect(presentation).toHaveAttribute('data-death-phase', 'last-words');
		await expect(presentation.getByRole('heading', { name: '死亡' })).toBeVisible();
		await expect(page.locator('.field-viewport.death-presentation-active')).toHaveCount(1);
		await expect(page.locator('.participant[data-self="true"]')).toHaveCount(0);
		await expect(page.locator('[data-death-presentation-tombstone]')).toHaveCount(1);
		await expect(presentation.locator('textarea')).toBeVisible();
		await expect(presentation.locator('.death-presentation-card')).toBeFocused();
		await presentation.getByRole('button', { name: '残さず進む' }).click();
		await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		await page.getByRole('button', { name: /を選ぶ$/ }).first().click();
		await startSelectedRun(page);
		await expect(page.getByRole('dialog')).toHaveCount(0);
	});

	test('publishes a terminal World State exit after live runtime death commits locally', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(57);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime), persistAcrossReload: true, rejectTracePublishes: true });
		await seedRelayAccount(page, secret, pubkey, startTime + 30_000);
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await pauseAtCurrentBrowserTime(page);

		await page.clock.runFor(31_000);
		await waitForDeathLastWords(page);
		await page.locator('[data-death-presentation] textarea').fill('A last word from this Run');
		await page.locator('[data-death-presentation]').getByRole('button', { name: '残して進む' }).click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		await expect(page.getByText('Runが終了しました', { exact: true })).toBeVisible();
		await expect(page.getByText('この人格のRunは死亡として終了しました。次の人格を選んでください。', { exact: true })).toBeVisible();
		await page.reload();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByText('Runが終了しました', { exact: true })).toHaveCount(0);
		await expect.poll(async () => page.evaluate((expectedPubkey) => {
			const state = (window as unknown as { __relayStartupTest: { state: { previousPublished: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][]; created_at?: number }>; published: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][]; created_at?: number }> } } }).__relayStartupTest.state;
			return [...new Map([...state.previousPublished, ...state.published]
				.filter((event) => event.kind === 30079 && event.pubkey === expectedPubkey && event.tags.some((tag) => tag[0] === 'd' && tag[1]?.endsWith(':exit')))
				.map((event) => [event.id, event])).values()];
		}, pubkey)).toHaveLength(1);
		const exit = await page.evaluate((expectedPubkey) => {
			const state = (window as unknown as { __relayStartupTest: { state: { previousPublished: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][]; created_at?: number }>; published: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][]; created_at?: number }> } } }).__relayStartupTest.state;
			const published = [...state.previousPublished, ...state.published];
			return published.find((event) => event.kind === 30079 && event.pubkey === expectedPubkey && event.tags.some((tag) => tag[0] === 'd' && tag[1]?.endsWith(':exit')));
		}, pubkey);
		expect(exit?.content).toMatch(/^\d+:\d+$/);
		expect(exit?.tags.find((tag) => tag[0] === 'e')?.[1]).toBe(CHANNEL_ID);
		const traces = await page.evaluate((expectedPubkey) => {
			const state = (window as typeof window & { __relayStartupTest: { state: { previousPublished: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][] }>; published: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][] }> } } }).__relayStartupTest.state;
			return [...new Map([...state.previousPublished, ...state.published]
				.filter((event) => event.kind === 42 && event.tags.some((tag) => tag[0] === 'l' && tag[1] === 'trace' && tag[2] === 'io.github.lokuyow.persona-bubble-field') && event.tags.some((tag) => tag[0] === 'l' && tag[1] === 'trace:death' && tag[2] === 'io.github.lokuyow.persona-bubble-field') && event.pubkey === expectedPubkey && event.content === 'A last word from this Run')
				.map((event) => [event.id, event])).values()];
		}, pubkey);
		expect(traces).toHaveLength(1);
		expect(traces[0]?.tags.find((tag) => tag[0] === 'w')?.[1]).toBe(exit?.content);
	});

	test('keeps local death committed when the terminal exit is rejected by Relay', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(63);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime), persistAcrossReload: true });
		await seedRelayAccount(page, secret, pubkey, startTime + 30_000);
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await pauseAtCurrentBrowserTime(page);
		await page.evaluate(() => (window as unknown as { __relayStartupTest: { rejectPositionPublishes(): void } }).__relayStartupTest.rejectPositionPublishes());
		await page.clock.runFor(31_000);
		await waitForDeathLastWords(page);
		await page.locator('[data-death-presentation] textarea').fill('trace publication is best effort');
		await page.locator('[data-death-presentation]').getByRole('button', { name: '残して進む' }).click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		await expect.poll(() => page.evaluate((expectedPubkey) => {
			const state = (window as unknown as { __relayStartupTest: { state: { previousPublished: Array<{ id: string; kind: number; pubkey?: string; tags: string[][] }>; published: Array<{ id: string; kind: number; pubkey?: string; tags: string[][] }> } } }).__relayStartupTest.state;
			return [...state.previousPublished, ...state.published].some((event) => event.kind === 30079 && event.pubkey === expectedPubkey && event.tags.some((tag) => tag[0] === 'd' && tag[1]?.endsWith(':exit')));
		}, pubkey)).toBe(true);
		const traces = (await relayState(page)).state.published.filter((event) => isDeathTraceEvent(event) && event.pubkey === pubkey);
		expect(traces).toHaveLength(0);
	});
});
