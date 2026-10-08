import { expect, test, type Page } from '@playwright/test';
import { MENDING_TERMINAL } from '../../src/lib/fieldFacilities';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import {
	chooseAvailableRelayMove,
	installDelayedRelay,
	moveRelaySelfTo,
	openClearReadyWorld,
	openReadyRelayWorld,
	readRelayGameState,
	relayState,
	startSelectedRun
} from './helpers/relayHarness';

async function releaseFirstRunPrimary(page: Page): Promise<void> {
	await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __relayStartupTest?: unknown }).__relayStartupTest))).toBe(true);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	await expect(page.locator('.participant[data-self="true"]')).toBeVisible();
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 420, height: 800 }]) {
	test(`guides the first Run through durable work at ${viewport.width}px`, async ({ page }) => {
		await page.clock.install({ time: Date.now() });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { persistAcrossReload: true });
		await page.setViewportSize(viewport);
		await page.goto('/');

		const dialog = page.getByRole('dialog');
		const opening = page.getByRole('button', { name: 'はじめる', exact: true });
		const candidates = page.getByRole('button', { name: /を選ぶ$/ });
		await expect(opening).toBeVisible();
		await expect(candidates).toHaveCount(0);
		await expect(dialog.getByRole('heading', { name: 'ここは、ハコ。' })).toBeFocused();
		await expect(dialog).toContainText('あなたは、別の誰かとしてここで生きる。');
		await expect(dialog).toContainText('寿命は7日。');
		await expect(dialog).toContainText('生き延びて、ソトを目指してください。');
		await expect(dialog.locator('.root-build, .rp-summary, .identity-section')).toHaveCount(0);

		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect(page.getByRole('button', { name: 'はじめる', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(0);
		await page.getByRole('button', { name: 'はじめる', exact: true }).click();
		await expect(page.getByRole('heading', { name: '人格を選択' })).toBeFocused();
		await expect(page.locator('#identity-selection-description')).toHaveText('あなたとして生きる人格');
		await expect(page.getByRole('region', { name: '人格を選択' })).toBeVisible();
		await expect(candidates).toHaveCount(3);
		await candidates.first().click();
		await startSelectedRun(page);
		await expect(dialog).toHaveCount(0);
		await releaseFirstRunPrimary(page);

		const tutorial = page.locator('[data-first-run-tutorial]');
		const hud = page.locator('.top-status-hud');
		await expect(tutorial).toHaveAttribute('data-first-run-tutorial', 'life');
		await expect(tutorial).toContainText('あなたの一生が始まりました。');
		await expect(tutorial).toContainText('寿命が0になると、この一生は終わります。');
		await expect(hud).toHaveAttribute('data-tutorial-highlight', 'lifespan');
		const lifeLayout = await tutorial.evaluate((element) => {
			const guide = element.getBoundingClientRect();
			const status = document.querySelector('.top-status-hud')?.getBoundingClientRect();
			const button = element.querySelector('button')?.getBoundingClientRect();
			return {
				insideViewport: guide.left >= 0 && guide.right <= innerWidth && guide.top >= 0 && guide.bottom <= innerHeight,
				belowHud: Boolean(status && guide.top >= status.bottom),
				buttonTarget: Boolean(button && button.width >= 44 && button.height >= 44)
			};
		});
		expect(lifeLayout).toEqual({ insideViewport: true, belowHud: true, buttonTarget: true });
		await expect(page.locator('.action-dock')).toBeVisible();

		await page.reload({ waitUntil: 'domcontentloaded' });
		await releaseFirstRunPrimary(page);
		await expect(page.locator('[data-first-run-tutorial="life"]')).toBeVisible();
		await page.locator('[data-first-run-tutorial="life"]').getByRole('button', { name: '次へ' }).click();
		await expect(page.locator('[data-first-run-tutorial="movement"]')).toHaveText('移動してみよう');
		await page.reload({ waitUntil: 'domcontentloaded' });
		await releaseFirstRunPrimary(page);
		await expect(page.locator('[data-first-run-tutorial="movement"]')).toHaveText('移動してみよう');
		await page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' }).focus();

		const move = await chooseAvailableRelayMove(page);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { rejectPositionPublishes(): void } }).__relayStartupTest.rejectPositionPublishes());
		await page.clock.runFor(1_001);
		await page.keyboard.press(move.key);
		await expect.poll(async () => (await relayState(page)).state.rejectedPositionPublishIds.length).toBeGreaterThan(0);
		await expect(page.locator('[data-first-run-tutorial="movement"]')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { allowPositionPublishes(): void } }).__relayStartupTest.allowPositionPublishes());
		await page.clock.runFor(1_001);
		await page.keyboard.press(move.key);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', move.expected);
		await expect(page.locator('[data-first-run-tutorial="work"]')).toContainText('作業をすると、ポイントを得て寿命を延ばせます。');
		await expect(page.locator('[data-field-facility="mending-terminal"]')).toHaveAttribute('data-tutorial-highlight', 'work');

		await page.reload({ waitUntil: 'domcontentloaded' });
		await releaseFirstRunPrimary(page);
		await expect(page.locator('[data-first-run-tutorial="work"]')).toBeVisible();
		await expect(page.locator('[data-field-facility="mending-terminal"]')).toHaveAttribute('data-tutorial-highlight', 'work');
		await expect.poll(async () => (await readRelayGameState(page)).mendingJob).toBeNull();

		await moveRelaySelfTo(page, { x: MENDING_TERMINAL.position.x - 1, y: MENDING_TERMINAL.position.y });
		const workMarker = await page.evaluate(() => sessionStorage.getItem('persona-bubble-field:first-run-tutorial'));
		expect(workMarker).toContain('"step":"work"');
		const terminal = page.getByRole('button', { name: '作業端末' });
		await expect(terminal).toBeEnabled();
		await terminal.click();
		const mendingDialog = page.getByRole('dialog');
		await expect(mendingDialog).toBeVisible();
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ mendingJob: expect.any(Object) });
		const started = await readRelayGameState(page);
		expect(started.mendingJob).toBeTruthy();
		const startedAtMs = (started.mendingJob as { startedAtMs: number }).startedAtMs;
		await expect(mendingDialog).toBeVisible();
		await expect(mendingDialog.locator('.mending-startup-feedback')).toContainText('作業を開始しました');
		await expect(page.locator('[data-first-run-tutorial="complete"]')).toHaveText('あとは自由です。');
		await mendingDialog.getByRole('button', { name: '閉じる', exact: true }).first().click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await page.clock.runFor(2_601);
		await expect(page.locator('[data-first-run-tutorial]')).toHaveCount(0);
		await expect(page.locator('.action-dock')).toBeVisible();

		await page.evaluate((marker) => { if (marker) sessionStorage.setItem('persona-bubble-field:first-run-tutorial', marker); }, workMarker);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await releaseFirstRunPrimary(page);
		await expect(page.locator('[data-first-run-tutorial="complete"]')).toHaveText('あとは自由です。');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		const recovered = await readRelayGameState(page);
		expect((recovered.mendingJob as { startedAtMs: number }).startedAtMs).toBe(startedAtMs);
		await page.clock.runFor(2_601);
		await expect(page.locator('[data-first-run-tutorial]')).toHaveCount(0);
	});
}

test('does not show first-run guidance for an existing Run', async ({ page }) => {
	await openReadyRelayWorld(page, 1);
	await expect(page.getByRole('button', { name: 'はじめる', exact: true })).toHaveCount(0);
	await expect(page.locator('[data-first-run-tutorial]')).toHaveCount(0);
});

test('keeps reincarnation selection copy after clear without onboarding', async ({ page }) => {
	const { pubkey } = await openClearReadyWorld(page);
	await page.getByRole('button', { name: '自分のプロフィールを開く' }).click();
	await page.getByRole('dialog').getByRole('button', { name: '脱出', exact: true }).click();
	await expect(page.getByRole('dialog')).toBeVisible();
	await expect(page.getByRole('button', { name: 'はじめる', exact: true })).toHaveCount(0);
	await expect(page.locator('[data-first-run-tutorial]')).toHaveCount(0);
	await expect(page.getByRole('region', { name: '転生先を選択' })).toBeVisible();
	await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toHaveCount(0);
});
