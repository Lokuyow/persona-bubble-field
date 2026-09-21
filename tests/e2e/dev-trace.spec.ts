import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { installFieldFrameSampling, sampleRenderedField } from './helpers/fieldFrames';
import { openDevWorld, fieldOwnedBlankPoint, installTraceGeometryFrameSampling, sampleTraceGeometryFrames, profileTrigger, profileDialog } from './helpers/devWorldHarness';


test.describe('DEV World Sandbox', () => {
	test.beforeEach(async ({ page }) => {
		await installHostOwnedStub(page);
	});

	for (const viewport of [{ name: 'desktop', width: 1100, height: 850 }, { name: 'mobile', width: 390, height: 844 }]) {
		test(`shows measured Trace special geometry from its first visible frame on ${viewport.name}`, async ({ page }) => {
			await page.setViewportSize(viewport);
			await installTraceGeometryFrameSampling(page);
			await page.goto('/?devWorld=1&devScenario=trace-replies');
			if (viewport.name === 'desktop') await page.keyboard.press('c');
			const rootCard = page.locator('.trace-root-card');
			await page.locator('[data-cell-position="8,4"]').click();
			await expect(rootCard).toHaveAttribute('data-trace-geometry-ready', 'ready');
			await expect(rootCard).toBeVisible();
			const firstOpenFrames = await sampleTraceGeometryFrames(page);
			const pendingFrames = firstOpenFrames.filter((frame) => frame.ready === 'pending');
			expect(pendingFrames.every((frame) => !frame.visible && frame.rootTailCount === 0 && frame.relationConnectorCount === 0)).toBe(true);
			const visibleFrames = firstOpenFrames.filter((frame) => frame.visible);
			expect(visibleFrames.length).toBeGreaterThan(0);
			const firstVisible = visibleFrames[0];
			const settled = visibleFrames.at(-1)!;
			expect(firstVisible.ready).toBe('ready');
			const firstViewBox = (firstVisible.viewBox ?? '').split(' ').map(Number);
			const settledViewBox = (settled.viewBox ?? '').split(' ').map(Number);
			expect(firstViewBox).toHaveLength(4);
			for (const [index, value] of firstViewBox.entries()) expect(value).toBeCloseTo(settledViewBox[index], 3);
			expect(firstVisible.rootTailCount).toBe(settled.rootTailCount);
			expect(firstVisible.relationConnectorCount).toBe(settled.relationConnectorCount);
			for (const key of ['x', 'y', 'width', 'height'] as const) {
				expect(firstVisible.rootCard[key]).toBeCloseTo(settled.rootCard[key], 1);
				expect(firstVisible.rootBubble[key]).toBeCloseTo(settled.rootBubble[key], 1);
				if (firstVisible.surface && settled.surface) expect(firstVisible.surface[key]).toBeCloseTo(settled.surface[key], 1);
			}

			const blankCell = await fieldOwnedBlankPoint(page, { x: 5, y: 3 });
			await page.mouse.click(blankCell.x, blankCell.y);
			await expect(rootCard).toHaveCount(0);
			const reopenStart = (await sampleTraceGeometryFrames(page)).length;
			await page.locator('[data-cell-position="8,4"]').click();
			await expect(rootCard).toHaveAttribute('data-trace-geometry-ready', 'ready');
			const reopenFrames = (await sampleTraceGeometryFrames(page)).slice(reopenStart).filter((frame) => frame.visible);
			expect(reopenFrames.length).toBeGreaterThan(0);
			const reopened = reopenFrames[0];
			const reopenedViewBox = (reopened.viewBox ?? '').split(' ').map(Number);
			for (const [index, value] of reopenedViewBox.entries()) expect(value).toBeCloseTo(firstViewBox[index], 3);
			for (const key of ['x', 'y', 'width', 'height'] as const) {
				expect(reopened.rootCard[key]).toBeCloseTo(firstVisible.rootCard[key], 1);
				expect(reopened.rootBubble[key]).toBeCloseTo(firstVisible.rootBubble[key], 1);
			}

			const resizeStart = (await sampleTraceGeometryFrames(page)).length;
			await page.setViewportSize({ width: viewport.width + 20, height: viewport.height });
			await expect(rootCard).toHaveAttribute('data-trace-geometry-ready', 'ready');
			const resizeFrames = (await sampleTraceGeometryFrames(page)).slice(resizeStart);
			const resizePendingFrames = resizeFrames.filter((frame) => frame.ready === 'pending');
			expect(resizePendingFrames.every((frame) => !frame.visible && frame.rootTailCount === 0 && frame.relationConnectorCount === 0)).toBe(true);
			const resizeVisibleFrames = resizeFrames.filter((frame) => frame.visible);
			expect(resizeVisibleFrames.length).toBeGreaterThan(0);
			expect(resizeVisibleFrames[0].ready).toBe('ready');
		});
	}

	test('preserves Trace reply drafts across clear and close, changes ownership and publishes locally', async ({ page }) => {
		await page.setViewportSize({ width: 1100, height: 850 });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.goto('/?devWorld=1&devScenario=trace-replies');
		await page.keyboard.press('c');
		const editor = page.getByRole('textbox', { name: '投稿エディター' });
		const preview = page.getByLabel('Reply preview', { exact: true });
		const selectCell = async (position: string) => {
			const cell = page.locator(`[data-cell-position="${position}"]`);
			const box = await cell.boundingBox();
			if (!box) throw new Error('Expected a visible Trace cell');
			// The root and its compact same-cell reply occupy the center and lower-right corner.
			await cell.click({ position: { x: 2, y: 2 } });
		};
		await editor.fill('top-level draft');
		await selectCell('8,4');
		await expect(preview).toHaveAttribute('data-reply-id', '2'.repeat(64));
		await expect(editor).toHaveValue('');
		await expect(editor).not.toBeFocused();
		await editor.fill('preserved A');
		await page.getByRole('button', { name: 'Clear reply', exact: true }).click();
		await expect(preview).toHaveCount(0);
		await expect(editor).toHaveValue('preserved A');
		await page.locator('.field-area').click({ position: { x: 8, y: 8 } });
		await expect(page.locator('[data-trace-marker-position="8,4"]')).toHaveCount(1);
		await selectCell('8,4');
		const menu = page.getByRole('menu');
		if (await menu.isVisible()) await page.getByRole('menuitem', { name: '痕跡を調べる', exact: true }).click();
		await expect(preview).toHaveAttribute('data-reply-id', '2'.repeat(64));
		await expect(editor).toHaveValue('preserved A');
		await page.locator('.field-area').click({ position: { x: 8, y: 8 } });
		await expect(preview).toHaveCount(0);
		await expect(editor).toHaveValue('preserved A');
		await selectCell('8,4');
		await expect(preview).toHaveAttribute('data-reply-id', '2'.repeat(64));
		await expect(editor).toHaveValue('preserved A');
		await selectCell('8,3');
		await expect(preview).toHaveAttribute('data-reply-id', '4'.repeat(64));
		await expect(editor).toHaveValue('');
		await editor.fill('DEV own reply');
		await editor.press('Alt+Enter');
		await expect(editor).toHaveValue('');
		await expect(preview).toHaveCount(0);
		await expect(page.locator('[data-trace-current-id]')).toHaveAttribute('data-trace-current-id', '4'.repeat(64));
		const own = page.locator('[data-trace-reply-id="' + '1'.padStart(64, '0') + '"]');
		await expect(own).toContainText('DEV own reply');
		await expect(own).toHaveAttribute('data-speech-type', 'monologue');
		await expect(own.getByRole('button', { name: /プロフィール/ })).toBeVisible();
		await editor.press('Escape');
		await page.keyboard.press('ArrowLeft');
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '6,3');
		await expect(own).toHaveCount(0);
		await expect(page.locator('.trace-root-card')).toHaveCount(0);
		await expect(page.locator('[data-trace-marker-position="8,4"]')).toHaveCount(1);
		await page.keyboard.press('ArrowRight');
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '7,3');
		await expect(own).toHaveCount(0);
	});

	test('shows current Trace selection only when multiple speeches are visible', async ({ page }) => {
		await page.setViewportSize({ width: 1100, height: 850 });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.goto('/?devWorld=1&devScenario=trace-markers');
		await page.locator('[data-cell-position="8,4"]').click();
		await expect(page.locator('.trace-root-card')).toBeVisible();
		await expect(page.locator('[data-trace-selection="current"]')).toHaveCount(0);
		await expect(page.locator('.trace-current-selection-outline')).toHaveCount(0);

		await page.goto('/?devWorld=1&devScenario=trace-replies');
		await page.keyboard.press('c');
		await page.locator('[data-cell-position="8,4"]').click();
		await expect(page.locator('[data-trace-selection="current"]')).toHaveCount(1);
		await expect(page.locator('[data-trace-root-id][data-trace-selection="current"]')).toHaveCount(1);
		await expect(page.locator('[data-trace-root-id] .trace-current-selection-outline')).toHaveCount(1);

		const select = async (id: string) => {
			await page.locator(`[data-trace-reply-id="${id.repeat(64)}"] .trace-reply-content-button`).click();
			await expect(page.locator('[data-trace-selection="current"]')).toHaveCount(1);
			await expect(page.locator(`[data-trace-reply-id="${id.repeat(64)}"][data-trace-selection="current"]`)).toHaveCount(1);
			await expect(page.locator(`[data-trace-reply-id="${id.repeat(64)}"] .trace-current-selection-outline`)).toHaveCount(id === 'd' || id === 'f' ? 1 : 0);
		};
		await select('7');
		await expect(page.locator('[data-trace-root-id][data-trace-selection="current"]')).toHaveCount(0);
		const normalSelection = await page.locator(`[data-trace-reply-id="${'7'.repeat(64)}"]`).evaluate((card) => {
			const style = getComputedStyle(card, '::before');
			return { borderColor: style.borderColor, borderStyle: style.borderStyle, borderWidth: style.borderWidth };
		});
		expect(normalSelection.borderColor).toBeTruthy();
		expect(normalSelection).toMatchObject({ borderStyle: 'solid', borderWidth: '2px' });
		await select('b');
		await expect(page.locator(`[data-trace-role="parent"][data-trace-reply-id="${'7'.repeat(64)}"][data-trace-selection="current"]`)).toHaveCount(0);
		await select('d');
		await select('f');
		await page.locator(`[data-trace-reply-id="${'f'.repeat(64)}"] .trace-reply-author-profile`).click();
		await expect(profileDialog(page)).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.locator(`[data-trace-reply-id="${'f'.repeat(64)}"][data-trace-selection="current"]`)).toHaveCount(1);
		await page.getByRole('button', { name: 'Clear reply', exact: true }).click();
		await expect(page.locator(`[data-trace-reply-id="${'f'.repeat(64)}"][data-trace-selection="current"]`)).toHaveCount(1);
	});

	for (const viewport of [{ name: 'desktop', width: 1100, height: 850 }, { name: 'mobile', width: 390, height: 844 }]) {
		test(`keeps a deep tree-only cluster interactive on ${viewport.name}`, async ({ page }) => {
			await page.setViewportSize(viewport);
			await page.goto('/?devWorld=1&devScenario=trace-replies');
			if (viewport.name === 'desktop') await page.keyboard.press('c');
			await page.locator('[data-cell-position="8,4"]').click();
			await expect(page.locator('.trace-root-card')).toHaveAttribute('data-trace-geometry-ready', 'ready');
			const direct = page.locator(`[data-trace-reply-id="${'7'.repeat(64)}"]`);
			await direct.locator('.trace-reply-content-button').click();
			await page.locator(`[data-trace-reply-id="${'b'.repeat(64)}"]`).locator('.trace-reply-content-button').click();
			await expect(page.locator('[data-trace-root-id] .trace-root-compact')).toBeVisible();
			await expect(page.locator(`[data-trace-role="parent"][data-trace-reply-id="${'7'.repeat(64)}"]`)).toBeVisible();
			await expect(page.locator(`[data-trace-role="current"][data-trace-reply-id="${'b'.repeat(64)}"]`)).toBeVisible();
			const children = page.locator('[data-trace-role="child"]');
			await expect(children).toHaveCount(2);
			const anchors = await page.locator('.trace-root-card, [data-trace-role="parent"], [data-trace-role="current"], [data-trace-role="child"]').evaluateAll((cards) =>
				cards.map((card) => {
					const box = card.getBoundingClientRect();
					return `${Math.round(box.left)},${Math.round(box.top)}`;
				})
			);
			expect(new Set(anchors).size).toBe(anchors.length);
			const authorLayout = await children.first().evaluate((card) => {
				const author = card.querySelector<HTMLElement>('[data-trace-author-block]');
				const avatarWrapper = author?.querySelector<HTMLElement>('.trace-reply-author-avatar');
				const avatar = author?.querySelector<HTMLElement>('.trace-reply-author-avatar .avatar');
				const name = author?.querySelector<HTMLElement>('.trace-reply-author-name');
				const surface = card as HTMLElement;
				const content = card.querySelector<HTMLElement>('.trace-reply-content-button');
				if (!author || !avatarWrapper || !avatar || !name || !surface || !content) throw new Error('Expected a reply author block, surface, and content control.');
				const authorBox = author.getBoundingClientRect();
				const avatarWrapperBox = avatarWrapper.getBoundingClientRect();
				const avatarBox = avatar.getBoundingClientRect();
				const nameBox = name.getBoundingClientRect();
				const surfaceBox = surface.getBoundingClientRect();
				const contentBox = content.getBoundingClientRect();
				return {
					authorDisplay: getComputedStyle(author).display,
					direction: getComputedStyle(author).flexDirection,
					nameWhiteSpace: getComputedStyle(name).whiteSpace,
					nameOverflow: getComputedStyle(name).textOverflow,
					authorLeft: authorBox.left, avatarWrapperBox, avatarBox, nameBox, surfaceBox, contentBox
				};
			});
			expect(authorLayout).toMatchObject({ authorDisplay: 'flex', direction: 'column', nameWhiteSpace: 'nowrap', nameOverflow: 'ellipsis' });
			for (const box of [authorLayout.avatarBox, authorLayout.nameBox, authorLayout.contentBox]) {
				expect(box.left).toBeGreaterThanOrEqual(authorLayout.surfaceBox.left - 0.5);
				expect(box.right).toBeLessThanOrEqual(authorLayout.surfaceBox.right + 0.5);
				expect(box.top).toBeGreaterThanOrEqual(authorLayout.surfaceBox.top - 0.5);
				expect(box.bottom).toBeLessThanOrEqual(authorLayout.surfaceBox.bottom + 0.5);
			}
			expect(authorLayout.avatarBox.left).toBeGreaterThanOrEqual(authorLayout.avatarWrapperBox.left - 0.5);
			expect(authorLayout.avatarBox.right).toBeLessThanOrEqual(authorLayout.avatarWrapperBox.right + 0.5);
			expect(authorLayout.avatarBox.top).toBeGreaterThanOrEqual(authorLayout.avatarWrapperBox.top - 0.5);
			expect(authorLayout.avatarBox.bottom).toBeLessThanOrEqual(authorLayout.avatarWrapperBox.bottom + 0.5);
			expect(Math.abs((authorLayout.avatarBox.left + authorLayout.avatarBox.right) / 2 - (authorLayout.avatarWrapperBox.left + authorLayout.avatarWrapperBox.right) / 2)).toBeLessThan(0.5);
			expect(Math.abs((authorLayout.avatarBox.top + authorLayout.avatarBox.bottom) / 2 - (authorLayout.avatarWrapperBox.top + authorLayout.avatarWrapperBox.bottom) / 2)).toBeLessThan(0.5);
			expect(authorLayout.avatarBox.bottom).toBeLessThanOrEqual(authorLayout.nameBox.top);
			expect(authorLayout.avatarBox.right).toBeLessThanOrEqual(authorLayout.contentBox.left);
			expect(authorLayout.nameBox.right).toBeLessThanOrEqual(authorLayout.contentBox.left);
			const shoutReply = page.locator(`[data-trace-reply-id="${'d'.repeat(64)}"]`);
			const shoutStacking = await shoutReply.evaluate((card) => {
				const surface = card as HTMLElement;
				const svg = card.querySelector<SVGSVGElement>('.bubble-surface');
				const author = card.querySelector<HTMLElement>('[data-trace-author-block]');
				const content = card.querySelector<HTMLElement>('.trace-reply-content-button');
				const avatar = card.querySelector<HTMLElement>('.trace-reply-author-avatar .avatar');
				const name = card.querySelector<HTMLElement>('.trace-reply-author-name');
				if (!surface || !svg || !author || !content || !avatar || !name) throw new Error('Expected a complete shout reply surface.');
				const style = (element: Element) => getComputedStyle(element);
				const surfaceBox = surface.getBoundingClientRect();
				const boxes = [avatar, name, content].map((element) => element.getBoundingClientRect());
				return {
					speechType: surface.dataset.speechType,
					svg: { position: style(svg).position, zIndex: style(svg).zIndex },
					author: { position: style(author).position, zIndex: style(author).zIndex },
					content: { position: style(content).position, zIndex: style(content).zIndex },
					name: { text: name.textContent, visibility: style(name).visibility, opacity: style(name).opacity, color: style(name).color },
					surfaceBox,
					boxes
				};
			});
			expect(shoutStacking.speechType).toBe('shout');
			expect(shoutStacking.svg).toEqual({ position: 'absolute', zIndex: '0' });
			expect(shoutStacking.author).toEqual({ position: 'relative', zIndex: '1' });
			expect(shoutStacking.content).toEqual({ position: 'relative', zIndex: '1' });
			expect(Number(shoutStacking.author.zIndex)).toBeGreaterThan(Number(shoutStacking.svg.zIndex));
			expect(Number(shoutStacking.content.zIndex)).toBeGreaterThan(Number(shoutStacking.svg.zIndex));
			expect(shoutStacking.name).toMatchObject({ visibility: 'visible', opacity: '1' });
			expect(shoutStacking.name.text?.trim().length).toBeGreaterThan(0);
			expect(shoutStacking.name.color).not.toBe('rgba(0, 0, 0, 0)');
			for (const box of shoutStacking.boxes) {
				expect(box.left).toBeGreaterThanOrEqual(shoutStacking.surfaceBox.left - 0.5);
				expect(box.right).toBeLessThanOrEqual(shoutStacking.surfaceBox.right + 0.5);
				expect(box.top).toBeGreaterThanOrEqual(shoutStacking.surfaceBox.top - 0.5);
				expect(box.bottom).toBeLessThanOrEqual(shoutStacking.surfaceBox.bottom + 0.5);
			}
			// Select the shout child that owns the next visible level; oldest-first
			// ordering deliberately makes the earlier normal sibling first.
			const selectedChild = page.locator(`[data-trace-role="child"][data-trace-reply-id="${'d'.repeat(64)}"]`);
			const selectedChildId = await selectedChild.getAttribute('data-trace-reply-id');
			if (!selectedChildId) throw new Error('Expected the nested child reply ID.');
			await selectedChild.locator('.trace-reply-content-button').click();
			await expect(page.locator('[data-trace-current-reply-id]')).toHaveAttribute('data-trace-current-reply-id', selectedChildId);
			await page.locator(`[data-trace-role="child"][data-trace-reply-id="${'f'.repeat(64)}"]`).getByRole('button', { name: /プロフィール/ }).click();
			await expect(profileDialog(page)).toBeVisible();
			await page.keyboard.press('Escape');
			const grandchild = page.locator(`[data-trace-reply-id="${'f'.repeat(64)}"]`);
			const grandchildGeometry = await grandchild.evaluate((card) => {
				const content = card.querySelector<HTMLElement>('.trace-reply-content-button');
				if (!content) throw new Error('Expected a grandchild content control.');
				const cardRect = card.getBoundingClientRect();
				const contentRect = content.getBoundingClientRect();
				const style = getComputedStyle(card);
				return {
					card: { left: cardRect.left, top: cardRect.top, right: cardRect.right, bottom: cardRect.bottom, paddingTop: Number.parseFloat(style.paddingTop), paddingBottom: Number.parseFloat(style.paddingBottom), borderTop: Number.parseFloat(style.borderTopWidth), borderBottom: Number.parseFloat(style.borderBottomWidth) },
					content: { left: contentRect.left, top: contentRect.top, right: contentRect.right, bottom: contentRect.bottom, height: contentRect.height }
				};
			});
			const grandchildContent = grandchildGeometry.content;
			const grandchildCard = grandchildGeometry.card;
			if (!grandchildContent || !grandchildCard) throw new Error('Expected a measurable grandchild content hit area.');
			expect(grandchildContent.top).toBeCloseTo(grandchildCard.top + grandchildCard.borderTop + grandchildCard.paddingTop, 1);
			expect(grandchildContent.bottom).toBeCloseTo(grandchildCard.bottom - grandchildCard.borderBottom - grandchildCard.paddingBottom, 1);
			expect(grandchildContent.left).toBeGreaterThan(grandchildCard.left);
			await page.mouse.click(grandchildContent.right - 2, grandchildContent.top + grandchildContent.height / 2);
			await expect(page.locator('[data-trace-current-reply-id]')).toHaveAttribute('data-trace-current-reply-id', 'f'.repeat(64));
			await grandchild.getByRole('button', { name: /プロフィール/ }).click();
			await expect(profileDialog(page)).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(page.locator('[data-trace-current-reply-id]')).toHaveAttribute('data-trace-current-reply-id', 'f'.repeat(64));
		});

			test(`preserves existing Trace anchors when a direct reply is added on ${viewport.name}`, async ({ page }) => {
			await page.setViewportSize(viewport);
			await page.goto('/?devWorld=1&devScenario=trace-replies');
			if (viewport.name === 'mobile') await page.locator('.sandbox-mobile-toggle').click();
			if (viewport.name === 'desktop') await page.keyboard.press('c');
			await page.locator('[data-cell-position="8,4"]').click();
			await expect(page.locator('.trace-root-card')).toHaveAttribute('data-trace-geometry-ready', 'ready');
			const existing = page.locator('[data-trace-reply-id="' + '6'.repeat(64) + '"]');
			const anchor = await existing.evaluate((card) => getComputedStyle(card).transform);
			await page.getByRole('button', { name: 'Add live trace reply' }).click();
			await expect(page.locator('[data-trace-reply-id="' + 'c'.repeat(64) + '"]')).toBeVisible();
			await expect.poll(() => existing.evaluate((card) => getComputedStyle(card).transform)).toBe(anchor);
		});

		test(`preserves selected Trace positions across direct and deep navigation on ${viewport.name}`, async ({ page }) => {
			await page.setViewportSize(viewport);
			await page.goto('/?devWorld=1&devScenario=trace-replies');
			if (viewport.name === 'desktop') await page.keyboard.press('c');
			await page.locator('[data-cell-position="8,4"]').click();
			await expect(page.locator('.trace-root-card')).toHaveAttribute('data-trace-geometry-ready', 'ready');
			await expect(page.locator('.field-scene')).not.toHaveAttribute('data-camera-animation', 'active');
			const rightUpper = page.locator('[data-trace-reply-id="' + '8'.repeat(64) + '"]');
			const readAnchor = (card: Locator) => card.evaluate((element) => getComputedStyle(element).transform);
			await expect(rightUpper).toBeVisible();
			const rightUpperBefore = await readAnchor(rightUpper);
			await rightUpper.locator('.trace-reply-content-button').click();
			await expect(page.locator('[data-trace-current-reply-id]')).toHaveAttribute('data-trace-current-reply-id', '8'.repeat(64));
			await expect.poll(() => readAnchor(rightUpper)).toBe(rightUpperBefore);

			await page.reload();
			if (viewport.name === 'desktop') await page.keyboard.press('c');
			await page.locator('[data-cell-position="8,4"]').click();
			await expect(page.locator('.trace-root-card')).toHaveAttribute('data-trace-geometry-ready', 'ready');
			await expect(page.locator('.field-scene')).not.toHaveAttribute('data-camera-animation', 'active');
			const branchParent = page.locator('[data-trace-reply-id="' + '7'.repeat(64) + '"]');
			const branchParentBefore = await readAnchor(branchParent);
			await branchParent.locator('.trace-reply-content-button').click();
			await expect(page.locator('[data-trace-current-reply-id]')).toHaveAttribute('data-trace-current-reply-id', '7'.repeat(64));
			await expect(page.locator('[data-trace-reply-id="' + 'b'.repeat(64) + '"]')).toBeVisible();
			await expect.poll(() => readAnchor(branchParent)).toBe(branchParentBefore);
			const child = page.locator('[data-trace-reply-id="' + 'b'.repeat(64) + '"]');
			const childBefore = await readAnchor(child);
			await child.locator('.trace-reply-content-button').click();
			await expect(page.locator('[data-trace-current-reply-id]')).toHaveAttribute('data-trace-current-reply-id', 'b'.repeat(64));
			await expect.poll(() => readAnchor(branchParent)).toBe(branchParentBefore);
			await expect.poll(() => readAnchor(child)).toBe(childBefore);
		});

		test(`shows known Trace continuation branches without hidden cards on ${viewport.name}`, async ({ page }) => {
			await page.setViewportSize(viewport);
			await page.goto('/?devWorld=1&devScenario=trace-replies');
			if (viewport.name === 'desktop') await page.keyboard.press('c');
			await page.locator('[data-cell-position="8,4"]').click();
			await expect(page.locator('.trace-root-card')).toHaveAttribute('data-trace-geometry-ready', 'ready');
			const id = (value: string) => value.repeat(64);
			const branch = (value: string) => page.locator(`[data-trace-continuation-reply-id="${id(value)}"]`);
			await expect(page.locator('[data-trace-reply-id="' + id('b') + '"]')).toHaveCount(0);
			await expect(branch('7')).toHaveCount(1);
			await expect(branch('6')).toHaveCount(0);
			const continuationStructure = await page.locator('[data-trace-continuation-reply-id]').evaluateAll((elements) => elements.every((element) =>
				element.closest('[data-trace-surface-occlusion-root-id]') !== null &&
				!element.classList.contains('trace-relation-connector')
			));
			expect(continuationStructure).toBe(true);

			await page.locator(`[data-trace-reply-id="${id('7')}"] .trace-reply-content-button`).click();
			await expect(page.locator(`[data-trace-reply-id="${id('b')}"]`)).toBeVisible();
			await expect(branch('7')).toHaveCount(0);
			await expect(branch('b')).toHaveCount(1);
			await page.locator(`[data-trace-reply-id="${id('b')}"] .trace-reply-content-button`).click();
			await expect(page.locator(`[data-trace-reply-id="${id('d')}"]`)).toBeVisible();
			await expect(page.locator(`[data-trace-reply-id="${id('e')}"]`)).toBeVisible();
			await expect(branch('b')).toHaveCount(0);
			await expect(branch('d')).toHaveCount(1);
			await expect(branch('e')).toHaveCount(0);
			await expect(page.locator(`[data-trace-reply-id="${id('f')}"]`)).toHaveCount(0);
			await page.locator(`[data-trace-reply-id="${id('d')}"] .trace-reply-content-button`).click();
			await expect(page.locator(`[data-trace-reply-id="${id('f')}"]`)).toBeVisible();
			await expect(branch('d')).toHaveCount(0);
		});
	}
	test('reselects the current reply without losing its draft, preserves it through profiles, and clears on range exit', async ({ page }) => {
		await page.setViewportSize({ width: 1100, height: 850 });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.goto('/?devWorld=1&devScenario=trace-replies');
		await page.keyboard.press('c');
		const editor = page.getByRole('textbox', { name: '投稿エディター' });
		const preview = page.getByLabel('Reply preview', { exact: true });
		await page.locator('[data-cell-position="8,4"]').click();
		const current = page.locator('[data-trace-reply-id="' + '7'.repeat(64) + '"]');
		await current.locator('.trace-reply-content-button').click();
		await expect(preview).toHaveAttribute('data-reply-id', '7'.repeat(64));
		await editor.fill('nested draft');
		await page.getByRole('button', { name: 'Clear reply', exact: true }).click();
		await current.locator('.trace-reply-content-button').click();
		await expect(preview).toHaveAttribute('data-reply-id', '7'.repeat(64));
		await expect(editor).toHaveValue('nested draft');
		await current.getByRole('button', { name: /プロフィール/ }).click();
		await expect(profileDialog(page)).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(editor).toHaveValue('nested draft');
		await expect(preview).toHaveAttribute('data-reply-id', '7'.repeat(64));
		await page.getByRole('button', { name: 'Clear reply', exact: true }).click();
		await expect(preview).toHaveCount(0);
		await expect(editor).toHaveValue('nested draft');
		await expect(current).toBeVisible();
		for (let step = 0; step < 4; step += 1) await page.keyboard.press('ArrowRight');
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
		await expect(editor).toHaveValue('nested draft');
		await expect(preview).toHaveCount(0);
		await expect(page.locator('.trace-root-card')).toHaveCount(0);
		await expect(page.locator('[data-trace-reply-id="' + '7'.repeat(64) + '"]')).toHaveCount(0);
		await expect(page.locator('[data-trace-marker-position="8,4"]')).toHaveCount(1);

		await page.reload();
		await page.keyboard.press('c');
		await page.locator('[data-cell-position="8,4"]').click();
		const activeCurrent = page.locator('[data-trace-reply-id="' + '7'.repeat(64) + '"]');
		await activeCurrent.locator('.trace-reply-content-button').click();
		await editor.fill('active nested draft');
		await editor.press('Escape');
		await page.keyboard.press('ArrowLeft');
		await page.keyboard.press('ArrowRight');
		for (let step = 0; step < 4; step += 1) await page.keyboard.press('ArrowRight');
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
		await expect(editor).toHaveValue('');
		await expect(preview).toHaveCount(0);
		await expect(page.locator('.trace-root-card')).toHaveCount(0);
		await expect(page.locator('[data-trace-reply-id="' + '7'.repeat(64) + '"]')).toHaveCount(0);
		await expect(page.locator('[data-trace-marker-position="8,4"]')).toHaveCount(1);
	});

	test('starts with the local-only self and deterministic character presentation', async ({ page }) => {
		await openDevWorld(page);

		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await expect(page.locator('.participant')).toHaveCount(1);
		await expect(page.locator('.sandbox-direction-pad, .world-direction-pad')).toHaveCount(0);

		const characterSelect = page.getByLabel('Select sandbox character');
		await expect(characterSelect).toHaveValue('001');

		const self = page.locator('.participant').first();
		await expect(self).toHaveAttribute('data-position', '7,3');
		await expect(self).not.toHaveAttribute('data-movement-animation', 'active');
		await expect(self.locator('img')).toHaveAttribute('src', /characters\/001\.webp$/);
	});

	test('uses logical cells for trace actions while markers remain decorative', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.addInitScript(() => {
			const NativeWebSocket = window.WebSocket;
			Object.defineProperty(window, '__traceExternalCalls', {
				value: { webSocketUrls: [] as string[], indexedDbOpen: 0 }, configurable: true
			});
			window.WebSocket = class extends NativeWebSocket {
				constructor(url: string | URL, protocols?: string | string[]) {
					(window as never as { __traceExternalCalls: { webSocketUrls: string[] } }).__traceExternalCalls.webSocketUrls.push(String(url));
					super(url, protocols);
				}
			};
			const nativeOpen = indexedDB.open.bind(indexedDB);
			indexedDB.open = ((...args: Parameters<IDBFactory['open']>) => {
				(window as never as { __traceExternalCalls: { indexedDbOpen: number } }).__traceExternalCalls.indexedDbOpen += 1;
				return nativeOpen(...args);
			}) as IDBFactory['open'];
		});
		await page.goto('/?devWorld=1&devScenario=trace-markers');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await expect(page.locator('main')).toHaveAttribute('data-trace-runtime', 'dev');
		const externalCallBaseline = await page.evaluate(() => (window as never as {
			__traceExternalCalls: { webSocketUrls: string[]; indexedDbOpen: number }
		}).__traceExternalCalls);

		const markers = page.locator('.trace-marker');
		await expect(markers).toHaveCount(3);
		await expect(page.locator('[data-trace-marker-position="2,2"]')).toHaveCount(1);
		await expect(page.locator('[data-trace-marker-position="7,3"]')).toHaveCount(0);
		await expect(page.locator('[data-trace-marker-position="8,4"]')).toHaveCount(1);
		await expect(page.locator('[data-trace-marker-position="8,3"]')).toHaveCount(1);
		await expect(page.locator('[data-trace-indicator-position="2,2"]')).toHaveCount(0);
		await expect(page.locator('.trace-investigation-indicator')).toHaveCount(3);
		const presentation = await markers.evaluateAll((elements) => elements.map((element) => ({
			text: element.textContent,
			pointerEvents: getComputedStyle(element).pointerEvents
		})));
		expect(presentation).toEqual(Array.from({ length: 3 }, () => ({ text: '', pointerEvents: 'none' })));

		const geometry = await page.evaluate(() => {
			const grid = document.querySelector<HTMLElement>('.field-grid');
			const scene = document.querySelector<HTMLElement>('.field-scene');
			const empty = document.querySelector<HTMLElement>('[data-trace-marker-position="8,4"]');
			const emptyIndicator = document.querySelector<HTMLElement>('[data-trace-indicator-position="8,4"]');
			const occupiedIndicator = document.querySelector<HTMLElement>('[data-trace-indicator-position="7,3"]');
			if (!grid || !scene || !empty || !emptyIndicator || !occupiedIndicator) throw new Error('Expected trace marker geometry.');
			const gridRect = grid.getBoundingClientRect();
			const emptyRect = empty.getBoundingClientRect();
			const emptyIndicatorRect = emptyIndicator.getBoundingClientRect();
			const occupiedIndicatorRect = occupiedIndicator.getBoundingClientRect();
			const cellSize = Number.parseFloat(getComputedStyle(scene).getPropertyValue('--cell-size'));
			return {
				cellSize,
				empty: { x: emptyRect.left + emptyRect.width / 2 - gridRect.left, y: emptyRect.top + emptyRect.height / 2 - gridRect.top },
				emptyIndicator: { x: emptyIndicatorRect.left + emptyIndicatorRect.width / 2 - gridRect.left, y: emptyIndicatorRect.top + emptyIndicatorRect.height / 2 - gridRect.top },
				occupiedIndicator: { x: occupiedIndicatorRect.left + occupiedIndicatorRect.width / 2 - gridRect.left, y: occupiedIndicatorRect.top + occupiedIndicatorRect.height / 2 - gridRect.top }
			};
		});
		expect(geometry.empty.x).toBeCloseTo(8.5 * geometry.cellSize, 1);
		expect(geometry.empty.y).toBeCloseTo(4.5 * geometry.cellSize, 1);
		expect(geometry.emptyIndicator.x).toBeCloseTo(9 * geometry.cellSize - 10, 0);
		expect(geometry.emptyIndicator.y).toBeCloseTo(4 * geometry.cellSize + 10, 0);
		expect(geometry.occupiedIndicator.x).toBeCloseTo(8 * geometry.cellSize - 10, 0);
		expect(geometry.occupiedIndicator.y).toBeCloseTo(3 * geometry.cellSize + 10, 0);
		expect(geometry.occupiedIndicator.x - geometry.emptyIndicator.x).toBeCloseTo(-geometry.cellSize, 0);
		expect(geometry.occupiedIndicator.y - geometry.emptyIndicator.y).toBeCloseTo(-geometry.cellSize, 0);

		const before = await page.evaluate(() => ({
			gridLeft: document.querySelector<HTMLElement>('.field-grid')!.getBoundingClientRect().left,
			markerLeft: document.querySelector<HTMLElement>('[data-trace-marker-position="2,2"]')!.getBoundingClientRect().left
		}));
		await page.locator('[data-cell-position="8,4"]').click();
		await expect(page.locator('[data-trace-root-id="' + '2'.repeat(64) + '"]')).toContainText('trace-only root near the viewer');
		await expect(page.getByRole('menu', { name: 'Cell actions' })).toHaveCount(0);
		const self = page.locator('.participant[data-self="true"]');
		const start = await fieldOwnedBlankPoint(page, { x: 5, y: 5 });
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x + 24, start.y);
		await page.mouse.up();
		await expect(self).toHaveAttribute('data-position', '8,3');
		await expect(page.locator('[data-trace-marker-position="7,3"]')).toHaveCount(1);
		const actionMenu = page.getByRole('menu', { name: 'Cell actions' });
		await expect(actionMenu).toHaveCount(0);
		const after = await page.evaluate(() => ({
			gridLeft: document.querySelector<HTMLElement>('.field-grid')!.getBoundingClientRect().left,
			markerLeft: document.querySelector<HTMLElement>('[data-trace-marker-position="2,2"]')!.getBoundingClientRect().left
		}));
		expect(after.gridLeft).not.toBe(before.gridLeft);
		expect(after.markerLeft - before.markerLeft).toBeCloseTo(after.gridLeft - before.gridLeft, 3);
		expect(await page.evaluate(() => (window as never as {
			__traceExternalCalls: { webSocketUrls: string[]; indexedDbOpen: number }
		}).__traceExternalCalls)).toEqual(externalCallBaseline);
	});

	test('opens and navigates the shared DEV trace conversation without changing it on menu open', async ({ page }) => {
		await page.setViewportSize({ width: 900, height: 720 });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.goto('/?devWorld=1&devScenario=trace-markers');
		await expect(page.locator('main')).toHaveAttribute('data-trace-runtime', 'dev');
		const markers = page.locator('.trace-marker');

		if (await page.locator('aside[aria-label="Chatter"]').isVisible()) await page.keyboard.press('c');

		await page.locator('[data-cell-position="2,2"]').focus();
		await page.keyboard.press('Enter');
		await expect(page.locator('.trace-root-bubble')).toHaveCount(0);
		await expect(page.locator('.trace-proximity-feedback')).toHaveText('近づくと調べられる');
		await expect(page.locator('.trace-proximity-feedback')).toHaveCount(0, { timeout: 1_500 });
		const liveAnchor = await page.locator('[data-bubble-id="dev-trace-live-message"]').evaluate((element) => getComputedStyle(element).transform);
		await page.locator('[data-cell-position="8,4"]').click({ position: { x: 4, y: 4 } });
		await expect(page.locator('[data-trace-root-id="' + '2'.repeat(64) + '"]')).toContainText('trace-only root near the viewer');
		await expect(page.locator('[data-trace-ghost-root-id="' + '2'.repeat(64) + '"]')).toBeVisible();
		await expect(page.locator('[data-trace-marker-position="8,4"]')).toHaveCount(0);
		await expect(markers).toHaveCount(2);
		await expect(page.locator('.trace-reply-status')).toHaveCount(0);
		await expect.poll(() => page.locator('[data-bubble-id="dev-trace-live-message"]').evaluate((element) => getComputedStyle(element).transform)).toBe(liveAnchor);

		await profileTrigger(page, '女の子').click();
		const menu = page.getByRole('menu', { name: 'Cell actions' });
		await expect(menu).toBeVisible();
		await expect(menu.getByRole('menuitem')).toHaveCount(2);
		await expect(page.locator('[data-trace-root-id="' + '2'.repeat(64) + '"]')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(menu).toBeHidden();

		await page.keyboard.press('ArrowRight');
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '8,3');
		await profileTrigger(page, '女の子').click();
		await expect(menu).toBeVisible();
		await expect(menu.locator('[data-cell-action="movement"]')).toHaveCount(0);
		await menu.locator('[data-cell-action="trace"]').click();
		await expect(page.locator('[data-trace-root-id="' + '4'.repeat(64) + '"]')).toContainText('newest root');
		const normalRootSurface = await page.locator('.bubble-layer').evaluate(() => {
			const root = document.querySelector<HTMLElement>('[data-trace-root-id]');
			const tail = document.querySelector<SVGPolygonElement>('.tail-layer polygon[data-trace-tail-root-id]');
			const tailOutline = document.querySelector<SVGPathElement>('.tail-layer path[data-trace-tail-root-id]');
			const surface = root?.querySelector<SVGSVGElement>('.normal-trace-root-surface');
			const outline = surface?.querySelector<SVGRectElement>('.normal-trace-root-outline');
			const opening = surface?.querySelector<SVGPolygonElement>('polygon[data-tail-opening]');
			if (!root || !tail || !tailOutline || !surface || !outline || !opening) throw new Error('Expected the normal trace root surface and tail.');
			const token = getComputedStyle(root).getPropertyValue('--trace-surface').trim();
			const probe = document.createElement('span');
			probe.style.setProperty('--trace-surface', token);
			probe.style.background = 'var(--trace-surface)';
			document.body.append(probe);
			const expectedSurface = getComputedStyle(probe).backgroundColor;
			probe.remove();
			const group = tail.closest<SVGGElement>('g[data-trace-surface-occlusion-root-id]');
			const sharedMask = group?.getAttribute('mask');
			const maskId = sharedMask?.replace(/^url\(#|\)$/g, '');
			const mask = maskId ? document.getElementById(maskId) : null;
			const screenPoints = (element: SVGGraphicsElement, points: readonly DOMPoint[]) => {
				const matrix = element.getScreenCTM();
				if (!matrix) throw new Error('Expected an SVG transform.');
				return points.map((point) => point.matrixTransform(matrix));
			};
			const openingPoints = screenPoints(opening, [opening.points.getItem(0), opening.points.getItem(1)]);
			const tailPoints = screenPoints(tail, [tail.points.getItem(0), tail.points.getItem(1)]);
			return {
				expectedSurface,
				tailFill: getComputedStyle(tail).fill,
				sharedMask,
				tailMask: tail.getAttribute('mask'),
				tailOutlineMask: tailOutline.getAttribute('mask'),
				bodyExclusionCount: mask?.querySelectorAll('rect[fill="black"]').length,
				pseudoContent: getComputedStyle(root, '::after').content,
				outlineMask: outline.getAttribute('mask'),
				openingError: Math.max(...openingPoints.map((point, index) => Math.hypot(point.x - tailPoints[index].x, point.y - tailPoints[index].y)))
			};
		});
		expect(normalRootSurface).toEqual({
			expectedSurface: normalRootSurface.expectedSurface,
			tailFill: normalRootSurface.expectedSurface,
			sharedMask: expect.stringMatching(/^url\(#trace-surface-occlusion-/),
			tailMask: null,
			tailOutlineMask: null,
			bodyExclusionCount: 1,
			pseudoContent: 'none',
			outlineMask: expect.stringMatching(/^url\(#speech-tail-opening-/),
			openingError: expect.any(Number)
		});
		expect(normalRootSurface.openingError).toBeLessThan(1);
		await expect(page.locator('.trace-root-selector')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Previous trace root' })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Next trace root' })).toHaveCount(0);

		await page.keyboard.press('ArrowLeft');
		await profileTrigger(page, '女の子').click();
		await expect(page.getByRole('menu', { name: 'Cell actions' })).toBeVisible();
		await page.getByRole('menu', { name: 'Cell actions' }).locator('[data-cell-action="trace"]').click();
		await expect(page.locator('[data-trace-root-id="' + '3'.repeat(64) + '"]')).toContainText('root beside the current participant');
		const monologueRootOutline = await page.locator('.bubble-layer').evaluate(() => {
			const tail = document.querySelector<SVGPolygonElement>('.tail-layer polygon[data-trace-tail-root-id]');
			const outline = document.querySelector<SVGPathElement>('.tail-layer path[data-trace-tail-root-id]');
			if (!tail || !outline) throw new Error('Expected the monologue root tail.');
			const group = tail.closest<SVGGElement>('g[data-trace-surface-occlusion-root-id]');
			const sharedMask = group?.getAttribute('mask');
			const maskId = sharedMask?.replace(/^url\(#|\)$/g, '');
			return { sharedMask, tailMask: tail.getAttribute('mask'), outlineMask: outline.getAttribute('mask'), reopenCount: maskId ? document.getElementById(maskId)?.querySelectorAll('polygon').length : null };
		});
		expect(monologueRootOutline).toEqual({
			sharedMask: expect.stringMatching(/^url\(#trace-surface-occlusion-/),
			tailMask: null,
			outlineMask: null,
			reopenCount: 0
		});
		await expect(page.locator('.trace-root-selector')).toHaveCount(0);

		await page.locator('.trace-ghost-profile-trigger').click();
		await expect(profileDialog(page)).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(profileDialog(page)).toBeHidden();
		await expect(page.locator('[data-trace-root-id="' + '3'.repeat(64) + '"]')).toBeVisible();

		await page.keyboard.press('ArrowLeft');
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '6,3');
		await expect(page.locator('[data-trace-root-id="' + '3'.repeat(64) + '"]')).toBeVisible();

		await page.locator('.field-area').click({ position: { x: 8, y: 8 } });
		await expect(page.locator('.trace-root-bubble')).toHaveCount(0);
		await expect(page.locator('[data-trace-marker-position="8,4"]')).toHaveCount(1);
		await expect(markers).toHaveCount(4);
	});

	test('does not leave a selectable trigger behind for the hidden open Trace marker', async ({ page }) => {
		await page.setViewportSize({ width: 900, height: 720 });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.goto('/?devWorld=1&devScenario=trace-markers');
		await expect(page.locator('[data-cell-position="8,4"]')).toBeVisible();
		const markers = page.locator('.trace-marker');
		await page.locator('[data-cell-position="8,4"]').click();
		await expect(page.locator('[data-trace-root-id="' + '2'.repeat(64) + '"]')).toBeVisible();
		await expect(page.locator('[data-trace-marker-position="8,4"]')).toHaveCount(0);
		await expect(page.locator('[data-trace-indicator-position="8,4"]')).toHaveCount(0);
		await expect(page.locator('[data-cell-position="8,4"]')).toHaveCount(0);
		const cell = await page.locator('.field-grid').evaluate((grid) => {
			const scene = document.querySelector<HTMLElement>('.field-scene');
			if (!scene) throw new Error('Expected the field scene.');
			return Number.parseFloat(getComputedStyle(scene).getPropertyValue('--cell-size'));
		});
		const grid = await page.locator('.field-grid').boundingBox();
		if (!grid) throw new Error('Expected the field grid.');
		await page.mouse.click(grid.x + 8 * cell + 2, grid.y + 4 * cell + 2);
		await expect(page.locator('.trace-root-bubble')).toHaveCount(0);
	});

	test('reactivates an inactive DEV self through Trace inspection', async ({ page }) => {
		await page.setViewportSize({ width: 900, height: 720 });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.goto('/?devWorld=1&devScenario=trace-inactive-self');
		await expect(page.locator('.participant[data-self="true"]')).toHaveCount(0);
		await expect(page.locator('[data-cell-position="8,4"]')).toHaveAttribute('aria-label', '痕跡を調べる');
		await page.locator('[data-cell-position="8,4"]').click();
		await expect(page.locator('[data-trace-root-id="' + '2'.repeat(64) + '"]')).toContainText('trace-only root near the viewer');
		await expect(page.locator('.participant[data-self="true"]')).toHaveCount(1);
		await expect(page.locator('.trace-proximity-feedback')).toHaveCount(0);
	});

	test('presents deterministic direct Trace replies without external runtime ownership', async ({ page }) => {
		await page.setViewportSize({ width: 900, height: 720 });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.addInitScript(() => {
			const NativeWebSocket = window.WebSocket;
			Object.defineProperty(window, '__traceReplyExternalCalls', {
				value: { webSocketUrls: [] as string[], indexedDbOpen: 0 }, configurable: true
			});
			window.WebSocket = class extends NativeWebSocket {
				constructor(url: string | URL, protocols?: string | string[]) {
					(window as never as { __traceReplyExternalCalls: { webSocketUrls: string[] } }).__traceReplyExternalCalls.webSocketUrls.push(String(url));
					super(url, protocols);
				}
			};
			const nativeOpen = indexedDB.open.bind(indexedDB);
			indexedDB.open = ((...args: Parameters<IDBFactory['open']>) => {
				(window as never as { __traceReplyExternalCalls: { indexedDbOpen: number } }).__traceReplyExternalCalls.indexedDbOpen += 1;
				return nativeOpen(...args);
			}) as IDBFactory['open'];
		});
		await page.goto('/?devWorld=1&devScenario=trace-replies');
		await expect(page.locator('main')).toHaveAttribute('data-trace-runtime', 'dev');

		if (await page.locator('aside[aria-label="Chatter"]').isVisible()) await page.keyboard.press('c');
		const externalBaseline = await page.evaluate(() => (window as never as {
			__traceReplyExternalCalls: { webSocketUrls: string[]; indexedDbOpen: number }
		}).__traceReplyExternalCalls);

		const liveBubble = page.locator('[data-bubble-id="dev-trace-live-message"]');
		const liveAnchor = await liveBubble.evaluate((element) => getComputedStyle(element).transform);
		await page.locator('[data-cell-position="8,4"]').click();
		await expect(page.locator('[data-trace-root-id="' + '2'.repeat(64) + '"]')).toContainText('trace-only root near the viewer');
		await expect.poll(() => liveBubble.evaluate((element) => getComputedStyle(element).transform)).toBe(liveAnchor);

		const replyBubbles = page.locator('[data-trace-reply-id]');
		await expect(replyBubbles).toHaveCount(5);
		await expect(page.locator('[data-trace-reply-id="' + '7'.repeat(64) + '"]')).toContainText('newest same-cell direct reply');
		const traceStacking = await page.locator('.bubble-layer').evaluate((layer) => {
			const viewport = document.querySelector<HTMLElement>('.field-viewport');
			const fieldArea = document.querySelector<HTMLElement>('.field-area');
			const tail = document.querySelector<SVGElement>('.tail-layer');
			const cards = [...layer.querySelectorAll<HTMLElement>('.trace-root-card, .trace-reply-card')];
			if (!viewport || !fieldArea || !tail) throw new Error('Expected the Trace stacking layers.');
			return {
				layerRect: layer.getBoundingClientRect().toJSON(),
				viewportRect: viewport.getBoundingClientRect().toJSON(),
				fieldZIndex: getComputedStyle(fieldArea).zIndex,
				bubbleZIndex: getComputedStyle(layer).zIndex,
				tailZIndex: getComputedStyle(tail).zIndex,
				cardPointerEvents: cards.map((card) => getComputedStyle(card).pointerEvents),
				cardParents: cards.map((card) => card.parentElement === layer)
			};
		});
		expect(traceStacking.layerRect).toEqual(traceStacking.viewportRect);
		expect(traceStacking.fieldZIndex).toBe('2');
		expect(traceStacking.bubbleZIndex).toBe('3');
		expect(traceStacking.tailZIndex).toBe('4');
		expect(traceStacking.cardPointerEvents.every((value) => value === 'auto')).toBe(true);
		expect(traceStacking.cardParents.every(Boolean)).toBe(true);
		const directChildIds = async () => page.locator('[data-trace-role="child"]').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-trace-reply-id')));
		expect(await directChildIds()).toEqual(['6', '7', '8', '9', 'a'].map((id) => id.repeat(64)));
		const oldestDirectAnchor = await page.locator('[data-trace-reply-id="' + '6'.repeat(64) + '"]').evaluate((card) => getComputedStyle(card).transform);
		await page.getByRole('button', { name: 'Add live trace reply' }).click();
		await expect(page.locator('[data-trace-reply-id="' + 'c'.repeat(64) + '"]')).toBeVisible();
		expect(await directChildIds()).toEqual(['6', '7', '8', '9', 'a', 'c'].map((id) => id.repeat(64)));
		await expect.poll(() => page.locator('[data-trace-reply-id="' + '6'.repeat(64) + '"]').evaluate((card) => getComputedStyle(card).transform)).toBe(oldestDirectAnchor);
		const traceSurface = await page.locator('.bubble-layer').evaluate(() => {
			const resolveSurface = (value: string) => {
				const probe = document.createElement('span');
				probe.style.setProperty('--trace-surface', value);
				probe.style.background = 'var(--trace-surface)';
				document.body.append(probe);
				const color = getComputedStyle(probe).backgroundColor;
				probe.remove();
				return color;
			};
			return [...document.querySelectorAll<HTMLElement>('.trace-root-bubble, .trace-reply-card')].map((card) => {
				const token = getComputedStyle(card).getPropertyValue('--trace-surface').trim();
				const fill = card.querySelector<SVGPathElement>('.trace-bubble-surface-fill');
				const text = card.querySelector<HTMLElement>('.bubble-content');
				return {
					speechType: card.dataset.speechType,
					token,
					expectedSurface: resolveSurface(token),
					background: getComputedStyle(card).backgroundColor,
					fill: fill ? getComputedStyle(fill).fill : null,
					textOpacity: text ? getComputedStyle(text).opacity : null
				};
			});
		});
		const normalTraceSurfaces = traceSurface.filter((surface) => surface.speechType === 'normal');
		const specialTraceSurfaces = traceSurface.filter((surface) => surface.speechType === 'shout' || surface.speechType === 'monologue');
		expect(normalTraceSurfaces.length).toBeGreaterThan(0);
		expect(specialTraceSurfaces.length).toBeGreaterThan(0);
		expect(normalTraceSurfaces.every((surface) => surface.background === surface.expectedSurface && surface.textOpacity === '1')).toBe(true);
		expect(specialTraceSurfaces.every((surface) => surface.fill === surface.expectedSurface && surface.textOpacity === '1')).toBe(true);
		const replyTailSeams = await replyBubbles.evaluateAll((cards) => cards
			.filter((card) => card.getAttribute('data-speech-type') === 'normal')
			.map((card) => getComputedStyle(card, '::after').content));
		expect(replyTailSeams.length).toBeGreaterThan(0);
		expect(replyTailSeams.every((content) => content === 'none')).toBe(true);
		await expect(page.locator('[data-trace-tail-root-id="' + '2'.repeat(64) + '"]')).toHaveCount(2);
		await expect(page.locator('[data-trace-tail-root-id="' + '2'.repeat(64) + '"]').first()).toHaveAttribute('data-trace-tail-target');
		await expect(page.locator('[data-trace-tail-reply-id]')).toHaveCount(0);
		const specialRootOutline = await page.locator('.bubble-layer').evaluate(() => {
			const root = document.querySelector<HTMLElement>('[data-trace-root-id]');
			const tail = document.querySelector<SVGPolygonElement>('.tail-layer polygon[data-trace-tail-root-id]');
			const outline = document.querySelector<SVGPathElement>('.tail-layer path[data-trace-tail-root-id]');
			const surfaceOutline = root?.querySelector<SVGPathElement>('.bubble-surface-outline');
			if (!tail || !outline || !surfaceOutline) throw new Error('Expected the special root surface and tail.');
			const group = tail.closest<SVGGElement>('g[data-trace-surface-occlusion-root-id]');
			const sharedMask = group?.getAttribute('mask');
			const maskId = sharedMask?.replace(/^url\(#|\)$/g, '');
			const mask = maskId ? document.getElementById(maskId) : null;
			return {
				sharedMask,
				tailMask: tail.getAttribute('mask'),
				outlineMask: outline.getAttribute('mask'),
				outlineReopenCount: mask?.querySelectorAll('polygon').length,
				surfaceOpeningCount: surfaceOutline.closest('svg')?.querySelectorAll('polygon[data-tail-opening]').length
			};
		});
		expect(specialRootOutline).toEqual({
			sharedMask: expect.stringMatching(/^url\(#trace-surface-occlusion-/),
			tailMask: null,
			outlineMask: null,
			outlineReopenCount: 0,
			surfaceOpeningCount: 1
		});
		const rootSpecialTailMask = await page.locator('.tail-layer').evaluate((layer) => {
			const group = layer.querySelector<SVGGElement>('[data-trace-surface-occlusion-root-id]');
			const maskId = group?.getAttribute('mask')?.replace(/^url\(#|\)$/g, '');
			const mask = maskId ? document.getElementById(maskId) : null;
			return {
				maskId,
				x: mask?.getAttribute('x'), y: mask?.getAttribute('y'),
				width: mask?.getAttribute('width'), height: mask?.getAttribute('height'),
				bodyFill: mask?.querySelector('path')?.getAttribute('fill'),
				viewportFill: mask?.querySelector('rect')?.getAttribute('fill')
			};
		});
		const [, , viewportWidth, viewportHeight] = (await page.locator('.tail-layer').getAttribute('viewBox') ?? '').split(' ');
		expect(rootSpecialTailMask).toMatchObject({ x: '0', y: '0', width: viewportWidth, height: viewportHeight, viewportFill: 'white', bodyFill: 'black' });
		const sharedTracePresentation = await page.locator('.tail-layer').evaluate((layer) => {
			const group = layer.querySelector<SVGGElement>('[data-trace-surface-occlusion-root-id]');
			const maskId = group?.getAttribute('mask')?.replace(/^url\(#|\)$/g, '');
			const mask = maskId ? document.getElementById(maskId) : null;
			const foreground = [...layer.querySelectorAll<SVGPolygonElement>('polygon[data-trace-relation-reply-id]')];
			const halos = [...layer.querySelectorAll<SVGPolygonElement>('polygon[data-trace-relation-halo-reply-id]')];
			const edgeWidth = (polygon: SVGPolygonElement, index: number) => {
				const points = polygon.points;
				return Math.hypot(points.getItem(index).x - points.getItem(index + 1).x, points.getItem(index).y - points.getItem(index + 1).y);
			};
			return {
				groupMask: group?.getAttribute('mask'),
				rootTailGroup: layer.querySelector('[data-trace-tail-root-id]')?.closest('g') === group,
				foregroundGroups: foreground.every((polygon) => polygon.closest('g') === group),
				haloGroups: halos.every((polygon) => polygon.closest('g') === group),
				relationPairs: foreground.map((polygon) => ({
					id: polygon.dataset.traceRelationReplyId,
					halo: halos.find((halo) => halo.dataset.traceRelationHaloReplyId === polygon.dataset.traceRelationReplyId)?.dataset.traceRelationHaloReplyId,
					foregroundFill: getComputedStyle(polygon).fill,
					haloFill: getComputedStyle(halos.find((halo) => halo.dataset.traceRelationHaloReplyId === polygon.dataset.traceRelationReplyId)!).fill,
					foregroundBox: (() => {
						const box = polygon.getBBox();
						return { width: box.width, height: box.height };
					})(),
					startWidth: edgeWidth(polygon, 0), endWidth: edgeWidth(polygon, 2),
					haloStartWidth: edgeWidth(halos.find((halo) => halo.dataset.traceRelationHaloReplyId === polygon.dataset.traceRelationReplyId)!, 0),
					haloEndWidth: edgeWidth(halos.find((halo) => halo.dataset.traceRelationHaloReplyId === polygon.dataset.traceRelationReplyId)!, 2)
				})),
				normalOccluders: mask?.querySelectorAll('rect[fill="black"]').length,
				specialOccluders: mask?.querySelectorAll('path[fill="black"]').length
			};
		});
		expect(sharedTracePresentation.groupMask).toMatch(/^url\(#trace-surface-occlusion-/);
		expect(sharedTracePresentation.rootTailGroup).toBe(true);
		expect(sharedTracePresentation.foregroundGroups).toBe(true);
		expect(sharedTracePresentation.haloGroups).toBe(true);
		expect(sharedTracePresentation.relationPairs.length).toBeGreaterThan(0);
		expect(sharedTracePresentation.relationPairs.every((relation) => {
			const widths = [relation.startWidth, relation.endWidth, relation.haloStartWidth, relation.haloEndWidth];
			return relation.halo === relation.id && relation.foregroundFill !== 'none' && relation.haloFill !== 'none' &&
				relation.foregroundBox.width > 0 && relation.foregroundBox.height > 0 && widths.every(Number.isFinite) &&
				relation.startWidth > relation.endWidth && relation.endWidth > 0 &&
				relation.haloStartWidth > relation.startWidth && relation.haloEndWidth > relation.endWidth && relation.haloEndWidth > 0;
		})).toBe(true);
		expect(sharedTracePresentation.normalOccluders).toBeGreaterThan(0);
		expect(sharedTracePresentation.specialOccluders).toBeGreaterThan(0);
		await page.locator('[data-trace-reply-id="' + '7'.repeat(64) + '"]').getByRole('button', { name: /プロフィール/ }).click();
		await expect(profileDialog(page)).toBeVisible();
		await page.keyboard.press('Escape');
	});

	test('navigates a deep DEV Trace one adjacent speech at a time through shared cell actions', async ({ page }) => {
		await page.setViewportSize({ width: 900, height: 720 });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.goto('/?devWorld=1&devScenario=trace-replies');

		await page.keyboard.press('c');
		await page.locator('[data-cell-position="8,4"]').click();
		await page.locator('[data-trace-reply-id="' + '7'.repeat(64) + '"]').locator('.trace-reply-content-button').click();
		await expect(page.locator('[data-trace-current-reply-id="' + '7'.repeat(64) + '"]')).toBeVisible();
		await expect(page.locator('[data-trace-reply-id="' + 'b'.repeat(64) + '"]')).toBeVisible();
		await page.locator('[data-trace-reply-id="' + 'b'.repeat(64) + '"]').locator('.trace-reply-content-button').click();
		await expect(page.locator('[data-trace-current-reply-id="' + 'b'.repeat(64) + '"]')).toBeVisible();
	});
});
