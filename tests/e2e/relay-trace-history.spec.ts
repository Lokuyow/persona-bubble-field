import { expect, test, type Page } from '@playwright/test';
import { finalizeEvent, getPublicKey, verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure';
import {
	buildWorldStateEventTemplate,
	buildDeathTraceEventTemplate,
	buildTraceReplyTemplate,
	buildWorldMessageTemplate,
	parseTraceReplyCandidate,
	parseTraceEvent,
	parseWorldMessage,
	validateTraceReplyCandidate
} from '../../src/lib/nostrProtocol';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { CHANNEL_ID, fixtureSecret, traceRuntimeEvents, installDelayedRelay, relayState, selectRelayTraceCell, clickRelayLogicalCell, installPromptApiStub, seedRelayAccount, readActionDockControlOrder } from './helpers/relayHarness';




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
					const relay = (window as unknown as { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
					relay.releasePrimary();
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
		await installPromptApiStub(page);
		await installDelayedRelay(page, { primaryEvents: primary, traceRoots: [root, unreadRoot, deathRoot], traceReplies: [reply] });
		await seedRelayAccount(page, selfSecret, selfPubkey);
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
			relay.releasePrimary();
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
		await page.locator('.trace-unread-indicator').hover();
		await expect(page.getByRole('tooltip')).toHaveText('未読の返信の痕跡');
		await expect(page.getByRole('button', { name: 'AI発言候補を生成' })).toBeVisible();
		expect(await readActionDockControlOrder(page)).toEqual([
			'profile-trigger', 'chatter-toggle', 'trace-unread-indicator', 'sound-control', 'speech-type-toggle', 'suggestions-anchor'
		]);
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
			const relay = (window as unknown as { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
			relay.releasePrimary();
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

	test('keeps the unread ActionDock order on mobile', async ({ page }) => {
		const now = Date.now();
		const selfSecret = fixtureSecret(23);
		const channel = { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' };
		const primary = {
			message: finalizeEvent(buildWorldMessageTemplate({ channel, content: 'mobile unread participant', speechType: 'normal', position: { x: 3, y: 2 }, createdAt: Math.floor(now / 1000) }), selfSecret),
			position: finalizeEvent(buildWorldStateEventTemplate({ channel, position: { x: 3, y: 2 }, slot: 0, createdAt: Math.floor(now / 1000) }), selfSecret)
		};
		let root = finalizeEvent(buildWorldMessageTemplate({ channel, content: 'mobile unread root', speechType: 'normal', position: { x: 4, y: 2 }, createdAt: Math.floor(now / 1000) }), selfSecret);
		for (let attempt = 1; BigInt(`0x${root.id}`) % 5n !== 0n; attempt += 1) {
			root = finalizeEvent(buildWorldMessageTemplate({ channel, content: `mobile unread root ${attempt}`, speechType: 'normal', position: { x: 4, y: 2 }, createdAt: Math.floor(now / 1000) }), selfSecret);
		}
		const parsedRoot = parseWorldMessage(root, CHANNEL_ID);
		if (!parsedRoot) throw new Error('Mobile unread root fixture did not parse.');
		const reply = finalizeEvent(buildTraceReplyTemplate({ root: parsedRoot, parent: parsedRoot, content: 'mobile unread reply', speechType: 'normal', createdAt: Math.floor(now / 1000) + 1 }), fixtureSecret(31));
		await page.clock.setFixedTime(now);
		await page.setViewportSize({ width: 390, height: 844 });
		await installHostOwnedStub(page);
		await installPromptApiStub(page);
		await installDelayedRelay(page, { primaryEvents: primary, traceRoots: [root], traceReplies: [reply] });
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
			relay.releasePrimary();
		});
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toBeVisible();
		await expect(page.locator('.trace-unread-indicator')).toBeVisible();
		await expect(page.getByRole('button', { name: 'AI発言候補を生成' })).toBeVisible();
		expect(await readActionDockControlOrder(page)).toEqual([
			'profile-trigger', 'chatter-toggle', 'trace-unread-indicator', 'sound-control', 'speech-type-toggle', 'suggestions-anchor'
		]);
	});

	test('opens death Last Words with the regular reply tree, publication, and semantic validation', async ({ page }) => {
		const now = Date.now();
		const trace = traceRuntimeEvents();
		const channel = { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' };
		const deathSecret = fixtureSecret(37);
		const deathRoot = finalizeEvent(buildDeathTraceEventTemplate({
			channel, content: 'Last Words root', position: { x: 4, y: 2 }, createdAt: Math.floor(now / 1000)
		}), deathSecret);
		const parsedDeath = parseTraceEvent(deathRoot, CHANNEL_ID);
		if (!parsedDeath || parsedDeath.source !== 'death') throw new Error('Death Trace fixture did not parse.');
		const direct = finalizeEvent(buildTraceReplyTemplate({
			root: parsedDeath, parent: parsedDeath, content: 'Last Words direct reply', speechType: 'normal', createdAt: Math.floor(now / 1000) + 1
		}), fixtureSecret(31));
		const parsedDirect = parseTraceReplyCandidate(direct);
		if (!parsedDirect) throw new Error('Death Trace direct reply fixture did not parse.');
		const validatedDirect = validateTraceReplyCandidate(parsedDirect, parsedDeath, parsedDeath);
		if (!validatedDirect) throw new Error('Death Trace direct reply fixture did not validate.');
		const nested = finalizeEvent(buildTraceReplyTemplate({
			root: parsedDeath, parent: validatedDirect, content: 'Last Words nested reply', speechType: 'shout', createdAt: Math.floor(now / 1000) + 2
		}), fixtureSecret(32));
		const wrongRoot = finalizeEvent({
			kind: nested.kind, created_at: nested.created_at, content: 'wrong death root',
			tags: nested.tags.map((tag) => tag[0] === 'E' ? ['E', 'f'.repeat(64), '', parsedDeath.pubkey] : tag)
		}, fixtureSecret(33));
		const wrongParent = finalizeEvent({
			kind: nested.kind, created_at: nested.created_at + 1, content: 'wrong death parent',
			tags: nested.tags.map((tag) => tag[0] === 'e' ? ['e', 'e'.repeat(64), '', 'd'.repeat(64)] : tag)
		}, fixtureSecret(34));
		await page.clock.setFixedTime(now);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize({ width: 1100, height: 850 });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, {
			primaryEvents: { message: trace.message, position: trace.selfPosition },
			traceRoots: [deathRoot], traceReplies: [direct, nested], deferTraceRoots: true
		});
		await seedRelayAccount(page, trace.selfSecret, trace.selfPubkey);
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await expect(page.locator('main')).toHaveAttribute('data-trace-runtime', 'relay');
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			(request.filter.kinds as number[] | undefined)?.includes(42) && request.filter.limit === 1000
		)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseTraceRoots(): void } }).__relayStartupTest.releaseTraceRoots());
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toBeVisible();
		await page.locator('.chatter-toggle').click();
		await selectRelayTraceCell(page, '4,2');
		const investigate = page.getByRole('button', { name: '痕跡を調べる', exact: true });
		if (await investigate.isVisible()) await investigate.click();
		await expect(page.locator(`[data-trace-root-id="${deathRoot.id}"]`)).toContainText('Last Words root');
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			request.filters.some((filter) => (filter['#E'] as string[] | undefined)?.includes(deathRoot.id)) &&
			request.filters.some((filter) => (filter['#e'] as string[] | undefined)?.includes(deathRoot.id))
		)).toBe(true);
		await expect(page.locator(`[data-trace-reply-id="${direct.id}"]`)).toContainText(direct.content);
		await page.locator(`[data-trace-reply-id="${direct.id}"] .trace-reply-content-button`).click();
		await expect(page.locator(`[data-trace-reply-id="${nested.id}"]`)).toContainText(nested.content);

		const editor = page.getByRole('textbox', { name: '投稿エディター' });
		await page.clock.setFixedTime(now + 5_000);
		await expect(page.getByLabel('Reply preview', { exact: true })).toHaveAttribute('data-reply-id', direct.id);
		await editor.fill('new nested reply');
		await editor.press('Enter');
		await expect.poll(async () => (await relayState(page)).state.published.find((event) => event.kind === 1111 && event.content === 'new nested reply')).toBeTruthy();
		const publishedNested = (await relayState(page)).state.published.find((event) => event.kind === 1111 && event.content === 'new nested reply')!;
		expect(publishedNested.tags).toEqual(expect.arrayContaining([
			['E', deathRoot.id, '', parsedDeath.pubkey], ['e', direct.id, '', direct.pubkey], ['k', '1111']
		]));

		await page.locator(`[data-trace-root-id="${deathRoot.id}"]`).click();
		await expect(page.getByLabel('Reply preview', { exact: true })).toHaveAttribute('data-reply-id', deathRoot.id);
		await editor.fill('new direct reply');
		await editor.press('Enter');
		await expect.poll(async () => (await relayState(page)).state.published.find((event) => event.kind === 1111 && event.content === 'new direct reply')).toBeTruthy();
		const publishedDirect = (await relayState(page)).state.published.find((event) => event.kind === 1111 && event.content === 'new direct reply')!;
		expect(publishedDirect.tags).toEqual(expect.arrayContaining([
			['E', deathRoot.id, '', parsedDeath.pubkey], ['K', '42'], ['P', parsedDeath.pubkey],
			['e', deathRoot.id, '', parsedDeath.pubkey], ['k', '42'], ['p', parsedDeath.pubkey]
		]));
		await expect(page.locator(`[data-trace-reply-id="${publishedDirect.id}"]`)).toContainText('new direct reply');
		const currentBeforeInvalidReplies = await page.locator('[data-trace-current-id]').getAttribute('data-trace-current-id');

		await page.evaluate((events) => {
			const relay = (window as typeof window & { __relayStartupTest: { injectTraceReply(event: object): void } }).__relayStartupTest;
			for (const event of events) relay.injectTraceReply(event);
		}, [wrongRoot, wrongParent]);
		await expect(page.locator(`[data-trace-reply-id="${wrongRoot.id}"]`)).toHaveCount(0);
		await expect(page.locator(`[data-trace-reply-id="${wrongParent.id}"]`)).toHaveCount(0);
		await expect(page.locator('[data-trace-current-id]')).toHaveAttribute('data-trace-current-id', currentBeforeInvalidReplies!);
	});

});
