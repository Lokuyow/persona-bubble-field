import { expect, test, type Page } from '@playwright/test';
import { ADJUSTMENT_TERMINAL, MENDING_TERMINAL } from '../../src/lib/fieldFacilities';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import {
	chooseAvailableRelayMove,
	installDelayedRelay,
	moveRelaySelfTo,
	openClearReadyWorld,
	openReadyRelayWorld,
	readRelayGameState,
	relayState,
	selectRelayTraceCell,
	startSelectedRun,
	traceRuntimeEvents
} from './helpers/relayHarness';

async function releaseFirstRunPrimary(page: Page): Promise<void> {
	await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __relayStartupTest?: unknown }).__relayStartupTest))).toBe(true);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	await expect(page.locator('.participant[data-self="true"]')).toBeVisible();
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 420, height: 800 }]) {
	test(`guides the first Run through all tutorial steps at ${viewport.width}px`, async ({ page }) => {
		test.setTimeout(60_000);
		const trace = traceRuntimeEvents();
		await page.clock.install({ time: Date.now() });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, {
			persistAcrossReload: true,
			traceRoots: [trace.root]
		});
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
		await expect(page.locator('[data-first-run-tutorial="speech"]')).toContainText('ここでは、ほかの住人に発言できます。');
		await expect(page.locator('.composer-editor-slot')).toHaveAttribute('data-tutorial-highlight', 'speech');
		await expect(page.locator('[data-first-run-tutorial="complete"]')).toHaveCount(0);
		await mendingDialog.getByRole('button', { name: '閉じる', exact: true }).first().click();
		await expect(page.getByRole('dialog')).toHaveCount(0);

		// Simulate a reload after the durable job write but before the tutorial marker advances.
		await page.evaluate((marker) => { if (marker) sessionStorage.setItem('persona-bubble-field:first-run-tutorial', marker); }, workMarker);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await releaseFirstRunPrimary(page);
		const speechStep = page.locator('[data-first-run-tutorial="speech"]');
		await expect(speechStep).toContainText('ここでは、ほかの住人に発言できます。');
		await expect(page.locator('.composer-editor-slot')).toHaveAttribute('data-tutorial-highlight', 'speech');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		const recovered = await readRelayGameState(page);
		expect((recovered.mendingJob as { startedAtMs: number }).startedAtMs).toBe(startedAtMs);
		const speechMarker = await page.evaluate(() => sessionStorage.getItem('persona-bubble-field:first-run-tutorial'));
		expect(speechMarker).toContain('"step":"speech"');

		await expect(speechStep).toBeVisible();
		await expect(page.locator('.composer-editor-slot')).toHaveAttribute('data-tutorial-highlight', 'speech');
		await expect(page.locator('.speech-type-toggle')).toHaveAttribute('data-tutorial-highlight', 'speech');
		await expect.poll(() => page.locator('.composer-editor-slot').evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('solid');
		await expect.poll(() => page.locator('.speech-type-toggle').evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe('none');
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await editor.fill('チュートリアル中の入力確認');
		await expect(editor).toHaveValue('チュートリアル中の入力確認');
		await editor.fill('');
		await speechStep.getByRole('button', { name: '次へ' }).click();

		const noteStep = page.locator('[data-first-run-tutorial="note"]');
		await expect(noteStep).toContainText('100ptを使って、書置きを残せます。');
		const noteAction = page.locator('.manual-trace-toggle');
		await expect(noteAction).toHaveAttribute('data-tutorial-highlight', 'note');
		await expect.poll(() => noteAction.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe('none');
		const noteGuidanceLayout = await noteStep.evaluate((guide) => {
			const target = document.querySelector('.manual-trace-toggle[data-tutorial-highlight="note"]');
			if (!(target instanceof HTMLElement)) return null;
			const guideBounds = guide.getBoundingClientRect();
			const targetBounds = target.getBoundingClientRect();
			const horizontalGap = Math.max(0, targetBounds.left - guideBounds.right, guideBounds.left - targetBounds.right);
			const verticalGap = Math.max(0, targetBounds.top - guideBounds.bottom, guideBounds.top - targetBounds.bottom);
			return {
				insideViewport: guideBounds.left >= 0 && guideBounds.right <= innerWidth && guideBounds.top >= 0 && guideBounds.bottom <= innerHeight,
				overlapsTarget: guideBounds.left < targetBounds.right && guideBounds.right > targetBounds.left && guideBounds.top < targetBounds.bottom && guideBounds.bottom > targetBounds.top,
				separation: Math.hypot(horizontalGap, verticalGap)
			};
		});
		expect(noteGuidanceLayout?.insideViewport, JSON.stringify(noteGuidanceLayout)).toBe(true);
		expect(noteGuidanceLayout?.overlapsTarget, JSON.stringify(noteGuidanceLayout)).toBe(false);
		expect(noteGuidanceLayout?.separation, JSON.stringify(noteGuidanceLayout)).toBeLessThanOrEqual(24);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await releaseFirstRunPrimary(page);
		await expect(noteStep).toBeVisible();
		await expect(noteAction).toHaveAttribute('data-tutorial-highlight', 'note');
		await noteStep.getByRole('button', { name: '次へ' }).click();

		const traceStep = page.locator('[data-first-run-tutorial="trace"]');
		await expect(traceStep).toContainText('他の住人の未読の痕跡・書置き・遺言のどれかを1つ読んで、5ptを受け取ろう。');
		await expect(traceStep.getByRole('button')).toHaveCount(0);
		const traceTarget = page.locator('[data-trace-marker-position="4,2"]');
		await expect(traceTarget).toHaveAttribute('data-tutorial-highlight', 'trace');
		await page.reload({ waitUntil: 'domcontentloaded' });
		await releaseFirstRunPrimary(page);
		await expect(traceStep).toBeVisible();
		await expect(traceTarget).toHaveAttribute('data-tutorial-highlight', 'trace');
		const pointsBeforeTrace = (await readRelayGameState(page)).points;
		const traceMovementEditor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await traceMovementEditor.focus();
		await page.keyboard.press('Escape');
		await moveRelaySelfTo(page, { x: 5, y: 2 });
		await expect(traceTarget).toBeInViewport();
		await expect.poll(() => traceStep.evaluate((guide) => guide.classList.contains('first-run-tutorial-anchored'))).toBe(true);
		const measureTraceGuidance = () => traceStep.evaluate((guide) => {
			const target = document.querySelector('[data-trace-marker-position="4,2"][data-tutorial-highlight="trace"]');
			if (!(target instanceof HTMLElement)) return null;
			const guideBounds = guide.getBoundingClientRect();
			const targetBounds = target.getBoundingClientRect();
			const horizontalGap = Math.max(0, targetBounds.left - guideBounds.right, guideBounds.left - targetBounds.right);
			const verticalGap = Math.max(0, targetBounds.top - guideBounds.bottom, guideBounds.top - targetBounds.bottom);
			return {
				insideViewport: guideBounds.left >= 0 && guideBounds.right <= innerWidth && guideBounds.top >= 0 && guideBounds.bottom <= innerHeight,
				overlapsTarget: guideBounds.left < targetBounds.right && guideBounds.right > targetBounds.left && guideBounds.top < targetBounds.bottom && guideBounds.bottom > targetBounds.top,
				separation: Math.hypot(horizontalGap, verticalGap)
			};
		});
		await expect.poll(async () => {
			const layout = await measureTraceGuidance();
			return layout && layout.separation <= 24 ? null : layout;
		}).toBeNull();
		const traceGuidanceLayout = await measureTraceGuidance();
		expect(traceGuidanceLayout?.insideViewport, JSON.stringify(traceGuidanceLayout)).toBe(true);
		expect(traceGuidanceLayout?.overlapsTarget, JSON.stringify(traceGuidanceLayout)).toBe(false);
		expect(traceGuidanceLayout?.separation, JSON.stringify(traceGuidanceLayout)).toBeLessThanOrEqual(24);
		await selectRelayTraceCell(page, '4,2');
		await expect(page.locator(`[data-trace-root-id="${trace.root.id}"]`)).toContainText(trace.root.content);
		await expect(page.locator(`[data-trace-ghost-root-id="${trace.root.id}"]`)).toBeVisible();
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ points: pointsBeforeTrace + 5 });
		const abilityStep = page.locator('[data-first-run-tutorial="ability"]');
		await expect(abilityStep).toContainText('強化端末へ移動して、能力をひとつ強化しよう。');
		await expect(abilityStep.getByRole('button')).toHaveCount(0);
		await expect(page.locator('[data-field-facility="adjustment-terminal"]')).toHaveAttribute('data-tutorial-highlight', 'ability');
		await expect.poll(() => page.locator('[data-field-facility="adjustment-terminal"]').evaluate((element) => getComputedStyle(element).filter)).not.toBe('none');
		const abilityMarker = await page.evaluate(() => sessionStorage.getItem('persona-bubble-field:first-run-tutorial'));
		expect(abilityMarker).toContain('"step":"ability"');

		await page.reload({ waitUntil: 'domcontentloaded' });
		await releaseFirstRunPrimary(page);
		await expect(abilityStep).toBeVisible();
		await expect.poll(() => page.locator('[data-field-facility="adjustment-terminal"]').evaluate((element) => getComputedStyle(element).filter)).not.toBe('none');
		const abilityPointsBefore = (await readRelayGameState(page)).points;
		const abilityMovementEditor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await abilityMovementEditor.focus();
		await page.keyboard.press('Escape');
		await moveRelaySelfTo(page, { x: ADJUSTMENT_TERMINAL.position.x - 1, y: ADJUSTMENT_TERMINAL.position.y });
		const adjustmentTerminal = page.getByRole('button', { name: '能力強化端末' });
		await expect(adjustmentTerminal).toBeEnabled();
		await adjustmentTerminal.click();
		const adjustmentDialog = page.getByRole('dialog');
		await expect(adjustmentDialog.locator('[data-first-run-ability-guidance]')).toContainText('能力をどれか1つ強化してください。');
		await expect(adjustmentDialog.locator('.ability-card.tutorial-upgrade-choice')).toHaveCount(3);
		const upgrade = adjustmentDialog.getByRole('button', { name: '推論効率をLv2へ強化（必要1pt）' });
		await expect(upgrade).toBeEnabled();
		await upgrade.click();
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ abilities: { inferenceEfficiency: 2 }, points: abilityPointsBefore - 1 });
		await expect(adjustmentDialog).toBeVisible();
		await expect(adjustmentDialog.locator('.level-up-badge')).toContainText('LEVEL UP');
		await expect(page.locator('[data-first-run-tutorial="complete"]')).toHaveText('あとは自由です。');
		await expect(adjustmentDialog.getByRole('button', { name: '閉じる', exact: true }).first()).toBeVisible();
		await adjustmentDialog.getByRole('button', { name: '閉じる', exact: true }).first().click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.locator('[data-first-run-tutorial="complete"]')).toBeVisible();
		await page.evaluate((marker) => { if (marker) sessionStorage.setItem('persona-bubble-field:first-run-tutorial', marker); }, abilityMarker);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await releaseFirstRunPrimary(page);
		await expect(page.locator('[data-first-run-tutorial="complete"]')).toHaveText('あとは自由です。');
		expect(await page.evaluate(() => sessionStorage.getItem('persona-bubble-field:first-run-tutorial'))).toBeNull();
		await page.clock.runFor(2_601);
		await expect(page.locator('[data-first-run-tutorial]')).toHaveCount(0);
		await expect(page.locator('.action-dock')).toBeVisible();
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __ehagakiTerminalCount?: number }).__ehagakiTerminalCount ?? 0)).toBe(0);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await releaseFirstRunPrimary(page);
		await expect(page.locator('[data-first-run-tutorial]')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'はじめる', exact: true })).toHaveCount(0);
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
