import { expect, test } from '@playwright/test';
import { WORLD_STATE_KIND } from '../../src/lib/nostrProtocol';
import { characterPicturePath } from '../../src/lib/character';
import { requireCharacterFromPubkey } from '../../src/lib/characterAssignment';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { AUTHORITATIVE_RELAYS, CHANNEL_ID, traceRuntimeEvents, installDelayedRelay, relayState, installPromptApiStub, seedRelayAccount, composerContextCalls, moveRelaySelfTo } from './helpers/relayHarness';




test.describe('Relay startup', () => {
	test('passes target-author character profiles across root, nested reply, and clear context patches', async ({ page }) => {
		const trace = traceRuntimeEvents();
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize({ width: 1100, height: 850 });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: { message: trace.message, position: trace.selfPosition }, traceRoots: [trace.root], traceReplies: [trace.direct, trace.deeper] });
		await seedRelayAccount(page, trace.selfSecret, trace.selfPubkey);
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releasePrimary(): void; releaseTraceRoots(): void; releaseTraceReplies(): void } }).__relayStartupTest;
			relay.releasePrimary(); relay.releaseTraceRoots(); relay.releaseTraceReplies();
		});
		await expect(page.locator('.participant')).toHaveCount(2);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');
		await page.locator('.chatter-toggle').click();
		await page.locator('[data-cell-position="4,2"]:not(.realtime-group-trigger)').click();
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
			const relay = (window as unknown as { __relayStartupTest: { releasePrimary(): void; releaseTraceRoots(): void; releaseTraceReplies(): void } }).__relayStartupTest;
			relay.releasePrimary(); relay.releaseTraceRoots(); relay.releaseTraceReplies();
		});
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');
		await page.locator('.chatter-toggle').click();
		await page.locator('[data-cell-position="4,2"]:not(.realtime-group-trigger)').click();
		await expect(page.getByLabel('Reply preview', { exact: true })).toContainText('Relay trace root');
		await page.locator(`[data-trace-reply-id="${trace.direct.id}"] .trace-reply-content-button`).click();
		await expect(page.getByLabel('Reply preview', { exact: true })).toContainText('Relay direct reply');
		const candidateButton = page.getByRole('button', { name: 'AI発言候補を生成' });
		await expect(candidateButton).toBeVisible();
		const speechType = page.locator('.speech-type-toggle');
		await speechType.click();
		await expect(speechType).toHaveAttribute('data-speech-type', 'shout');
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
		expect(reply.tags).toContainEqual(['l', 'speech:shout', 'io.github.lokuyow.persona-bubble-field']);
		await expect(speechType).toHaveAttribute('data-speech-type', 'shout');
		await expect(page.getByRole('textbox', { name: '投稿エディター' })).toHaveValue('');
		await expect(page.locator('.suggestion-panel')).toHaveCount(0);
	});

	test('rejects mismatched structured reply output before position or message publication', async ({ page }) => {
		const trace = traceRuntimeEvents();
		await page.clock.setFixedTime((trace.selfPosition.created_at + 1) * 1_000);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize({ width: 1100, height: 850 });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: { message: trace.message, position: trace.selfPosition }, traceRoots: [trace.root] });
		await seedRelayAccount(page, trace.selfSecret, trace.selfPubkey);
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
			relay.releasePrimary();
		});
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');
		await page.locator('.chatter-toggle').click();
		await page.locator('[data-cell-position="4,2"]:not(.realtime-group-trigger)').click();
		const editor = page.getByRole('textbox', { name: '投稿エディター' });
		const preview = page.getByLabel('Reply preview', { exact: true });
		await expect(preview).toContainText('Relay trace root');
		const inspectionPublishes = async () => (await relayState(page)).state.published.filter((event) =>
			event.kind === WORLD_STATE_KIND && event.pubkey === trace.selfPubkey && event.content === '3:2'
		);
		await expect.poll(inspectionPublishes).toHaveLength(AUTHORITATIVE_RELAYS.length);
		expect([...new Set((await inspectionPublishes()).map((event) => event.id))]).toHaveLength(1);
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
				const relay = (window as unknown as { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
				relay.releasePrimary();
			});
			await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');
			await page.locator('.chatter-toggle').click();
			await page.locator('[data-cell-position="4,2"]:not(.realtime-group-trigger)').click();
			const preview = page.getByLabel('Reply preview', { exact: true });
			const editor = page.getByRole('textbox', { name: '投稿エディター' });
			const speechType = page.locator('.speech-type-toggle');
			await expect(preview).toContainText('Relay trace root');
			await expect(editor).not.toBeFocused();
			await expect(page.locator('[data-points-value]')).toHaveText('5pt');
			const pointsBeforeReply = 5;
			await speechType.click();
			await speechType.click();
			await expect(speechType).toHaveAttribute('data-speech-type', 'monologue');
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
			if (outcome !== 'rejected') await expect(page.locator('[data-interaction-reward-feedback]')).toHaveText(['+5pt', '+10pt']);
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
				await expect(page.locator('[data-points-value]')).toHaveText(`${pointsBeforeReply + 10}pt`);
			} else {
				await expect(page.locator('[data-points-value]')).toHaveText(`${pointsBeforeReply}pt`);
			}
			if (outcome === 'rejected') await page.getByRole('button', { name: 'Clear reply', exact: true }).click();
			await expect(speechType).toHaveAttribute('data-speech-type', 'monologue');
			await speechType.click();
			await expect(speechType).toHaveAttribute('data-speech-type', 'normal');
			await editor.fill('normal kind 42 after reply mode');
			await editor.press('Enter');
			await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 42 && event.content === 'normal kind 42 after reply mode')).toBe(true);
		});
	}

	test('recovers the reserved signed manual Trace after the browser tab closes and still allows clear with an unknown result', async ({ page, context }) => {
		const trace = traceRuntimeEvents();
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, {
			primaryEvents: { message: trace.message, position: trace.selfPosition },
			deferTracePublishes: true
		});
		await seedRelayAccount(page, trace.selfSecret, trace.selfPubkey, Date.now() + 7 * 24 * 60 * 60 * 1000, 101_000);
		await page.goto('/');
		await page.evaluate(() => (window as unknown as { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');
		const traceButton = page.getByRole('button', { name: /書置きを投稿/ });
		await expect(traceButton).toHaveText('100pt');
		await expect(traceButton).toHaveAttribute('aria-pressed', 'false');
		await traceButton.click();
		await expect(traceButton).toHaveAttribute('aria-pressed', 'true');
		await expect(traceButton).toHaveText('100pt');
		const editor = page.getByRole('textbox', { name: '投稿エディター' });
		await editor.fill('survive a closed browser tab');
		await editor.press('Enter');
		await expect(traceButton).toHaveAttribute('data-manual-trace-status', 'sending');
		await expect(traceButton).toBeDisabled();
		await expect(traceButton).toHaveText('100pt');
		await expect(traceButton).toHaveAttribute('aria-label', /送信中/);
		const firstState = async () => (await relayState(page)).state.published.filter((event) => event.kind === 42 && event.tags.some((tag) => tag[0] === 'l' && tag[1] === 'trace:manual'));
		await expect.poll(firstState).toHaveLength(AUTHORITATIVE_RELAYS.length);
		const originalIds = [...new Set((await firstState()).map((event) => event.id))];
		expect(originalIds).toHaveLength(1);
		const originalEventId = originalIds[0];

		// Closing the tab discards its in-memory publisher while IndexedDB keeps the debit and signed outbox.
		await page.close();
		const restarted = await context.newPage();
		await restarted.goto('/favicon.svg');
		await restarted.evaluate(async () => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('persona-bubble-field-account');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				const transaction = database.transaction('persona-bubble-field-world-write-journal', 'readwrite');
				const store = transaction.objectStore('persona-bubble-field-world-write-journal');
				const request = store.getAllKeys();
				await new Promise<void>((resolve, reject) => {
					request.onsuccess = () => {
						for (const key of request.result) {
							const get = store.get(key);
						get.onsuccess = () => {
							const record = get.result as { pendingManualTrace?: { leaseUntilMs: number } } | undefined;
							if (record?.pendingManualTrace) store.put({ ...record, pendingManualTrace: { ...record.pendingManualTrace, leaseUntilMs: 0 } }, key);
						};
						}
					};
					transaction.oncomplete = () => resolve();
					transaction.onerror = () => reject(transaction.error);
				});
			} finally { database.close(); }
		});
		const persistedOutbox = await restarted.evaluate(async () => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('persona-bubble-field-account');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				const transaction = database.transaction('persona-bubble-field-world-write-journal');
				const request = transaction.objectStore('persona-bubble-field-world-write-journal').getAll();
				return await new Promise<Array<{ pendingManualTrace?: { event: { id: string }; status: string; leaseUntilMs: number } }>>((resolve, reject) => {
					transaction.oncomplete = () => resolve(request.result);
					transaction.onerror = () => reject(transaction.error);
				});
			} finally { database.close(); }
		});
		expect(persistedOutbox.some((record) => record.pendingManualTrace?.event.id === originalEventId && record.pendingManualTrace.leaseUntilMs === 0)).toBe(true);
		await restarted.emulateMedia({ reducedMotion: 'reduce' });
		await installHostOwnedStub(restarted);
		await installDelayedRelay(restarted, {
			primaryEvents: { message: trace.message, position: trace.selfPosition },
			rejectTracePublishes: true,
			persistAcrossReload: true
		});
		await restarted.clock.install({ time: Date.now() });
		await restarted.goto('/');
		await restarted.evaluate(() => (window as unknown as { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		const recoveredPublishes = async () => (await relayState(restarted)).state.published.filter((event) => event.kind === 42 && event.tags.some((tag) => tag[0] === 'l' && tag[1] === 'trace:manual'));
		await expect.poll(recoveredPublishes).toHaveLength(AUTHORITATIVE_RELAYS.length);
		expect([...new Set((await recoveredPublishes()).map((event) => event.id))]).toEqual([originalEventId]);
		await expect(restarted.locator('.manual-trace-toggle')).toHaveAttribute('data-manual-trace-status', 'unknown');
		await expect(restarted.locator('.manual-trace-toggle')).toHaveText('100pt');
		await expect(restarted.locator('.manual-trace-toggle')).toHaveAttribute('aria-label', /結果未確認/);
		await restarted.locator('.manual-trace-toggle').hover();
		await expect(restarted.getByRole('tooltip')).toContainText('同じイベントを自動再試行します');
		const retryEditor = restarted.getByRole('textbox', { name: '投稿エディター' });
		const manualMode = restarted.locator('.manual-trace-toggle');
		const terminalCountBeforeNewDraft = await restarted.evaluate(() => (window as unknown as { __ehagakiTerminalCount?: number }).__ehagakiTerminalCount ?? 0);
		await retryEditor.fill('a changed body must remain a separate draft');
		await manualMode.click();
		await retryEditor.press('Enter');
		await expect.poll(() => restarted.evaluate(() => (window as unknown as { __ehagakiTerminalCount: number }).__ehagakiTerminalCount)).toBe(terminalCountBeforeNewDraft + 1);
		await expect(retryEditor).toHaveValue('a changed body must remain a separate draft');
		const eventsAfterNewDraftAttempt = await recoveredPublishes();
		expect([...new Set(eventsAfterNewDraftAttempt.map((event) => event.id))]).toEqual([originalEventId]);
		expect(eventsAfterNewDraftAttempt.some((event) => event.content === 'a changed body must remain a separate draft')).toBe(false);
		await restarted.evaluate(() => (window as unknown as { __relayStartupTest: { allowTracePublishes(): void } }).__relayStartupTest.allowTracePublishes());
		await restarted.clock.runFor(20_001);
		await expect(restarted.locator('.manual-trace-toggle')).toHaveAttribute('data-manual-trace-status', 'confirmed');
		await expect(restarted.locator('.manual-trace-toggle')).toHaveText('100pt');
		await expect(restarted.locator('.manual-trace-toggle')).not.toContainText('投稿済');
		await expect(retryEditor).toHaveValue('a changed body must remain a separate draft');
		const successfulRecoveryPublishes = await recoveredPublishes();
		expect(successfulRecoveryPublishes).toHaveLength(AUTHORITATIVE_RELAYS.length * 2);
		expect([...new Set(successfulRecoveryPublishes.map((event) => event.id))]).toEqual([originalEventId]);
		expect(successfulRecoveryPublishes.every((event) => event.content === 'survive a closed browser tab')).toBe(true);
		await expect(restarted.getByRole('button', { name: '自分のプロフィールを開く' })).toBeEnabled();
		await restarted.getByRole('button', { name: '自分のプロフィールを開く' }).click();
		const profile = restarted.getByRole('dialog');
		await expect(profile.getByRole('button', { name: '脱出', exact: true })).toBeEnabled();
		await profile.getByRole('button', { name: '脱出', exact: true }).click();
		await expect(restarted.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		const traceEventsAfterClear = await restarted.evaluate(() => {
			const state = (window as unknown as { __relayStartupTest: { state: { previousPublished: Array<{ id: string; kind: number; tags: string[][] }>; published: Array<{ id: string; kind: number; tags: string[][] }> } } }).__relayStartupTest.state;
			return [...state.previousPublished, ...state.published].filter((event) => event.kind === 42 && event.tags.some((tag) => tag[0] === 'l' && tag[1] === 'trace:manual'));
		});
		expect(traceEventsAfterClear).toHaveLength(AUTHORITATIVE_RELAYS.length * 2);
		expect([...new Set(traceEventsAfterClear.map((event) => event.id))]).toEqual([originalEventId]);
		const terminalOutbox = await restarted.evaluate(async ({ channelId, pubkey }) => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('persona-bubble-field-account');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				const transaction = database.transaction('persona-bubble-field-world-write-journal');
				const request = transaction.objectStore('persona-bubble-field-world-write-journal').get(channelId + String.fromCharCode(0) + pubkey);
				return await new Promise<{ pendingManualTrace?: { event: { id: string }; status: string } }>((resolve, reject) => {
					transaction.oncomplete = () => resolve(request.result);
					transaction.onerror = () => reject(transaction.error);
				});
			} finally { database.close(); }
		}, { channelId: CHANNEL_ID, pubkey: trace.selfPubkey });
		expect(terminalOutbox?.pendingManualTrace).toMatchObject({ event: { id: originalEventId }, status: 'confirmed' });
		await restarted.clock.runFor(40_001);
		const eventsAfterTerminalRetryWindow = await restarted.evaluate(() => {
			const state = (window as unknown as { __relayStartupTest: { state: { previousPublished: Array<{ id: string; kind: number; tags: string[][] }>; published: Array<{ id: string; kind: number; tags: string[][] }> } } }).__relayStartupTest.state;
			return [...state.previousPublished, ...state.published].filter((event) => event.kind === 42 && event.tags.some((tag) => tag[0] === 'l' && tag[1] === 'trace:manual'));
		});
		expect(eventsAfterTerminalRetryWindow).toHaveLength(traceEventsAfterClear.length);
		expect([...new Set(eventsAfterTerminalRetryWindow.map((event) => event.id))]).toEqual([originalEventId]);
	});

	test('shows a confirmed manual Trace on its author field without waiting for the Relay root bootstrap', async ({ page }) => {
		const trace = traceRuntimeEvents();
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: { message: trace.message, position: trace.selfPosition } });
		await seedRelayAccount(page, trace.selfSecret, trace.selfPubkey, Date.now() + 7 * 24 * 60 * 60 * 1000, 300);
		await page.goto('/');
		await page.evaluate(() => (window as unknown as { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');
		const manualTrace = page.getByRole('button', { name: /書置きを投稿/ });
		await expect(manualTrace).toHaveText('100pt');
		await manualTrace.click();
		await expect(manualTrace).toHaveAttribute('aria-pressed', 'true');
		const editor = page.getByRole('textbox', { name: '投稿エディター' });
		await editor.fill('visible on my own field immediately');
		await editor.press('Enter');
		const manualPublishes = async () => (await relayState(page)).state.published.filter((event) => event.kind === 42 && event.tags.some((tag) => tag[0] === 'l' && tag[1] === 'trace:manual'));
		await expect.poll(manualPublishes).toHaveLength(AUTHORITATIVE_RELAYS.length);
		const manualEvent = (await manualPublishes())[0]!;
		await expect(page.locator('.manual-trace-toggle')).toHaveAttribute('data-manual-trace-status', 'confirmed');
		await expect(manualTrace).toHaveAttribute('aria-pressed', 'false');
		await expect(manualTrace).toHaveText('100pt');
		await expect(manualTrace).not.toContainText('投稿済');
		await manualTrace.click();
		await expect(manualTrace).toHaveAttribute('aria-pressed', 'true');
		await expect(manualTrace).toHaveText('100pt');
		await manualTrace.click();
		await expect(manualTrace).toHaveAttribute('aria-pressed', 'false');
		await page.clock.install({ time: await page.evaluate(() => Date.now()) });
		await moveRelaySelfTo(page, { x: 4, y: 2 });
		await expect(page.locator('[data-trace-marker-position="3,2"]')).toBeVisible();
		const manualMarker = page.locator('[data-trace-marker-position="3,2"]');
		await expect(manualMarker).toHaveAttribute('data-trace-marker-kind', 'manual');
		await expect(manualMarker).toHaveCSS('mask-image', /trace-icon\.svg/);
		await page.locator('[data-cell-position="3,2"]').click();
		await expect(page.locator(`[data-trace-root-id="${manualEvent.id}"]`)).toBeVisible();
		await expect(page.locator(`[data-trace-root-id="${manualEvent.id}"]`)).toContainText('visible on my own field immediately');
		await page.reload();
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => (window as unknown as { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('[data-trace-marker-position="3,2"]')).toHaveAttribute('data-trace-marker-kind', 'manual');
		await expect(page.locator('[data-trace-marker-position="3,2"]')).toHaveCSS('mask-image', /trace-icon\.svg/);
		await expect(manualTrace).toHaveAttribute('aria-pressed', 'false');
		await expect(manualTrace).toHaveText('100pt');
		await manualTrace.click();
		await expect(manualTrace).toHaveAttribute('aria-pressed', 'true');
		await editor.fill('a second reusable manual Trace');
		await editor.press('Enter');
		await expect.poll(manualPublishes).toHaveLength(AUTHORITATIVE_RELAYS.length);
		const eventIds = [...new Set((await manualPublishes()).map((event) => event.id))];
		expect(eventIds).toHaveLength(1);
		expect(eventIds[0]).not.toBe(manualEvent.id);
		await expect(manualTrace).toHaveAttribute('data-manual-trace-status', 'confirmed');
		await expect(manualTrace).toHaveAttribute('aria-pressed', 'false');
		await expect(manualTrace).toHaveText('100pt');
	});

});
