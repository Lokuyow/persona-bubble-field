import { expect, test, type Page } from '@playwright/test';
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
		await page.goto('/');
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
		await expect(dialog).toHaveAttribute('aria-modal', 'true');
		await expect(dialog.locator('[data-help-category]')).toHaveCount(7);
		const body = dialog.locator('.help-body');
		await body.evaluate((element) => { element.scrollTop = 120; });
		const livingCategory = dialog.locator('[data-help-category="living"]');
		await livingCategory.scrollIntoViewIfNeeded();
		const homeScroll = await body.evaluate((element) => element.scrollTop);
		await livingCategory.click();
		await expect(body).toHaveAttribute('data-help-page', 'category');
		await expect(dialog.locator('#help-living-title')).toBeVisible();
		await dialog.getByRole('button', { name: '戻る' }).click();
		await expect(body).toHaveAttribute('data-help-page', 'home');
		await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(homeScroll);

		await dialog.locator('[data-help-category="events"]').click();
		await expect(body).toHaveAttribute('data-help-page', 'events');
		const eventListScroll = await body.evaluate((element) => element.scrollTop);
		await dialog.locator('[data-help-event="cooperation"]').click();
		await expect(body).toHaveAttribute('data-help-page', 'event');
		await expect(dialog.locator('#help-cooperation-title')).toBeVisible();
		await expect(dialog.locator('table')).toHaveCount(2);
		await dialog.getByRole('button', { name: '戻る' }).click();
		await expect(body).toHaveAttribute('data-help-page', 'events');
		await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(eventListScroll);
		await dialog.getByRole('button', { name: '戻る' }).click();
		await dialog.locator('[data-help-category="events"]').click();
		await expect(body).toHaveAttribute('data-help-page', 'events');
		await dialog.locator('[data-help-event="tag-game"]').click();
		await expect(dialog).toContainText('鬼になった者は、毎秒1時間の寿命を失います。');
		await expect(dialog.getByText('寿命が0になると、その一生は終了します。', { exact: true })).toBeVisible();
		await dialog.getByRole('button', { name: '戻る' }).click();
		await dialog.getByRole('button', { name: '戻る' }).click();
		await dialog.locator('[data-help-category="nostr"]').click();
		const faqQuestions = dialog.locator('.faq-list details');
		await expect(faqQuestions).toHaveCount(7);
		await faqQuestions.nth(0).locator('summary').click();
		await expect(faqQuestions.nth(0)).toHaveAttribute('open', '');
		await expect(faqQuestions.nth(1)).not.toHaveAttribute('open', '');
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
		await page.goto('/');
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
