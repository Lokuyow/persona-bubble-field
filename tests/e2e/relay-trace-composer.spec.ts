import { expect, test } from '@playwright/test';
import { WORLD_STATE_KIND } from '../../src/lib/nostrProtocol';
import { characterPicturePath } from '../../src/lib/character';
import { requireCharacterFromPubkey } from '../../src/lib/characterAssignment';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { AUTHORITATIVE_RELAYS, traceRuntimeEvents, installDelayedRelay, relayState, installPromptApiStub, seedRelayAccount, composerContextCalls } from './helpers/relayHarness';




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
		const fixtureTime = Date.now();
		const trace = traceRuntimeEvents();
		await page.clock.setFixedTime(fixtureTime + 1_000);
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

});
