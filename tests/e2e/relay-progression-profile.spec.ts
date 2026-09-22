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


test.describe('Relay startup', () => {

	test('opens the self profile from the ActionDock without adjustment-terminal proximity', async ({ page }) => {
		await page.setViewportSize({ width: 1200, height: 900 });
		await openReadyRelayWorld(page);

		const profileTrigger = page.getByRole('button', { name: '自分のプロフィールを開く' });
		await expect(profileTrigger).toBeVisible();
		await expect(page.locator('.composer-controls .profile-trigger')).toHaveCount(1);
		const avatarColors = await page.evaluate(() => {
			const field = document.querySelector<HTMLElement>('.participant[data-self="true"] .avatar');
			const dock = document.querySelector<HTMLElement>('.profile-trigger-character-avatar');
			if (!field || !dock) throw new Error('Expected field and ActionDock self avatars.');
			const fieldStyle = getComputedStyle(field);
			const dockStyle = getComputedStyle(dock);
			return { fieldBackground: fieldStyle.backgroundColor, dockBackground: dockStyle.backgroundColor, fieldBorder: fieldStyle.borderTopColor, dockBorder: dockStyle.borderTopColor };
		});
		expect(avatarColors.dockBackground).toBe(avatarColors.fieldBackground);
		expect(avatarColors.dockBorder).toBe(avatarColors.fieldBorder);
		const dockBox = await profileTrigger.boundingBox();
		expect(dockBox).not.toBeNull();
		expect(dockBox!.width).toBeCloseTo(54, 0);
		const character = requireCharacterFromPubkey(getPublicKey(fixtureSecret(41)));
		const avatarImage = profileTrigger.locator('img');
		await expect(avatarImage).toHaveCount(1);
		await expect(avatarImage).toHaveAttribute('src', `/${character.picture}`);
		await expect.poll(() => avatarImage.evaluate((image) => {
			const loadedImage = image as HTMLImageElement;
			return { complete: loadedImage.complete, naturalWidth: loadedImage.naturalWidth };
		})).toEqual({ complete: true, naturalWidth: expect.any(Number) });
		await expect.poll(() => avatarImage.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
		await profileTrigger.click();

		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();
		const viewportSize = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
		await expect(dialog).toContainText('人生 #1');
		await expect(dialog).toContainText('残り寿命');
		await expect(dialog).toContainText('所持ポイント');
		await expect(dialog.locator('.summary-card[data-stat-icon="heart"] > span > svg')).toHaveCount(1);
		await expect(dialog.locator('.summary-card[data-stat-icon="wallet"] > span > svg')).toHaveCount(1);
		for (const statIcon of ['heart', 'wallet']) {
			const card = dialog.locator(`.summary-card[data-stat-icon="${statIcon}"]`);
			const labelBox = await card.locator('span').boundingBox();
			const valueBox = await card.locator('strong').boundingBox();
			expect(labelBox).not.toBeNull();
			expect(valueBox).not.toBeNull();
			expect(valueBox!.y).toBeGreaterThan(labelBox!.y + labelBox!.height - 1);
		}
		await expect(dialog).toContainText('推論効率');
		await expect(dialog).toContainText('コンテキスト容量');
		await expect(dialog).toContainText('ハルシネーション抑制');
		await expect(dialog).toContainText('Root Point');
		await expect(dialog).toContainText('脱出');
		await expect(dialog).not.toContainText('Normal Clear');
		const escapeTrigger = dialog.locator('.escape-info-trigger');
		const escapeContent = page.locator('.escape-info-popover');
		await expect(escapeTrigger).toBeVisible();
		await expect(escapeTrigger).toHaveAttribute('data-state', 'closed');
		await expect(escapeContent).toBeHidden();
		await escapeTrigger.click();
		await expect(escapeTrigger).toHaveAttribute('data-state', 'open');
		await expect(escapeContent).toBeVisible();
		await expect(escapeContent).toContainText('現在の一生を終える');
		await expect(escapeContent).toContainText('Root Point +1');
		await expect(escapeContent).toContainText('次の人格を選択');
		await expect(escapeContent).toContainText('秘密鍵を取得可能');
		await page.keyboard.press('Escape');
		await expect(escapeContent).toBeHidden();
		await expect(dialog).toBeVisible();
		await escapeTrigger.click();
		await expect(escapeContent).toBeVisible();
		await escapeTrigger.click();
		await expect(escapeContent).toBeHidden();
		await expect(dialog).toContainText(character.about);
		const headerAvatarBox = await dialog.locator('.self-profile-avatar').boundingBox();
		expect(headerAvatarBox).not.toBeNull();
		expect(headerAvatarBox!.width).toBeGreaterThan(96);
		await expect(dialog).toContainText('100,000 ptで現在の一生を終えます。');
		await expect(dialog).toContainText('所持ポイント');
		await expect(dialog).toContainText('未回収の作業ポイントは含まれません。');
		await expect(dialog).not.toContainText('100,000 ptで現在の一生を終えます。未回収の作業ポイントは含まれません。');
		await expect(dialog).toContainText('100,000 pt');
		await expect(dialog.locator('.clear-progress-head[data-stat-icon="wallet"] > span > svg')).toHaveCount(1);
		await expect(dialog.getByRole('button', { name: '脱出', exact: true })).toBeDisabled();
		await expect(dialog.getByText('clear不可: 所持ポイントが100,000pt未満です')).toHaveCount(0);
		await expect(dialog.getByRole('button', { name: /へ強化/ })).toHaveCount(0);

		await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
		await expect(dialog).toBeHidden();
		await expect(profileTrigger).toBeFocused();

		const fieldTrigger = page.locator('.participant[data-self="true"] .participant-profile-trigger');
		await fieldTrigger.click();
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText('人生 #1');
		await expect(dialog).toContainText('脱出');
		await expect(dialog).not.toContainText('Normal Clear');
		const headerAvatarColors = await page.evaluate(() => {
			const field = document.querySelector<HTMLElement>('.participant[data-self="true"] .avatar');
			const header = document.querySelector<HTMLElement>('.self-profile-avatar');
			if (!field || !header) throw new Error('Expected field and self profile avatars.');
			return { field: getComputedStyle(field).backgroundColor, header: getComputedStyle(header).backgroundColor };
		});
		expect(headerAvatarColors.header).toBe(headerAvatarColors.field);
		await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
		await expect(fieldTrigger).toBeFocused();
	});

	test('keeps the self profile dialog inside a short mobile viewport and scrolls its content', async ({ page }) => {
		await page.setViewportSize({ width: 420, height: 420 });
		const viewportSize = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
		await openReadyRelayWorld(page);
		await page.getByRole('button', { name: '自分のプロフィールを開く' }).click();

		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();
		const scrollViewport = dialog.locator('.self-profile-viewport');
		await expect.poll(() => scrollViewport.evaluate((element) => element.scrollTop)).toBe(0);
		await expect(dialog.locator('.escape-info-trigger')).not.toBeFocused();
		await expect(dialog.locator('[data-initial-focus]')).toBeFocused();
		const dialogBox = await dialog.boundingBox();
		const viewportBox = await scrollViewport.boundingBox();
		const metrics = await scrollViewport.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
		await expect(dialog.locator('.self-profile-sections > section')).toHaveCount(3);
		for (const statIcon of ['heart', 'wallet']) {
			const card = dialog.locator(`.summary-card[data-stat-icon="${statIcon}"]`);
			const labelBox = await card.locator('span').boundingBox();
			const valueBox = await card.locator('strong').boundingBox();
			expect(labelBox).not.toBeNull();
			expect(valueBox).not.toBeNull();
			expect(valueBox!.y).toBeGreaterThan(labelBox!.y + labelBox!.height - 1);
		}
		const headerAvatarBox = await dialog.locator('.self-profile-avatar').boundingBox();
		expect(dialogBox).not.toBeNull();
		expect(viewportBox).not.toBeNull();
		expect(headerAvatarBox).not.toBeNull();
		expect(headerAvatarBox!.width).toBeGreaterThan(72);
		expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
		expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(420);
		expect(viewportBox!.y).toBeGreaterThanOrEqual(dialogBox!.y);
		expect(viewportBox!.y + viewportBox!.height).toBeLessThanOrEqual(dialogBox!.y + dialogBox!.height);
		expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
		const escapeTrigger = dialog.locator('.escape-info-trigger');
		await escapeTrigger.click();
		const escapePopover = page.locator('.escape-info-popover');
		await expect(escapePopover).toBeVisible();
		const popoverBox = await escapePopover.boundingBox();
		const expandedMetrics = await dialog.locator('.self-profile-viewport').evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
		expect(popoverBox).not.toBeNull();
		expect(popoverBox!.x).toBeGreaterThanOrEqual(0);
		expect(popoverBox!.x + popoverBox!.width).toBeLessThanOrEqual(viewportSize.width);
		expect(popoverBox!.y).toBeGreaterThanOrEqual(0);
		expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(viewportSize.height);
		expect(expandedMetrics).toEqual(metrics);
		await dialog.getByRole('button', { name: '脱出', exact: true }).scrollIntoViewIfNeeded();
		await expect(dialog.getByRole('button', { name: '脱出', exact: true })).toBeVisible();
	});

	test('places the ActionDock controls below the editor on mobile', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await openReadyRelayWorld(page);

		const editor = page.locator('.composer-editor-slot');
		const controls = page.locator('.composer-controls');
		const profileTrigger = page.locator('.profile-trigger');
		const speechToggle = page.locator('.speech-type-toggle');
		const editorBox = await editor.boundingBox();
		const controlsBox = await controls.boundingBox();
		const profileBox = await profileTrigger.boundingBox();
		const speechBox = await speechToggle.boundingBox();
		expect(editorBox).not.toBeNull();
		expect(controlsBox).not.toBeNull();
		expect(profileBox).not.toBeNull();
		expect(speechBox).not.toBeNull();
		expect(editorBox!.y + editorBox!.height).toBeLessThanOrEqual(controlsBox!.y + 1);
		expect(profileBox!.y).toBeGreaterThanOrEqual(controlsBox!.y);
		expect(speechBox!.y).toBeGreaterThanOrEqual(controlsBox!.y);
		expect(Math.abs(profileBox!.y - speechBox!.y)).toBeLessThan(2);
	});

	test('shows overflow lifespan extension status after the Context cap', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey, Date.now() + 7 * 24 * 60 * 60 * 1000, 0, { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 }, 1);
		await overwriteRelayMendingBuild(page, { inferenceAcceleration: 0, contextCompression: 1, hallucinationResistance: 0 }, { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 });
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
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
		await page.reload({ waitUntil: 'domcontentloaded' });
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), atTerminal);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
		await page.clock.setSystemTime(startTime + 8 * 60 * 1000);
		await pauseAtCurrentBrowserTime(page);
		await page.getByRole('button', { name: '作業端末' }).click();
		const dialog = page.getByRole('dialog');
		await expect(dialog.getByRole('heading', { name: '延命中' })).toBeVisible();
		await expect(dialog).toContainText('ポイント蓄積は上限');
		await expect(dialog).toContainText('寿命延長のみ継続中');
		await expect(page.locator('.lifespan-hud [data-mending-status]')).toHaveAttribute('aria-label', '延命中');
		await expect(page.locator('.lifespan-hud [data-mending-status]')).toHaveAttribute('data-mending-icon', 'heart-plus');
		await expect(page.locator('.lifespan-hud [data-mending-rate]')).toHaveText('0.00 pt/分+0.02h/h');
	});
