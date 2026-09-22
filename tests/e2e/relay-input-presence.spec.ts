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
import { CHANNEL_ID, AUTHORITATIVE_RELAYS, fixtureSecret, profileDialog, openProfile, installDelayedRelay, relayState, openClockedReadyRelayWorld, pauseAtCurrentBrowserTime, installVisualAnimationRafMetrics, openReadyRelayWorld, seedRelayAccount, chooseHorizontalMove, chooseMoveToward, pressRelayKeyboardMovement, reverseMoveKey, type AvailableMove } from './helpers/relayHarness';


test.describe('Relay startup', () => {
	test('uses an empty Host-owned Composer editor Arrow for one movement and prevents its default', async ({ page }) => {
		const editor = await openClockedReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const move = await chooseHorizontalMove(page);
		await page.evaluate(() => {
			(window as typeof window & { __keyboardDefaulted?: boolean }).__keyboardDefaulted = false;
			window.addEventListener('keydown', (event) => {
				if (event.key.startsWith('Arrow')) (window as typeof window & { __keyboardDefaulted?: boolean }).__keyboardDefaulted = event.defaultPrevented;
			});
		});
		await editor.focus();
		await pressRelayKeyboardMovement(page, move, { advanceToNextPositionSecond: true });
		await expect(self).toHaveAttribute('data-movement-animation', 'active');
		await page.clock.runFor(16);
		await expect(self).toHaveAttribute('data-movement-animation', 'active');
		await page.clock.runFor(1_000);
		await expect(self).not.toHaveAttribute('data-movement-animation', 'active');
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __keyboardDefaulted?: boolean }).__keyboardDefaulted)).toBe(true);
	});

	test('does not move or prevent Arrow default from another Composer control', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const before = await self.getAttribute('data-position');
		await page.evaluate(() => {
			(window as typeof window & { __keyboardDefaulted?: boolean }).__keyboardDefaulted = false;
			window.addEventListener('keydown', (event) => {
				if (event.key.startsWith('Arrow')) (window as typeof window & { __keyboardDefaulted?: boolean }).__keyboardDefaulted = event.defaultPrevented;
			});
		});
		const send = page.locator('ehagaki-composer').getByRole('button', { name: 'Send' });
		await send.focus();
		await page.keyboard.press('ArrowRight');
		await expect(self).toHaveAttribute('data-position', before ?? '');
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __keyboardDefaulted?: boolean }).__keyboardDefaulted)).toBe(false);
	});

	test('preserves Composer editing Arrow behavior while non-empty and re-enables movement after deletion', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const before = await self.getAttribute('data-position');
		await editor.fill('x');
		await editor.focus();
		await page.keyboard.press('ArrowLeft');
		await expect(self).toHaveAttribute('data-position', before ?? '');
		await expect.poll(() => editor.evaluate((element) => ({
			value: (element as HTMLTextAreaElement).value,
			selectionStart: (element as HTMLTextAreaElement).selectionStart
		}))).toEqual({ value: 'x', selectionStart: 0 });

		await editor.fill('');
		const move = await chooseHorizontalMove(page);
		await editor.focus();
		await pressRelayKeyboardMovement(page, move);
	});

	test('fails closed for Composer empty-state null and preserves modifier Arrow behavior', async ({ page }) => {
		await page.addInitScript(() => {
			(window as typeof window & { __ehagakiDeferComposerEmptyState?: boolean }).__ehagakiDeferComposerEmptyState = true;
		});
		const editor = await openReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const before = await self.getAttribute('data-position');
		const move = await chooseHorizontalMove(page);
		await editor.focus();
		await page.keyboard.press(move.key);
		await expect(self).toHaveAttribute('data-position', before ?? '');

		await page.evaluate(() => (window as typeof window & { __ehagakiResolveComposerEmptyState?: () => void }).__ehagakiResolveComposerEmptyState?.());
		await page.keyboard.press('Shift+' + move.key);
		await page.keyboard.press('Control+' + move.key);
		await page.keyboard.press('Alt+' + move.key);
		await page.keyboard.press('Meta+' + move.key);
		await expect(self).toHaveAttribute('data-position', before ?? '');

		await editor.fill('');
		await pressRelayKeyboardMovement(page, move);
	});

	test('continues Composer-empty movement on a hold at the Relay movement cadence', async ({ page }) => {
		const editor = await openClockedReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const position = await self.getAttribute('data-position');
		if (!position) throw new Error('Expected the Relay self participant position.');
		const [x] = position.split(',').map(Number);
		const move = await chooseHorizontalMove(page);
		const key = move.key;
		const publishedPositionIds = async () => new Set(
			(await relayState(page)).state.published
				.filter((event) => event.kind === WORLD_STATE_KIND)
				.map((event) => event.id)
		).size;
		const initialPublishedPositionCount = await publishedPositionIds();
		await editor.focus();
		await page.evaluate((movementKey) => {
			(window as typeof window & { __relayCadenceKeydown?: string }).__relayCadenceKeydown = undefined;
			window.addEventListener('keydown', (event) => {
				if (event.key === movementKey) (window as typeof window & { __relayCadenceKeydown?: string }).__relayCadenceKeydown = event.key;
			}, { once: true });
		}, key);
		await page.keyboard.down(key);
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __relayCadenceKeydown?: string }).__relayCadenceKeydown)).toBe(key);
		await page.clock.runFor(50);
		// Let the fake-clock timer at the 50ms boundary dispatch before observing the publish.
		await page.clock.runFor(1);
		await expect.poll(publishedPositionIds).toBeGreaterThan(initialPublishedPositionCount);
		await expect(self).toHaveAttribute('data-position', move.expected);
		await page.clock.runFor(750);
		await page.clock.runFor(750);
		await page.keyboard.up(key);
		const finalPosition = await self.getAttribute('data-position');
		const [finalX] = (finalPosition ?? '').split(',').map(Number);
		expect(Math.abs(finalX - x)).toBeGreaterThanOrEqual(1);
		await page.clock.runFor(1_000);
		await expect(self).toHaveAttribute('data-position', finalPosition ?? '');
	});

	test('focuses the Composer with N and blurs it with Escape before WASD movement', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const move = await chooseHorizontalMove(page);

		await page.locator('.participant').first().focus();
		await page.keyboard.press('n');
		await expect(editor).toBeFocused();

		await editor.fill('keep this content');
		await page.keyboard.press('Escape');
		await expect(editor).not.toBeFocused();
		await expect(editor).toHaveValue('keep this content');
		await pressRelayKeyboardMovement(page, { key: move.key === 'ArrowRight' ? 'd' : 'a', expected: move.expected });
	});

	test('keeps WASD and N as normal Composer input while the editor is focused', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const before = await self.getAttribute('data-position');

		await editor.fill('');
		await editor.focus();
		for (const key of ['w', 'a', 's', 'd', 'n', 'c']) await page.keyboard.press(key);
		await expect(self).toHaveAttribute('data-position', before ?? '');
		await expect(editor).toHaveValue('wasdnc');
	});

	test('does not intercept Composer shortcuts while a profile dialog is open', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const before = await self.getAttribute('data-position');

		await openProfile(page);
		await page.keyboard.press('d');
		await page.keyboard.press('n');
		await expect(self).toHaveAttribute('data-position', before ?? '');
		await expect(editor).not.toBeFocused();
		await expect(profileDialog(page)).toBeVisible();
	});

	test('does not intercept WASD or N during composition or with modifiers in the Composer', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const before = await self.getAttribute('data-position');

		await page.locator('.participant').first().focus();
		await page.keyboard.press('Shift+d');
		await page.keyboard.press('Control+n');
		await page.keyboard.press('Alt+w');
		await page.keyboard.press('Meta+a');
		await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'd', code: 'KeyD', isComposing: true, bubbles: true
		})));
		await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'n', code: 'KeyN', isComposing: true, bubbles: true
		})));
		await expect(self).toHaveAttribute('data-position', before ?? '');
		await expect(editor).not.toBeFocused();

		await editor.fill('composition content');
		await editor.focus();
		await editor.evaluate((element) => element.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'Escape', code: 'Escape', isComposing: true, bubbles: true, composed: true
		})));
		await expect(editor).toBeFocused();
		await expect(editor).toHaveValue('composition content');
	});

	test('permanently dismisses speech at a visual RAF crossing before canonical refresh', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.clock.install({ time: Date.now() });
		await page.addInitScript(() => {
			const browserWindow: Window = window;
			const interval = browserWindow.setInterval.bind(browserWindow);
			const refresh = { ticks: 0, lastTick: 0 };
			browserWindow.setInterval = (handler, timeout, ...args) => {
				if (timeout !== 250 || typeof handler !== 'function') return interval(handler, timeout, ...args);
				return interval(() => {
					refresh.ticks += 1;
					refresh.lastTick = Date.now();
					handler(...args);
				}, timeout);
			};
			Object.assign(window, { __presenceRefreshClock: refresh });
		});
		const channel = { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' };
		const createdAt = Math.floor(Date.now() / 1000);
		const selfSecret = fixtureSecret(23);
		const remoteSecret = fixtureSecret(19);
		const speech = finalizeEvent(buildWorldMessageTemplate({
			channel, createdAt, content: 'speech remains dismissed after the visual speaker returns',
			speechType: 'normal', position: { x: 10, y: 3 }
		}), remoteSecret);
		const selfPosition = finalizeEvent(buildWorldStateEventTemplate({
			channel, createdAt, position: { x: 7, y: 3 }, slot: 0
		}), selfSecret);
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: { message: speech, position: selfPosition } });
		await seedRelayAccount(page, selfSecret, selfPosition.pubkey);
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		const bubble = page.locator(`[data-bubble-participant-id="${speech.pubkey}"]`);
		const speaker = page.locator(`.participant[data-participant-id="${speech.pubkey}"]`);
		await expect(bubble).toBeVisible();
		await pauseAtCurrentBrowserTime(page);
		await page.clock.runFor(500);
		const refreshClock = () => page.evaluate(() => {
			const refresh = (window as unknown as { __presenceRefreshClock: { ticks: number; lastTick: number } }).__presenceRefreshClock;
			return { ...refresh, now: Date.now() };
		});
		const clock = await refreshClock();
		expect(clock.ticks).toBeGreaterThan(0);
		// Advance exactly to a controlled refresh boundary; no wall-clock race.
		await page.clock.runFor(clock.lastTick + 250 - clock.now);
		const before = await refreshClock();
		const sampleX = () => speaker.evaluate((element) => {
			const rect = element.getBoundingClientRect();
			const area = document.querySelector('.field-area')!.getBoundingClientRect();
			return { x: rect.x + rect.width / 2, left: area.left, right: area.right };
		});
		const initial = await sampleX();
		expect(initial.x).toBeGreaterThan(initial.left);
		expect(initial.x).toBeLessThan(initial.right);
		const injectPosition = async (x: number, slot: 0 | 1) => {
			const event = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt, position: { x, y: 3 }, slot }), remoteSecret);
			await page.evaluate((event) => (window as unknown as {
				__relayStartupTest: { injectPosition(event: object): void };
			}).__relayStartupTest.injectPosition(event), event);
		};
		await injectPosition(15, 0);
		await expect(speaker).toHaveAttribute('data-position', '15,3');
		await page.clock.runFor(100);
		const outside = await sampleX();
		expect(outside.x).toBeGreaterThan(outside.right);
		await expect(bubble).toHaveCount(0);
		expect((await refreshClock()).ticks).toBe(before.ticks);
		// Canonical position is back inside before any refresh can dismiss it.
		await injectPosition(10, 1);
		await expect(speaker).toHaveAttribute('data-position', '10,3');
		await page.clock.runFor(500);
		const returned = await sampleX();
		expect(returned.x).toBeGreaterThan(returned.left);
		expect(returned.x).toBeLessThan(returned.right);
		expect((await refreshClock()).ticks).toBeGreaterThan(before.ticks);
		await expect(bubble).toHaveCount(0);
	});

	test('removes a remote participant immediately when a live World State exit arrives', async ({ page }) => {
		const selfSecret = fixtureSecret(19);
		const remoteSecret = fixtureSecret(20);
		const createdAt = Math.floor(Date.now() / 1000);
		const channel = { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' };
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { deferPrimaryEvents: true });
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === WORLD_STATE_KIND
		)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimaryEvents(): void; releasePrimary(): void } }).__relayStartupTest.releasePrimaryEvents());
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());

		const cell = { x: 2, y: 1 };
		const active = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt, position: cell, slot: 0 }), remoteSecret);
		const exit = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt, position: cell, slot: 'exit' }), remoteSecret);
		const inject = (event: NostrEvent) => page.evaluate((nextEvent) => (window as typeof window & {
			__relayStartupTest: { injectPosition(event: object): void }
		}).__relayStartupTest.injectPosition(nextEvent), event);
		await inject(active);
		const remote = page.locator(`.participant[data-participant-id="${active.pubkey}"]`);
		await expect(remote).toHaveAttribute('data-position', `${cell.x},${cell.y}`);
		await inject(exit);
		await expect(remote).toHaveCount(0);
		await expect(page.locator(`.participant[data-position="${cell.x},${cell.y}"]`)).toHaveCount(0);
	});

	test('retargets active participant and camera animation when another participant updates', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.clock.install({ time: Date.now() });
		const editor = await openReadyRelayWorld(page);
		await pauseAtCurrentBrowserTime(page);
		await installVisualAnimationRafMetrics(page);
		const self = page.locator('.participant[data-self="true"]');
		const scene = page.locator('.field-scene');
		const remotePosition = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' },
			position: { x: 4, y: 2 },
			slot: 0,
			createdAt: Math.floor(Date.now() / 1000) + 1
		}), fixtureSecret(19));

		const initialPosition = await self.getAttribute('data-position');
		if (!initialPosition) throw new Error('Expected the Relay self participant position.');
		const [initialX, initialY] = initialPosition.split(',').map(Number);
		const cameraBoundary = { x: initialX < 8 ? 15 : 0, y: initialY < 4 ? 7 : 0 };
		let move = await chooseMoveToward(page, cameraBoundary);
		let retargetMove: AvailableMove | null = null;
		for (let attempt = 0; attempt < 16; attempt += 1) {
			const transformBeforeMove = await scene.evaluate((element) => getComputedStyle(element).transform);
			const positionBeforeMove = await self.getAttribute('data-position');
			if (!positionBeforeMove) throw new Error('Expected the Relay self participant position.');
			await editor.focus();
			await pressRelayKeyboardMovement(page, move, { advanceToNextPositionSecond: true });
			await expect(self).toHaveAttribute('data-movement-animation', 'active');
			await page.clock.runFor(2_000);
			const transformAfterMove = await scene.evaluate((element) => getComputedStyle(element).transform);
			if (transformAfterMove !== transformBeforeMove) {
				retargetMove = {
					key: reverseMoveKey(move.key),
					expected: positionBeforeMove
				};
				break;
			}
			await expect(self).not.toHaveAttribute('data-movement-animation', 'active');
			move = await chooseMoveToward(page, cameraBoundary);
		}
		expect(retargetMove).not.toBeNull();

		const transformBeforeRetarget = await scene.evaluate((element) => getComputedStyle(element).transform);
		await editor.focus();
		await pressRelayKeyboardMovement(page, retargetMove!, { advanceToNextPositionSecond: true });
		await expect(self).toHaveAttribute('data-movement-animation', 'active');
		await page.evaluate((event) => {
			(window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event);
		}, remotePosition);
		await page.clock.runFor(100);
		await expect(self).toHaveAttribute('data-movement-animation', 'active');
		await expect(scene).toHaveAttribute('data-camera-animation', 'active');
		expect(await page.evaluate(() => (window as typeof window & { __visualAnimationRafMetrics: { maxPending(): number } }).__visualAnimationRafMetrics.maxPending())).toBeLessThanOrEqual(1);
		const transformDuringRetarget = await scene.evaluate((element) => getComputedStyle(element).transform);

		await page.clock.runFor(1_000);
		await expect(self).not.toHaveAttribute('data-movement-animation', 'active');
		await expect(scene).not.toHaveAttribute('data-camera-animation', 'active');
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __visualAnimationRafMetrics: { pending(): number } }).__visualAnimationRafMetrics.pending())).toBe(0);
		const transformAtRest = await scene.evaluate((element) => getComputedStyle(element).transform);
		expect(transformBeforeRetarget).not.toBe(transformAtRest);
		expect(transformDuringRetarget).not.toBe(transformAtRest);
		await expect(self).toHaveAttribute('data-position', retargetMove!.expected);
		await expect(page.locator(`.participant[data-participant-id="${remotePosition.pubkey}"]`)).toHaveAttribute('data-position', '4,2');
	});
});
