import { expect, test, type Locator, type Page } from '@playwright/test';
import { getPublicKey } from 'nostr-tools/pure';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { finishDialogExit } from './helpers/dialogMotion';
import {
	fixtureSecret,
	installDelayedRelay,
	pauseAtCurrentBrowserTime,
	readRelayGameState,
	relayState,
	seedRelayAccount,
	testEvents,
	traceRuntimeEvents,
	upcomingRegistrationSchedule
} from './helpers/relayHarness';

const APP_BASE_PATH = process.env.BASE_PATH ?? '';

type HelpSideEffectSnapshot = Readonly<{
	playerState: unknown;
	interactionRewards: unknown;
	writeJournal: readonly Readonly<{ profileLastReservedSecond?: number | null }>[];
	rootReads: unknown;
	replyReads: unknown;
	traceRewards: unknown;
	tutorialProgress: string | null;
}>;

async function readHelpSideEffectSnapshot(page: Page): Promise<HelpSideEffectSnapshot> {
	return await page.evaluate(async () => {
		const openDatabase = (name: string): Promise<IDBDatabase> => new Promise((resolve, reject) => {
			const request = indexedDB.open(name);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const readStores = async (name: string, stores: string[], recordKey?: IDBValidKey): Promise<unknown[]> => {
			const database = await openDatabase(name);
			try {
				const transaction = database.transaction(stores, 'readonly');
				const requests = stores.map((storeName) => recordKey === undefined
					? transaction.objectStore(storeName).getAll()
					: transaction.objectStore(storeName).get(recordKey));
				return await new Promise((resolve, reject) => {
					transaction.oncomplete = () => resolve(requests.map((request) => request.result));
					transaction.onerror = () => reject(transaction.error);
					transaction.onabort = () => reject(transaction.error);
				});
			} finally { database.close(); }
		};
		const [playerState, interactionRewards, writeJournal] = await readStores('persona-bubble-field-account', [
			'persona-bubble-field-player-state', 'persona-bubble-field-interaction-rewards', 'persona-bubble-field-world-write-journal'
		]);
		const [rootReads, replyReads, traceRewards] = await readStores('persona-bubble-field-trace', [
			'trace-root-read', 'trace-reply-read', 'trace-reward-outbox'
		]);
		return {
			playerState,
			interactionRewards,
			writeJournal: writeJournal as Array<{ profileLastReservedSecond?: number | null }>,
			rootReads,
			replyReads,
			traceRewards,
			tutorialProgress: sessionStorage.getItem('persona-bubble-field:first-run-tutorial')
		};
	}) as HelpSideEffectSnapshot;
}

async function expectHelpHeaderGeometry(dialog: Locator, withBack: boolean): Promise<void> {
	const header = dialog.locator('.help-header');
	const title = dialog.locator('.help-title');
	const close = dialog.getByRole('button', { name: '閉じる' });
	const [headerBox, titleBox, closeBox] = await Promise.all([
		header.boundingBox(), title.boundingBox(), close.boundingBox()
	]);
	expect(headerBox).not.toBeNull();
	expect(titleBox).not.toBeNull();
	expect(closeBox).not.toBeNull();
	expect(closeBox!.x).toBeGreaterThan(titleBox!.x + titleBox!.width);
	expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(headerBox!.x + headerBox!.width);
	expect(Math.abs((closeBox!.y + closeBox!.height / 2) - (titleBox!.y + titleBox!.height / 2))).toBeLessThanOrEqual(1);
	await expect(dialog.locator('.help-description')).toHaveCSS('position', 'absolute');
	const descriptionBox = await dialog.locator('.help-description').boundingBox();
	expect(descriptionBox).not.toBeNull();
	expect(descriptionBox!.width).toBeLessThanOrEqual(1);
	expect(descriptionBox!.height).toBeLessThanOrEqual(1);

	if (withBack) {
		const backBox = await dialog.getByRole('button', { name: '戻る' }).boundingBox();
		expect(backBox).not.toBeNull();
		expect(backBox!.x + backBox!.width).toBeLessThanOrEqual(titleBox!.x);
		expect(Math.abs((backBox!.y + backBox!.height / 2) - (closeBox!.y + closeBox!.height / 2))).toBeLessThanOrEqual(1);
	}
}

async function expectPlayerFacingHelpText(dialog: Locator): Promise<void> {
	const text = await dialog.locator('.help-body').innerText();
	expect(text).not.toMatch(/Realtime Event|Identity|activeな一生|active Identity|usable|export|Root entropy|backup|Nostr client|\bHUD\b|\btimeline\b|\bUI\b|痕跡root/i);
}

test.describe('in-game Help', () => {
	test('keeps Help browsing read-only and restores navigation, Escape, focus, and a fresh top page', async ({ page }) => {
		const now = Date.now();
		const trace = traceRuntimeEvents();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: now });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize({ width: 390, height: 844 });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, {
			primaryEvents: testEvents(now),
			traceRoots: [trace.root],
			traceReplies: [trace.direct]
		});
		await seedRelayAccount(page, secret, pubkey, now + 7 * 24 * 60 * 60 * 1_000, 654_321,
			{ inferenceEfficiency: 2, contextCapacity: 3, hallucinationSuppression: 4 }, 2,
			{ inferenceAcceleration: 1, contextCompression: 1, hallucinationResistance: 0 });
		await page.goto(`${APP_BASE_PATH}/`);
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releasePrimaryEvents(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releasePrimaryEvents();
			relay.releasePrimary();
		});
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toBeVisible();
		await expect(page.locator('.participant[data-self="true"]')).toBeVisible();
		await expect.poll(async () => (await readHelpSideEffectSnapshot(page)).writeJournal.some((record) => record.profileLastReservedSecond != null)).toBe(true);
		await pauseAtCurrentBrowserTime(page);

		const trigger = page.getByRole('button', { name: 'ヘルプ', exact: true });
		const initialSnapshot = await readHelpSideEffectSnapshot(page);
		const initialGame = await readRelayGameState(page);
		const initialRelay = (await relayState(page)).state.published;
		await trigger.click();
		const dialog = page.locator('[data-help-dialog]');
		await expect(page.getByRole('dialog', { name: 'ヘルプ' })).toBeVisible();
		await expectHelpHeaderGeometry(dialog, false);
		await expect(dialog).toHaveAttribute('aria-modal', 'true');
		await expect(dialog.locator('[data-help-category]')).toHaveCount(7);
		await expectPlayerFacingHelpText(dialog);
		const traceCategoryIcon = dialog.locator('[data-help-category="traces"] .category-icon .help-trace-icon');
		const traceCategoryPresentation = await traceCategoryIcon.evaluate((icon) => {
			const maskImage = getComputedStyle(icon).maskImage;
			const source = maskImage.match(/url\(["']?([^"')]+)["']?\)/)?.[1];
			return { fill: getComputedStyle(icon).backgroundColor, categoryColor: getComputedStyle(icon.parentElement!).color, sourcePath: source ? new URL(source, document.baseURI).pathname : null };
		});
		expect(traceCategoryPresentation.fill).toBe(traceCategoryPresentation.categoryColor);
		expect(traceCategoryPresentation.sourcePath).toBe(`${APP_BASE_PATH}/trace/trace-icon.svg`);
		const body = dialog.locator('.help-body');
		await body.evaluate((element) => { element.scrollTop = 120; });
		const livingCategory = dialog.locator('[data-help-category="living"]');
		await livingCategory.scrollIntoViewIfNeeded();
		const homeScroll = await body.evaluate((element) => element.scrollTop);
		await livingCategory.click();
		await expect(body).toHaveAttribute('data-help-page', 'category');
		await expect(dialog.locator('#help-living-title')).toBeVisible();
		await expect(dialog.getByText('成果を回収せずに連続して作業できる時間の上限が増えます。')).toBeVisible();
		await expectPlayerFacingHelpText(dialog);
		await expectHelpHeaderGeometry(dialog, true);
		await dialog.getByRole('button', { name: '戻る' }).click();
		await expect(body).toHaveAttribute('data-help-page', 'home');
		await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(homeScroll);
		const tracesCategory = dialog.locator('[data-help-category="traces"]');
		await tracesCategory.scrollIntoViewIfNeeded();
		await tracesCategory.click();
		const traceIcons = dialog.locator('.help-section .help-trace-icon');
		await expect(traceIcons).toHaveCount(3);
		const traceImagePaths = await traceIcons.evaluateAll((icons) => icons.map((icon) => {
			const source = getComputedStyle(icon).maskImage.match(/url\(["']?([^"')]+)["']?\)/)?.[1];
			return source ? new URL(source, document.baseURI).pathname : null;
		}));
		expect(traceImagePaths).toEqual([
			`${APP_BASE_PATH}/trace/trace-icon.svg`,
			`${APP_BASE_PATH}/trace/trace-icon.svg`,
			`${APP_BASE_PATH}/trace/trace-death-icon.svg`
		]);
		await expectPlayerFacingHelpText(dialog);
		await dialog.getByRole('button', { name: '戻る' }).click();
		await expect(body).toHaveAttribute('data-help-page', 'home');
		for (const categoryId of ['start', 'conversation'] as const) {
			const category = dialog.locator(`[data-help-category="${categoryId}"]`);
			await category.scrollIntoViewIfNeeded();
			await category.click();
			if (categoryId === 'conversation') {
				await expect(dialog).toContainText('最近の発言を最大50件まで扱い、そのうち画面内に完全に収まる新しい発言だけを表示します。すべての発言が永久に残るSNSの投稿一覧や、完全な過去ログではありません。');
				await expect(dialog).not.toContainText('最近の発言を最大50件表示します');
			}
			await expectPlayerFacingHelpText(dialog);
			await dialog.getByRole('button', { name: '戻る' }).click();
			await expect(body).toHaveAttribute('data-help-page', 'home');
		}

		await dialog.locator('[data-help-category="events"]').click();
		await expect(body).toHaveAttribute('data-help-page', 'events');
		await expectPlayerFacingHelpText(dialog);
		const eventListScroll = await body.evaluate((element) => element.scrollTop);
		await dialog.locator('[data-help-event="cooperation"]').click();
		await expect(body).toHaveAttribute('data-help-page', 'event');
		await expect(dialog.locator('#help-cooperation-title')).toBeVisible();
		await page.clock.runFor(100);
		await expect.poll(() => dialog.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
		await expect(dialog.locator('table')).toHaveCount(2);
		const cooperationWarning = dialog.locator('.help-section[aria-labelledby="help-cooperation-title"] .mortality-warning');
		await expect(cooperationWarning).toHaveAttribute('role', 'note');
		await expect(cooperationWarning.locator('.warning-mark')).toHaveAttribute('aria-hidden', 'true');
		await expect(cooperationWarning.locator('strong')).toHaveText('注意：協力不足で失敗した場合、抜け駆けした参加者は寿命を3日失います。');
		await expect(cooperationWarning.locator('p')).toHaveText('この寿命減少によって寿命が0になると、現在の一生は終了します。');
		for (const viewport of [{ width: 390, height: 844 }, { width: 1000, height: 800 }]) {
			await page.setViewportSize(viewport);
			await expect(cooperationWarning).toBeVisible();
			const containedInInitialView = await cooperationWarning.evaluate((warning) => {
				const body = warning.closest<HTMLElement>('.help-body');
				if (!body) return false;
				const warningRect = warning.getBoundingClientRect();
				const bodyRect = body.getBoundingClientRect();
				return warningRect.top >= bodyRect.top && warningRect.bottom <= bodyRect.bottom &&
					warningRect.left >= bodyRect.left && warningRect.right <= bodyRect.right;
			});
			expect(containedInInitialView).toBe(true);
		}
		await expectPlayerFacingHelpText(dialog);
		await dialog.getByRole('button', { name: '戻る' }).click();
		await expect(body).toHaveAttribute('data-help-page', 'events');
		await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(eventListScroll);
		await dialog.getByRole('button', { name: '戻る' }).click();
		await dialog.locator('[data-help-category="events"]').click();
		await expect(body).toHaveAttribute('data-help-page', 'events');
		await dialog.locator('[data-help-event="tag-game"]').click();
		await expect(dialog).toContainText('鬼になった者は、毎秒1時間の寿命を失います。');
		await expect(dialog.getByText('寿命が0になると、その一生は終了します。', { exact: true })).toBeVisible();
		const tagGameSymbols = dialog.locator('.tag-game-rule-symbol');
		await expect(tagGameSymbols).toHaveCount(2);
		await expect(tagGameSymbols.nth(0).locator('[data-tag-game-effect-symbol="benefit"]')).toHaveCount(1);
		await expect(tagGameSymbols.nth(1).locator('[data-tag-game-effect-symbol="calamity"]')).toHaveCount(1);
		await expectPlayerFacingHelpText(dialog);
		await dialog.getByRole('button', { name: '戻る' }).click();
		await dialog.getByRole('button', { name: '戻る' }).click();
		await dialog.locator('[data-help-category="life"]').click();
		await expect(dialog).toContainText('脱出済みの人格は同じ人格で新しい一生を始められます。');
		await expect(dialog).toContainText('使用できるのは最大9RPで、各能力はRank 0〜3');
		await expect(dialog).toContainText('正常な脱出1回につき1RPを獲得します。死亡ではRPは増えません。');
		await expect(dialog).toContainText('各能力はRank 0〜3、Rankを1上げるごとに1RPを使います。');
		await expect(dialog).toContainText('Rank 0〜3の順に×1.00／×2.00／×3.00／×4.00です。蓄積上限後の作業には適用されません。');
		await expect(dialog).toContainText('Rank 0〜3の順に通常の×1.00／×2.00／×3.00／×4.00です。蓄積上限後のポイント生成と寿命延長は、通常時の0%／20%／35%／50%になります。');
		await expect(dialog).toContainText('Rank 0〜3の順に7日／14日／21日／30日です。新しい一生の開始時は、どのRankでも7日です。');
		const rootBuildFact = dialog.locator('.help-section[aria-labelledby="help-life-title"] .help-fact').nth(3);
		const rootBuildList = rootBuildFact.locator('.icon-list');
		for (const viewport of [{ width: 390, height: 844 }, { width: 1000, height: 800 }]) {
			await page.setViewportSize(viewport);
			await rootBuildFact.scrollIntoViewIfNeeded();
			await expect(rootBuildFact).toBeVisible();
			expect(await rootBuildList.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		}
		await expectPlayerFacingHelpText(dialog);
		await dialog.getByRole('button', { name: '戻る' }).click();
		await dialog.locator('[data-help-category="nostr"]').click();
		await expect(dialog).toContainText('一般的なNostrクライアントへ持ち出せます。');
		await expect(dialog).toContainText('ブラウザに保存された重要なデータを失うと');
		await expectPlayerFacingHelpText(dialog);
		const faqQuestions = dialog.locator('.faq-list details');
		await expect(faqQuestions).toHaveCount(7);
		await faqQuestions.nth(0).locator('summary').click();
		await expect(faqQuestions.nth(0)).toHaveAttribute('open', '');
		await expect(faqQuestions.nth(1)).not.toHaveAttribute('open', '');
		await expectPlayerFacingHelpText(dialog);
		await page.keyboard.press('Escape');
		await finishDialogExit(dialog, true);
		await expect(trigger).toBeFocused();
		await trigger.click();
		const reopened = page.getByRole('dialog', { name: 'ヘルプ' });
		await expect(reopened.locator('.help-body')).toHaveAttribute('data-help-page', 'home');
		await expect(reopened.locator('.help-body')).toHaveJSProperty('scrollTop', 0);
		await reopened.getByRole('button', { name: '閉じる' }).click();
		await finishDialogExit(reopened, true);
		await expect(trigger).toBeFocused();

		expect(await readHelpSideEffectSnapshot(page)).toEqual(initialSnapshot);
		expect(await readRelayGameState(page)).toEqual(initialGame);
		expect((await relayState(page)).state.published).toEqual(initialRelay);
	});

	test('keeps ordinary lifespan and realtime event time moving while Help is open', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const initialTime = schedule.registrationAtMs + 1_000;
		await page.clock.install({ time: initialTime });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize({ width: 1000, height: 800 });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(initialTime) });
		const secret = fixtureSecret(19);
		await seedRelayAccount(page, secret, getPublicKey(secret), initialTime + 7 * 24 * 60 * 60 * 1_000, 250);
		await page.goto(`${APP_BASE_PATH}/`);
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releasePrimaryEvents(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releasePrimaryEvents();
			relay.releasePrimary();
		});
		await expect(page.locator('.participant[data-self="true"]')).toBeVisible();
		const realtimePanel = page.locator('[data-realtime-panel]');
		await expect(realtimePanel).toBeVisible();
		await expect(realtimePanel).toContainText('参加受付');
		const lifespanBefore = Number(await page.locator('[data-unified-status-hud]').getAttribute('data-current-remaining-ms'));
		const trigger = page.getByRole('button', { name: 'ヘルプ', exact: true });
		await trigger.click();
		const dialog = page.getByRole('dialog', { name: 'ヘルプ' });
		await expect(dialog).toBeVisible();
		await expectHelpHeaderGeometry(dialog, false);
		await page.clock.setSystemTime(schedule.gameAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect(realtimePanel).toContainText('ゲーム中');
		const lifespanWhileOpen = Number(await page.locator('[data-unified-status-hud]').getAttribute('data-current-remaining-ms'));
		expect(lifespanWhileOpen).toBeLessThan(lifespanBefore);
		await dialog.getByRole('button', { name: '閉じる' }).click();
		await expect(dialog).toBeHidden();
		await expect(realtimePanel).toContainText('ゲーム中');
		const lifespanAfterClose = Number(await page.locator('[data-unified-status-hud]').getAttribute('data-current-remaining-ms'));
		expect(lifespanAfterClose).toBe(lifespanWhileOpen);
	});
});