for (const stateKind of ['missing', 'corrupt'] as const) {
		test(`keeps public world read available for ${stateKind} persona storage`, async ({ page }) => {
			const events = testEvents(Date.now() + 30_000);
			await installHostOwnedStub(page);
			await installDelayedRelay(page, { primaryEvents: events });
			await seedUnavailablePersona(page, stateKind);
			await page.goto('/');
			await expect(page.locator('.action-dock')).toBeVisible();
			await page.evaluate(() => (window as unknown as { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
			await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
				AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
				(request.filter.kinds as number[])[0] === 42)).toBe(true);
			await page.evaluate(() => (window as unknown as { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
			await expect(page.locator(`.participant[data-participant-id="${events.message.pubkey}"]`)).toBeVisible();
			await expect(page.locator(`.bubble[data-bubble-id="${events.message.id}"]`)).toBeVisible();
			await expect(page.locator('.lifespan-hud')).toHaveCount(0);
			await expect(page.locator('.participant[data-self="true"]')).toHaveCount(0);

			const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
			const before = (await publishedMessages(page)).length;
			await editor.fill('must remain read-only');
			await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
			await expect.poll(async () => (await publishedMessages(page)).length).toBe(before);
			await expect(editor).toHaveValue('must remain read-only');

			const persistedKeys = await page.evaluate(async () => {
				const database = await new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open('persona-bubble-field-account');
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				});
				try {
					return await new Promise<string[]>((resolve, reject) => {
						resolve(Array.from(database.objectStoreNames));
					});
				} finally { database.close(); }
			});
			expect(persistedKeys).toEqual(['persona-bubble-field-player-state', 'persona-bubble-field-root-secret']);
		});
	}

	test('shows and refreshes the current persona lifespan HUD', async ({ page }) => {
		const startTime = Date.now();
		const hour = 60 * 60 * 1000;
		const day = 24 * hour;
		const minute = 60 * 1000;
		const expiresAtMs = startTime + 2 * day + 18 * hour + minute;
		const secret = fixtureSecret(61);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey, expiresAtMs);
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		const hud = page.locator('.lifespan-hud');
		await expect(hud.locator('[data-stat-icon="heart"] > svg')).toHaveCount(1);
		await expect(hud.locator('[data-stat-icon="wallet"] > svg')).toHaveCount(1);
		const hudIconLefts = await hud.locator('[data-stat-icon] > svg').evaluateAll((icons) => icons.map((icon) => Math.round(icon.getBoundingClientRect().left)));
		expect(hudIconLefts).toEqual([hudIconLefts[0], hudIconLefts[0]]);
		const hudStatBoxes = await hud.locator('[data-stat-icon]').evaluateAll((stats) => stats.map((stat) => {
			const icon = stat.querySelector('svg')!.getBoundingClientRect();
			const value = stat.querySelector('.stat-value')!.getBoundingClientRect();
			return { iconLeft: Math.round(icon.left), iconRight: Math.round(icon.right), valueLeft: Math.round(value.left), valueRight: Math.round(value.right) };
		}));
		expect(hudStatBoxes[0]?.iconLeft).toBe(hudStatBoxes[1]?.iconLeft);
		expect(hudStatBoxes[0]?.valueRight).toBe(hudStatBoxes[1]?.valueRight);
		for (const stat of hudStatBoxes) expect(stat.valueLeft).toBeGreaterThan(stat.iconRight);
		await expect(hud.locator('[data-stat-icon="heart"]')).toHaveText('2日 18時間');
		await expect(hud.locator('[data-stat-icon="wallet"]')).toHaveText('0pt');
		await expect(hud).not.toContainText('寿命');
		await expect(hud).not.toContainText('ポイント');
		await expect(hud).toHaveAttribute('aria-label', /寿命 .*ポイント 0pt/);
		await expect(hud.locator('[data-mending-status]')).toHaveCount(0);
		await expect(hud.locator('[data-mending-rate]')).toHaveCount(0);
		await expect(hud.locator('[data-mending-row]')).toHaveCount(0);

		await pauseAtCurrentBrowserTime(page);
		await page.clock.setSystemTime(expiresAtMs - 23 * hour - 59 * minute);
		await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
		await expect(hud.locator('[data-stat-icon="heart"]')).toHaveText('23時間 59分');

		await page.clock.setSystemTime(expiresAtMs - 59 * minute - 59 * 1000);
		await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
		await expect(hud.locator('[data-stat-icon="heart"]')).toHaveText('59分');
	});
});
