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
import { CHANNEL_ID, AUTHORITATIVE_RELAYS, fixtureSecret, installVirtualKeyboardStub, installDelayedRelay, relayState, openReadyRelayWorld, seedRelayAccount } from './helpers/relayHarness';


test.describe('Relay startup', () => {
	for (const width of [700, 701]) {
		test(`keeps Chatter initialization and overlay geometry at width ${width}`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			await openReadyRelayWorld(page);
			const chatter = page.locator('aside.recent-message-timeline');
			const chatterToggle = page.locator('.chatter-toggle');
			await expect(chatter).toBeVisible({ visible: width > 700 });
			await expect(chatterToggle).toHaveAttribute('aria-pressed', String(width > 700));
			await expect(page.locator('.timeline-hide-control, .timeline-show-control')).toHaveCount(0);
			const geometry = () => page.evaluate(() => ({
				rects: ['.field-viewport', '.field-area', '.field-scene', '.speech-area', '.action-dock', '.participant']
					.map((selector) => [...document.querySelectorAll(selector)].map((node) => node.getBoundingClientRect().toJSON())),
				camera: getComputedStyle(document.querySelector('.field-scene')!).transform
			}));
			const before = await geometry();
			for (const open of [width <= 700, width > 700]) {
				await chatterToggle.click();
				await expect(chatter).toBeVisible({ visible: open });
				await expect(chatterToggle).toHaveAttribute('aria-pressed', String(open));
				expect(await geometry()).toEqual(before);
			}
			await expect.poll(() => page.evaluate(() => localStorage.getItem('persona-bubble-field:chatter-open')))
				.toBe(String(width > 700));
			// Keep a manual choice opposite to the next viewport's reload default.
			await page.setViewportSize({ width: width === 700 ? 701 : 700, height: 900 });
			await expect(page.locator('.field-area')).toHaveCSS('width', width === 700 ? '685px' : '684px');
			await expect(chatter).toBeVisible({ visible: width > 700 });
			await page.reload();
			await expect(page.locator('.field-viewport')).toHaveClass(/initial-field-geometry-ready/);
			await expect(chatter).toBeVisible({ visible: width > 700 });
			await expect(chatterToggle).toHaveAttribute('aria-pressed', String(width > 700));
		});
	}

	test('centers the first visible field frame before Relay bootstrap and preserves it through presence', async ({ page }) => {
		await page.setViewportSize({ width: 2560, height: 1440 });
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await installFieldFrameSampling(page);
		const secret = fixtureSecret(41);
		await seedRelayAccount(page, secret, getPublicKey(secret));
		await page.goto('/');
		await expect.poll(async () => (await readFieldFrames(page)).filter((frame) => frame.source === 'frame' && frame.visible).length).toBeGreaterThan(0);
		const first = (await readFieldFrames(page)).find((frame) => frame.source === 'frame' && frame.visible)!;
		expect(first.scene.width).toBe(1216);
		expect(first.scene.height).toBe(608);
		expect(Math.abs(
		(first.scene.x + first.scene.width / 2) - (first.area.x + first.area.width / 2)
	)).toBeLessThan(0.5);
		expect(Math.abs(
		(first.scene.y + first.scene.height / 2) - (first.area.y + first.area.height / 2)
	)).toBeLessThan(0.5);
		expect(first.viewport).toEqual({ x: 0, y: 0, width: 2560, height: 1373 });
		expect(first.composer?.height).toBe(67);
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as unknown as { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('.participant[data-self="true"]')).toBeVisible();
		const visible = (await sampleRenderedField(page)).filter((frame) => frame.source === 'frame' && frame.visible);
		for (const frame of visible) {
			expect(frame.scene.width).toBe(1216);
			expect(frame.scene.height).toBe(608);
			expect(frame.scene.x).toBeGreaterThanOrEqual(frame.area.x - frame.scene.width);
			expect(frame.scene.x).toBeLessThanOrEqual(frame.area.x + frame.area.width);
			expect(frame.scene.y).toBeGreaterThanOrEqual(frame.area.y - frame.scene.height);
			expect(frame.scene.y).toBeLessThanOrEqual(frame.area.y + frame.area.height);
		}
	});

	test('renders DEV sandbox without Composer in the initial response or after hydration', async ({ page }) => {
		const hostOwned = await installHostOwnedStub(page);
		const consoleIssues: string[] = [];
		page.on('console', (message) => {
			if (message.type() === 'warning' || message.type() === 'error') consoleIssues.push(message.text());
		});
		page.on('pageerror', (error) => consoleIssues.push(error.message));

		const response = await page.goto('/?devWorld=1');
		expect(response).not.toBeNull();
		expect(await response!.text()).not.toContain('<div class="action-dock');

		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await expect(page.locator('.participant')).toHaveCount(1);
		await expect(page.locator('.action-dock')).toHaveCount(0);
		await expect(page.locator('ehagaki-composer')).toHaveCount(0);
		const soundButton = page.getByRole('button', { name: 'Open sound settings' });
		await expect(soundButton).toBeVisible();
		await soundButton.click();
		await expect(page.getByRole('dialog', { name: 'Sound settings' })).toBeVisible();
		expect(hostOwned.requests()).toBe(0);
		expect(consoleIssues).toEqual([]);
	});

	test('keeps history-only messages in the timeline without restoring their presence or bubbles', async ({ page }) => {
		const historySecret = fixtureSecret(20);
		const createdAt = Math.floor(Date.now() / 1000) - 3_600;
		const historyMessage = finalizeEvent(buildWorldMessageTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' },
			content: 'history-only message',
			speechType: 'monologue',
			position: { x: 1, y: 1 },
			createdAt
		}), historySecret);
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { historyMessages: [historyMessage] });
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === 42 &&
			request.filters.length === 2 &&
			request.filters.some((filter) => typeof filter.since === 'number') &&
			request.filters.some((filter) => filter.limit === 50 && filter.since === undefined)
		)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());

		await expect(page.locator(`[data-timeline-event-id="${historyMessage.id}"]`)).toHaveCount(1);
		await expect(page.locator(`[data-participant-id="${historyMessage.pubkey}"]`)).toHaveCount(0);
		await expect(page.locator(`[data-bubble-id="${historyMessage.id}"]`)).toHaveCount(0);
	});

	test('continues timeline ingestion while its overlay is hidden', async ({ page }) => {
		await page.setViewportSize({ width: 1200, height: 500 });
		const liveSecret = fixtureSecret(21);
		const liveMessage = finalizeEvent(buildWorldMessageTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' },
			content: 'arrived while hidden',
			speechType: 'normal',
			position: { x: 3, y: 3 },
			createdAt: Math.floor(Date.now() / 1000)
		}), liveSecret);
		const historyMessages = Array.from({ length: 9 }, (_, index) => finalizeEvent(buildWorldMessageTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' },
			content: `history ${index + 1}`,
			speechType: 'normal',
			position: { x: 3, y: 3 },
			createdAt: Math.floor(Date.now() / 1000) - 3_600 - index
		}), fixtureSecret(30 + index)));
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { historyMessages });
		const selfSecret = fixtureSecret(41);
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		await page.goto('/');
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === 42
		)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('.participant')).toHaveCount(2);
		await expect(page.locator('aside.recent-message-timeline')).toBeVisible();
		const visibleTimeline = page.locator('.timeline-visible-entries .timeline-entry');
		const beforeHiddenIds = await visibleTimeline.evaluateAll((entries) => entries.map((entry) => entry.getAttribute('data-timeline-event-id')));
		await page.locator('.chatter-toggle').click();
		await expect(page.locator('aside.recent-message-timeline')).toBeHidden();
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectMessage(event: object): void } }).__relayStartupTest.injectMessage(event), liveMessage);
		await page.locator('.chatter-toggle').click();
		await expect(page.locator(`[data-timeline-event-id="${liveMessage.id}"]`)).toHaveCount(1);
		const afterShownIds = await visibleTimeline.evaluateAll((entries) => entries.map((entry) => entry.getAttribute('data-timeline-event-id')));
		expect(afterShownIds.some((id) => !beforeHiddenIds.includes(id))).toBe(true);
	});

	for (const viewport of [
		{ name: 'desktop', width: 1200, height: 900 },
		{ name: 'mobile', width: 390, height: 844 }
	]) {
		test(`reserves the one-line Composer from the initial render on ${viewport.name}`, async ({ page }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height });
			await installHostOwnedStub(page);
			await installDelayedRelay(page);

			const response = await page.goto('/', { waitUntil: 'commit' });
			expect(response).not.toBeNull();
			expect(await response!.text()).toContain('action-dock');

			await expect(page.locator('.action-dock')).toBeVisible();
			await expect(page.locator('ehagaki-composer')).toBeVisible();
			const beforePreferredHeight = await page.evaluate(() => {
				const shell = document.querySelector<HTMLElement>('.app-shell')!;
				const dock = document.querySelector<HTMLElement>('.action-dock')!;
				const field = document.querySelector<HTMLElement>('.field-viewport')!;
				return {
					dockHeight: dock.getBoundingClientRect().height,
					fieldHeight: field.getBoundingClientRect().height,
					viewportHeight: window.innerHeight,
					initialPreferredHeight: getComputedStyle(shell)
						.getPropertyValue('--composer-initial-preferred-height').trim(),
					preferredHeight: getComputedStyle(shell).getPropertyValue('--composer-preferred-height').trim()
				};
			});
			expect(beforePreferredHeight.initialPreferredHeight).toBe('50px');
			expect(beforePreferredHeight.preferredHeight).toBe('50px');
			const expectedInitialDockHeight = viewport.name === 'mobile' ? 121 : 71;
			expect(beforePreferredHeight.dockHeight).toBeCloseTo(expectedInitialDockHeight, 1);
			expect(beforePreferredHeight.fieldHeight + beforePreferredHeight.dockHeight)
				.toBeCloseTo(beforePreferredHeight.viewportHeight, 1);

			await page.evaluate(() => (window as typeof window & {
				__ehagakiSetPreferredHeight(height: number): void;
			}).__ehagakiSetPreferredHeight(50));
			await expect.poll(() => page.evaluate(() => document.querySelector<HTMLElement>('.action-dock')!.getBoundingClientRect().height))
				.toBeCloseTo(beforePreferredHeight.dockHeight, 1);

			const afterPreferredHeight = await page.evaluate(() => ({
				dockHeight: document.querySelector<HTMLElement>('.action-dock')!.getBoundingClientRect().height,
				fieldHeight: document.querySelector<HTMLElement>('.field-viewport')!.getBoundingClientRect().height
			}));
			expect(Math.abs(afterPreferredHeight.dockHeight - beforePreferredHeight.dockHeight)).toBeLessThan(0.5);
			expect(Math.abs(afterPreferredHeight.fieldHeight - beforePreferredHeight.fieldHeight)).toBeLessThan(0.5);
			if (viewport.name === 'desktop') {
				await page.evaluate(() => (window as typeof window & {
					__ehagakiSetPreferredHeight(height: number): void;
				}).__ehagakiSetPreferredHeight(200));
				await expect.poll(() => page.locator('.action-dock').evaluate((dock) => dock.getBoundingClientRect().height))
					.toBeGreaterThan(afterPreferredHeight.dockHeight);
				const grown = await page.evaluate(() => {
					const rect = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect().toJSON();
					return { dock: rect('.action-dock'), left: rect('.composer-controls-left'), editor: rect('.composer-editor-slot'), right: rect('.composer-controls-right'), field: rect('.field-viewport') };
				});
				const grownCenters = [grown.left, grown.editor, grown.right].map((box) => box.y + box.height / 2);
				expect(Math.max(...grownCenters) - Math.min(...grownCenters)).toBeLessThanOrEqual(1);
				for (const box of [grown.left, grown.editor, grown.right]) {
					expect(box.y).toBeGreaterThanOrEqual(grown.dock.y);
					expect(box.y + box.height).toBeLessThanOrEqual(grown.dock.y + grown.dock.height);
				}
				expect(grown.field.height).toBeCloseTo(afterPreferredHeight.fieldHeight, 1);
				await page.evaluate(() => (window as typeof window & {
					__ehagakiSetPreferredHeight(height: number): void;
				}).__ehagakiSetPreferredHeight(50));
			}
		});
	}

	test('keeps Field geometry reserved while only the fixed Composer follows VirtualKeyboard geometry', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await installVirtualKeyboardStub(page);
		await openReadyRelayWorld(page);
		await expect.poll(() => page.evaluate(() => (window as typeof window & {
			__virtualKeyboardTest: { state(): { overlaysContent: boolean } };
		}).__virtualKeyboardTest.state().overlaysContent)).toBe(true);

		const before = await page.evaluate(() => {
			const dock = document.querySelector<HTMLElement>('.action-dock')!;
			const field = document.querySelector<HTMLElement>('.field-viewport')!;
			const self = document.querySelector<HTMLElement>('.participant[data-self="true"]')!;
			return {
				dock: dock.getBoundingClientRect().toJSON(),
				field: field.getBoundingClientRect().toJSON(),
				participant: self.getBoundingClientRect().toJSON(),
				cameraTransform: getComputedStyle(document.querySelector<HTMLElement>('.field-scene')!).transform,
				position: getComputedStyle(dock).position,
				viewportHeight: window.innerHeight
			};
		});
		expect(before.position).toBe('fixed');
		expect(before.dock.bottom).toBeCloseTo(before.viewportHeight, 1);
		expect(before.field.height + before.dock.height).toBeCloseTo(before.viewportHeight, 1);

		await page.evaluate(() => (window as typeof window & {
			__virtualKeyboardTest: { setBottomInset(inset: number): void };
		}).__virtualKeyboardTest.setBottomInset(300));
		await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.app-shell')!)
			.getPropertyValue('--composer-keyboard-inset').trim())).toBe('300px');

		const keyboardOpen = await page.evaluate(() => {
			const dock = document.querySelector<HTMLElement>('.action-dock')!;
			const field = document.querySelector<HTMLElement>('.field-viewport')!;
			const self = document.querySelector<HTMLElement>('.participant[data-self="true"]')!;
			const editor = document.querySelector<HTMLElement>('.composer-editor-slot')!;
			const controlsLeft = document.querySelector<HTMLElement>('.composer-controls-left')!;
			const controlsRight = document.querySelector<HTMLElement>('.composer-controls-right')!;
			return {
				dock: dock.getBoundingClientRect().toJSON(),
				field: field.getBoundingClientRect().toJSON(),
				participant: self.getBoundingClientRect().toJSON(),
				editor: editor.getBoundingClientRect().toJSON(),
				controlsLeft: controlsLeft.getBoundingClientRect().toJSON(),
				controlsRight: controlsRight.getBoundingClientRect().toJSON(),
				cameraTransform: getComputedStyle(document.querySelector<HTMLElement>('.field-scene')!).transform
			};
		});
		expect(keyboardOpen.dock.bottom).toBeCloseTo(544, 1);
		expect(keyboardOpen.editor.bottom).toBeLessThan(keyboardOpen.controlsLeft.top);
		expect(keyboardOpen.controlsLeft.right).toBeLessThanOrEqual(keyboardOpen.controlsRight.left);
		expect(keyboardOpen.controlsRight.right).toBeLessThanOrEqual(390);
		expect(keyboardOpen.controlsRight.bottom).toBeLessThanOrEqual(keyboardOpen.dock.bottom);
		const keyboardSendBox = await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).boundingBox();
		expect(keyboardSendBox).not.toBeNull();
		if (keyboardSendBox) expect(keyboardSendBox.y + keyboardSendBox.height).toBeLessThanOrEqual(keyboardOpen.dock.bottom);
		expect(keyboardOpen.field.height).toBeCloseTo(before.field.height, 1);
		expect(keyboardOpen.participant).toEqual(before.participant);
		expect(keyboardOpen.cameraTransform).toBe(before.cameraTransform);

		await page.evaluate(() => (window as typeof window & {
			__virtualKeyboardTest: { setBottomInset(inset: number): void };
		}).__virtualKeyboardTest.setBottomInset(0));
		await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.app-shell')!)
			.getPropertyValue('--composer-keyboard-inset').trim())).toBe('0px');
		await expect(page.locator('.action-dock')).toHaveCSS('bottom', '0px');

	});

	for (const viewport of [
		{ name: 'desktop', width: 1200, height: 900 },
		{ name: 'mobile', width: 390, height: 844 }
	]) {
		test(`keeps Field geometry stable while Host-owned Composer grows on ${viewport.name}`, async ({ page }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height });
			await openReadyRelayWorld(page);
			const participantPosition = await page.locator('.participant[data-self="true"]').getAttribute('data-position');
			if (!participantPosition) throw new Error('Expected the Relay self participant position.');
			const [participantX, participantY] = participantPosition.split(',').map(Number);
			const bubbleEvent = finalizeEvent(buildWorldMessageTemplate({
				channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' },
				content: 'geometry regression bubble',
				speechType: 'normal',
				position: { x: participantX, y: participantY },
				// A same-second bootstrap position outranks a message's position evidence.
				createdAt: Math.floor(Date.now() / 1000) + 1
			}), fixtureSecret(19));
			await page.evaluate((event) => (window as typeof window & {
				__relayStartupTest: { injectMessage(event: object): void };
			}).__relayStartupTest.injectMessage(event), bubbleEvent);
			await expect(page.locator('.bubble').first()).toBeVisible();
			await expect(page.locator('.field-scene')).not.toHaveAttribute('data-camera-animation', 'active');
			await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
			const readGeometry = () => page.evaluate(() => {
				const rect = (selector: string, index = 0) => {
					const element = document.querySelectorAll<HTMLElement>(selector)[index];
					return element?.getBoundingClientRect().toJSON() ?? null;
				};
				return {
					dock: rect('.action-dock'),
					viewport: rect('.field-viewport'),
					area: rect('.field-area'),
					scene: rect('.field-scene'),
					speech: rect('.speech-area'),
					participant: rect('.participant[data-self="true"]'),
					bubble: rect('.bubble'),
					transform: getComputedStyle(document.querySelector('.field-scene')!).transform
				};
			});
			const before = await readGeometry();
			expect(before.bubble).not.toBeNull();

			await page.evaluate(() => (window as typeof window & {
				__ehagakiSetPreferredHeight(height: number): void;
			}).__ehagakiSetPreferredHeight(200));
			await expect.poll(async () => (await readGeometry()).dock!.height).toBeGreaterThan(before.dock!.height);
			const grown = await readGeometry();
			expect(grown.dock!.y).toBeLessThan(before.dock!.y);
			expect(grown.viewport).toEqual(before.viewport);
			expect(grown.area).toEqual(before.area);
			expect(grown.scene).toEqual(before.scene);
			expect(grown.speech).toEqual(before.speech);
			expect(grown.participant).toEqual(before.participant);
			expect(grown.bubble).toEqual(before.bubble);
			expect(grown.transform).toBe(before.transform);

			await page.evaluate(() => (window as typeof window & {
				__ehagakiSetPreferredHeight(height: number): void;
			}).__ehagakiSetPreferredHeight(50));
			await expect.poll(async () => (await readGeometry()).dock!.height).toBeCloseTo(before.dock!.height, 1);
			const restored = await readGeometry();
			expect(restored.viewport).toEqual(before.viewport);
			expect(restored.area).toEqual(before.area);
			expect(restored.scene).toEqual(before.scene);
			expect(restored.speech).toEqual(before.speech);
			expect(restored.participant).toEqual(before.participant);
			expect(restored.bubble).toEqual(before.bubble);
			expect(restored.transform).toBe(before.transform);
		});
	}

	test('starts primary reads without delaying Composer and projects evidence before final primary EOSE', async ({ page }) => {
		const hostOwned = await installHostOwnedStub(page);
		await installDelayedRelay(page, { deferPrimaryEvents: true });
		const selfSecret = fixtureSecret(41);
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		await page.goto('/');

		await expect(page.locator('.action-dock')).toBeVisible();
		await expect.poll(hostOwned.requests).toBeGreaterThan(0);
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await expect(editor).toBeVisible();
		await editor.fill('queued until Relay is ready');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect(page.locator('.speech-type-toggle')).toBeDisabled();

		const duringPendingPrimary = await relayState(page);
		expect(duringPendingPrimary.state.requests.some((request) => AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) && [42, WORLD_STATE_KIND].includes((request.filter.kinds as number[])[0]))).toBe(true);
		expect(duringPendingPrimary.state.published.filter((event) => event.kind === 42)).toHaveLength(0);
		await expect.poll(async () => {
			const requests = (await relayState(page)).state.requests;
			return [42, WORLD_STATE_KIND].every((kind) => requests.some((request) =>
				AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
				(request.filter.kinds as number[])[0] === kind
			));
		}).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimaryEvents(): void } }).__relayStartupTest.releasePrimaryEvents());
		await expect(page.locator('.participant[data-position="3,2"]')).toHaveCount(1);
		await expect(page.locator('.bubble')).toHaveCount(0);

		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { rejectPositionPublishes(): void } }).__relayStartupTest.rejectPositionPublishes());
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.getByRole('button', { name: 'Enter field again' })).toBeVisible();
		await expect(editor).toHaveValue('queued until Relay is ready');
		await editor.fill('reject while entry is retryable');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect(editor).toHaveValue('reject while entry is retryable');
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { allowPositionPublishes(): void } }).__relayStartupTest.allowPositionPublishes());
		await page.getByRole('button', { name: 'Enter field again' }).click();
		await editor.fill('publish after entry recovery');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect.poll(async () => new Set((await relayState(page)).state.published
			.filter((event) => event.kind === 42)
			.map((event) => event.id)).size).toBe(1);
		const [publishedMessageId] = new Set((await relayState(page)).state.published
			.filter((event) => event.kind === 42)
			.map((event) => event.id));
		await expect(editor).toHaveValue('');
		await expect(page.locator('.participant[data-position="3,2"]')).toHaveCount(1);
		await expect(page.locator(`.bubble[data-bubble-id="${publishedMessageId}"]`)).toHaveCount(1);

		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { rejectMessagePublishes(): void } }).__relayStartupTest.rejectMessagePublishes());
		await editor.fill('retain after Relay rejection');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect(editor).toHaveValue('retain after Relay rejection');
		await page.evaluate(() => { (window as typeof window & { __ehagakiAbortNextSubmit?: boolean }).__ehagakiAbortNextSubmit = true; });
		await editor.fill('retain after abort');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect(editor).toHaveValue('retain after abort');
	});

	test('aborting a primary-waiting submit releases it without publishing later', async ({ page }) => {
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		const selfSecret = fixtureSecret(41);
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await editor.fill('abort while waiting for primary bootstrap');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __ehagakiSubmitStarted?: boolean }).__ehagakiSubmitStarted))).toBe(true);
		await page.evaluate(() => (window as typeof window & { __ehagakiAbortActiveSubmit(): void }).__ehagakiAbortActiveSubmit());
		await expect(editor).toHaveValue('abort while waiting for primary bootstrap');
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) && [42, WORLD_STATE_KIND].includes((request.filter.kinds as number[])[0]))).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('.participant')).toHaveCount(2);
		expect(new Set((await relayState(page)).state.published.filter((event) => event.kind === 42).map((event) => event.id)).size).toBe(0);
		await expect(editor).toHaveValue('abort while waiting for primary bootstrap');
	});

	test('never mounts or loads the Host-owned Composer in DEV World', async ({ page }) => {
		const hostOwned = await installHostOwnedStub(page);
		await page.goto('/?devWorld=1');

		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await expect(page.locator('.action-dock')).toHaveCount(0);
		await expect(page.locator('ehagaki-composer')).toHaveCount(0);
		expect(hostOwned.requests()).toBe(0);
	});
});
