import { expect, test, type Page } from '@playwright/test';
import { finalizeEvent, getPublicKey, verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure';
import {
	buildWorldStateEventTemplate,
	buildDeathTraceEventTemplate,
	buildManualTraceEventTemplate,
	buildTraceReplyTemplate,
	buildWorldMessageTemplate,
	parseTraceReplyCandidate,
	parseTraceEvent,
	parseWorldMessage,
	validateTraceReplyCandidate
} from '../../src/lib/nostrProtocol';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { expectIconCloseButton } from './helpers/iconCloseButton';
import { expectDialogIconCloseButton } from './helpers/dialogMotion';
import { AUTHORITATIVE_RELAYS, CHANNEL_ID, fixtureSecret, traceRuntimeEvents, installDelayedRelay, relayState, selectRelayTraceCell, clickRelayLogicalCell, installPromptApiStub, seedRelayAccount, readActionDockControlOrder, moveRelaySelfTo } from './helpers/relayHarness';




async function expectUnreadPopoverPresentation(page: Page, viewportWidth: number, viewportHeight: number): Promise<void> {
	const presentation = await page.evaluate(() => {
		const unread = document.querySelector<HTMLElement>('.trace-unread-indicator');
		const explanation = document.querySelector<HTMLElement>('.trace-unread-explanation');
		if (!unread || !explanation) throw new Error('Expected unread trigger and explanation to be rendered.');
		const tokenValue = (property: string, token: string): string => {
			const probe = document.createElement('div');
			probe.style.setProperty(property, `var(${token})`);
			document.body.append(probe);
			const value = getComputedStyle(probe).getPropertyValue(property);
			probe.remove();
			return value;
		};
		const unreadStyle = getComputedStyle(unread);
		const explanationStyle = getComputedStyle(explanation);
		const rect = explanation.getBoundingClientRect();
		return {
			unread: {
				width: unread.getBoundingClientRect().width,
				height: unread.getBoundingClientRect().height,
				background: unreadStyle.backgroundColor,
				backgroundTokens: [
					tokenValue('background-color', '--action-notification-background'),
					tokenValue('background-color', '--action-notification-background-hover'),
					tokenValue('background-color', '--action-notification-background-active')
				],
				borderStyle: unreadStyle.borderStyle,
				borderWidth: Number.parseFloat(unreadStyle.borderWidth),
				borderColor: unreadStyle.borderColor,
				borderColorToken: tokenValue('border-color', '--action-notification-border'),
				color: unreadStyle.color,
				colorToken: tokenValue('color', '--action-notification-foreground')
			},
			explanation: {
				text: explanation.textContent?.trim(),
				left: rect.left,
				right: rect.right,
				top: rect.top,
				bottom: rect.bottom,
				background: explanationStyle.backgroundColor,
				color: explanationStyle.color,
				paddingTop: Number.parseFloat(explanationStyle.paddingTop),
				paddingRight: Number.parseFloat(explanationStyle.paddingRight),
				paddingBottom: Number.parseFloat(explanationStyle.paddingBottom),
				paddingLeft: Number.parseFloat(explanationStyle.paddingLeft),
				maxWidth: Number.parseFloat(explanationStyle.maxWidth),
				overflowWrap: explanationStyle.overflowWrap,
				clientWidth: explanation.clientWidth,
				scrollWidth: explanation.scrollWidth,
				clientHeight: explanation.clientHeight,
				scrollHeight: explanation.scrollHeight
			}
		};
	});
	expect(presentation.unread.width).toBeGreaterThanOrEqual(44);
	expect(presentation.unread.height).toBeGreaterThanOrEqual(44);
	expect(presentation.unread.backgroundTokens).toContain(presentation.unread.background);
	expect(presentation.unread.borderStyle).toBe('solid');
	expect(presentation.unread.borderWidth).toBeGreaterThan(0);
	expect(presentation.unread.borderColor).toBe(presentation.unread.borderColorToken);
	expect(presentation.unread.color).toBe(presentation.unread.colorToken);
	expect(presentation.explanation.text).toBe('どこかにあなたへの返信の痕跡があります');
	expect(presentation.explanation.background).not.toBe('rgba(0, 0, 0, 0)');
	expect(presentation.explanation.color).not.toBe('rgb(0, 0, 0)');
	expect(presentation.explanation.paddingTop).toBeGreaterThan(0);
	expect(presentation.explanation.paddingRight).toBeGreaterThan(0);
	expect(presentation.explanation.paddingBottom).toBeGreaterThan(0);
	expect(presentation.explanation.paddingLeft).toBeGreaterThan(0);
	expect(presentation.explanation.maxWidth).toBeGreaterThan(0);
	expect(presentation.explanation.maxWidth).toBeLessThan(viewportWidth);
	expect(presentation.explanation.overflowWrap).toBe('anywhere');
	expect(presentation.explanation.scrollWidth).toBeLessThanOrEqual(presentation.explanation.clientWidth + 1);
	expect(presentation.explanation.scrollHeight).toBeLessThanOrEqual(presentation.explanation.clientHeight + 1);
	expect(presentation.explanation.left).toBeGreaterThanOrEqual(16);
	expect(presentation.explanation.right).toBeLessThanOrEqual(viewportWidth - 16);
	expect(presentation.explanation.top).toBeGreaterThanOrEqual(16);
	expect(presentation.explanation.bottom).toBeLessThanOrEqual(viewportHeight - 16);
}

test.describe('Relay startup', () => {
	test('returns Trace reply success with silent authoritative Relays still pending and reconciles a later echo once', async ({ page }) => {
		const now = Date.now();
		const trace = traceRuntimeEvents();
		await page.clock.setFixedTime(now);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize({ width: 390, height: 844 });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, {
			primaryEvents: { message: trace.message, position: trace.selfPosition }, traceRoots: [trace.root],
			silentReplyRelays: AUTHORITATIVE_RELAYS.filter((url) => url !== 'wss://nos.lol/')
		});
		await seedRelayAccount(page, trace.selfSecret, trace.selfPubkey);
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toBeVisible();
		await selectRelayTraceCell(page, '4,2');
		await expect(page.locator(`[data-trace-root-id="${trace.root.id}"]`)).toContainText(trace.root.content);
		const editor = page.getByRole('textbox', { name: '投稿エディター' });
		await expect(page.getByLabel('Reply preview', { exact: true })).toHaveAttribute('data-reply-id', trace.root.id);
		await editor.fill('reply before silent Relay timeouts');
		await editor.press('Enter');
		await expect(editor).toHaveValue('');
		const published = await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { state: { published: Array<{ id: string; kind: number; content: string }> } }
		}).__relayStartupTest.state.published.filter((event) => event.kind === 1111 && event.content === 'reply before silent Relay timeouts'));
		expect(published).toHaveLength(AUTHORITATIVE_RELAYS.length);
		const eventId = published[0].id;
		await expect(page.locator(`[data-trace-reply-id="${eventId}"]`)).toContainText('reply before silent Relay timeouts');
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectTraceReply(event: object): void } })
			.__relayStartupTest.injectTraceReply(event), (await relayState(page)).state.published.find((event) => event.id === eventId)!);
		await expect(page.locator(`[data-trace-reply-id="${eventId}"]`)).toHaveCount(1);
	});

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

	test('awards first visible unread Trace and own-target reply rewards in the points HUD', async ({ page }) => {
		const now = Date.now();
		const createdAt = Math.floor(now / 1000);
		const selfSecret = fixtureSecret(23);
		const selfPubkey = getPublicKey(selfSecret);
		const channel = { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' };
		const primary = {
			message: finalizeEvent(buildWorldMessageTemplate({ channel, content: 'reward participant', speechType: 'normal', position: { x: 3, y: 2 }, createdAt }), selfSecret),
			position: finalizeEvent(buildWorldStateEventTemplate({ channel, position: { x: 3, y: 2 }, slot: 0, createdAt }), selfSecret)
		};
		const makeTraceRoot = (secret: Uint8Array, content: string, x: number) => {
			for (let attempt = 0; attempt < 100; attempt += 1) {
				const event = finalizeEvent(buildWorldMessageTemplate({ channel, content: `${content} ${attempt}`, speechType: 'normal', position: { x, y: 2 }, createdAt }), secret);
				if (BigInt(`0x${event.id}`) % 5n === 0n) return event;
			}
			throw new Error('Could not create an eligible Trace root.');
		};
		const unreadRoot = makeTraceRoot(fixtureSecret(30), 'reward other root', 4);
		const selfRoot = makeTraceRoot(selfSecret, 'reward self root', 5);
		const parsedSelfRoot = parseWorldMessage(selfRoot, CHANNEL_ID);
		if (!parsedSelfRoot) throw new Error('Reward self root did not parse.');
		const unreadReply = finalizeEvent(buildTraceReplyTemplate({ root: parsedSelfRoot, parent: parsedSelfRoot,
			content: 'reward reply to current Identity', speechType: 'normal', createdAt: createdAt + 1 }), fixtureSecret(31));
		await page.clock.setFixedTime(now);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize({ width: 390, height: 844 });
		await installHostOwnedStub(page);
		await installPromptApiStub(page);
		await installDelayedRelay(page, { primaryEvents: primary, traceRoots: [unreadRoot, selfRoot], traceReplies: [unreadReply] });
		await seedRelayAccount(page, selfSecret, selfPubkey, now + 7 * 24 * 60 * 60 * 1000, 300);
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => (window as unknown as { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await page.evaluate(() => {
			const target = window as unknown as { __rewardFeedbackSeen: { text: string; animationName: string; pointerEvents: string; left: number; right: number; viewportWidth: number; cueTop: number; cueBottom: number; actorLeft: number; actorRight: number; actorTop: number; actorPosition: string; samples: { actorPosition: string; horizontalDelta: number; verticalGap: number; cameraTransform: string; insideViewport: boolean }[] }[] };
			target.__rewardFeedbackSeen = [];
			new MutationObserver((records) => records.flatMap((record) => [...record.addedNodes]).forEach((node) => {
				if (!(node instanceof Element)) return;
				const cues = [node, ...node.querySelectorAll('[data-interaction-reward-feedback]')]
					.filter((element) => element.matches('[data-interaction-reward-feedback]'));
				for (const cue of cues) {
					const style = getComputedStyle(cue);
					const rect = cue.getBoundingClientRect();
					const actor = document.querySelector<HTMLElement>('.participant[data-self="true"]');
					if (!actor) continue;
					const actorRect = actor.getBoundingClientRect();
					const result = { text: cue.textContent?.trim() ?? '', animationName: style.animationName, pointerEvents: style.pointerEvents,
						left: rect.left, right: rect.right, viewportWidth: window.innerWidth, cueTop: rect.top, cueBottom: rect.bottom,
						actorLeft: actorRect.left, actorRight: actorRect.right, actorTop: actorRect.top,
						actorPosition: actor.dataset.position ?? '', samples: [] as { actorPosition: string; horizontalDelta: number; verticalGap: number; cameraTransform: string; insideViewport: boolean }[] };
					target.__rewardFeedbackSeen.push(result);
					const sample = () => {
						if (!cue.isConnected || result.samples.length > 90) return;
						const nextActor = document.querySelector<HTMLElement>('.participant[data-self="true"]');
						if (!nextActor) return;
						const cueRect = cue.getBoundingClientRect();
						const nextActorRect = nextActor.getBoundingClientRect();
						const sceneTransform = getComputedStyle(document.querySelector('.field-scene')!).transform;
						result.samples.push({ actorPosition: nextActor.dataset.position ?? '',
							horizontalDelta: Math.abs((cueRect.left + cueRect.right) / 2 - (nextActorRect.left + nextActorRect.right) / 2),
							verticalGap: nextActorRect.top - cueRect.bottom, cameraTransform: sceneTransform,
							insideViewport: cueRect.left >= 0 && cueRect.right <= window.innerWidth });
						requestAnimationFrame(sample);
					};
					requestAnimationFrame(sample);
				}
			})).observe(document.body, { childList: true, subtree: true });
		});
		await expect(page.locator('[data-points-value]')).toHaveText('300pt');
		await selectRelayTraceCell(page, '4,2');
		const investigateOther = page.getByRole('button', { name: '痕跡を調べる', exact: true });
		if (await investigateOther.isVisible()) await investigateOther.click();
		await expect(page.locator(`[data-trace-root-id="${unreadRoot.id}"]`)).toBeVisible();
		await expect(page.locator('[data-points-value]')).toHaveText('305pt');
		await expect.poll(() => page.evaluate(() => (window as unknown as { __rewardFeedbackSeen: { text: string }[] }).__rewardFeedbackSeen)).toContainEqual(expect.objectContaining({ text: '+5pt' }));
		await expect.poll(() => page.evaluate(() => (window as unknown as { __rewardFeedbackSeen: { text: string; animationName: string; pointerEvents: string }[] }).__rewardFeedbackSeen
			.some((cue) => cue.text === '+5pt' && cue.animationName.endsWith('interaction-reward-fade') && cue.pointerEvents === 'none'))).toBe(true);
		await expect.poll(() => page.evaluate(() => (window as unknown as { __rewardFeedbackSeen: { text: string; left: number; right: number; viewportWidth: number }[] }).__rewardFeedbackSeen
			.some((cue) => cue.text === '+5pt' && cue.left >= 0 && cue.right <= cue.viewportWidth))).toBe(true);
		await expect(page.locator('[data-points-value] [data-interaction-reward-feedback]')).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => (window as unknown as { __rewardFeedbackSeen: { text: string; left: number; right: number; cueBottom: number; actorLeft: number; actorRight: number; actorTop: number }[] }).__rewardFeedbackSeen
			.some((cue) => cue.text === '+5pt' && Math.abs((cue.left + cue.right) / 2 - (cue.actorLeft + cue.actorRight) / 2) < 50 &&
				cue.actorTop >= cue.cueBottom && cue.actorTop - cue.cueBottom < 25)))
			.toBe(true);
		await moveRelaySelfTo(page, { x: 4, y: 2 });
		await selectRelayTraceCell(page, '5,2');
		const investigateSelf = page.getByRole('button', { name: '痕跡を調べる', exact: true });
		if (await investigateSelf.isVisible()) await investigateSelf.click();
		await expect(page.locator(`[data-trace-root-id="${selfRoot.id}"]`)).toBeVisible();
		await expect(page.locator(`[data-trace-reply-id="${unreadReply.id}"]`)).toBeVisible();
		await expect(page.locator('[data-points-value]')).toHaveText('315pt');
		await expect.poll(() => page.evaluate(() => (window as unknown as { __rewardFeedbackSeen: { text: string }[] }).__rewardFeedbackSeen))
			.toContainEqual(expect.objectContaining({ text: '+10pt' }));
		const movedSelfPosition = finalizeEvent(buildWorldStateEventTemplate({ channel, position: { x: 6, y: 2 }, slot: 0, createdAt: createdAt + 1 }), selfSecret);
		await page.evaluate((event) => (window as unknown as { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), movedSelfPosition);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '6,2');
		expect(await page.locator('.field-area').evaluate((area) => ({ x: area.scrollLeft, y: area.scrollTop }))).toEqual({ x: 0, y: 0 });
		await expect.poll(() => page.evaluate(() => (window as unknown as { __rewardFeedbackSeen: { text: string; samples: { actorPosition: string; horizontalDelta: number; verticalGap: number; cameraTransform: string }[] }[] }).__rewardFeedbackSeen
			.some((cue) => cue.text === '+10pt' && cue.samples.some((sample) => sample.actorPosition === '6,2' && sample.horizontalDelta < 50 && sample.verticalGap >= 0 && sample.verticalGap < 25))))
			.toBe(true);
		await expect.poll(() => page.evaluate(() => (window as unknown as { __rewardFeedbackSeen: { text: string; samples: { actorPosition: string; cameraTransform: string }[] }[] }).__rewardFeedbackSeen
			.some((cue) => cue.text === '+10pt' && new Set(cue.samples.filter((sample) => sample.actorPosition === '4,2' || sample.actorPosition === '6,2').map((sample) => sample.cameraTransform)).size > 1)))
			.toBe(true);
		const edgeSelfPosition = finalizeEvent(buildWorldStateEventTemplate({ channel, position: { x: 0, y: 2 }, slot: 0, createdAt: createdAt + 2 }), selfSecret);
		await page.evaluate((event) => (window as unknown as { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), edgeSelfPosition);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '0,2');
		await expect.poll(() => page.evaluate(() => (window as unknown as { __rewardFeedbackSeen: { text: string; samples: { actorPosition: string; insideViewport: boolean; horizontalDelta: number; verticalGap: number }[] }[] }).__rewardFeedbackSeen
			.some((cue) => cue.text === '+10pt' && cue.samples.some((sample) => sample.actorPosition === '0,2' && sample.insideViewport && sample.horizontalDelta < 50 && sample.verticalGap >= 0 && sample.verticalGap < 25))))
			.toBe(true);
	});

	test('persists Trace root and reply read state and keeps notification generic', async ({ page }) => {
		await page.addInitScript(() => {
			(window as typeof window & { __unreadArrivalCount?: number }).__unreadArrivalCount = 0;
		document.addEventListener('animationstart', (event) => {
			if (event.target instanceof Element && event.target.matches('.trace-unread-arrival-ring')) {
				const target = window as typeof window & { __unreadArrivalCount?: number };
				target.__unreadArrivalCount = (target.__unreadArrivalCount ?? 0) + 1;
			}
		}, true);
		});
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
		const manualRoot = finalizeEvent(buildManualTraceEventTemplate({
			channel,
			content: 'read-state manual trace',
			position: { x: 7, y: 2 },
			speechType: 'normal',
			createdAt: Math.floor(now / 1000)
		}), selfSecret);
		const deathRoot = finalizeEvent(buildDeathTraceEventTemplate({
			channel,
			content: 'read-state death trace',
			position: { x: 6, y: 2 },
			createdAt: Math.floor(now / 1000)
		}), fixtureSecret(37));
		const reply = finalizeEvent(buildTraceReplyTemplate({ root: parsedRoot, parent: parsedRoot, content: 'private reply detail', speechType: 'normal', createdAt: Math.floor(now / 1000) + 1 }), fixtureSecret(31));
		const replyAfterRootRead = finalizeEvent(buildTraceReplyTemplate({ root: parsedRoot, parent: parsedRoot, content: 'private reply after root read', speechType: 'normal', createdAt: Math.floor(now / 1000) + 2 }), fixtureSecret(32));
		const replyWhileAlreadyUnread = finalizeEvent(buildTraceReplyTemplate({ root: parsedRoot, parent: parsedRoot, content: 'another private reply while unread', speechType: 'normal', createdAt: Math.floor(now / 1000) + 3 }), fixtureSecret(33));
		const replyAfterSecondRead = finalizeEvent(buildTraceReplyTemplate({ root: parsedRoot, parent: parsedRoot, content: 'reply after second read', speechType: 'normal', createdAt: Math.floor(now / 1000) + 4 }), fixtureSecret(34));
		await page.clock.setFixedTime(now);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize({ width: 1100, height: 850 });
		await installHostOwnedStub(page);
		await installPromptApiStub(page);
		await installDelayedRelay(page, { primaryEvents: primary, traceRoots: [root, unreadRoot, manualRoot, deathRoot], traceReplies: [reply] });
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
		await expect(unreadMarker).toHaveAttribute('data-trace-marker-kind', 'random');
		await expect(unreadMarker.locator('.trace-marker-history-icon')).toBeVisible();
		await expect(unreadMarker.locator('.trace-marker-history-icon path').first()).toHaveAttribute('d', 'M17 3.34a10 10 0 1 1-14.995 8.984L2 12l.005-.324A10 10 0 0 1 17 3.34M12 6a1 1 0 0 0-.993.883L11 7v5l.009.131a1 1 0 0 0 .197.477l.087.1l3 3l.094.082a1 1 0 0 0 1.226 0l.094-.083l.083-.094a1 1 0 0 0 0-1.226l-.083-.094L13 11.585V7l-.007-.117A1 1 0 0 0 12 6');
		await expect(unreadMarker).toHaveCSS('color', 'rgb(82, 104, 134)');
		const unreadRootOpacity = Number(await unreadMarker.evaluate((element) => getComputedStyle(element).opacity));
		const replyUnreadMarker = page.locator('[data-trace-marker-position="4,2"]');
		await expect(replyUnreadMarker.locator('.trace-marker-history-icon')).toBeVisible();
		await expect(replyUnreadMarker).toHaveAttribute('data-trace-marker-kind', 'random');
		await expect(replyUnreadMarker).toHaveAttribute('data-trace-root-unread-reply', 'true');
		await expect(replyUnreadMarker).toHaveCSS('color', 'rgb(207, 6, 254)');
		const unreadReplyOpacity = Number(await replyUnreadMarker.evaluate((element) => getComputedStyle(element).opacity));
		expect(unreadReplyOpacity).toBeGreaterThan(unreadRootOpacity);
		for (const viewport of [{ width: 1100, cellSize: 76 }, { width: 390, cellSize: 50 }]) {
			await page.setViewportSize({ width: viewport.width, height: 850 });
			if (viewport.width !== 1100) {
				await page.reload();
				await expect(page.locator('.action-dock')).toBeVisible();
				await page.evaluate(() => (window as unknown as { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
				await expect(page.locator('[data-trace-marker-position="4,2"]')).toBeVisible();
			}
			await expect(page.locator('[data-trace-indicator-position]')).toHaveCount(0);
			const geometry = await page.evaluate(() => {
				const grid = document.querySelector<HTMLElement>('.field-grid')!;
				const scene = document.querySelector<HTMLElement>('.field-scene')!;
				const gridRect = grid.getBoundingClientRect();
				const cellSize = Number.parseFloat(getComputedStyle(scene).getPropertyValue('--cell-size'));
				const roots = [...document.querySelectorAll<HTMLElement>('.trace-marker-field-root')].map((marker) => {
					const [x, y] = marker.dataset.traceMarkerPosition!.split(',').map(Number);
					const rect = marker.getBoundingClientRect();
					const icon = marker.querySelector<SVGElement>('.trace-marker-history-icon');
					const iconRect = icon?.getBoundingClientRect();
					return {
						kind: marker.dataset.traceMarkerKind,
						x, y,
						left: rect.left - gridRect.left,
						top: rect.top - gridRect.top,
						right: rect.right - gridRect.left,
						width: rect.width,
						height: rect.height,
						icon: iconRect ? { width: iconRect.width, height: iconRect.height } : null
					};
				});
				return { cellSize, roots };
			});
			expect(geometry.cellSize).toBe(viewport.cellSize);
			expect(geometry.roots.map((root) => root.kind).sort()).toEqual(['death', 'manual', 'random', 'random']);
			for (const root of geometry.roots) {
				const expectedSize = Math.max(10, Math.min(18, geometry.cellSize * 0.24));
				const expectedInset = Math.max(3, geometry.cellSize * 0.06);
				expect(root.width).toBeCloseTo(expectedSize, 2);
				expect(root.height).toBeCloseTo(expectedSize, 2);
				expect(root.left).toBeGreaterThanOrEqual(root.x * geometry.cellSize);
				expect(root.top).toBeCloseTo(root.y * geometry.cellSize + expectedInset, 1);
				expect(root.right).toBeCloseTo((root.x + 1) * geometry.cellSize - expectedInset, 1);
				expect(root.right).toBeLessThanOrEqual((root.x + 1) * geometry.cellSize);
				expect(root.top + root.height).toBeLessThanOrEqual((root.y + 1) * geometry.cellSize);
				if (root.kind === 'random') expect(root.icon).toEqual({ width: root.width, height: root.height });
			}
		}
		await page.setViewportSize({ width: 1100, height: 850 });
		await page.reload();
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => (window as unknown as { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toBeVisible();
		const manualMarker = page.locator('[data-trace-marker-position="7,2"]');
		await expect(manualMarker).toHaveAttribute('data-trace-marker-kind', 'manual');
		await expect(manualMarker).toHaveCSS('mask-image', /trace-icon\.svg/);
		await expect(page.locator('.trace-unread-indicator')).toBeVisible();
		expect(await page.evaluate(() => (window as typeof window & { __unreadArrivalCount?: number }).__unreadArrivalCount)).toBe(0);
		await expect(page.locator('.trace-unread-explanation')).toHaveCount(0);
		await page.locator('.trace-unread-indicator').hover();
		await expect(page.getByRole('tooltip')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'AI発言候補を生成' })).toBeVisible();
		expect(await readActionDockControlOrder(page)).toEqual([
			'profile-trigger', 'chatter-toggle', 'trace-unread-indicator', 'sound-control', 'speech-type-toggle', 'suggestions-anchor'
		]);
		for (const width of [1200, 838, 701]) {
			await page.setViewportSize({ width, height: 850 });
			const geometry = await page.evaluate(() => {
				const rect = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect().toJSON();
				return {
					dock: rect('.action-dock'),
					left: rect('.composer-controls-left'),
					editor: rect('.composer-editor-slot'),
					right: rect('.composer-controls-right'),
					unread: rect('.trace-unread-indicator'),
					chatter: rect('.chatter-toggle'),
					profile: rect('.profile-trigger'),
					sound: rect('.speaker-button')
				};
			});
			expect(geometry.unread.height).toBe(geometry.chatter.height);
			expect(geometry.unread.height).toBe(geometry.profile.height);
			expect(geometry.unread.height).toBe(geometry.sound.height);
			expect(geometry.left.right).toBeLessThanOrEqual(geometry.editor.left);
			expect(geometry.editor.right).toBeLessThanOrEqual(geometry.right.left);
			const centers = [geometry.left, geometry.editor, geometry.right].map((box) => box.y + box.height / 2);
			expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
			for (const box of [geometry.left, geometry.editor, geometry.right, geometry.unread, geometry.sound]) {
				expect(box.x).toBeGreaterThanOrEqual(geometry.dock.x);
				expect(box.right).toBeLessThanOrEqual(geometry.dock.right);
				expect(box.y).toBeGreaterThanOrEqual(geometry.dock.y);
				expect(box.bottom).toBeLessThanOrEqual(geometry.dock.bottom);
			}
		}
		await page.setViewportSize({ width: 1100, height: 850 });
		const dockBeforeExplanation = await page.locator('.action-dock').boundingBox();
		await page.locator('.trace-unread-indicator').click();
		const explanation = page.locator('.trace-unread-explanation');
		await expect(explanation).toHaveText('どこかにあなたへの返信の痕跡があります');
		await expectUnreadPopoverPresentation(page, 1100, 850);
		const explanationBox = await explanation.boundingBox();
		const dockWithExplanation = await page.locator('.action-dock').boundingBox();
		expect(explanationBox && dockBeforeExplanation && dockWithExplanation).toBeTruthy();
		if (explanationBox && dockBeforeExplanation && dockWithExplanation) {
			expect(explanationBox.x).toBeGreaterThanOrEqual(16);
			expect(explanationBox.x + explanationBox.width).toBeLessThanOrEqual(1100 - 16);
			expect(dockWithExplanation.height).toBe(dockBeforeExplanation.height);
		}
		await page.keyboard.press('Escape');
		await expect(explanation).toHaveCount(0);
		await page.locator('.trace-unread-indicator').click();
		await expect(explanation).toBeVisible();
		await expect(page.locator('[data-trace-root-id]')).toHaveCount(0);
		await page.locator('.chatter-toggle').click();
		await selectRelayTraceCell(page, '4,2');
		await expect(page.locator(`[data-trace-root-id="${root.id}"]`)).toContainText(root.content);
		await expect(page.locator(`[data-trace-root-id="${root.id}"]`)).toHaveAttribute('data-trace-current-kind', 'root');
		await expect(page.locator(`[data-trace-ghost-root-id="${root.id}"]`)).toBeVisible();
		await expect(page.locator(`[data-trace-reply-id="${reply.id}"]`)).toContainText(reply.content);
		const dockHeightBeforeUnreadClear = (await page.locator('.action-dock').boundingBox())?.height;
		await expect(page.locator('.trace-unread-indicator')).toHaveCount(0);
		expect((await page.locator('.action-dock').boundingBox())?.height).toBe(dockHeightBeforeUnreadClear);
		await expect(explanation).toHaveCount(0);
		await clickRelayLogicalCell(page, { x: 0, y: 0 });
		await expect(replyUnreadMarker).toHaveAttribute('data-trace-root-read', 'true');
		await expect(replyUnreadMarker.locator('.trace-marker-history-icon')).toBeVisible();
		await expect(replyUnreadMarker).toHaveCSS('color', 'rgb(82, 104, 134)');
		const readRootOpacity = Number(await replyUnreadMarker.evaluate((element) => getComputedStyle(element).opacity));
		expect(unreadRootOpacity).toBeGreaterThan(readRootOpacity);
		await expect(replyUnreadMarker).toHaveCSS('filter', 'grayscale(1) brightness(1.12)');
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
		await expect(marker.locator('.trace-marker-history-icon')).toBeVisible();
		await expect(marker).toHaveCSS('color', 'rgb(207, 6, 254)');
		const unreadReplyOpacityAfterRootRead = Number(await marker.evaluate((element) => getComputedStyle(element).opacity));
		await expect(marker).toHaveCSS('filter', 'none');
		await expect(page.locator('.trace-unread-indicator')).toBeVisible();
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __unreadArrivalCount?: number }).__unreadArrivalCount)).toBe(1);
		await expect(page.locator('.trace-unread-explanation')).toHaveCount(0);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectTraceReply(event: object): void } }).__relayStartupTest.injectTraceReply(event), replyWhileAlreadyUnread);
		await selectRelayTraceCell(page, '4,2');
		await expect(page.locator(`[data-trace-reply-id="${replyAfterRootRead.id}"]`)).toContainText(replyAfterRootRead.content);
		await expect(page.locator(`[data-trace-reply-id="${replyWhileAlreadyUnread.id}"]`)).toContainText(replyWhileAlreadyUnread.content);
		expect(await page.evaluate(() => (window as typeof window & { __unreadArrivalCount?: number }).__unreadArrivalCount)).toBe(1);
		const hideTimeline = page.locator('.chatter-toggle');
		if (await hideTimeline.isVisible()) await hideTimeline.click();
		const requestsBeforeTraceClose = (await relayState(page)).state.requests.length;
		const knownReplyDeliveriesBeforeClose = await page.evaluate((replyId) =>
			(window as typeof window & { __relayStartupTest: { state: { traceDeliveries: string[] } } }).__relayStartupTest.state.traceDeliveries
				.filter((id) => id === replyId).length, replyAfterRootRead.id);
		await clickRelayLogicalCell(page, { x: 0, y: 0 });
		await expect(marker).toHaveAttribute('data-trace-root-read', 'true');
		await expect(marker).not.toHaveAttribute('data-trace-root-unread-reply');
		await expect(marker.locator('.trace-marker-history-icon')).toBeVisible();
		await expect(marker).toHaveCSS('color', 'rgb(82, 104, 134)');
		const readRootOpacityAfterReplyRead = Number(await marker.evaluate((element) => getComputedStyle(element).opacity));
		expect(unreadReplyOpacityAfterRootRead).toBeGreaterThan(readRootOpacityAfterReplyRead);
		await expect(marker).toHaveCSS('filter', 'grayscale(1) brightness(1.12)');
		await expect.poll(async () => {
			const state = await relayState(page);
			const notificationRequests = state.state.requests.slice(requestsBeforeTraceClose).filter((request) =>
				request.filters.length === 1 && request.filters.some((filter) =>
					(filter.kinds as number[] | undefined)?.includes(1111) &&
					(filter['#p'] as string[] | undefined)?.includes(selfPubkey) &&
					!filter['#E'] && !filter['#e']));
			const knownReplyDeliveries = await page.evaluate((replyId) =>
				(window as typeof window & { __relayStartupTest: { state: { traceDeliveries: string[] } } }).__relayStartupTest.state.traceDeliveries
					.filter((id) => id === replyId).length, replyAfterRootRead.id);
			return notificationRequests.length >= AUTHORITATIVE_RELAYS.length &&
				knownReplyDeliveries >= knownReplyDeliveriesBeforeClose + AUTHORITATIVE_RELAYS.length;
		}).toBe(true);
		const secondReplyCandidate = parseTraceReplyCandidate(replyAfterSecondRead);
		expect(secondReplyCandidate).not.toBeNull();
		expect(validateTraceReplyCandidate(secondReplyCandidate!, parsedRoot, parsedRoot)).not.toBeNull();
		const notificationDeliveries = await page.evaluate((event) => (window as typeof window & {
			__relayStartupTest: { injectTraceNotificationReply(event: object): number }
		}).__relayStartupTest.injectTraceNotificationReply(event), replyAfterSecondRead);
		expect(notificationDeliveries).toBe(AUTHORITATIVE_RELAYS.length);
		await expect(marker).toHaveAttribute('data-trace-root-unread-reply', 'true');
		await expect(page.locator('.trace-unread-indicator')).toBeVisible();
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __unreadArrivalCount?: number }).__unreadArrivalCount)).toBe(2);
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
		await page.setViewportSize({ width: 320, height: 844 });
		await installHostOwnedStub(page);
		await installPromptApiStub(page);
		await installDelayedRelay(page, { primaryEvents: primary, traceRoots: [root], traceReplies: [reply] });
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret), Date.now() + 7 * 24 * 60 * 60 * 1000, 500);
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
		const fieldGeometryBeforeToggle = await page.locator('.field-grid').boundingBox();
		const fieldCellSizeBeforeToggle = await page.locator('.field-scene').evaluate((element) => getComputedStyle(element).getPropertyValue('--cell-size'));
		for (const width of [320, 360, 390]) {
			await page.setViewportSize({ width, height: 844 });
			const geometry = await page.evaluate(() => {
				const rect = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect().toJSON();
				return {
					dock: rect('.action-dock'),
					content: rect('.action-dock-content'),
					editor: rect('.composer-editor-slot'),
					left: rect('.composer-controls-left'),
					right: rect('.composer-controls-right'),
					controls: ['.profile-trigger', '.chatter-toggle', '.trace-unread-indicator', '.speaker-button', '.speech-type-toggle', '.suggestions-toggle']
						.map((selector) => rect(selector))
				};
			});
			if (width < 360) {
				expect(geometry.left.bottom).toBeLessThanOrEqual(geometry.right.top);
			} else {
				expect(geometry.left.top).toBeLessThan(geometry.right.bottom);
				expect(geometry.right.top).toBeLessThan(geometry.left.bottom);
				expect(geometry.left.right).toBeLessThanOrEqual(geometry.right.left);
			}
			expect(geometry.left.left).toBeGreaterThanOrEqual(geometry.content.left);
			expect(geometry.left.right).toBeLessThanOrEqual(geometry.content.right);
			expect(geometry.left.top).toBeGreaterThanOrEqual(geometry.content.top);
			expect(geometry.left.bottom).toBeLessThanOrEqual(geometry.content.bottom);
			expect(geometry.right.left).toBeGreaterThanOrEqual(geometry.content.left);
			expect(geometry.right.right).toBeLessThanOrEqual(geometry.content.right);
			expect(geometry.right.top).toBeGreaterThanOrEqual(geometry.content.top);
			expect(geometry.right.bottom).toBeLessThanOrEqual(geometry.content.bottom);
			for (const box of [geometry.editor, ...geometry.controls]) {
				expect(box.left).toBeGreaterThanOrEqual(0);
				expect(box.top).toBeGreaterThanOrEqual(0);
				expect(box.right).toBeLessThanOrEqual(width);
				expect(box.bottom).toBeLessThanOrEqual(geometry.dock.bottom);
			}
			for (const control of geometry.controls) {
				expect(control.width).toBeGreaterThanOrEqual(44);
				expect(control.height).toBeGreaterThanOrEqual(44);
			}
			for (let first = 0; first < geometry.controls.length; first += 1) {
				for (let second = first + 1; second < geometry.controls.length; second += 1) {
					const a = geometry.controls[first];
					const b = geometry.controls[second];
					expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
				}
			}
		}

		await page.setViewportSize({ width: 320, height: 844 });
		const manualTrace = page.locator('.manual-trace-toggle');
		await manualTrace.click();
		await expect(manualTrace).toHaveAttribute('aria-pressed', 'true');
		expect(await page.locator('.field-grid').boundingBox()).toEqual(fieldGeometryBeforeToggle);
		expect(await page.locator('.field-scene').evaluate((element) => getComputedStyle(element).getPropertyValue('--cell-size'))).toBe(fieldCellSizeBeforeToggle);
		await manualTrace.click();
		await expect(manualTrace).toHaveAttribute('aria-pressed', 'false');
		const chatter = page.locator('.chatter-toggle');
		await chatter.click();
		await expect(chatter).toHaveAttribute('aria-pressed', 'true');
		await chatter.click();
		await expect(chatter).toHaveAttribute('aria-pressed', 'false');

		const profile = page.getByRole('button', { name: '自分のプロフィールを開く' });
		await profile.click();
		const profileDialog = page.getByRole('dialog');
		await expect(profileDialog).toBeVisible();
		const profileClose = profileDialog.getByRole('button', { name: '閉じる' });
		await expectDialogIconCloseButton(profileDialog, profileClose, '閉じる');
		await profileClose.click();
		await expect(profileDialog).toBeHidden();

		const unread = page.locator('.trace-unread-indicator');
		const dockBeforeExplanation = await page.locator('.action-dock').boundingBox();
		await unread.click();
		const explanation = page.locator('.trace-unread-explanation');
		await expect(explanation).toHaveText('どこかにあなたへの返信の痕跡があります');
		await expectUnreadPopoverPresentation(page, 320, 844);
		const explanationBox = await explanation.boundingBox();
		const dockWithExplanation = await page.locator('.action-dock').boundingBox();
		expect(explanationBox && dockBeforeExplanation && dockWithExplanation).toBeTruthy();
		if (explanationBox && dockBeforeExplanation && dockWithExplanation) {
			expect(explanationBox.x).toBeGreaterThanOrEqual(16);
			expect(explanationBox.x + explanationBox.width).toBeLessThanOrEqual(320 - 16);
			expect(explanationBox.y).toBeGreaterThanOrEqual(16);
			expect(explanationBox.y + explanationBox.height).toBeLessThanOrEqual(844 - 16);
			expect(dockWithExplanation.height).toBe(dockBeforeExplanation.height);
		}
		await unread.click();
		await expect(explanation).toHaveCount(0);
		await unread.click();
		await expect(explanation).toBeVisible();
		await page.locator('body').click({ position: { x: 10, y: 10 } });
		await expect(explanation).toHaveCount(0);

		const speaker = page.getByRole('button', { name: /Open sound settings/ });
		await speaker.click();
		const soundDialog = page.getByRole('dialog', { name: 'Sound settings' });
		await expect(soundDialog.getByRole('slider', { name: 'Sound volume' })).toBeVisible();
		await speaker.click();
		await expect(soundDialog).toBeHidden();

		const speechType = page.locator('.speech-type-toggle');
		const initialSpeechType = await speechType.getAttribute('data-speech-type');
		await speechType.click();
		await expect.poll(() => speechType.getAttribute('data-speech-type')).not.toBe(initialSpeechType);
		const nextSpeechType = await speechType.getAttribute('data-speech-type');
		await speechType.click();
		await expect.poll(() => speechType.getAttribute('data-speech-type')).not.toBe(nextSpeechType);
		await speechType.click();
		await expect(speechType).toHaveAttribute('data-speech-type', initialSpeechType!);

		const suggestions = page.getByRole('button', { name: 'AI発言候補を生成' });
		await suggestions.click();
		const candidatePanel = page.locator('.suggestion-panel');
		await expect(candidatePanel).toBeVisible();
		const candidateClose = page.getByRole('button', { name: '発言候補を閉じる' });
		await expectIconCloseButton(candidateClose, '発言候補を閉じる');
		await candidateClose.click();
		await expect(candidatePanel).toHaveCount(0);
	});

	test('opens death 遺言 with the regular reply tree, publication, and semantic validation', async ({ page }) => {
		const now = Date.now();
		const trace = traceRuntimeEvents();
		const channel = { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' };
		const deathSecret = fixtureSecret(37);
		const deathRoot = finalizeEvent(buildDeathTraceEventTemplate({
			channel, content: '遺言 root', position: { x: 4, y: 2 }, createdAt: Math.floor(now / 1000)
		}), deathSecret);
		const parsedDeath = parseTraceEvent(deathRoot, CHANNEL_ID);
		if (!parsedDeath || parsedDeath.source !== 'death') throw new Error('Death Trace fixture did not parse.');
		const direct = finalizeEvent(buildTraceReplyTemplate({
			root: parsedDeath, parent: parsedDeath, content: '遺言 direct reply', speechType: 'normal', createdAt: Math.floor(now / 1000) + 1
		}), fixtureSecret(31));
		const parsedDirect = parseTraceReplyCandidate(direct);
		if (!parsedDirect) throw new Error('Death Trace direct reply fixture did not parse.');
		const validatedDirect = validateTraceReplyCandidate(parsedDirect, parsedDeath, parsedDeath);
		if (!validatedDirect) throw new Error('Death Trace direct reply fixture did not validate.');
		const nested = finalizeEvent(buildTraceReplyTemplate({
			root: parsedDeath, parent: validatedDirect, content: '遺言 nested reply', speechType: 'shout', createdAt: Math.floor(now / 1000) + 2
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
		await expect(page.locator(`[data-trace-root-id="${deathRoot.id}"]`)).toContainText('遺言 root');
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
		await expect(page.getByLabel('Reply preview', { exact: true })).toHaveCount(0);

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
