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
import { CHANNEL_ID, AUTHORITATIVE_RELAYS, fixtureSecret, traceRuntimeEvents, installDelayedRelay, relayState, relayFieldCellCenter, selectRelayTraceCell, clickRelayLogicalCell, dragRelayJoystick, pauseAtCurrentBrowserTime, installPromptApiStub, seedRelayAccount, composerContextCalls } from './helpers/relayHarness';


test.describe('Relay startup', () => {
	test('shows published Trace replies to a fresh client through Relay history and live delivery', async ({ page: sender, browser }) => {
		const time = Date.now();
		const trace = traceRuntimeEvents();
		const readerContext = await browser.newContext({ viewport: { width: 1100, height: 850 } });
		try {
			const reader = await readerContext.newPage();
			const readerSecret = fixtureSecret(43);
			const readerPubkey = getPublicKey(readerSecret);
			expect(readerPubkey).not.toBe(trace.selfPubkey);
			const readerPosition = finalizeEvent(buildWorldStateEventTemplate({
				channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 3, y: 2 }, slot: 0, createdAt: trace.selfPosition.created_at
			}), readerSecret);
			const openClient = async (client: Page, secret: Uint8Array, pubkey: string, position: NostrEvent, history: NostrEvent[]) => {
				await client.clock.setFixedTime(time);
				await client.emulateMedia({ reducedMotion: 'reduce' });
				await client.setViewportSize({ width: 1100, height: 850 });
				await installHostOwnedStub(client);
				await installDelayedRelay(client, { primaryEvents: { message: trace.message, position }, traceRoots: [trace.root], traceReplies: history });
				await seedRelayAccount(client, secret, pubkey);
				await client.goto('/');
				await expect(client.locator('.action-dock')).toBeVisible();
				await client.evaluate(() => {
					const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
					relay.releaseMetadata(); relay.releasePrimary();
				});
				await expect(client.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');
				await client.locator('.chatter-toggle').click();
				await expect(client.locator('[data-trace-marker-position="4,2"]')).toBeVisible();
			};
			const publish = async (content: string) => {
				const openRoot = sender.locator(`[data-trace-root-id="${trace.root.id}"]`);
				if (await openRoot.isVisible()) {
					// After the first publish, the open root keeps its conversation visible while
					// its light and logical-cell trigger remain hidden. Re-select the root through
					// its visible native button to establish the next reply target.
					await openRoot.click();
				} else {
					await selectRelayTraceCell(sender, '4,2');
				}
				await expect(sender.getByLabel('Reply preview', { exact: true })).toHaveAttribute('data-reply-id', trace.root.id);
				const editor = sender.getByRole('textbox', { name: '投稿エディター' });
				await editor.fill(content);
				await editor.press('Enter');
				await expect(editor).toHaveValue('');
				// Only the signed EVENT received on the publish wire crosses clients.
				const raw = (await relayState(sender)).state.published.find((event) => event.kind === 1111 && event.content === content) as NostrEvent;
				expect(verifyEvent(raw)).toBe(true);
				return raw;
			};
			await openClient(sender, trace.selfSecret, trace.selfPubkey, trace.selfPosition, []);
			const history = await publish('cross-client history reply');
			await openClient(reader, readerSecret, readerPubkey, readerPosition, [history]);
			const cachedIds = () => reader.evaluate(async () => {
				const db = await new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open('persona-bubble-field-trace');
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				});
				try {
					return await new Promise<string[]>((resolve, reject) => {
						const request = db.transaction('trace-replies').objectStore('trace-replies').getAll();
						request.onsuccess = () => resolve(request.result.map((record) => record.eventId));
						request.onerror = () => reject(request.error);
					});
				} finally { db.close(); }
			});
			expect(await cachedIds()).toEqual([]);
			await selectRelayTraceCell(reader, '4,2');
			await expect(reader.locator(`[data-trace-reply-id="${history.id}"]`)).toContainText(history.content);
			await expect.poll(async () => (await relayState(reader)).state.requests.some((request) =>
				request.filters.length === 3 && request.filters.filter((filter) => (filter.kinds as number[])?.includes(1111) && filter.limit === 100).length === 2
			)).toBe(true);
			const wire = (await relayState(reader)).state.requests.find((request) => request.filters.length === 3 && request.filters.filter((filter) => filter.limit === 100).length === 2)!;
			expect(wire.filters.find((filter) => Array.isArray(filter['#E']))?.['#E']).toEqual([trace.root.id]);
			expect(wire.filters.find((filter) => Array.isArray(filter['#e']))?.['#e']).toEqual([trace.root.id]);
			expect(wire.filters.find((filter) => Array.isArray(filter['#p']))).toMatchObject({ '#p': [readerPubkey] });
			expect(wire.filters.find((filter) => Array.isArray(filter['#p']))).not.toHaveProperty('#E');
			await sender.clock.setFixedTime(time + 1000);
			await sender.getByRole('textbox', { name: '投稿エディター' }).press('Escape');
			await sender.keyboard.press('ArrowUp');
			await expect(sender.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,1');
			const live = await publish('cross-client live reply');
			expect(live.id).not.toBe(history.id);
			const wrongRoot = finalizeEvent({
				kind: live.kind, created_at: live.created_at, content: 'wrong-root candidate',
				tags: live.tags.map((tag) => tag[0] === 'E' ? ['E', 'f'.repeat(64), '', trace.root.pubkey] : tag)
			}, trace.selfSecret);
			expect(parseTraceReplyCandidate(wrongRoot)).not.toBeNull();
			await reader.evaluate((event) => (window as unknown as { __relayStartupTest: { injectTraceReply(event: object): void } }).__relayStartupTest.injectTraceReply(event), wrongRoot);
			await reader.evaluate((event) => (window as unknown as { __relayStartupTest: { injectTraceReply(event: object): void } }).__relayStartupTest.injectTraceReply(event), live);
			await expect(reader.locator(`[data-trace-reply-id="${live.id}"]`)).toContainText(live.content);
			const received = await reader.evaluate(() => (window as unknown as { __relayStartupTest: { state: { traceDeliveries: string[] } } }).__relayStartupTest.state.traceDeliveries);
			expect(received).toEqual(expect.arrayContaining([history.id, wrongRoot.id, live.id]));
			await expect.poll(cachedIds).toEqual(expect.arrayContaining([history.id, live.id]));
			expect(await cachedIds()).not.toContain(wrongRoot.id);
			await expect(reader.locator(`[data-trace-reply-id="${wrongRoot.id}"]`)).toHaveCount(0);
			await expect(reader.locator('[data-trace-current-id]')).toHaveAttribute('data-trace-current-id', trace.root.id);
		} finally { await readerContext.close(); }
	});

	test('persists Trace root and reply read state and keeps notification generic', async ({ page }) => {
		const now = Date.now();
		const selfSecret = fixtureSecret(23);
		const selfPubkey = getPublicKey(selfSecret);
		const channel = { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' };
		const primary = {
			message: finalizeEvent(buildWorldMessageTemplate({ channel, content: 'read-state participant', speechType: 'normal', position: { x: 3, y: 2 }, createdAt: Math.floor(now / 1000) }), selfSecret),
			position: finalizeEvent(buildWorldStateEventTemplate({ channel, position: { x: 3, y: 2 }, slot: 0, createdAt: Math.floor(now / 1000) }), selfSecret)
		};
		let root = finalizeEvent(buildWorldMessageTemplate({ channel, content: 'read-state root 0', speechType: 'normal', position: { x: 4, y: 2 }, createdAt: Math.floor(now / 1000) }), selfSecret);
		for (let attempt = 1; BigInt(`0x${root.id}`) % 5n !== 0n; attempt += 1) {
			root = finalizeEvent(buildWorldMessageTemplate({ channel, content: `read-state root ${attempt}`, speechType: 'normal', position: { x: 4, y: 2 }, createdAt: Math.floor(now / 1000) }), selfSecret);
		}
		const parsedRoot = parseWorldMessage(root, CHANNEL_ID);
		if (!parsedRoot) throw new Error('Read-state root fixture did not parse.');
		let unreadRoot = finalizeEvent(buildWorldMessageTemplate({ channel, content: 'read-state unread root', speechType: 'normal', position: { x: 5, y: 2 }, createdAt: Math.floor(now / 1000) }), selfSecret);
		for (let attempt = 1; BigInt(`0x${unreadRoot.id}`) % 5n !== 0n; attempt += 1) {
			unreadRoot = finalizeEvent(buildWorldMessageTemplate({ channel, content: `read-state unread root ${attempt}`, speechType: 'normal', position: { x: 5, y: 2 }, createdAt: Math.floor(now / 1000) }), selfSecret);
		}
		const deathRoot = finalizeEvent(buildDeathTraceEventTemplate({
			channel,
			content: 'read-state death trace',
			position: { x: 6, y: 2 },
			createdAt: Math.floor(now / 1000)
		}), fixtureSecret(37));
		const reply = finalizeEvent(buildTraceReplyTemplate({ root: parsedRoot, parent: parsedRoot, content: 'private reply detail', speechType: 'normal', createdAt: Math.floor(now / 1000) + 1 }), fixtureSecret(31));
		const replyAfterRootRead = finalizeEvent(buildTraceReplyTemplate({ root: parsedRoot, parent: parsedRoot, content: 'private reply after root read', speechType: 'normal', createdAt: Math.floor(now / 1000) + 2 }), fixtureSecret(32));
		await page.clock.setFixedTime(now);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize({ width: 1100, height: 850 });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: primary, traceRoots: [root, unreadRoot, deathRoot], traceReplies: [reply] });
		await seedRelayAccount(page, selfSecret, selfPubkey);
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toBeVisible();
		const unreadMarker = page.locator('[data-trace-marker-position="5,2"]');
		await expect(unreadMarker).toBeVisible();
		const deathMarker = page.locator('[data-trace-marker-position="6,2"]');
		await expect(deathMarker).toHaveAttribute('data-trace-marker-kind', 'death');
		await expect(deathMarker).toHaveCSS('mask-image', /trace-death-icon\.svg/);
		await expect(deathMarker).toHaveCSS('color', 'rgb(82, 104, 134)');
		await expect(unreadMarker).toHaveAttribute('data-trace-marker-kind', 'normal');
		await expect(unreadMarker).toHaveCSS('mask-image', /trace-icon\.svg/);
		await expect(unreadMarker).toHaveCSS('color', 'rgb(82, 104, 134)');
		await expect(unreadMarker).toHaveCSS('opacity', '0.72');
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toHaveCSS('mask-image', /trace-icon\.svg/);
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toHaveAttribute('data-trace-marker-kind', 'normal');
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toHaveCSS('color', 'rgb(207, 6, 254)');
		await expect(page.locator('.trace-unread-indicator')).toBeVisible();
		await page.locator('.trace-unread-indicator').click();
		await expect(page.locator('.trace-unread-explanation')).toContainText('どこかにあなたへの返信の痕跡があります');
		await expect(page.locator('[data-trace-root-id]')).toHaveCount(0);
		await page.locator('.chatter-toggle').click();
		await selectRelayTraceCell(page, '4,2');
		await expect(page.locator(`[data-trace-root-id="${root.id}"]`)).toContainText(root.content);
		await expect(page.locator(`[data-trace-root-id="${root.id}"]`)).toHaveAttribute('data-trace-current-kind', 'root');
		await expect(page.locator(`[data-trace-ghost-root-id="${root.id}"]`)).toBeVisible();
		await expect(page.locator(`[data-trace-reply-id="${reply.id}"]`)).toContainText(reply.content);
		await expect(page.locator('.trace-unread-indicator')).toHaveCount(0);
		await clickRelayLogicalCell(page, { x: 0, y: 0 });
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toHaveAttribute('data-trace-root-read', 'true');
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toHaveCSS('mask-image', /trace-icon\.svg/);
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toHaveCSS('color', 'rgb(82, 104, 134)');
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toHaveCSS('opacity', '0.66');
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toHaveCSS('filter', 'grayscale(1) brightness(1.12)');
		await expect(deathMarker).toHaveCSS('opacity', '0.72');
		await page.reload();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toBeVisible();
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toHaveAttribute('data-trace-root-read', 'true');
		await expect(page.locator('.trace-unread-indicator')).toHaveCount(0);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectTraceReply(event: object): void } }).__relayStartupTest.injectTraceReply(event), replyAfterRootRead);
		const marker = page.locator('[data-trace-marker-position="4,2"]');
		await expect(marker).toHaveAttribute('data-trace-root-read', 'true');
		await expect(marker).toHaveAttribute('data-trace-root-unread-reply', 'true');
		await expect(marker).toHaveCSS('mask-image', /trace-icon\.svg/);
		await expect(marker).toHaveCSS('color', 'rgb(207, 6, 254)');
		await expect(marker).toHaveCSS('opacity', '0.72');
		await expect(marker).toHaveCSS('filter', 'none');
		await expect(page.locator('.trace-unread-indicator')).toBeVisible();
		await selectRelayTraceCell(page, '4,2');
		await expect(page.locator(`[data-trace-reply-id="${replyAfterRootRead.id}"]`)).toContainText(replyAfterRootRead.content);
		const hideTimeline = page.locator('.chatter-toggle');
		if (await hideTimeline.isVisible()) await hideTimeline.click();
		await clickRelayLogicalCell(page, { x: 0, y: 0 });
		await expect(marker).toHaveAttribute('data-trace-root-read', 'true');
		await expect(marker).not.toHaveAttribute('data-trace-root-unread-reply');
		await expect(marker).toHaveCSS('mask-image', /trace-icon\.svg/);
		await expect(marker).toHaveCSS('color', 'rgb(82, 104, 134)');
		await expect(marker).toHaveCSS('opacity', '0.66');
		await expect(marker).toHaveCSS('filter', 'grayscale(1) brightness(1.12)');
	});

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

	test('passes target-author character profiles across root, nested reply, and clear context patches', async ({ page }) => {
		const trace = traceRuntimeEvents();
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize({ width: 1100, height: 850 });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: { message: trace.message, position: trace.selfPosition }, traceRoots: [trace.root], traceReplies: [trace.direct, trace.deeper] });
		await seedRelayAccount(page, trace.selfSecret, trace.selfPubkey);
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void; releaseTraceRoots(): void; releaseTraceReplies(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary(); relay.releaseTraceRoots(); relay.releaseTraceReplies();
		});
		await expect(page.locator('.participant')).toHaveCount(2);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');
		await page.locator('.chatter-toggle').click();
		await page.locator('[data-cell-position="4,2"]').click();
		await expect(page.getByLabel('Reply preview', { exact: true })).toContainText('Relay trace root');

		const rootCharacter = requireCharacterFromPubkey(trace.root.pubkey);
		const rootCalls = await composerContextCalls(page);
		const rootCall = [...rootCalls].reverse().find((call) => call.preloadedEvents?.[trace.root.id]);
		expect(rootCall?.preloadedEvents?.[trace.root.id]?.pubkey).toBe(trace.root.pubkey);
		expect(rootCall?.preloadedProfiles?.[trace.root.pubkey]?.displayName).toBe(rootCharacter.name);
		expect(rootCall?.preloadedProfiles?.[trace.root.pubkey]?.picture).toBe(
			new URL(`/characters/${characterPicturePath(rootCharacter.characterId).split('/').at(-1)}`, page.url()).toString()
		);
		expect(rootCall?.preloadedProfiles?.[trace.root.pubkey]?.picture).toMatch(/^https?:\/\//);

		await page.locator(`[data-trace-reply-id="${trace.direct.id}"] .trace-reply-content-button`).click();
		await expect(page.getByLabel('Reply preview', { exact: true })).toContainText('Relay direct reply');
		const replyCharacter = requireCharacterFromPubkey(trace.direct.pubkey);
		const replyCalls = await composerContextCalls(page);
		const replyCall = [...replyCalls].reverse().find((call) => call.preloadedEvents?.[trace.direct.id]);
		expect(replyCall?.preloadedEvents?.[trace.direct.id]?.pubkey).toBe(trace.direct.pubkey);
		expect(replyCall?.preloadedProfiles?.[trace.direct.pubkey]?.displayName).toBe(replyCharacter.name);
		expect(replyCall?.preloadedProfiles?.[trace.direct.pubkey]?.picture).toBe(
			new URL(`/characters/${characterPicturePath(replyCharacter.characterId).split('/').at(-1)}`, page.url()).toString()
		);
		expect(replyCall?.preloadedProfiles).not.toHaveProperty(trace.root.pubkey);

		await page.getByRole('button', { name: 'Clear reply', exact: true }).click();
		await expect(page.getByLabel('Reply preview', { exact: true })).toHaveCount(0);
		const clearCall = (await composerContextCalls(page)).at(-1);
		expect(clearCall?.reply).toBeNull();
		expect(clearCall?.preloadedProfiles).toBeUndefined();
	});

	test('directly sends an AI candidate as a Trace reply using the selected root and target', async ({ page }) => {
		const trace = traceRuntimeEvents();
		await installPromptApiStub(page);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize({ width: 1100, height: 850 });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: { message: trace.message, position: trace.selfPosition }, traceRoots: [trace.root], traceReplies: [trace.direct] });
		await seedRelayAccount(page, trace.selfSecret, trace.selfPubkey);
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void; releaseTraceRoots(): void; releaseTraceReplies(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary(); relay.releaseTraceRoots(); relay.releaseTraceReplies();
		});
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');
		await page.locator('.chatter-toggle').click();
		await page.locator('[data-cell-position="4,2"]').click();
		await expect(page.getByLabel('Reply preview', { exact: true })).toContainText('Relay trace root');
		await page.locator(`[data-trace-reply-id="${trace.direct.id}"] .trace-reply-content-button`).click();
		await expect(page.getByLabel('Reply preview', { exact: true })).toContainText('Relay direct reply');
		const candidateButton = page.getByRole('button', { name: 'AI発言候補を生成' });
		await expect(candidateButton).toBeVisible();
		await candidateButton.click();
		const primary = page.locator('.suggestion-primary').first();
		await expect(primary).toBeVisible();
		await primary.click();
		const directReplies = async () => [...new Map(
			(await relayState(page)).state.published
				.filter((event) => event.kind === 1111 && event.content === 'まずは自然な返答です。')
				.map((event) => [event.id, event])
		)].map(([, event]) => event);
		await expect.poll(directReplies).toHaveLength(1);
		const reply = (await directReplies())[0];
		expect(reply.tags).toEqual(expect.arrayContaining([
			['E', trace.root.id, '', trace.root.pubkey], ['e', trace.direct.id, '', trace.direct.pubkey], ['k', '1111']
		]));
		expect(reply.tags.some((tag) => tag[0] === 'w')).toBe(false);
		await expect(page.getByRole('textbox', { name: '投稿エディター' })).toHaveValue('');
		await expect(page.locator('.suggestion-panel')).toHaveCount(0);
	});

	test('rejects mismatched structured reply output before position or message publication', async ({ page }) => {
		const trace = traceRuntimeEvents();
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize({ width: 1100, height: 850 });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: { message: trace.message, position: trace.selfPosition }, traceRoots: [trace.root] });
		await seedRelayAccount(page, trace.selfSecret, trace.selfPubkey);
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');
		await page.locator('.chatter-toggle').click();
		await page.locator('[data-cell-position="4,2"]').click();
		const editor = page.getByRole('textbox', { name: '投稿エディター' });
		const preview = page.getByLabel('Reply preview', { exact: true });
		await expect(preview).toContainText('Relay trace root');
		const before = (await relayState(page)).state.published.length;
		let terminals = 0;
		for (const target of ['f'.repeat(64), null]) {
			await page.evaluate((eventId) => {
				(window as unknown as { __ehagakiSubmitReplyOverride: unknown }).__ehagakiSubmitReplyOverride = eventId === null ? null : { eventId, relayHints: [], authorPubkey: null };
			}, target);
			await editor.fill('retain mismatched draft');
			await editor.press('Enter');
			await expect.poll(() => page.evaluate(() => (window as unknown as { __ehagakiTerminalCount: number }).__ehagakiTerminalCount)).toBe(++terminals);
			await expect(editor).toHaveValue('retain mismatched draft');
			await expect(preview).toHaveAttribute('data-reply-id', trace.root.id);
			expect((await relayState(page)).state.published).toHaveLength(before);
		}
		await page.getByRole('button', { name: 'Clear reply', exact: true }).click();
		await page.evaluate((eventId) => {
			(window as unknown as { __ehagakiSubmitReplyOverride: unknown }).__ehagakiSubmitReplyOverride = { eventId, relayHints: [], authorPubkey: null };
		}, trace.root.id);
		await editor.press('Enter');
		await expect.poll(() => page.evaluate(() => (window as unknown as { __ehagakiTerminalCount: number }).__ehagakiTerminalCount)).toBe(++terminals);
		expect((await relayState(page)).state.published).toHaveLength(before);
		await expect(editor).toHaveValue('retain mismatched draft');
	});

	for (const outcome of ['accepted', 'duplicate', 'rejected'] as const) {
		test(`publishes a Trace reply with ${outcome} and quarantines echo before OK`, async ({ page }) => {
			const time = Date.now();
			const trace = traceRuntimeEvents();
			await page.clock.setFixedTime(time);
			await page.emulateMedia({ reducedMotion: 'reduce' });
			await page.setViewportSize({ width: 1100, height: 850 });
			await installHostOwnedStub(page);
			await installDelayedRelay(page, { primaryEvents: { message: trace.message, position: trace.selfPosition }, traceRoots: [trace.root] });
			await seedRelayAccount(page, trace.selfSecret, trace.selfPubkey);
			await page.goto('/');
			await page.evaluate(() => {
				const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
				relay.releaseMetadata(); relay.releasePrimary();
			});
			await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');
			await page.locator('.chatter-toggle').click();
			await page.locator('[data-cell-position="4,2"]').click();
			const preview = page.getByLabel('Reply preview', { exact: true });
			const editor = page.getByRole('textbox', { name: '投稿エディター' });
			await expect(preview).toContainText('Relay trace root');
			await expect(editor).not.toBeFocused();
			await page.clock.setFixedTime(time + 1000);
			await page.evaluate((outcome) => Object.assign((window as unknown as {
				__relayStartupTest: { state: Record<string, unknown> }
			}).__relayStartupTest.state, { deferReplyPublishes: true, echoRepliesBeforeResult: true, replyOutcome: outcome }), outcome);
			await editor.fill('own Trace shout');
			await editor.press('Control+Enter');
			await expect.poll(async () => (await relayState(page)).state.published.filter((event) => event.kind === 1111).length).toBeGreaterThan(0);
			const raw = (await relayState(page)).state.published.find((event) => event.kind === 1111)!;
			expect(raw.tags).toEqual(expect.arrayContaining([
				['E', trace.root.id, '', trace.root.pubkey], ['e', trace.root.id, '', trace.root.pubkey], ['k', '42']
			]));
			expect(raw.tags.some((tag) => tag[0] === 'w')).toBe(false);
			const bubble = page.locator(`[data-trace-reply-id="${raw.id}"]`);
			await expect(bubble).toHaveCount(0);
			await expect(editor).toHaveValue('own Trace shout');
			const positionsBefore = (await relayState(page)).state.published.filter((event) => event.kind === WORLD_STATE_KIND).length;
			await editor.press('Escape');
			await page.keyboard.press('ArrowRight');
			await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');
			expect((await relayState(page)).state.published.filter((event) => event.kind === WORLD_STATE_KIND)).toHaveLength(positionsBefore);
			await page.evaluate(() => (window as unknown as { __relayStartupTest: { releasePublishes(kind: number): void } }).__relayStartupTest.releasePublishes(1111));
			await expect.poll(() => page.evaluate(() => (window as unknown as { __ehagakiTerminalCount: number }).__ehagakiTerminalCount)).toBe(1);
			if (outcome === 'rejected') {
				await expect(editor).toHaveValue('own Trace shout');
				await expect(bubble).toHaveCount(0);
				await expect(preview).toHaveAttribute('data-reply-id', trace.root.id);
			} else {
				await expect(editor).toHaveValue('');
				await expect(preview).toHaveCount(0);
			}
			if (outcome !== 'rejected') {
				await expect(bubble).toContainText('own Trace shout');
				await expect(bubble).toHaveAttribute('data-speech-type', 'shout');
				await expect(page.locator('[data-trace-current-id]')).toHaveAttribute('data-trace-current-id', trace.root.id);
				await expect(page.locator(`[data-trace-reply-ghost-id="${raw.id}"]`)).toHaveCount(0);
			}
			if (outcome === 'rejected') await page.getByRole('button', { name: 'Clear reply', exact: true }).click();
			await editor.fill('normal kind 42 after reply mode');
			await editor.press('Enter');
			await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 42 && event.content === 'normal kind 42 after reply mode')).toBe(true);
		});
	}

	test('opens a Relay trace root and settles the explicit conversation reply subscription', async ({ page }) => {
		const trace = traceRuntimeEvents();
		await installHostOwnedStub(page);
		await installDelayedRelay(page, {
			deferPrimaryEvents: true,
			primaryEvents: { message: trace.message, position: trace.selfPosition },
			traceRoots: [trace.root],
			deferTraceRoots: true,
			deferTraceReplies: true
		});
		await seedRelayAccount(page, trace.selfSecret, trace.selfPubkey);
		await page.goto('/');
		await expect(page.locator('main')).toHaveAttribute('data-trace-runtime', 'relay');
		const hideTimeline = page.locator('.chatter-toggle');
		if (await hideTimeline.isVisible()) await hideTimeline.click();

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

		await page.evaluate(() => {
			(window as typeof window & { __relayStartupTest: { state: { published: unknown[] } } }).__relayStartupTest.state.published.length = 0;
		});
		const publishedPositionIds = async () => new Set(
			(await relayState(page)).state.published.filter((event) => event.kind === WORLD_STATE_KIND).map((event) => event.id)
		).size;
		const positionsBefore = await publishedPositionIds();
		await dragRelayJoystick(page, { x: 24, y: -24 });
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '4,1');
		const positionsAfterMovement = await publishedPositionIds();
		expect(positionsAfterMovement).toBe(positionsBefore + 1);
		await page.locator('[data-cell-position="4,2"]').click();
		await expect(page.locator(`[data-trace-root-id="${trace.root.id}"]`)).toContainText('Relay trace root');
		await expect(page.locator('.trace-reply-status')).toHaveCount(0);
		await expect.poll(publishedPositionIds).toBeGreaterThanOrEqual(positionsAfterMovement);
		await expect.poll(publishedPositionIds).toBeLessThanOrEqual(positionsAfterMovement + 1);

		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			request.filters.some((filter) =>
				(filter.kinds as number[] | undefined)?.includes(1111) &&
				(filter['#E'] as string[] | undefined)?.includes(trace.root.id)
			) && request.filters.some((filter) =>
				(filter.kinds as number[] | undefined)?.includes(1111) &&
				!('#E' in filter) &&
				(filter['#e'] as string[] | undefined)?.includes(trace.root.id)
			)
		)).toBe(true);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releaseTraceReplies(): void }
		}).__relayStartupTest.releaseTraceReplies());
		await expect(page.locator('.trace-reply-status')).toHaveCount(0);
		await expect(page.locator(`[data-trace-root-id="${trace.root.id}"]`)).toBeVisible();
	});

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
