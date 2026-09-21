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
import { AUTHORITATIVE_RELAYS, fixtureSecret, testEvents, installDelayedRelay, relayState, requestKind, publishedMessages, startSelectedRun, setPendingRootPoints, seedRelayAccount, isRealtimeRequest, overwriteRelayGameState, installDeathTransitionFailure, armDeathTransitionFailure, installDeathTransitionClockRollback, armDeathTransitionClockRollback, moveRelaySelfTo } from './helpers/relayHarness';


test.describe('Relay startup', () => {
	test('reloads and reconciles a valid Run after a death transition clock rollback', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(57);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installDeathTransitionClockRollback(page, startTime);
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		const expiresAtMs = startTime + 60_000;
		await seedRelayAccount(page, secret, pubkey, expiresAtMs);
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await armDeathTransitionClockRollback(page);
		const reloaded = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
		await page.clock.setSystemTime(expiresAtMs + 1);
		await page.clock.runFor(1_000);
		await reloaded;
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		expect((await relayState(page)).state.published.some((event) => event.kind === WORLD_STATE_KIND && event.pubkey === pubkey && event.tags.some((tag) => tag[0] === 'd' && tag[1]?.endsWith(':exit')))).toBe(false);
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === WORLD_STATE_KIND && event.pubkey === pubkey)).toBe(true);
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await editor.fill('valid run remains publishable after rollback reconciliation');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 42 && event.pubkey === pubkey)).toBe(true);
	});

	test('rejects a stale Run world write after another tab commits death selection', async ({ page }) => {
		await page.clock.install({ time: Date.now() });
		const secret = fixtureSecret(57);
		const oldPubkey = getPublicKey(secret);
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { persistAcrossReload: true });
		await seedRelayAccount(page, secret, oldPubkey);
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator('.action-dock')).toBeVisible();
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${oldPubkey}"]`)).toBeVisible();
		const deathTab = await page.context().newPage();
		try {
			await installHostOwnedStub(deathTab);
			await installDelayedRelay(deathTab);
			await deathTab.goto('/');
			await overwriteRelayGameState(deathTab, { version: 4, personaPubkey: oldPubkey, lifespanExpiresAtMs: Date.now() - 1, points: 0,
				abilities: { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 }, mendingJob: null });
			await deathTab.reload({ waitUntil: 'domcontentloaded' });
			await expect(deathTab.getByRole('dialog')).toBeVisible();
			await expect(deathTab.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);

			const reloaded = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
			const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
			await editor.fill('stale Run must not publish after death commit');
			await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
			await reloaded;
			await expect(page.getByRole('dialog')).toBeVisible();
			await expect.poll(async () => {
				const state = (await relayState(page)).state;
				return state.published.some((event) => event.kind === 42 && event.pubkey === oldPubkey && event.content === 'stale Run must not publish after death commit');
			}).toBe(false);
		} finally {
			await deathTab.close();
		}
	});

	test('reconciles stale mending into pending selection after another tab commits death', async ({ page }) => {
		await page.clock.install({ time: Date.now() });
		const secret = fixtureSecret(57);
		const oldPubkey = getPublicKey(secret);
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await seedRelayAccount(page, secret, oldPubkey);
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${oldPubkey}"]`)).toBeVisible();
		await moveRelaySelfTo(page, { x: 11, y: 3 });
		await page.getByRole('button', { name: '作業端末' }).click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByRole('button', { name: '作業を開始' })).toHaveCount(0);

		const deathTab = await page.context().newPage();
		try {
			await installHostOwnedStub(deathTab);
			await installDelayedRelay(deathTab);
			await deathTab.goto('/');
			await overwriteRelayGameState(deathTab, { version: 4, personaPubkey: oldPubkey, lifespanExpiresAtMs: Date.now() - 1, points: 0,
				abilities: { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 }, mendingJob: null });
			await deathTab.reload({ waitUntil: 'domcontentloaded' });
			await expect(deathTab.getByRole('dialog')).toBeVisible();

			await page.getByRole('dialog').getByRole('button', { name: '閉じる', exact: true }).click();
			await page.reload({ waitUntil: 'domcontentloaded' });
			await expect(page.getByRole('dialog')).toBeVisible();
			await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		} finally {
			await deathTab.close();
		}
	});

	test('falls back to a read-only world when startup death transition fails', async ({ page }) => {
		const secret = fixtureSecret(57);
		const pubkey = getPublicKey(secret);
		const events = testEvents();
		await installDeathTransitionFailure(page);
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: events });
		await seedRelayAccount(page, secret, pubkey);
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await overwriteRelayGameState(page, {
			version: 4, personaPubkey: pubkey, lifespanExpiresAtMs: Date.now() - 1, points: 321, pointProgressTicks: 0, mendingJob: null,
			abilities: { inferenceEfficiency: 100, contextCapacity: 100, hallucinationSuppression: 100 }
		});
		await armDeathTransitionFailure(page);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-participant-id="${events.message.pubkey}"]`)).toBeVisible();
		await expect(page.locator(`.bubble[data-bubble-id="${events.message.id}"]`)).toBeVisible();
		await expect(page.locator('.participant[data-self="true"]')).toHaveCount(0);
		expect((await publishedMessages(page))).toHaveLength(0);
		await expect.poll(() => page.evaluate(() => (window as typeof window & {
			__personaLifecycleFailureTest: { injected(): number }
		}).__personaLifecycleFailureTest.injected())).toBe(1);
		const persisted = await page.evaluate(async () => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('persona-bubble-field-account');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				const transaction = database.transaction('persona-bubble-field-player-state');
				const request = transaction.objectStore('persona-bubble-field-player-state').get('player-lifecycle');
				return await new Promise<{ pubkey: string; lifespanExpiresAtMs: number }>((resolve, reject) => {
					transaction.oncomplete = () => {
						const state = request.result as { mode: { activeRun: { identity: { pubkey: string }; gameState: { lifespanExpiresAtMs: number } } } };
						resolve({ pubkey: state.mode.activeRun.identity.pubkey, lifespanExpiresAtMs: state.mode.activeRun.gameState.lifespanExpiresAtMs });
					};
					transaction.onerror = () => reject(transaction.error);
				});
			} finally { database.close(); }
		});
		expect(persisted).toEqual({ pubkey, lifespanExpiresAtMs: expect.any(Number) });
		expect(persisted.lifespanExpiresAtMs).toBeLessThan(Date.now());
	});

	test('keeps a deterministic three-choice selection pending until one Identity is chosen', async ({ page }) => {
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await page.goto('/');
		const candidateButtons = page.getByRole('button', { name: /を選ぶ$/ });
		await expect(candidateButtons).toHaveCount(3);
		await expect.poll(() => page.locator('main > :not(.selection-backdrop)').evaluateAll((elements) => elements.every((element) => (element as HTMLElement).inert))).toBe(true);
		await expect(page.getByRole('heading', { name: 'Runを始める' })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(candidateButtons.first()).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(page.getByRole('button', { name: /Root build/ })).toBeFocused();
		expect((await relayState(page)).state.published.filter((event) => event.kind === 0)).toHaveLength(0);
		const labelsBeforeReload = await candidateButtons.allTextContents();
		await expect(page.locator('.participant[data-self="true"]')).toHaveCount(0);
		await page.reload({ waitUntil: 'domcontentloaded' });
		const reloadedButtons = page.getByRole('button', { name: /を選ぶ$/ });
		await expect(reloadedButtons).toHaveCount(3);
		expect(await reloadedButtons.allTextContents()).toEqual(labelsBeforeReload);
		await page.evaluate(() => { document.documentElement.dataset.identitySelectionDocumentToken = crypto.randomUUID(); });
		const documentToken = await page.locator('html').getAttribute('data-identity-selection-document-token');
		await reloadedButtons.nth(1).click();
		await startSelectedRun(page);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		expect(await page.locator('html').getAttribute('data-identity-selection-document-token')).toBe(documentToken);
		await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __relayStartupTest?: unknown }).__relayStartupTest))).toBe(true);
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect.poll(async () => (await relayState(page)).state.requests.filter((request) =>
			request.filter.limit === undefined && [42, WORLD_STATE_KIND].includes(requestKind(request)!)).length).toBeGreaterThan(0);
		const requestCountsAfterRelease = await (async () => {
			const requests = (await relayState(page)).state.requests;
			return {
				metadata: requests.filter((request) => [40, 41].includes(requestKind(request)!)).length,
				primary: requests.filter((request) => request.filter.limit === undefined && [42, WORLD_STATE_KIND].includes(requestKind(request)!)).length
			};
		})();
		await expect(page.locator('.participant[data-self="true"]')).toBeVisible();
		const requestCountsAfterSelection = await (async () => {
			const requests = (await relayState(page)).state.requests;
			return {
				metadata: requests.filter((request) => [40, 41].includes(requestKind(request)!)).length,
				primary: requests.filter((request) => request.filter.limit === undefined && [42, WORLD_STATE_KIND].includes(requestKind(request)!)).length
			};
		})();
		expect(requestCountsAfterSelection).toEqual(requestCountsAfterRelease);
		const selectedPubkey = await page.locator('.participant[data-self="true"]').getAttribute('data-participant-id');
		expect(selectedPubkey).toBeTruthy();
		await expect.poll(async () => (await relayState(page)).state.published.some((event) =>
			event.kind === WORLD_STATE_KIND && event.pubkey === selectedPubkey)).toBe(true);
		await expect.poll(async () => (await relayState(page)).state.published.some((event) =>
			event.kind === 0 && event.pubkey === selectedPubkey)).toBe(true);
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await editor.fill('selected identity remains publishable without a reload');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect.poll(async () => (await relayState(page)).state.published.some((event) =>
			event.kind === 42 && event.pubkey === selectedPubkey && event.content === 'selected identity remains publishable without a reload')).toBe(true);
		const lifecycle = await page.evaluate(async () => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('persona-bubble-field-account');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				return await new Promise<{ mode: string; identities: number; runNumber: number }>((resolve, reject) => {
					const request = database.transaction('persona-bubble-field-player-state').objectStore('persona-bubble-field-player-state').get('player-lifecycle');
					request.onsuccess = () => {
						const state = request.result as { identities: unknown[]; mode: { kind: string; activeRun?: { runNumber: number } } };
						resolve({ mode: state.mode.kind, identities: state.identities.length, runNumber: state.mode.activeRun?.runNumber ?? 0 });
					};
					request.onerror = () => reject(request.error);
				});
			} finally { database.close(); }
		});
		expect(lifecycle).toEqual({ mode: 'running', identities: 1, runNumber: 1 });
	});

	test('allocates a Root build before starting a Run', async ({ page }) => {
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await page.goto('/');
		await page.setViewportSize({ width: 420, height: 420 });
		await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		await setPendingRootPoints(page, 0);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await page.getByRole('button', { name: /を選ぶ$/ }).first().click();
		const rootToggle = page.locator('.root-build-toggle');
		await expect(rootToggle).toHaveAttribute('aria-expanded', 'false');
		await expect(rootToggle).toContainText('使用 0 / 0 RP');
		await expect(page.locator('.rank-controls')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Runを開始' })).toBeEnabled();
		await setPendingRootPoints(page, 3);
		await page.reload({ waitUntil: 'domcontentloaded' });

		await expect(page.locator('.rp-summary')).toContainText('3 RP');
		const rootBuild = page.locator('.root-build');
		await expect(rootToggle).toHaveAttribute('aria-expanded', 'true');
		await expect(rootBuild.locator('.ability-row')).toHaveCount(3);
		await rootToggle.focus();
		await page.keyboard.press('Enter');
		await expect(rootToggle).toHaveAttribute('aria-expanded', 'false');
		await page.keyboard.press('Space');
		await expect(rootToggle).toHaveAttribute('aria-expanded', 'true');
		await expect(rootBuild.getByRole('button', { name: '推論加速の詳細' })).toBeVisible();
		const mobileLayout = await rootBuild.locator('.ability-row').first().evaluate((row) => {
			const main = row.querySelector('.ability-main')?.getBoundingClientRect();
			const content = row.closest('.selection-content');
			if (!main || !(content instanceof HTMLElement)) throw new Error('ability layout is incomplete');
			return { mainWidth: main.width, noHorizontalOverflow: content.scrollWidth <= content.clientWidth };
		});
		expect(mobileLayout.mainWidth).toBeGreaterThan(120);
		expect(mobileLayout.noHorizontalOverflow).toBe(true);
		await page.setViewportSize({ width: 1280, height: 800 });
		const desktopCenters = await rootBuild.locator('.ability-row').first().evaluate((row) => {
			const help = row.querySelector('.help-trigger')?.getBoundingClientRect();
			const rank = row.querySelector('.rank-controls button')?.getBoundingClientRect();
			if (!help || !rank) throw new Error('ability controls are incomplete');
			return { helpCenter: help.top + help.height / 2, rankCenter: rank.top + rank.height / 2 };
		});
		expect(Math.abs(desktopCenters.helpCenter - desktopCenters.rankCenter)).toBeLessThanOrEqual(1);
		await expect.poll(async () => rootBuild.locator('.help-trigger').evaluateAll((elements) => elements.every((element) => {
			const rect = element.getBoundingClientRect();
			return rect.width >= 44 && rect.height >= 44;
		}))).toBe(true);
		await expect.poll(async () => rootBuild.locator('.rank-controls button').first().evaluate((element) => {
			const rect = element.getBoundingClientRect();
			return rect.width >= 44 && rect.height >= 44;
		})).toBe(true);
		const selectionContent = page.locator('.selection-content');
		await selectionContent.evaluate((element) => { element.scrollTop = element.scrollHeight - element.clientHeight; });
		const help = rootBuild.getByRole('button', { name: '推論加速の詳細' });
		await help.scrollIntoViewIfNeeded();
		const scrollBeforeHelp = await selectionContent.evaluate((element) => element.scrollTop);
		await help.click();
		await expect(page.locator('.help-content')).toBeVisible();
		await expect.poll(async () => selectionContent.evaluate((element) => element.scrollTop)).toBe(scrollBeforeHelp);
		await expect.poll(async () => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('推論加速の詳細');
		await help.click();
		await expect(page.locator('.help-content')).toHaveCount(0);
		await expect.poll(async () => selectionContent.evaluate((element) => element.scrollTop)).toBe(scrollBeforeHelp);
		await help.focus();
		await page.keyboard.press('Enter');
		await expect(page.locator('.help-content')).toBeVisible();
		await expect.poll(async () => selectionContent.evaluate((element) => element.scrollTop)).toBe(scrollBeforeHelp);
		await expect.poll(async () => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('推論加速の詳細');
		await page.keyboard.press('Escape');
		await expect(rootBuild).not.toContainText('Rank 3: ×2.00');
		await page.getByRole('button', { name: /を選ぶ$/ }).first().click();
		const rankRows = page.locator('.ability-row');
		for (let index = 0; index < 3; index += 1) {
			await rankRows.nth(index).getByRole('button', { name: /を上げる$/ }).click();
		}
		await expect.poll(async () => page.locator('.rank-controls button[aria-label$="を上げる"]').evaluateAll((buttons) => buttons.every((button) => (button as HTMLButtonElement).disabled))).toBe(true);
		await expect(page.getByRole('button', { name: 'Runを開始' })).toBeEnabled();
		await startSelectedRun(page);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator('.participant[data-self="true"]')).toBeVisible();
	});

	test('reuses a completed anonymous world session after Identity selection', async ({ page }) => {
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await page.goto('/');
		const candidateButtons = page.getByRole('button', { name: /を選ぶ$/ });
		await expect(candidateButtons).toHaveCount(3);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.filter((request) =>
			request.filter.limit === undefined && [42, WORLD_STATE_KIND].includes(requestKind(request)!)).length).toBeGreaterThan(0);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			request.filter.limit === undefined && requestKind(request) === WORLD_STATE_KIND)).toBe(true);
		const requestsBeforeSelection = await relayState(page);
		const countBootstrapRequests = (requests: typeof requestsBeforeSelection.state.requests) => ({
			metadata: requests.filter((request) => [40, 41].includes(requestKind(request)!)).length,
				primary: requests.filter((request) => request.filter.limit === undefined && [42, WORLD_STATE_KIND].includes(requestKind(request)!)).length
		});
		const countsBeforeSelection = countBootstrapRequests(requestsBeforeSelection.state.requests);
		await candidateButtons.nth(0).click();
		await startSelectedRun(page);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.locator('.participant[data-self="true"]')).toBeVisible();
		expect(countBootstrapRequests((await relayState(page)).state.requests)).toEqual(countsBeforeSelection);
	});

	test('enters a selected identity before delayed Trace promotion and settles the existing ordering afterward', async ({ page }) => {
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { deferTraceRoots: true });
		await page.goto('/');
		const candidateButtons = page.getByRole('button', { name: /を選ぶ$/ });
		await expect(candidateButtons).toHaveCount(3);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => request.filter.limit === undefined && [42, WORLD_STATE_KIND].includes(requestKind(request)!))).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => request.filter.limit === undefined && requestKind(request) === WORLD_STATE_KIND)).toBe(true);
		const beforeSelection = await relayState(page);
		const bootstrapCounts = (requests: typeof beforeSelection.state.requests) => ({
			metadata: requests.filter((request) => [40, 41].includes(requestKind(request)!)).length,
				primary: requests.filter((request) => request.filter.limit === undefined && [42, WORLD_STATE_KIND].includes(requestKind(request)!)).length
		});
		const countsBeforeSelection = bootstrapCounts(beforeSelection.state.requests);

		await candidateButtons.nth(0).click();
		await startSelectedRun(page);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.locator('.participant[data-self="true"]')).toBeVisible();
		const selectedPubkey = await page.locator('.participant[data-self="true"]').getAttribute('data-participant-id');
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === WORLD_STATE_KIND && event.pubkey === selectedPubkey)).toBe(true);
		expect(bootstrapCounts((await relayState(page)).state.requests)).toEqual(countsBeforeSelection);

		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseTraceRoots(): void } }).__relayStartupTest.releaseTraceRoots());
		await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).length).toBeGreaterThan(0);
	});

	test('clears an anonymous startup error before fresh signed fallback recovery', async ({ page }) => {
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await page.goto('/');
		const candidateButtons = page.getByRole('button', { name: /を選ぶ$/ });
		await expect(candidateButtons).toHaveCount(3);
		const metadataRequestsBeforeSelection = (await relayState(page)).state.requests.filter((request) => [40, 41].includes(requestKind(request)!)).length;
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { failMetadataDiscovery(): void } }).__relayStartupTest.failMetadataDiscovery());
		await candidateButtons.nth(0).click();
		await startSelectedRun(page);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect.poll(async () => (await relayState(page)).state.requests.filter((request) => [40, 41].includes(requestKind(request)!)).length)
			.toBeGreaterThan(metadataRequestsBeforeSelection);
		await expect(page.locator('.participant[data-self="true"]')).toBeVisible();
		const selectedPubkey = await page.locator('.participant[data-self="true"]').getAttribute('data-participant-id');
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await editor.fill('fresh signed fallback remains publishable');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect.poll(async () => (await relayState(page)).state.published.some((event) =>
			event.kind === 42 && event.pubkey === selectedPubkey && event.content === 'fresh signed fallback remains publishable')).toBe(true);
	});

	test('scrolls an overflowing mobile identity selection to the last candidate', async ({ page }) => {
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await page.goto('/');

		const dialog = page.locator('.selection-dialog');
		const candidateButtons = page.getByRole('button', { name: /を選ぶ$/ });
		await expect(candidateButtons).toHaveCount(3);
		await page.setViewportSize({ width: 420, height: 420 });
		await page.locator('.candidate-about').nth(1).evaluate((element) => {
			element.textContent = '長いプロフィール。'.repeat(160);
		});

		const content = page.locator('.selection-content');
		const footer = page.locator('.selection-footer');
		const before = await dialog.evaluate((element) => {
			const content = element.querySelector('.selection-content');
			const footer = element.querySelector('.selection-footer');
			if (!(content instanceof HTMLElement) || !(footer instanceof HTMLElement)) throw new Error('selection layout is incomplete');
			const dialogRect = element.getBoundingClientRect();
			const footerRect = footer.getBoundingClientRect();
			return {
				dialogInsideViewport: dialogRect.top >= 0 && dialogRect.bottom <= window.innerHeight && dialogRect.left >= 0 && dialogRect.right <= window.innerWidth,
				contentScrollable: content.scrollHeight > content.clientHeight,
				contentScrollTop: content.scrollTop,
				footerBottom: footerRect.bottom,
				footerHeight: footerRect.height
			};
		});
		expect(before.dialogInsideViewport).toBe(true);
		expect(before.contentScrollable).toBe(true);
		expect(before.footerBottom).toBeLessThanOrEqual(420);
		await candidateButtons.nth(2).scrollIntoViewIfNeeded();
		await expect(candidateButtons.nth(2)).toBeVisible();
		const afterScroll = await content.evaluate((element) => ({ scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
		expect(afterScroll.scrollTop).toBeGreaterThan(0);
		expect(afterScroll.scrollTop).toBeLessThanOrEqual(afterScroll.scrollHeight - afterScroll.clientHeight);
		await expect(footer).toBeVisible();
		await expect(page.getByRole('button', { name: 'Runを開始' })).toBeVisible();
		const footerAfterScroll = await footer.boundingBox();
		expect(footerAfterScroll).not.toBeNull();
		expect(footerAfterScroll!.y + footerAfterScroll!.height).toBeLessThanOrEqual(420);
		await candidateButtons.nth(2).click();
		await startSelectedRun(page);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator('.participant[data-self="true"]')).toBeVisible();
	});

	test('starts identity selection with the heading focused and keeps candidate keyboard selection available', async ({ page }) => {
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await page.goto('/');

		const dialog = page.locator('.selection-dialog');
		const candidates = page.getByRole('button', { name: /を選ぶ$/ });
		const runButton = page.getByRole('button', { name: 'Runを開始' });
		await expect(candidates).toHaveCount(3);
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole('heading', { name: 'Runを始める' })).toBeFocused();
		await expect(candidates).toHaveCount(3);
		await expect(dialog.locator('.candidate.chosen')).toHaveCount(0);
		await expect(dialog.locator('.candidate-check')).toHaveCount(0);
		await expect(dialog).toContainText('選択中未選択');
		await expect(runButton).toBeDisabled();

		await page.keyboard.press('Shift+Tab');
		await expect(dialog.getByRole('button', { name: /Root build/ })).toBeFocused();
		await dialog.getByRole('heading', { name: 'Runを始める' }).focus();
		await page.keyboard.press('Tab');
		await expect(candidates.first()).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(candidates.first()).toHaveClass(/chosen/);
		await expect(dialog.locator('.candidate-check')).toHaveCount(1);
		await expect(dialog).not.toContainText('選択中未選択');
		await expect(runButton).toBeEnabled();
	});

	for (const viewport of [{ width: 1280, height: 800 }, { width: 420, height: 800 }]) {
		test(`centers the identity selection dialog at ${viewport.width}px`, async ({ page }) => {
			await installHostOwnedStub(page);
			await installDelayedRelay(page);
			await page.goto('/');
			await page.setViewportSize(viewport);
			const dialog = page.locator('.selection-dialog');
			await expect(dialog).toBeVisible();
			const metrics = await dialog.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				return { centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2, width: rect.width, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
			});
			expect(Math.abs(metrics.centerX - metrics.viewportWidth / 2)).toBeLessThanOrEqual(8);
			expect(metrics.centerY).toBeGreaterThan(0);
			expect(metrics.centerY).toBeLessThan(metrics.viewportHeight);
			expect(metrics.width).toBeLessThanOrEqual(metrics.viewportWidth);
			expect(metrics.centerX - metrics.width / 2).toBeGreaterThanOrEqual(0);
			expect(metrics.centerX + metrics.width / 2).toBeLessThanOrEqual(metrics.viewportWidth);
		});
	}

	test('converges two tabs selecting different candidates on one Identity', async ({ page }) => {
		const other = await page.context().newPage();
		try {
			await Promise.all([page, other].map(async (client) => {
				await installHostOwnedStub(client);
				await installDelayedRelay(client);
				await client.goto('/');
				await expect(client.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
			}));
			await page.getByRole('button', { name: /を選ぶ$/ }).nth(0).click();
			await startSelectedRun(page);
			await expect(page.getByRole('dialog')).toHaveCount(0);
			await other.getByRole('button', { name: /を選ぶ$/ }).nth(1).click();
			await startSelectedRun(other);
			await expect.poll(async () => page.evaluate(async () => {
				const database = await new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open('persona-bubble-field-account');
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				});
				try {
					const request = database.transaction('persona-bubble-field-player-state').objectStore('persona-bubble-field-player-state').get('player-lifecycle');
					return await new Promise<{ identities: number; mode: string }>((resolve, reject) => {
						request.onsuccess = () => resolve({ identities: (request.result as { identities: unknown[] }).identities.length, mode: (request.result as { mode: { kind: string } }).mode.kind });
						request.onerror = () => reject(request.error);
					});
				} finally { database.close(); }
			})).toEqual({ identities: 1, mode: 'running' });
		} finally {
			await other.close();
		}
	});
});
