import { expect, test, type Page } from '@playwright/test';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';

async function openDevWorld(page: Page): Promise<void> {
	await page.goto('/?devWorld=1');
	await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
	await expect(page.locator('.participant')).toHaveCount(1);
}

async function openClockedDevWorld(page: Page): Promise<void> {
	await page.clock.install({ time: Date.now() });
	await openDevWorld(page);
	await page.clock.pauseAt(Date.now());
}

async function readMergedBubbleGeometry(page: Page, memberPrefixes: readonly string[]) {
	return page.locator('.bubble-merged').evaluate((bubble, prefixes) => {
		const mergedMemberIds = new Set(prefixes.map((prefix) => prefix.repeat(64)));
		const rect = bubble.getBoundingClientRect();
		const style = getComputedStyle(bubble);
		const polygons = [...document.querySelectorAll<SVGPolygonElement>('.tail-layer polygon')]
			.filter((polygon) => mergedMemberIds.has(polygon.dataset.tailParticipantId ?? ''));
		const tailStartXs = polygons.map((polygon) => {
			const first = polygon.points.getItem(0);
			const second = polygon.points.getItem(1);
			const target = polygon.points.getItem(polygon.points.numberOfItems - 1);
			const base = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
			const dx = target.x - base.x;
			const dy = target.y - base.y;
			const length = Math.hypot(dx, dy) || 1;
			return base.x + (dx / length) * 2;
		});
		const connectionMasks = [...bubble.querySelectorAll<HTMLElement>('.bubble-tail-connection')].map((mask) => {
			const maskRect = mask.getBoundingClientRect();
			const maskStyle = getComputedStyle(mask);
			return {
				participantId: mask.dataset.tailParticipantId,
				centerX: maskRect.left + maskRect.width / 2,
				width: maskRect.width,
				height: maskRect.height,
				background: maskStyle.backgroundColor
			};
		});

		return {
			memberCount: Number(bubble.dataset.mergedMembers),
			width: rect.width,
			height: rect.height,
			fontSize: Number.parseFloat(style.fontSize),
			paddingLeft: Number.parseFloat(style.paddingLeft),
			tailStartXs,
			connectionMasks,
			tailOutlineCount: document.querySelectorAll('.tail-layer path[data-tail-participant-id]').length,
			borderRadius: style.borderRadius,
			background: style.backgroundColor
		};
	}, memberPrefixes);
}

async function readCharacterGeometry(page: Page) {
	return page.locator('.participant').first().evaluate((participant) => {
		const avatar = participant.querySelector<HTMLElement>('.avatar');
		const participantRect = participant.getBoundingClientRect();
		const avatarRect = avatar?.getBoundingClientRect();
		const fieldGrid = document.querySelector<HTMLElement>('.field-grid');
		if (!avatar || !avatarRect) throw new Error('Expected the participant avatar to be rendered.');
		if (!fieldGrid) throw new Error('Expected the field grid to be rendered.');
		const fieldGridRect = fieldGrid.getBoundingClientRect();
		const [x, y] = (participant.dataset.position ?? '').split(',').map(Number);
		const cellSize = Number.parseFloat(getComputedStyle(participant).width);

		return {
			cellWidth: getComputedStyle(participant).width,
			cellHeight: getComputedStyle(participant).height,
			avatarWidth: getComputedStyle(avatar).width,
			avatarHeight: getComputedStyle(avatar).height,
			participantCenter: {
				x: participantRect.left + participantRect.width / 2,
				y: participantRect.top + participantRect.height / 2
			},
			avatarCenter: {
				x: avatarRect.left + avatarRect.width / 2,
				y: avatarRect.top + avatarRect.height / 2
			},
			gridCellCenter: {
				x: fieldGridRect.left + (x + 0.5) * cellSize,
				y: fieldGridRect.top + (y + 0.5) * cellSize
			}
		};
	});
}

async function fieldCellCenter(page: Page, position: { x: number; y: number }): Promise<{ x: number; y: number }> {
	return page.locator('.field-grid').evaluate((grid, cell) => {
		const scene = document.querySelector<HTMLElement>('.field-scene');
		if (!scene) throw new Error('Expected the field scene to be rendered.');
		const rect = grid.getBoundingClientRect();
		const cellSize = Number.parseFloat(getComputedStyle(scene).getPropertyValue('--cell-size'));
		return { x: rect.left + (cell.x + 0.5) * cellSize, y: rect.top + (cell.y + 0.5) * cellSize };
	}, position);
}

async function dragJoystick(page: Page, delta: { x: number; y: number }, startCell = { x: 5, y: 5 }): Promise<void> {
	const start = await fieldCellCenter(page, startCell);
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(start.x + delta.x, start.y + delta.y);
	await page.mouse.up();
}

async function expectNoConsoleProblems(page: Page, action: () => Promise<void>): Promise<void> {
	const problems: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error' || message.type() === 'warning') problems.push(`${message.type()}: ${message.text()}`);
	});
	page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
	await action();
	expect(problems).toEqual([]);
}

function profileTrigger(page: Page, name: string) {
	return page.getByRole('button', { name: `${name} のプロフィールを開く` });
}

function profileDialog(page: Page) {
	return page.getByRole('dialog');
}

async function expectProfile(page: Page, character: { name: string; picture: string; about: string }): Promise<void> {
	const dialog = profileDialog(page);
	await expect(dialog).toBeVisible();
	await expect(dialog.locator('[data-dialog-title]')).toHaveText(character.name);
	await expect(dialog.locator('.profile-dialog-avatar img')).toHaveAttribute('src', new RegExp(`characters/${character.picture}$`));
	await expect(dialog.locator('.profile-dialog-about')).toHaveText(character.about);
}

async function openProfile(page: Page, name: string): Promise<void> {
	await profileTrigger(page, name).click();
	await expect(profileDialog(page)).toBeVisible();
}

async function profileTriggerCenter(page: Page, name: string): Promise<{ x: number; y: number }> {
	const box = await profileTrigger(page, name).boundingBox();
	if (!box) throw new Error('Expected the profile trigger to have a bounding box.');
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe('DEV World Sandbox', () => {
	test.beforeEach(async ({ page }) => { await installHostOwnedStub(page); });

	test('preserves Trace reply drafts across clear and close, changes ownership and publishes locally', async ({ page }) => {
		await page.setViewportSize({ width: 1100, height: 850 });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.goto('/?devWorld=1&devTrace=replies');
		await page.getByRole('button', { name: 'Hide Chatter' }).click();
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
		await expect(page.locator('[data-trace-reply-ghost-id="' + '1'.padStart(64, '0') + '"]')).toHaveCount(0);
		await editor.press('Escape');
		await page.keyboard.press('ArrowLeft');
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '6,3');
		await expect(page.locator('[data-trace-reply-ghost-id="' + '1'.padStart(64, '0') + '"]')).toBeVisible();
		await page.keyboard.press('ArrowRight');
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '7,3');
		await expect(page.locator('[data-trace-reply-ghost-id="' + '1'.padStart(64, '0') + '"]')).toHaveCount(0);
	});
	test('reselects the current reply without losing its draft, preserves it through profiles, and clears on range exit', async ({ page }) => {
		await page.setViewportSize({ width: 1100, height: 850 });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.goto('/?devWorld=1&devTrace=replies');
		await page.getByRole('button', { name: 'Hide Chatter' }).click();
		const selectCell = async (position: string) => {
			const cell = page.locator(`[data-cell-position="${position}"]`);
			const box = await cell.boundingBox();
			if (!box) throw new Error('Expected a visible Trace cell');
			await cell.click({ position: { x: box.width - 2, y: box.height - 2 } });
		};
		const editor = page.getByRole('textbox', { name: '投稿エディター' });
		const preview = page.getByLabel('Reply preview', { exact: true });
		await selectCell('8,4');
		await selectCell('6,4');
		await page.getByRole('menu').locator('[data-cell-action="reply"]').first().click();
		await expect(preview).toHaveAttribute('data-reply-id', '7'.repeat(64));
		await expect(editor).not.toBeFocused();
		await editor.fill('nested draft');
		await page.getByRole('button', { name: 'Clear reply', exact: true }).click();
		await selectCell('6,4');
		await expect(preview).toHaveAttribute('data-reply-id', '7'.repeat(64));
		await expect(editor).toHaveValue('nested draft');
		await page.locator('[data-trace-current-reply-ghost-id="' + '7'.repeat(64) + '"] .trace-ghost-profile-trigger').click();
		await expect(profileDialog(page)).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(editor).toHaveValue('nested draft');
		await expect(preview).toHaveAttribute('data-reply-id', '7'.repeat(64));
		await page.keyboard.press('ArrowRight');
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '8,3');
		await expect(editor).toHaveValue('');
		await expect(preview).toHaveCount(0);
		await expect(page.locator('[data-trace-current-reply-id="' + '7'.repeat(64) + '"]')).toBeVisible();
		await page.keyboard.press('ArrowLeft');
		await expect(preview).toHaveCount(0);
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

	test('uses logical cells for trace actions while lights remain decorative', async ({ page }) => {
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
		await page.goto('/?devWorld=1&devTrace=lights');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await expect(page.locator('main')).toHaveAttribute('data-trace-runtime', 'dev');
		const externalCallBaseline = await page.evaluate(() => (window as never as {
			__traceExternalCalls: { webSocketUrls: string[]; indexedDbOpen: number }
		}).__traceExternalCalls);

		const lights = page.locator('.trace-light');
		await expect(lights).toHaveCount(4);
		await expect(page.locator('[data-trace-light-position="2,2"]')).toHaveCount(1);
		await expect(page.locator('[data-trace-light-position="7,3"]')).toHaveCount(1);
		await expect(page.locator('[data-trace-light-position="8,4"]')).toHaveCount(1);
		await expect(page.locator('[data-trace-light-position="8,3"]')).toHaveCount(1);
		const presentation = await lights.evaluateAll((elements) => elements.map((element) => ({
			text: element.textContent,
			pointerEvents: getComputedStyle(element).pointerEvents
		})));
		expect(presentation).toEqual(Array.from({ length: 4 }, () => ({ text: '', pointerEvents: 'none' })));

		const geometry = await page.evaluate(() => {
			const grid = document.querySelector<HTMLElement>('.field-grid');
			const scene = document.querySelector<HTMLElement>('.field-scene');
			const empty = document.querySelector<HTMLElement>('[data-trace-light-position="2,2"]');
			const occupied = document.querySelector<HTMLElement>('[data-trace-light-position="7,3"]');
			if (!grid || !scene || !empty || !occupied) throw new Error('Expected trace light geometry.');
			const gridRect = grid.getBoundingClientRect();
			const emptyRect = empty.getBoundingClientRect();
			const occupiedRect = occupied.getBoundingClientRect();
			const cellSize = Number.parseFloat(getComputedStyle(scene).getPropertyValue('--cell-size'));
			return {
				cellSize,
				empty: { x: emptyRect.left + emptyRect.width / 2 - gridRect.left, y: emptyRect.top + emptyRect.height / 2 - gridRect.top },
				occupied: { x: occupiedRect.left + occupiedRect.width / 2 - gridRect.left, y: occupiedRect.top + occupiedRect.height / 2 - gridRect.top }
			};
		});
		expect(geometry.empty.x).toBeCloseTo(2.5 * geometry.cellSize, 1);
		expect(geometry.empty.y).toBeCloseTo(2.5 * geometry.cellSize, 1);
		expect(geometry.occupied.x).toBeGreaterThan(7.5 * geometry.cellSize);
		expect(geometry.occupied.y).toBeLessThan(3.5 * geometry.cellSize);

		const before = await page.evaluate(() => ({
			gridLeft: document.querySelector<HTMLElement>('.field-grid')!.getBoundingClientRect().left,
			lightLeft: document.querySelector<HTMLElement>('[data-trace-light-position="2,2"]')!.getBoundingClientRect().left
		}));
		await page.locator('[data-cell-position="8,4"]').click();
		await expect(page.locator('[data-trace-root-id="' + '2'.repeat(64) + '"]')).toContainText('trace-only root near the viewer');
		await expect(page.getByRole('menu', { name: 'Cell actions' })).toHaveCount(0);
		const self = page.locator('.participant[data-self="true"]');
		const start = await fieldCellCenter(page, { x: 5, y: 5 });
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x + 24, start.y);
		await page.mouse.up();
		await expect(self).toHaveAttribute('data-position', '8,3');
		const actionMenu = page.getByRole('menu', { name: 'Cell actions' });
		await expect(actionMenu).toHaveCount(0);
		const after = await page.evaluate(() => ({
			gridLeft: document.querySelector<HTMLElement>('.field-grid')!.getBoundingClientRect().left,
			lightLeft: document.querySelector<HTMLElement>('[data-trace-light-position="2,2"]')!.getBoundingClientRect().left
		}));
		expect(after.gridLeft).not.toBe(before.gridLeft);
		expect(after.lightLeft - before.lightLeft).toBeCloseTo(after.gridLeft - before.gridLeft, 3);
		expect(await page.evaluate(() => (window as never as {
			__traceExternalCalls: { webSocketUrls: string[]; indexedDbOpen: number }
		}).__traceExternalCalls)).toEqual(externalCallBaseline);
	});

	test('opens and navigates the shared DEV trace conversation without changing it on menu open', async ({ page }) => {
		await page.setViewportSize({ width: 900, height: 720 });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.goto('/?devWorld=1&devTrace=lights');
		await expect(page.locator('main')).toHaveAttribute('data-trace-runtime', 'dev');
		const hideTimeline = page.getByRole('button', { name: 'Hide Chatter' });
		if (await hideTimeline.isVisible()) await hideTimeline.click();

		await page.locator('[data-cell-position="2,2"]').focus();
		await page.keyboard.press('Enter');
		await expect(page.locator('.trace-root-bubble')).toHaveCount(0);
		const liveAnchor = await page.locator('[data-bubble-id="dev-trace-live-message"]').evaluate((element) => getComputedStyle(element).transform);
		await page.locator('[data-cell-position="8,4"]').click({ position: { x: 4, y: 4 } });
		await expect(page.locator('[data-trace-root-id="' + '2'.repeat(64) + '"]')).toContainText('trace-only root near the viewer');
		await expect(page.locator('[data-trace-ghost-root-id="' + '2'.repeat(64) + '"]')).toBeVisible();
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
		await expect(page.getByText('1/2', { exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Next trace root' }).click();
		await expect(page.locator('[data-trace-root-id="' + '5'.repeat(64) + '"]')).toContainText('older root');
		await expect(page.getByText('2/2', { exact: true })).toBeVisible();

		await page.locator('.trace-ghost-profile-trigger').click();
		await expect(profileDialog(page)).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(profileDialog(page)).toBeHidden();
		await expect(page.locator('[data-trace-root-id="' + '5'.repeat(64) + '"]')).toBeVisible();

		await page.keyboard.press('ArrowLeft');
		await page.keyboard.press('ArrowLeft');
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '6,3');
		await expect(page.locator('[data-trace-root-id="' + '5'.repeat(64) + '"]')).toBeVisible();
		await page.getByRole('button', { name: 'Previous trace root' }).click();
		await expect(page.locator('[data-trace-root-id="' + '5'.repeat(64) + '"]')).toBeVisible();

		await page.locator('.field-area').click({ position: { x: 8, y: 8 } });
		await expect(page.locator('.trace-root-bubble')).toHaveCount(0);
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
		await page.goto('/?devWorld=1&devTrace=replies');
		await expect(page.locator('main')).toHaveAttribute('data-trace-runtime', 'dev');
		const hideTimeline = page.getByRole('button', { name: 'Hide Chatter' });
		if (await hideTimeline.isVisible()) await hideTimeline.click();
		const externalBaseline = await page.evaluate(() => (window as never as {
			__traceReplyExternalCalls: { webSocketUrls: string[]; indexedDbOpen: number }
		}).__traceReplyExternalCalls);

		const liveBubble = page.locator('[data-bubble-id="dev-trace-live-message"]');
		const liveAnchor = await liveBubble.evaluate((element) => getComputedStyle(element).transform);
		await page.locator('[data-cell-position="8,4"]').click();
		await expect(page.locator('[data-trace-root-id="' + '2'.repeat(64) + '"]')).toContainText('trace-only root near the viewer');
		await expect.poll(() => liveBubble.evaluate((element) => getComputedStyle(element).transform)).toBe(liveAnchor);

		const replyBubbles = page.locator('[data-trace-reply-id]');
		await expect(replyBubbles).toHaveCount(3);
		await expect(page.locator('[data-trace-reply-id="' + '7'.repeat(64) + '"]')).toContainText('newest same-cell direct reply');
		await expect(page.locator('[data-trace-reply-id="' + '7'.repeat(64) + '"]')).toHaveAttribute('data-trace-reply-count', '2');
		await expect(page.getByLabel('2 replies in this cell')).toBeVisible();
		await expect(page.locator('[data-trace-reply-position="9,4"][data-trace-reply-id]')).toHaveAttribute('data-speech-type', 'shout');
		await expect(page.locator('[data-trace-reply-position="8,4"][data-trace-reply-id]')).toHaveAttribute('data-speech-type', 'monologue');

		const traceBubbleBackgrounds = await page.locator('.trace-root-bubble, .trace-reply-bubble').evaluateAll((bubbles) => bubbles.map((bubble) => ({
			speechType: bubble.getAttribute('data-speech-type'),
			background: getComputedStyle(bubble).backgroundColor
		})));
		expect(traceBubbleBackgrounds.filter(({ speechType }) => speechType === 'shout' || speechType === 'monologue')
			.every(({ background }) => background === 'rgba(0, 0, 0, 0)')).toBe(true);
		expect(traceBubbleBackgrounds.filter(({ speechType }) => speechType === 'normal')
			.every(({ background }) => background !== 'rgba(0, 0, 0, 0)')).toBe(true);
		await expect(page.getByText('deeper branch reply')).toHaveCount(0);
		await expect(page.getByText('offscreen reply body must stay hidden')).toHaveCount(0);
		await expect(page.locator('[data-trace-reply-offscreen-position="15,7"]')).toBeVisible();
		await expect(page.locator('[data-trace-reply-ghost-id="' + 'a'.repeat(64) + '"]')).toHaveCount(0);
		await expect(page.locator('[data-cell-position="15,7"]')).toHaveCount(0);
		await expect(page.locator('[data-trace-relation-reply-id]')).toHaveCount(3);
		expect(await page.locator('[data-trace-relation-reply-id]').first().evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');

		const coexistence = await page.evaluate(() => {
			const center = (selector: string) => {
				const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
				return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
			};
			return {
				participant: center('[data-participant-id="' + 'f'.repeat(64) + '"]'),
				participantReply: center('[data-trace-reply-ghost-id="' + '8'.repeat(64) + '"]'),
				root: center('[data-trace-ghost-root-id="' + '2'.repeat(64) + '"]'),
				rootReply: center('[data-trace-reply-ghost-id="' + '9'.repeat(64) + '"]')
			};
		});
		expect(coexistence.participantReply).not.toEqual(coexistence.participant);
		expect(coexistence.rootReply).not.toEqual(coexistence.root);

		await page.getByRole('button', { name: 'Add live trace reply' }).click();
		await expect(page.locator('[data-trace-reply-id="' + '7'.repeat(64) + '"]')).toContainText('newest same-cell direct reply');
		await expect(page.locator('[data-trace-reply-id="' + '7'.repeat(64) + '"]')).toHaveAttribute('data-trace-reply-count', '3');
		await expect(page.getByText('live newest same-cell direct reply')).toHaveCount(0);

		await page.locator('[data-trace-reply-ghost-id="' + '7'.repeat(64) + '"]').click();
		await expect(profileDialog(page)).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(profileDialog(page)).toBeHidden();
		await expect(page.locator('[data-trace-reply-id="' + '7'.repeat(64) + '"]')).toBeVisible();

		const connectorBeforeMovement = await page.locator('[data-trace-reply-offscreen-position="15,7"]').getAttribute('d');
		await dragJoystick(page, { x: -24, y: 0 }, { x: 5, y: 3 });
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '6,3');
		await expect.poll(() => page.locator('[data-trace-reply-offscreen-position="15,7"]').getAttribute('d')).not.toBe(connectorBeforeMovement);
		await page.keyboard.press('ArrowRight');
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '7,3');

		// With the Composer dock present, the field area's corner can lie outside the logical grid.
		const blankCell = await fieldCellCenter(page, { x: 5, y: 3 });
		await page.mouse.click(blankCell.x, blankCell.y);
		await expect(replyBubbles).toHaveCount(0);
		await page.locator('[data-cell-position="8,4"]').click();
		await expect(page.locator('[data-trace-reply-id="' + 'c'.repeat(64) + '"]')).toContainText('live newest same-cell direct reply');
		await expect(page.locator('[data-trace-reply-id="' + 'c'.repeat(64) + '"]')).toHaveAttribute('data-trace-reply-count', '3');
		expect(await page.evaluate(() => (window as never as {
			__traceReplyExternalCalls: { webSocketUrls: string[]; indexedDbOpen: number }
		}).__traceReplyExternalCalls)).toEqual(externalBaseline);
	});

	test('navigates a deep DEV Trace one adjacent speech at a time through shared cell actions', async ({ page }) => {
		await page.setViewportSize({ width: 900, height: 720 });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.goto('/?devWorld=1&devTrace=replies');
		const hideTimeline = page.getByRole('button', { name: 'Hide Chatter' });
		await hideTimeline.click();
		const selectCell = async (position: string) => {
			const cell = page.locator(`[data-cell-position="${position}"]`);
			const box = await cell.boundingBox();
			if (!box) throw new Error(`Expected visible logical cell ${position}.`);
			await cell.click({ position: { x: box.width - 2, y: box.height - 2 } });
		};
		const selectParticipantCell = async (participantId: string) => {
			const box = await page.locator(`[data-participant-id="${participantId}"]`).boundingBox();
			if (!box) throw new Error(`Expected visible participant ${participantId}.`);
			await page.mouse.click(box.x + 3, box.y + 3);
		};

		await selectCell('8,4');
		await selectCell('6,4');
		let menu = page.getByRole('menu', { name: 'Cell actions' });
		await expect(menu.locator('[data-cell-action="reply"]')).toHaveCount(2);
		await menu.locator('[data-cell-action="reply"]').first().click();
		await expect(page.locator('[data-trace-current-reply-id="' + '7'.repeat(64) + '"]'))
			.toContainText('newest same-cell direct reply');
		await expect(page.locator('[data-trace-parent-id="' + '2'.repeat(64) + '"]'))
			.toContainText('trace-only root near the viewer');
		await expect(page.locator('[data-trace-reply-id="' + 'b'.repeat(64) + '"]'))
			.toContainText('deeper branch reply');

		await selectCell('7,4');
		await expect(page.locator('[data-trace-current-reply-id="' + 'b'.repeat(64) + '"]'))
			.toContainText('deeper branch reply');
		await expect(page.locator('[data-trace-parent-id="' + '7'.repeat(64) + '"]'))
			.toContainText('newest same-cell direct reply');
		await expect(page.getByText('trace-only root near the viewer')).toHaveCount(0);
		await expect(page.locator('[data-trace-reply-id="' + 'd'.repeat(64) + '"]'))
			.toHaveAttribute('data-trace-reply-count', '2');

		await selectCell('8,4');
		menu = page.getByRole('menu', { name: 'Cell actions' });
		const sameAuthorReplies = menu.locator('[data-cell-action="reply"]');
		await expect(sameAuthorReplies).toHaveCount(2);
		await expect(sameAuthorReplies.nth(0)).toHaveText(/ #1$/);
		await expect(sameAuthorReplies.nth(1)).toHaveText(/ #2$/);
		await expect(menu).not.toContainText('newest same-author grandchild');
		await expect(menu).not.toContainText('older same-author grandchild');
		await sameAuthorReplies.first().click();
		await expect(page.locator('[data-trace-current-reply-id="' + 'd'.repeat(64) + '"]'))
			.toContainText('newest same-author grandchild');
		await expect(page.locator('[data-trace-parent-id="' + 'b'.repeat(64) + '"]'))
			.toContainText('deeper branch reply');

		await selectParticipantCell('f'.repeat(64));
		menu = page.getByRole('menu', { name: 'Cell actions' });
		await expect(menu.locator('[data-cell-action="participant"]')).toHaveCount(1);
		await expect(menu.locator('[data-cell-action="reply"]')).toHaveCount(1);
		await menu.locator('[data-cell-action="reply"]').click();
		await expect(page.locator('[data-trace-current-reply-id="' + 'd'.repeat(64) + '"]')).toBeVisible();

		await page.keyboard.press('ArrowRight');
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '8,3');
		await selectParticipantCell('f'.repeat(64));
		await page.getByRole('menu', { name: 'Cell actions' }).locator('[data-cell-action="reply"]').click();
		await expect(page.locator('[data-trace-current-reply-id="' + 'f'.repeat(64) + '"]'))
			.toContainText('great-grandchild reply');
		await expect(page.locator('[data-trace-parent-id="' + 'd'.repeat(64) + '"]')).toBeVisible();

		await selectCell('8,4');
		await expect(page.locator('[data-trace-current-reply-id="' + 'd'.repeat(64) + '"]')).toBeVisible();
		await selectCell('7,4');
		await expect(page.locator('[data-trace-current-reply-id="' + 'b'.repeat(64) + '"]')).toBeVisible();
		await expect(page.locator('[data-trace-reply-id="' + 'd'.repeat(64) + '"]'))
			.toContainText('newest same-author grandchild');

		await page.locator('[data-trace-current-reply-ghost-id="' + 'b'.repeat(64) + '"] .trace-ghost-profile-trigger').click();
		await expect(profileDialog(page)).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(profileDialog(page)).toBeHidden();
		await expect(page.locator('[data-trace-current-reply-id="' + 'b'.repeat(64) + '"]')).toBeVisible();

		await page.setViewportSize({ width: 420, height: 720 });
		for (let step = 0; step < 4; step += 1) await page.keyboard.press('ArrowRight');
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '12,3');
		await expect(page.locator('[data-trace-parent-id="' + '7'.repeat(64) + '"]')).toHaveCount(0);
		await expect(page.locator('[data-trace-parent-offscreen-id="' + '7'.repeat(64) + '"]'))
			.toHaveAttribute('data-trace-parent-direction', 'left');
		await expect(page.locator('[data-cell-position="6,4"]')).toHaveCount(0);
		await expect(page.locator('[data-cell-position="8,4"]')).toHaveCount(1);

		for (let step = 0; step < 4; step += 1) await page.keyboard.press('ArrowLeft');
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '8,3');
		const restoredParentCell = page.locator('[data-cell-position="6,4"]');
		await expect(restoredParentCell).toHaveCount(1);
	});

	test('shows a finite recent-message overlay with semantic colors and existing profile focus restoration', async ({ page }) => {
		await page.setViewportSize({ width: 1200, height: 1600 });
		await page.goto('/?devWorld=1&devSpeech=timeline');
		const timeline = page.getByLabel('Chatter', { exact: true });
		const visibleEntries = timeline.locator('.timeline-visible-entries .timeline-entry');
		await expect(timeline).toBeVisible();
		expect(await visibleEntries.count()).toBeGreaterThan(20);
		const measurementParity = await visibleEntries.first().evaluate((entry) => {
			const measurement = document.querySelector<HTMLElement>('.timeline-measurements .timeline-entry');
			if (!measurement) throw new Error('Expected a matching timeline measurement entry.');
			return {
				visibleHeight: entry.getBoundingClientRect().height,
				measurementHeight: measurement.getBoundingClientRect().height,
				visibleNames: entry.querySelectorAll('.timeline-name').length,
				measurementNames: measurement.querySelectorAll('.timeline-name').length
			};
		});
		expect(Math.abs(measurementParity.visibleHeight - measurementParity.measurementHeight)).toBeLessThan(1);
		expect(measurementParity.visibleNames).toBe(1);
		expect(measurementParity.measurementNames).toBe(1);
		await expect(timeline.locator('img')).toHaveCount(0);
		const presentation = await timeline.evaluate((element) => {
			const style = getComputedStyle(element);
			const entries = element.querySelector<HTMLElement>('.timeline-visible-entries');
			return {
				backgroundColor: style.backgroundColor,
				backdropFilter: style.backdropFilter,
				boxShadow: style.boxShadow,
				overflowY: entries ? getComputedStyle(entries).overflowY : ''
			};
		});
		expect(presentation).toEqual({
			backgroundColor: 'rgba(0, 0, 0, 0)',
			backdropFilter: 'none',
			boxShadow: 'none',
			overflowY: 'visible'
		});

		const timelineOrder = await visibleEntries.evaluateAll((entries) => entries.map((entry) => ({
			id: entry.getAttribute('data-timeline-event-id'),
			createdAt: Number(entry.getAttribute('data-timeline-created-at'))
		})));
		expect(timelineOrder.every((entry, index) => index === 0 ||
			entry.createdAt < timelineOrder[index - 1].createdAt ||
			(entry.createdAt === timelineOrder[index - 1].createdAt &&
				(entry.id ?? '') > (timelineOrder[index - 1].id ?? '')))).toBe(true);
		expect(await visibleEntries.locator('.timeline-content').allTextContents()).toContain('same content, different event');
		await expect(visibleEntries.filter({ hasText: 'line 1' }).locator('.timeline-ellipsis')).toHaveCount(1);
		await expect(visibleEntries.filter({ hasText: 'same content, different event' }).locator('.timeline-ellipsis')).toHaveCount(0);
		const shortEntryFlow = await visibleEntries.filter({ hasText: 'timeline message 22' }).first().evaluate((entry) => {
			const name = entry.querySelector<HTMLElement>('.timeline-name');
			const content = entry.querySelector<HTMLElement>('.timeline-content');
			if (!name || !content) throw new Error('Expected an inline timeline name and content.');
			const contentLine = content.getClientRects()[0];
			return {
				nameTop: name.getBoundingClientRect().top,
				contentTop: contentLine?.top ?? -1,
				contentTag: content.tagName,
				textHeight: entry.querySelector<HTMLElement>('.timeline-text')?.clientHeight ?? 0
			};
		});
		expect(Math.abs(shortEntryFlow.nameTop - shortEntryFlow.contentTop)).toBeLessThan(4.5);
		expect(shortEntryFlow.contentTag).toBe('SPAN');
		expect(shortEntryFlow.textHeight).toBeLessThan(40);
		const longEntryFlow = await visibleEntries.filter({ hasText: 'line 1' }).first().locator('.timeline-text').evaluate((text) => ({
			clientHeight: text.clientHeight,
			scrollHeight: text.scrollHeight,
			contentLines: text.querySelector<HTMLElement>('.timeline-content')?.getClientRects().length ?? 0
		}));
		expect(longEntryFlow.contentLines).toBeGreaterThan(1);
		expect(longEntryFlow.scrollHeight).toBeGreaterThan(longEntryFlow.clientHeight);
		await expect(timeline.locator('.timeline-measurements button.timeline-name')).toHaveCount(0);
		await expect(timeline.locator('button.timeline-name')).toHaveCount(await visibleEntries.count());
		const toneColors = await visibleEntries.evaluateAll((entries) => entries.reduce<Record<string, string>>((colors, entry) => {
			const tone = entry.getAttribute('data-timeline-tone') ?? 'default';
			const name = entry.querySelector<HTMLElement>('.timeline-name');
			if (name) colors[tone] = getComputedStyle(name).color;
			return colors;
		}, {}));
		expect(Object.keys(toneColors)).toEqual(expect.arrayContaining([
			'coral', 'lavender', 'mint', 'yellow', 'sky', 'peach', 'rose', 'blue', 'default'
		]));
		expect(new Set(Object.entries(toneColors)
		.filter(([tone]) => tone !== 'default')
		.map(([, color]) => color)).size).toBe(8);

		const activePubkey = 'a'.repeat(64);
		const outsidePubkey = 'f'.repeat(64);
		const activeParticipantTone = await page.locator(`[data-participant-id="${activePubkey}"] .avatar`).evaluate((avatar) =>
			[...avatar.classList].find((className) => className.startsWith('avatar-'))?.slice('avatar-'.length));
		await expect(timeline.locator(`[data-timeline-pubkey="${activePubkey}"]`).first()).toHaveAttribute('data-timeline-tone', activeParticipantTone ?? '');
		await expect(timeline.locator(`[data-timeline-pubkey="${outsidePubkey}"]`).first()).toHaveAttribute('data-timeline-tone', 'default');

		const activeName = timeline.locator(`[data-timeline-pubkey="${activePubkey}"] .timeline-name`).first();
		await expect(activeName).toHaveCSS('text-decoration-line', 'none');
		await activeName.click();
		await expect(profileDialog(page)).toBeVisible();
		await expect(timeline).toBeVisible();
		await profileDialog(page).getByRole('button', { name: '閉じる' }).click();
		await expect(activeName).toBeFocused();

		const outsideName = timeline.locator(`[data-timeline-pubkey="${outsidePubkey}"] .timeline-name`).first();
		await outsideName.click();
		await expect(profileDialog(page)).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(profileDialog(page)).toBeHidden();
	});

	test('toggles Chatter with the unmodified C shortcut and preserves its guards', async ({ page }) => {
		await page.setViewportSize({ width: 1200, height: 900 });
		await page.goto('/?devWorld=1&devSpeech=timeline');
		const chatter = page.locator('aside.recent-message-timeline');
		const hide = page.getByRole('button', { name: 'Hide Chatter' });
		await expect(chatter).toBeVisible();
		await expect(hide).toHaveAttribute('aria-keyshortcuts', 'C');
		const beforeIds = await page.locator('.timeline-visible-entries .timeline-entry').evaluateAll((entries) =>
			entries.map((entry) => entry.getAttribute('data-timeline-event-id')));

		await page.keyboard.press('c');
		await expect(chatter).toBeHidden();
		await page.keyboard.press('C');
		await expect(chatter).toBeVisible();
		await expect(page.locator('.timeline-visible-entries .timeline-entry')).toHaveCount(beforeIds.length);
		await expect(page.getByRole('button', { name: 'Hide Chatter' })).toHaveAttribute('aria-keyshortcuts', 'C');

		await page.keyboard.press('Control+c');
		await expect(chatter).toBeVisible();
		await page.keyboard.press('Shift+c');
		await expect(chatter).toBeVisible();
		await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'c', code: 'KeyC', isComposing: true, bubbles: true
		})));
		await expect(chatter).toBeVisible();

		await page.locator('.timeline-name').first().click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'c', code: 'KeyC', bubbles: true
		})));
		await expect(chatter).toBeVisible();
		await page.getByRole('dialog').getByRole('button', { name: '閉じる' }).click();

		await page.keyboard.press('c');
		await expect(chatter).toBeHidden();
		await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'c', code: 'KeyC', repeat: true, bubbles: true
		})));
		await expect(chatter).toBeHidden();
	});

	test('renders only fully fitting entries without a scroll container', async ({ page }) => {
		await page.setViewportSize({ width: 1200, height: 500 });
		await page.goto('/?devWorld=1&devSpeech=timeline');
		const timeline = page.locator('aside.recent-message-timeline');
		const visibleEntries = timeline.locator('.timeline-visible-entries .timeline-entry');
		await expect.poll(() => visibleEntries.count()).toBeGreaterThan(0);
		const initialCount = await visibleEntries.count();

		await page.setViewportSize({ width: 1200, height: 1400 });
		await expect.poll(() => visibleEntries.count()).toBeGreaterThan(initialCount);
		const expandedCount = await visibleEntries.count();

		await page.setViewportSize({ width: 1200, height: 500 });
		await expect.poll(() => visibleEntries.count()).toBeLessThan(expandedCount);
		const layout = await page.evaluate(() => {
			const container = document.querySelector<HTMLElement>('.timeline-visible-entries');
			if (!container) throw new Error('Expected the visible timeline container.');
			const containerRect = container.getBoundingClientRect();
			return {
				overflowY: getComputedStyle(container).overflowY,
				scrollTop: container.scrollTop,
				scrollHeight: container.scrollHeight,
				clientHeight: container.clientHeight,
				entryBottoms: [...container.querySelectorAll<HTMLElement>('.timeline-entry')].map((entry) => entry.getBoundingClientRect().bottom),
				interactiveCount: container.querySelectorAll('button.timeline-name').length,
				measurementInteractiveCount: document.querySelectorAll('.timeline-measurements button.timeline-name').length,
				containerBottom: containerRect.bottom
			};
		});
		expect(layout.overflowY).toBe('visible');
		expect(layout.scrollTop).toBe(0);
		expect(layout.scrollHeight).toBeGreaterThanOrEqual(layout.clientHeight);
		expect(layout.interactiveCount).toBe(await visibleEntries.count());
		expect(layout.measurementInteractiveCount).toBe(0);
	});

	test('starts closed on mobile, preserves manual show/hide through resize, and leaves field geometry unchanged', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/?devWorld=1&devSpeech=timeline');
		const timeline = page.locator('aside.recent-message-timeline');
		const show = page.getByRole('button', { name: 'Show Chatter' });
		await expect(timeline).toBeHidden();
		await expect(show).toBeVisible();
		await expect(show).toHaveAttribute('aria-keyshortcuts', 'C');
		await page.keyboard.press('c');
		await expect(timeline).toBeVisible();
		await page.setViewportSize({ width: 1200, height: 900 });
		await expect(timeline).toBeVisible();
		await page.setViewportSize({ width: 390, height: 844 });
		await expect(timeline).toBeVisible();
		await expect.poll(() => page.locator('.field-area').evaluate((element) => element.getBoundingClientRect().width)).toBe(374);
		await page.keyboard.press('c');
		await expect(timeline).toBeHidden();

		const before = await page.evaluate(() => ({
			field: document.querySelector<HTMLElement>('.field-area')!.getBoundingClientRect().toJSON(),
			scene: getComputedStyle(document.querySelector<HTMLElement>('.field-scene')!).transform,
			participants: [...document.querySelectorAll<HTMLElement>('.participant')].map((participant) => participant.getBoundingClientRect().toJSON())
		}));
		await show.click();
		await expect(timeline).toBeVisible();
		await expect(page.getByRole('button', { name: 'Hide Chatter' })).toBeVisible();
		await page.getByRole('button', { name: 'Hide Chatter' }).click();
		await expect(timeline).toBeHidden();
		const afterMobileHide = await page.evaluate(() => ({
			field: document.querySelector<HTMLElement>('.field-area')!.getBoundingClientRect().toJSON(),
			scene: getComputedStyle(document.querySelector<HTMLElement>('.field-scene')!).transform,
			participants: [...document.querySelectorAll<HTMLElement>('.participant')].map((participant) => participant.getBoundingClientRect().toJSON())
		}));
		expect(afterMobileHide.field).toEqual(before.field);
		expect(afterMobileHide.scene).toBe(before.scene);
		expect(afterMobileHide.participants).toEqual(before.participants);
		await page.setViewportSize({ width: 1200, height: 900 });
		await expect(timeline).toBeHidden();
		await expect(show).toBeVisible();
		await show.click();
		await expect(timeline).toBeVisible();

		await page.setViewportSize({ width: 390, height: 844 });
		await expect(timeline).toBeVisible();
	});

	test('uses the prototype park background beneath the field grid', async ({ page }) => {
		await openDevWorld(page);

		await expect(page.locator('.field-sun')).toHaveCount(0);
		const fieldGrid = page.locator('.field-grid');
		const background = await fieldGrid.evaluate((element) => {
			const style = getComputedStyle(element);
			const scene = document.querySelector<HTMLElement>('.field-scene');
			if (!scene) throw new Error('Expected the field scene to be rendered.');
			const sceneRect = scene.getBoundingClientRect();
			const boundaryStyle = getComputedStyle(element, '::after');
			return {
				image: style.backgroundImage,
				size: style.backgroundSize,
				sceneRatio: sceneRect.width / sceneRect.height,
				boundaryBorder: boundaryStyle.borderTopWidth,
				boundaryShadow: boundaryStyle.boxShadow
			};
		});

		expect(background.image).toContain('prototype-urban-park.png');
		expect(background.image).not.toContain('repeating-conic-gradient');
		expect(background.size).toContain('76px 76px');
		expect(background.size).toContain('100% 100%');
		expect(background.sceneRatio).toBeCloseTo(2, 5);
		expect(background.boundaryBorder).toBe('2px');
		expect(background.boundaryShadow).toContain('inset');
	});

		test('selects and presents character 020 from the catalog', async ({ page }) => {
		await page.goto('/?devWorld=1&devCharacter=020');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await expect(page.getByLabel('Select sandbox character')).toHaveValue('020');

		const self = page.locator('.participant').first();
		await expect(self.locator('img')).toHaveAttribute('src', /characters\/020\.webp$/);
		await openProfile(page, 'アミナ');
		await expectProfile(page, {
			name: 'アミナ',
			picture: '020.webp',
			about: '静かな場所ではよく笑う。'
		});
	});

	test('renders deterministic normal and merged speech tails in the DEV fixture', async ({ page }) => {
		await page.goto('/?devWorld=1&devSpeech=merged2');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await expect(page.locator('.bubble-normal')).toHaveCount(1);
		await expect(page.locator('.bubble-merged')).toHaveCount(1);
		await expect(page.locator('.bubble-merged')).toHaveAttribute('data-merged-members', '2');
		await expect(page.locator('.bubble-merged small')).toHaveCount(0);

		const tailState = await page.locator('.tail-layer').evaluate((layer) => {
			const polygons = [...layer.querySelectorAll('polygon')];
			const outlines = [...layer.querySelectorAll('path')];
			const bubbles = [...document.querySelectorAll<HTMLElement>('.bubble')];
			const participants = [...document.querySelectorAll<HTMLElement>('.participant')];
			const fieldArea = document.querySelector<HTMLElement>('.field-area');
			const fieldScene = document.querySelector<HTMLElement>('.field-scene');
			if (!fieldArea || !fieldScene) throw new Error('Missing field geometry');
			const cellSize = Number.parseFloat(getComputedStyle(fieldScene).getPropertyValue('--cell-size'));
			const cameraTransform = getComputedStyle(fieldScene).transform;
			const cameraY = cameraTransform === 'none' ? 0 : -Number.parseFloat(cameraTransform.split(',')[5]);
			const expectedCellY: Record<string, number> = {
				['a'.repeat(64)]: 2,
				['b'.repeat(64)]: 2,
				['c'.repeat(64)]: 2
			};
			const mergedParticipantIds = new Set(['b', 'c'].map((prefix) => prefix.repeat(64)));
			return {
				polygonCount: polygons.length,
				outlineCount: outlines.length,
				lineCount: layer.querySelectorAll('line').length,
				polygonStyles: polygons.map((polygon) => {
					const tone = [...polygon.classList].find((className) => className.startsWith('tail-'))?.slice(5);
					const bubble = bubbles.find((candidate) => candidate.classList.contains(`bubble-${tone}`));
					if (!bubble) throw new Error(`Missing bubble for tone ${tone ?? 'unknown'}`);
					const bubbleStyle = getComputedStyle(bubble);
					return {
						fill: getComputedStyle(polygon).fill,
						background: bubbleStyle.backgroundColor,
						maskBackground: mergedParticipantIds.has(polygon.dataset.tailParticipantId ?? '')
							? getComputedStyle(bubble.querySelector<HTMLElement>(`[data-tail-participant-id="${polygon.dataset.tailParticipantId}"]`)!).backgroundColor
							: getComputedStyle(bubble, '::after').backgroundColor,
						maskWidth: mergedParticipantIds.has(polygon.dataset.tailParticipantId ?? '')
							? getComputedStyle(bubble.querySelector<HTMLElement>(`[data-tail-participant-id="${polygon.dataset.tailParticipantId}"]`)!).width
							: getComputedStyle(bubble, '::after').width,
						maskHeight: mergedParticipantIds.has(polygon.dataset.tailParticipantId ?? '')
							? getComputedStyle(bubble.querySelector<HTMLElement>(`[data-tail-participant-id="${polygon.dataset.tailParticipantId}"]`)!).height
							: getComputedStyle(bubble, '::after').height,
						borderRadius: bubbleStyle.borderRadius,
						borderColor: bubbleStyle.borderTopColor,
						outlineColor: getComputedStyle(document.querySelector<SVGPathElement>(`path[data-tail-participant-id="${polygon.dataset.tailParticipantId}"]`)!).stroke,
						target: (() => {
							const point = polygon.points.getItem(polygon.points.numberOfItems - 1);
							return { x: point.x, y: point.y };
						})(),
						participantCenterX: (() => {
							const participant = participants.find((candidate) => candidate.dataset.participantId === polygon.dataset.tailParticipantId);
							if (!participant) return null;
							const rect = participant.getBoundingClientRect();
							return rect.left + rect.width / 2;
						})(),
						cellY: expectedCellY[polygon.dataset.tailParticipantId ?? ''] ?? null,
						fieldTop: fieldArea.getBoundingClientRect().top,
						cellSize,
						cameraY
					};
				}),
				outlineStyles: outlines.map((outline) => {
					const style = getComputedStyle(outline);
					return { fill: style.fill, strokeDasharray: style.strokeDasharray, opacity: style.opacity };
				})
			};
		});

		expect(tailState).toMatchObject({ polygonCount: 3, outlineCount: 3, lineCount: 0 });
		expect(tailState.polygonStyles).toEqual(tailState.polygonStyles.map((style) => ({
			...style,
			fill: style.background,
			maskBackground: style.background
		})));
		expect(tailState.polygonStyles.map((style) => style.maskWidth)).toEqual(['11px', '9px', '9px']);
		expect(tailState.polygonStyles.every((style) => style.maskHeight === '3px')).toBe(true);
		expect(tailState.polygonStyles.every((style) => style.borderRadius.split(' ').length <= 2)).toBe(true);
		expect(tailState.polygonStyles.every((style) => style.borderColor === style.outlineColor)).toBe(true);
		expect(tailState.polygonStyles.every((style) => style.cellY !== null)).toBe(true);
		expect(tailState.polygonStyles.every((style) => Math.abs(style.target.y - (style.fieldTop + style.cellY * style.cellSize - style.cameraY - 4)) < 0.01)).toBe(true);
		expect(tailState.polygonStyles.every((style) => style.participantCenterX !== null && Math.abs(style.target.x - style.participantCenterX) < 0.01)).toBe(true);
		expect(tailState.outlineStyles).toEqual([
			{ fill: 'none', strokeDasharray: 'none', opacity: '1' },
			{ fill: 'none', strokeDasharray: 'none', opacity: '1' },
			{ fill: 'none', strokeDasharray: 'none', opacity: '1' }
		]);
		expect(await page.locator('.bubble-normal').evaluate((bubble) => getComputedStyle(bubble).borderRadius)).toBe('18px');
		expect(await page.locator('.bubble-merged').evaluate((bubble) => getComputedStyle(bubble).borderRadius)).toBe('18px');
	});

	test('renders burst and cloud surfaces with outline-continuous special tails', async ({ page }) => {
		await page.goto('/?devWorld=1&devSpeech=types');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await expect(page.locator('.bubble[data-speech-type="normal"]')).toHaveCount(1);
		await expect(page.locator('.bubble-normal[data-speech-type="shout"]')).toHaveCount(1);
		await expect(page.locator('.bubble-normal[data-speech-type="monologue"]')).toHaveCount(1);
		await expect(page.locator('.bubble-merged[data-speech-type="shout"]')).toHaveCount(1);
		await expect(page.locator('.bubble-merged[data-speech-type="monologue"]')).toHaveCount(1);
		await expect(page.locator('.bubble-normal[data-speech-type="shout"] .bubble-surface')).toHaveCount(1);
		await expect(page.locator('.bubble-normal[data-speech-type="monologue"] .bubble-surface')).toHaveCount(1);
		await expect(page.locator('.bubble[data-speech-type]:not([data-speech-type="normal"]) .bubble-tail-connection')).toHaveCount(0);
		await expect(page.locator('.bubble[data-speech-type="normal"] .bubble-surface')).toHaveCount(0);

		const surfaces = await page.locator('.bubble-surface').evaluateAll((elements) => elements.map((surface) => {
			const bubble = surface.closest<HTMLElement>('.bubble');
			const fill = surface.querySelector<SVGPathElement>('.bubble-surface-fill');
			const outline = surface.querySelector<SVGPathElement>('.bubble-surface-outline');
			if (!bubble || !fill || !outline) throw new Error('Expected separated speech fill and outline paths.');
			const colorContext = document.createElement('canvas').getContext('2d');
			if (!colorContext) throw new Error('Expected a 2D color context.');
			const resolveColor = (value: string) => {
				colorContext.fillStyle = value;
				return colorContext.fillStyle;
			};
			const bubbleRect = bubble.getBoundingClientRect();
			const surfaceRect = surface.getBoundingClientRect();
			const pathBounds = fill.getBBox();
			const visualBounds = (surface.dataset.visualBounds ?? '').split(',').map(Number);
			if (visualBounds.length !== 4 || visualBounds.some((value) => !Number.isFinite(value))) {
				throw new Error('Expected finite special speech visual bounds.');
			}
			const toneBackground = resolveColor(getComputedStyle(bubble).getPropertyValue('--tone-background').trim());
			const toneOutline = resolveColor(getComputedStyle(bubble).getPropertyValue('--tone-outline').trim());
			return {
				type: bubble.dataset.speechType,
				d: fill.getAttribute('d'),
				fill: resolveColor(getComputedStyle(fill).fill),
				stroke: resolveColor(getComputedStyle(outline).stroke),
				strokeWidth: getComputedStyle(outline).strokeWidth,
				toneBackground,
				toneOutline,
				bubbleRect: bubbleRect.toJSON(),
				surfaceRect: surfaceRect.toJSON(),
				pathBox: { x: pathBounds.x, y: pathBounds.y, width: pathBounds.width, height: pathBounds.height },
				visualBounds: { x: visualBounds[0], y: visualBounds[1], width: visualBounds[2], height: visualBounds[3] }
			};
		}));

		const shouts = surfaces.filter((surface) => surface.type === 'shout');
		const monologues = surfaces.filter((surface) => surface.type === 'monologue');
		expect(shouts).toHaveLength(2);
		expect(monologues).toHaveLength(2);
		expect(shouts.every((surface) => (surface.d?.match(/\bL/g)?.length ?? 0) >= 20 && !surface.d?.includes('Q'))).toBe(true);
		expect(monologues.every((surface) => (surface.d?.match(/\bC/g)?.length ?? 0) >= 7 && !surface.d?.includes('L'))).toBe(true);

		const stacking = await page.locator('.bubble-layer').evaluate(() => {
			const bubbles = [...document.querySelectorAll<HTMLElement>('.bubble')];
			const rectsOverlap = (a: DOMRect, b: DOMRect) =>
				a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
			const shoutBubbles = bubbles.filter((bubble) => bubble.dataset.speechType === 'shout');
			const opponents = bubbles.filter((bubble) => bubble.dataset.speechType !== 'shout');
			return {
				shoutZIndexes: shoutBubbles.map((bubble) => getComputedStyle(bubble).zIndex),
				normalZIndexes: opponents.filter((bubble) => bubble.dataset.speechType === 'normal').map((bubble) => getComputedStyle(bubble).zIndex),
				monologueZIndexes: opponents.filter((bubble) => bubble.dataset.speechType === 'monologue').map((bubble) => getComputedStyle(bubble).zIndex),
				overlaps: shoutBubbles.flatMap((shout) => {
					const surface = shout.querySelector<SVGSVGElement>('.bubble-surface');
					if (!surface) throw new Error('Expected a shout surface.');
					const surfaceRect = surface.getBoundingClientRect();
					return opponents.filter((opponent) => rectsOverlap(surfaceRect, opponent.getBoundingClientRect())).map((opponent) => opponent.dataset.speechType);
				})
			};
		});
		expect(stacking.shoutZIndexes.every((zIndex) => zIndex === '3')).toBe(true);
		expect(stacking.normalZIndexes.every((zIndex) => zIndex === 'auto')).toBe(true);
		expect(stacking.monologueZIndexes.every((zIndex) => zIndex === 'auto')).toBe(true);
		expect(stacking.overlaps.length).toBeGreaterThan(0);
		expect(stacking.overlaps.some((speechType) => speechType === 'monologue')).toBe(true);
		for (const surface of surfaces) {
			expect(surface.fill).toBe(surface.toneBackground);
			expect(surface.stroke).toBe(surface.toneOutline);
			expect(surface.strokeWidth).toBe('1px');
			expect(surface.surfaceRect.left - surface.bubbleRect.left).toBeCloseTo(surface.visualBounds.x, 1);
			expect(surface.surfaceRect.top - surface.bubbleRect.top).toBeCloseTo(surface.visualBounds.y, 1);
			expect(surface.surfaceRect.width).toBeCloseTo(surface.visualBounds.width, 1);
			expect(surface.surfaceRect.height).toBeCloseTo(surface.visualBounds.height, 1);
			expect(surface.pathBox.x).toBeGreaterThanOrEqual(surface.visualBounds.x);
			expect(surface.pathBox.y).toBeGreaterThanOrEqual(surface.visualBounds.y);
			expect(surface.pathBox.x + surface.pathBox.width).toBeLessThanOrEqual(surface.visualBounds.x + surface.visualBounds.width);
			expect(surface.pathBox.y + surface.pathBox.height).toBeLessThanOrEqual(surface.visualBounds.y + surface.visualBounds.height);
			expect(
				surface.pathBox.x < 0 ||
				surface.pathBox.y < 0 ||
				surface.pathBox.x + surface.pathBox.width > surface.bubbleRect.width ||
				surface.pathBox.y + surface.pathBox.height > surface.bubbleRect.height
			).toBe(true);
		}
		expect(await page.locator('.tail-layer polygon')).toHaveCount(7);
		expect(await page.locator('.tail-layer path')).toHaveCount(7);

		const tailUnions = await page.locator('.bubble-layer').evaluate(() => {
			const bubbles = [...document.querySelectorAll<HTMLElement>('.bubble')];
			const specialBubbles = bubbles.filter((bubble) => bubble.dataset.speechType !== 'normal');
			const screenPoints = (element: SVGGraphicsElement, points: readonly DOMPoint[]) => {
				const matrix = element.getScreenCTM();
				if (!matrix) throw new Error('Expected an SVG transform.');
				return points.map((point) => {
					const transformed = point.matrixTransform(matrix);
					return { x: transformed.x, y: transformed.y };
				});
			};

			return specialBubbles.flatMap((bubble) => {
				const surface = bubble.querySelector<SVGSVGElement>('.bubble-surface');
				const fill = surface?.querySelector<SVGPathElement>('.bubble-surface-fill');
				const outline = surface?.querySelector<SVGPathElement>('.bubble-surface-outline');
				const mask = surface?.querySelector<SVGMaskElement>('mask');
				if (!surface || !fill || !outline || !mask) throw new Error('Expected a masked special speech surface.');
				const content = bubble.querySelector<HTMLElement>('.bubble-content');
				const contentRect = content?.getBoundingClientRect();
				const inverseSurfaceMatrix = fill.getScreenCTM()?.inverse();
				if (bubble.dataset.speechType === 'monologue' && (!contentRect || !inverseSurfaceMatrix)) {
					throw new Error('Expected monologue content geometry.');
				}
				const contentSafePointsInside = bubble.dataset.speechType === 'monologue' && contentRect && inverseSurfaceMatrix
					? [
						{ x: contentRect.left + Math.min(4, contentRect.width / 4), y: contentRect.top + Math.min(4, contentRect.height / 4) },
						{ x: contentRect.right - Math.min(4, contentRect.width / 4), y: contentRect.top + Math.min(4, contentRect.height / 4) },
						{ x: contentRect.left + Math.min(4, contentRect.width / 4), y: contentRect.bottom - Math.min(4, contentRect.height / 4) },
						{ x: contentRect.right - Math.min(4, contentRect.width / 4), y: contentRect.bottom - Math.min(4, contentRect.height / 4) }
					].map((point) => fill.isPointInFill(new DOMPoint(point.x, point.y).matrixTransform(inverseSurfaceMatrix)))
					: [];
				return [...mask.querySelectorAll<SVGPolygonElement>('polygon[data-tail-opening]')].map((opening) => {
					const participantId = opening.dataset.tailOpening;
					if (!participantId) throw new Error('Expected a tail opening participant id.');
					const tail = document.querySelector<SVGPolygonElement>(`.tail-layer polygon[data-tail-participant-id="${participantId}"]`);
					const tailOutline = document.querySelector<SVGPathElement>(`.tail-layer path[data-tail-participant-id="${participantId}"]`);
					if (!tail || !tailOutline) throw new Error('Expected fill and outline for every special tail connection.');
					const openingPoints = screenPoints(opening, [opening.points.getItem(0), opening.points.getItem(1)]);
					const tailPoints = screenPoints(tail, [tail.points.getItem(0), tail.points.getItem(1)]);
					const outlinePoints = screenPoints(tailOutline, [
						tailOutline.getPointAtLength(0),
						tailOutline.getPointAtLength(tailOutline.getTotalLength())
					]);
					const openingMidpoint = new DOMPoint(
						(opening.points.getItem(0).x + opening.points.getItem(1).x) / 2,
						(opening.points.getItem(0).y + opening.points.getItem(1).y) / 2
					);
					return {
						speechType: bubble.dataset.speechType,
						participantId,
						openingMatchesOutlineMask: outline.getAttribute('mask') === `url(#${mask.id})`,
						openingFill: getComputedStyle(opening).fill,
						openingInsideBody: fill.isPointInFill(openingMidpoint),
						contentSafePointsInside,
						openingPoints,
						tailPoints,
						outlinePoints,
						bodyStrokeWidth: getComputedStyle(outline).strokeWidth,
						tailStrokeWidth: getComputedStyle(tailOutline).strokeWidth
					};
				});
			});
		});

		expect(tailUnions).toHaveLength(6);
		for (const union of tailUnions) {
			expect(union.openingMatchesOutlineMask).toBe(true);
			expect(union.openingFill).toBe('rgb(0, 0, 0)');
			expect(union.openingInsideBody).toBe(true);
			if (union.speechType === 'monologue') expect(union.contentSafePointsInside.every(Boolean)).toBe(true);
			expect(union.bodyStrokeWidth).toBe(union.tailStrokeWidth);
			for (const [index, openingPoint] of union.openingPoints.entries()) {
				expect(Math.hypot(openingPoint.x - union.tailPoints[index].x, openingPoint.y - union.tailPoints[index].y)).toBeLessThan(1);
				expect(Math.hypot(openingPoint.x - union.outlinePoints[index].x, openingPoint.y - union.outlinePoints[index].y)).toBeLessThan(1);
			}
		}

		const normalSeam = await page.locator('.bubble[data-speech-type="normal"]').evaluate((bubble) => {
			const style = getComputedStyle(bubble, '::after');
			return { height: style.height, bottom: style.bottom };
		});
		expect(normalSeam).toEqual({ height: '3px', bottom: '-1px' });
	});

	test('keeps long merged shout body placement independent from decorative overflow', async ({ page }) => {
		await expectNoConsoleProblems(page, async () => {
			await page.goto('/?devWorld=1&devSpeech=merged2-shout-long');
			await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
			await expect(page.locator('.bubble-merged[data-speech-type="shout"]')).toHaveCount(1);
			await expect(page.locator('.bubble-merged[data-speech-type="shout"] .bubble-surface')).toBeVisible();
		});

		const state = await page.locator('.bubble-merged[data-speech-type="shout"]').evaluate((bubble) => {
			const surface = bubble.querySelector<SVGSVGElement>('.bubble-surface');
			const fill = surface?.querySelector<SVGPathElement>('.bubble-surface-fill');
			if (!surface || !fill) throw new Error('Expected a shout surface.');
			const bodyRect = bubble.getBoundingClientRect();
			const surfaceRect = surface.getBoundingClientRect();
			const pathBounds = fill.getBBox();
			return {
				body: { left: bodyRect.left, top: bodyRect.top, width: bodyRect.width, height: bodyRect.height },
				surface: { left: surfaceRect.left, top: surfaceRect.top, width: surfaceRect.width, height: surfaceRect.height },
				path: { x: pathBounds.x, y: pathBounds.y, width: pathBounds.width, height: pathBounds.height }
			};
		});
		expect(state.body.width).toBeGreaterThan(0);
		expect(state.body.height).toBeGreaterThan(0);
		expect(state.surface.width).toBeGreaterThan(state.body.width);
		expect(state.surface.height).toBeGreaterThan(state.body.height);
		expect(state.surface.left).toBeLessThan(state.body.left);
		expect(state.surface.top).toBeLessThan(state.body.top);
		expect(state.path.x).toBeLessThan(0);
		expect(state.path.y).toBeLessThan(0);
	});

	test('remeasures mounted bubble bodies after height-only viewport resize', async ({ page }) => {
		for (const speechType of ['shout', 'monologue'] as const) {
			await page.setViewportSize({ width: 1440, height: 1000 });
			await expectNoConsoleProblems(page, async () => {
				await page.goto(`/?devWorld=1&devSpeech=merged2-${speechType}-long`);
				await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
				await expect(page.locator(`.bubble-merged[data-speech-type="${speechType}"]`)).toHaveCount(1);
			});
			const bubble = page.locator(`.bubble-merged[data-speech-type="${speechType}"]`);
			const measure = () => bubble.evaluate((element) => {
				const content = element.querySelector<HTMLElement>('.bubble-content');
				const surface = element.querySelector<SVGSVGElement>('.bubble-surface');
				if (!content || !surface) throw new Error('Expected a special bubble body and surface.');
				const bodyRect = element.getBoundingClientRect();
				const surfaceRect = surface.getBoundingClientRect();
				const visualBounds = (surface.dataset.visualBounds ?? '').split(',').map(Number);
				const contentStyle = getComputedStyle(content);
				const ellipsis = element.querySelector<HTMLElement>('.bubble-ellipsis');
				const ellipsisRect = ellipsis?.getBoundingClientRect();
				return {
					bodyWidth: bodyRect.width,
					bodyHeight: bodyRect.height,
					surfaceWidth: surfaceRect.width,
					surfaceHeight: surfaceRect.height,
					visualWidth: visualBounds[2],
					visualHeight: visualBounds[3],
					clientHeight: content.clientHeight,
					scrollHeight: content.scrollHeight,
					lineHeight: Number.parseFloat(contentStyle.lineHeight),
					ellipsisVisible: Boolean(ellipsisRect && ellipsisRect.width > 0 && ellipsisRect.height > 0)
				};
			});

			await expect.poll(async () => (await measure()).surfaceHeight).toBeGreaterThan(178);
			const before = await measure();
			expect(before.bodyHeight).toBeGreaterThan(100);
			expect(before.surfaceHeight).toBeGreaterThan(before.bodyHeight);
			expect(before.visualHeight).toBeGreaterThan(before.bodyHeight);
			expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
			expect(before.clientHeight).toBeLessThanOrEqual(before.lineHeight * 5 + 1);
			expect(before.ellipsisVisible).toBe(true);

			await expectNoConsoleProblems(page, async () => {
				await page.setViewportSize({ width: 1440, height: 920 });
				await expect.poll(async () => {
					const state = await measure();
					return state.visualHeight;
				}).toBeGreaterThan(before.bodyHeight);
			});
			const after = await measure();
			expect(after.bodyWidth).toBeCloseTo(before.bodyWidth, 1);
			expect(after.bodyHeight).toBeCloseTo(before.bodyHeight, 1);
			expect(after.surfaceWidth).toBeGreaterThan(after.bodyWidth);
			expect(after.surfaceHeight).toBeGreaterThan(after.bodyHeight);
			expect(after.visualWidth).toBeGreaterThan(after.bodyWidth);
			expect(after.visualHeight).toBeGreaterThan(after.bodyHeight);
			expect(after.scrollHeight).toBeGreaterThan(after.clientHeight);
			expect(after.clientHeight).toBeLessThanOrEqual(after.lineHeight * 5 + 1);
			expect(after.ellipsisVisible).toBe(true);
		}

		await page.setViewportSize({ width: 1440, height: 1000 });
		await expectNoConsoleProblems(page, async () => {
			await page.goto('/?devWorld=1&devSpeech=types');
			await expect(page.locator('.bubble[data-speech-type="normal"]')).toHaveCount(1);
		});
		const normalBubble = page.locator('.bubble[data-speech-type="normal"]');
		const normalBefore = await normalBubble.evaluate((element) => {
			const rect = element.getBoundingClientRect();
			return { width: rect.width, height: rect.height };
		});
		await expectNoConsoleProblems(page, async () => {
			await page.setViewportSize({ width: 1440, height: 920 });
			await expect.poll(async () => (await normalBubble.boundingBox())?.height ?? 0).toBeGreaterThan(0);
		});
		const normalAfter = await normalBubble.evaluate((element) => {
			const rect = element.getBoundingClientRect();
			const seam = getComputedStyle(element, '::after');
			return { width: rect.width, height: rect.height, seamHeight: seam.height, seamBottom: seam.bottom };
		});
		expect(normalAfter.width).toBeCloseTo(normalBefore.width, 1);
		expect(normalAfter.height).toBeCloseTo(normalBefore.height, 1);
		expect(normalAfter.seamHeight).toBe('3px');
		expect(normalAfter.seamBottom).toBe('-1px');
	});

	for (const speechType of ['shout', 'monologue'] as const) {
		test(`keeps five-line clamping, dynamic size, and safe bounds for ${speechType} bubbles`, async ({ page }) => {
			await page.setViewportSize({ width: 320, height: 844 });
			await page.goto(`/?devWorld=1&devSpeech=merged2-${speechType}-long`);
			await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
			const bubble = page.locator(`.bubble-merged[data-speech-type="${speechType}"]`);
			await expect(bubble).toHaveCount(1);
			const state = await bubble.evaluate((element) => {
				const content = element.querySelector<HTMLElement>('.bubble-content');
				const surface = element.querySelector<SVGSVGElement>('.bubble-surface');
				if (!content || !surface) throw new Error('Expected special bubble content and surface.');
				const contentStyle = getComputedStyle(content);
				const rect = element.getBoundingClientRect();
				const surfaceRect = surface.getBoundingClientRect();
				return {
					left: rect.left,
					right: rect.right,
					width: rect.width,
					height: rect.height,
					clientHeight: content.clientHeight,
					scrollHeight: content.scrollHeight,
					lineHeight: Number.parseFloat(contentStyle.lineHeight),
					surfaceLeft: surfaceRect.left,
					surfaceRight: surfaceRect.right,
					surfaceTop: surfaceRect.top,
					surfaceBottom: surfaceRect.bottom,
					ellipsisVisible: (() => {
						const indicator = element.querySelector<HTMLElement>('.bubble-ellipsis');
						if (!indicator) return false;
						const indicatorRect = indicator.getBoundingClientRect();
						return indicatorRect.width > 0 && indicatorRect.height > 0;
					})()
				};
			});
			expect(state.left).toBeGreaterThanOrEqual(16);
			expect(state.right).toBeLessThanOrEqual(304);
			expect(state.width).toBeGreaterThan(0);
			expect(state.height).toBeGreaterThan(0);
			expect(state.scrollHeight).toBeGreaterThan(state.clientHeight);
			expect(state.clientHeight).toBeLessThanOrEqual(state.lineHeight * 5 + 1);
			if (speechType === 'monologue') {
				expect(state.surfaceLeft).toBeGreaterThanOrEqual(0);
				expect(state.surfaceRight).toBeLessThanOrEqual(320);
				expect(state.surfaceTop).toBeGreaterThanOrEqual(84);
				expect(state.surfaceBottom).toBeLessThanOrEqual(466);
			} else {
				expect(state.surfaceLeft < 0 || state.surfaceRight > 320 || state.surfaceTop < 84 || state.surfaceBottom > 466).toBe(true);
			}
			expect(state.ellipsisVisible).toBe(true);
		});
	}

	test('preserves explicit line breaks in normal and merged bubbles without clamping short content', async ({ page }) => {
		await page.goto('/?devWorld=1&devSpeech=linebreak');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();

		const bubbles = page.locator('.bubble');
		await expect(bubbles).toHaveCount(2);
		const state = await bubbles.evaluateAll((elements) => elements.map((element) => {
			const content = element.querySelector<HTMLElement>('.bubble-content');
			if (!content) throw new Error('Expected bubble content element.');
			const style = getComputedStyle(content);
			return {
				text: content.textContent,
				whiteSpace: style.whiteSpace,
				display: style.display,
				lineClamp: style.webkitLineClamp,
				overflow: style.overflow,
				lineHeight: Number.parseFloat(style.lineHeight),
				clientHeight: content.clientHeight,
				scrollHeight: content.scrollHeight,
				ellipsisCount: element.querySelectorAll('.bubble-ellipsis').length
			};
		}));

		expect(state.map((bubble) => bubble.text)).toEqual([
			'normal line 1\nnormal line 2\nnormal line 3',
			'merged line 1\nmerged line 2\nmerged line 3'
		]);
		expect(state.every((bubble) => bubble.whiteSpace === 'pre-line')).toBe(true);
		expect(state.every((bubble) => bubble.display === 'flow-root')).toBe(true);
		expect(state.every((bubble) => bubble.lineClamp === '5')).toBe(true);
		expect(state.every((bubble) => bubble.overflow === 'hidden')).toBe(true);
		expect(state.every((bubble) => bubble.scrollHeight === bubble.clientHeight)).toBe(true);
		expect(state.every((bubble) => Math.abs(bubble.clientHeight - bubble.lineHeight * 3) <= 1)).toBe(true);
		expect(state.every((bubble) => bubble.ellipsisCount === 0)).toBe(true);
		expect(state.every((bubble) => bubble.clientHeight > 0)).toBe(true);
	});

	for (const [query, expectedTexts] of [
		[
			'long',
			[
				'Normal bubble message that wraps repeatedly inside the speech bubble width. '.repeat(8).trim(),
				'Merged bubble message that wraps repeatedly inside the speech bubble width. '.repeat(8).trim()
			]
		],
		[
			'linebreak-overflow',
			[
				'normal line 1\nnormal line 2\nnormal line 3\nnormal line 4\nnormal line 5\nnormal line 6',
				'merged line 1\nmerged line 2\nmerged line 3\nmerged line 4\nmerged line 5\nmerged line 6'
			]
		]
	] as const) {
		test(`clamps ${query === 'long' ? 'wrapped long text' : 'explicit six-line text'} in normal and merged bubbles`, async ({ page }) => {
			await page.setViewportSize({ width: 390, height: 844 });
			await page.goto(`/?devWorld=1&devSpeech=${query}`);
			await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();

			const bubbles = page.locator('.bubble');
			await expect(bubbles).toHaveCount(2);
			const state = await bubbles.evaluateAll((elements) => elements.map((element) => {
				const content = element.querySelector<HTMLElement>('.bubble-content');
				if (!content) throw new Error('Expected bubble content element.');
				const style = getComputedStyle(content);
				const lineHeight = Number.parseFloat(style.lineHeight);
				return {
					text: content.textContent,
					display: style.display,
					lineClamp: style.webkitLineClamp,
					overflow: style.overflow,
					clientHeight: content.clientHeight,
					scrollHeight: content.scrollHeight,
					lineHeight,
					bubbleHeight: element.getBoundingClientRect().height,
					ellipsis: (() => {
						const indicator = element.querySelector<HTMLElement>('.bubble-ellipsis');
						if (!indicator) return null;
						const rect = indicator.getBoundingClientRect();
						return {
							text: indicator.textContent,
							ariaHidden: indicator.getAttribute('aria-hidden'),
							visible: rect.width > 0 && rect.height > 0 && getComputedStyle(indicator).visibility !== 'hidden'
						};
					})()
				};
			}));

			expect(state.map((bubble) => bubble.text)).toEqual(expectedTexts);
			expect(state.every((bubble) => bubble.display === 'flow-root')).toBe(true);
			expect(state.every((bubble) => bubble.lineClamp === '5')).toBe(true);
			expect(state.every((bubble) => bubble.overflow === 'hidden')).toBe(true);
			expect(state.every((bubble) => bubble.scrollHeight > bubble.clientHeight)).toBe(true);
			expect(state.every((bubble) => bubble.clientHeight <= bubble.lineHeight * 5 + 1)).toBe(true);
			expect(state.every((bubble) => bubble.bubbleHeight > 0)).toBe(true);
			expect(state.every((bubble) => bubble.ellipsis?.text === '…')).toBe(true);
			expect(state.every((bubble) => bubble.ellipsis?.ariaHidden === 'true')).toBe(true);
			expect(state.every((bubble) => bubble.ellipsis?.visible)).toBe(true);
		});
	}

	test('sizes normal bubbles by content up to the 240px safe maximum', async ({ page }) => {
		await page.goto('/?devWorld=1&devSpeech=normal-sizes');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();

		const bubbles = page.locator('.bubble-normal');
		await expect(bubbles).toHaveCount(3);
		const state = await bubbles.evaluateAll((elements) => elements.map((element) => {
			const rect = element.getBoundingClientRect();
			return { width: rect.width, height: rect.height, left: rect.left, right: rect.right };
		}));

		expect(state[0].width).toBeLessThan(state[1].width);
		expect(state[1].width).toBeLessThanOrEqual(state[2].width);
		expect(state[0].width).toBeLessThan(240);
		expect(state.every((bubble) => bubble.width <= 240.5)).toBe(true);
		expect(state.every((bubble) => bubble.left >= 16 && bubble.right <= 1264)).toBe(true);
	});

	test('grows merged bubbles by content while increasing the maximum with member count', async ({ page }) => {
		const fixtures = [
			{ query: 'merged2', longQuery: 'merged2-long', count: 2, maxWidth: 330, members: ['b', 'c'] },
			{ query: 'merged3', longQuery: 'merged3-long', count: 3, maxWidth: 345, members: ['b', 'c', 'd'] },
			{ query: 'merged4', longQuery: 'merged4-long', count: 4, maxWidth: 360, members: ['b', 'c', 'd', 'e'] }
		] as const;

		for (const fixture of fixtures) {
			await page.goto(`/?devWorld=1&devSpeech=${fixture.query}`);
			await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
			await expect(page.locator('.bubble-merged')).toHaveAttribute('data-merged-members', String(fixture.count));
			const short = await readMergedBubbleGeometry(page, fixture.members);

			await page.goto(`/?devWorld=1&devSpeech=${fixture.longQuery}`);
			await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
			const long = await readMergedBubbleGeometry(page, fixture.members);

			expect(short.width).toBeLessThan(fixture.maxWidth);
			expect(long.width).toBeGreaterThan(short.width);
			expect(long.width).toBeLessThanOrEqual(fixture.maxWidth + 0.5);
			expect(long.width).toBeLessThanOrEqual(360.5);
			expect(long.height).toBeGreaterThan(0);
		}
	});

	test('changes bubble height with rendered lines and keeps the five-line ceiling', async ({ page }) => {
		const fixtures = ['merged2', 'linebreak', 'linebreak-five', 'linebreak-overflow'] as const;
		const normalHeights: number[] = [];
		const mergedHeights: number[] = [];

		for (const query of fixtures) {
			await page.goto(`/?devWorld=1&devSpeech=${query}`);
			await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
			normalHeights.push(await page.locator('.bubble-normal').first().evaluate((element) => element.getBoundingClientRect().height));
			mergedHeights.push(await page.locator('.bubble-merged').first().evaluate((element) => element.getBoundingClientRect().height));
		}

		expect(normalHeights[0]).toBeLessThan(normalHeights[1]);
		expect(normalHeights[1]).toBeLessThan(normalHeights[2]);
		expect(Math.abs(normalHeights[3] - normalHeights[2])).toBeLessThanOrEqual(1);
		expect(mergedHeights[0]).toBeLessThan(mergedHeights[1]);
		expect(mergedHeights[1]).toBeLessThan(mergedHeights[2]);
		expect(Math.abs(mergedHeights[3] - mergedHeights[2])).toBeLessThanOrEqual(1);
	});

	test('does not add an ellipsis when both bubbles fit exactly five rendered lines', async ({ page }) => {
		await page.goto('/?devWorld=1&devSpeech=linebreak-five');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();

		const bubbles = page.locator('.bubble');
		await expect(bubbles).toHaveCount(2);
		const state = await bubbles.evaluateAll((elements) => elements.map((element) => {
			const content = element.querySelector<HTMLElement>('.bubble-content');
			if (!content) throw new Error('Expected bubble content element.');
			const style = getComputedStyle(content);
			const lineHeight = Number.parseFloat(style.lineHeight);
			return {
				text: content.textContent,
				clientHeight: content.clientHeight,
				scrollHeight: content.scrollHeight,
				lineHeight,
				ellipsisCount: element.querySelectorAll('.bubble-ellipsis').length
			};
		}));

		for (const bubble of state) {
			expect(bubble.text).toContain('line 5');
			expect(bubble.scrollHeight).toBe(bubble.clientHeight);
			expect(Math.abs(bubble.clientHeight - bubble.lineHeight * 5)).toBeLessThanOrEqual(1);
			expect(bubble.ellipsisCount).toBe(0);
		}
	});

	test('keeps similar wrapping information when the same content becomes merged', async ({ page }) => {
		await page.goto('/?devWorld=1&devSpeech=comparison');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await expect(page.locator('.bubble-normal[data-speech-type="shout"]')).toHaveCount(1);
		await expect(page.locator('.bubble-merged')).toHaveCount(1);

		const state = await page.locator('.bubble-layer').evaluate(() => {
			const normal = document.querySelector<HTMLElement>('.bubble-normal[data-speech-type="shout"] .bubble-content');
			const merged = document.querySelector<HTMLElement>('.bubble-merged .bubble-content');
			if (!normal || !merged) throw new Error('Expected comparison bubbles.');
			const normalStyle = getComputedStyle(normal);
			const mergedStyle = getComputedStyle(merged);
			return {
				normalText: normal.textContent,
				mergedText: merged.textContent,
				normalLines: Math.round(normal.clientHeight / Number.parseFloat(normalStyle.lineHeight)),
				mergedLines: Math.round(merged.clientHeight / Number.parseFloat(mergedStyle.lineHeight)),
				normalFontSize: Number.parseFloat(normalStyle.fontSize),
				mergedFontSize: Number.parseFloat(mergedStyle.fontSize),
				normalWidth: normal.parentElement?.getBoundingClientRect().width ?? 0,
				mergedWidth: merged.parentElement?.getBoundingClientRect().width ?? 0
			};
		});

		expect(state.normalText).toBe(state.mergedText);
		expect(state.mergedFontSize).toBeGreaterThan(state.normalFontSize);
		expect(state.mergedWidth).toBeGreaterThan(state.normalWidth);
		expect(Math.abs(state.mergedLines - state.normalLines)).toBeLessThanOrEqual(1);
	});

	test('keeps clamped bubbles and explicit ellipsis inside the safe bounds at 320px', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 844 });
		await page.goto('/?devWorld=1&devSpeech=linebreak-overflow');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();

		const bubbles = page.locator('.bubble-merged');
		await expect(bubbles).toHaveCount(1);
		const state = await bubbles.evaluateAll((elements) => elements.map((element) => {
			const content = element.querySelector<HTMLElement>('.bubble-content');
			const indicator = element.querySelector<HTMLElement>('.bubble-ellipsis');
			if (!content || !indicator) throw new Error('Expected clamped content and ellipsis.');
			const rect = element.getBoundingClientRect();
			const indicatorRect = indicator.getBoundingClientRect();
			const style = getComputedStyle(content);
			return {
				left: rect.left,
				right: rect.right,
				clientHeight: content.clientHeight,
				scrollHeight: content.scrollHeight,
				lineHeight: Number.parseFloat(style.lineHeight),
				indicatorVisible: indicatorRect.width > 0 && indicatorRect.height > 0
			};
		}));

		expect(state).toHaveLength(1);
		expect(state.every((bubble) => bubble.left >= 16 && bubble.right <= 304)).toBe(true);
		expect(state.every((bubble) => bubble.scrollHeight > bubble.clientHeight)).toBe(true);
		expect(state.every((bubble) => bubble.clientHeight <= bubble.lineHeight * 5 + 1)).toBe(true);
		expect(state.every((bubble) => bubble.indicatorVisible)).toBe(true);
	});

	test('renders the full speech showcase with eight colors and a merged bubble', async ({ page }) => {
		await page.goto('/?devWorld=1&devSpeech=1');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await expect(page.locator('.participant')).toHaveCount(8);
		await expect(page.locator('.bubble-normal')).toHaveCount(8);
		const mergedBubble = page.locator('.bubble-merged');
		await expect(mergedBubble).toHaveCount(1);
		await expect(mergedBubble).toHaveAttribute('data-merged-members', '2');
		await expect(mergedBubble.locator('.bubble-tail-connection')).toHaveCount(2);
		await expect(page.locator('.tail-layer polygon')).toHaveCount(10);
		await expect(page.locator('.tail-layer path')).toHaveCount(10);
		await expect(page.locator('.participant[data-self="true"] .participant-name')).toHaveCount(1);
		await expect(page.locator('.participant:not([data-self="true"]) .participant-name-self')).toHaveCount(0);
		await expect(page.locator('.participant[data-self="true"] .participant-name')).toHaveCSS('border-top-width', '2px');
		await expect(page.locator('.participant[data-self="true"] .participant-name')).toHaveCSS('font-weight', '800');

		const colorState = await page.locator('.bubble-layer').evaluate(() => {
			const participants = [...document.querySelectorAll<HTMLElement>('.participant')];
			const bubbles = [...document.querySelectorAll<HTMLElement>('.bubble-normal')];
			const colors = participants.map((participant) => {
				const avatar = participant.querySelector<HTMLElement>('.avatar');
				const participantId = participant.dataset.participantId;
				const bubble = bubbles.find((candidate) => candidate.dataset.bubbleParticipantId === participantId);
				const tail = document.querySelector<SVGPolygonElement>(`.tail-layer polygon[data-tail-participant-id="${participantId}"]`);
				const outline = document.querySelector<SVGPathElement>(`.tail-layer path[data-tail-participant-id="${participantId}"]`);
				if (!avatar || !bubble || !tail || !outline) throw new Error('Expected participant color elements');
				const tone = [...bubble.classList].find((className) => className.startsWith('tone-'))?.slice(5);
				return {
					avatarTone: [...avatar.classList].find((className) => className.startsWith('avatar-'))?.slice(7),
					bubbleTone: tone,
					bubbleBackground: getComputedStyle(bubble).backgroundColor,
					bubbleOutline: getComputedStyle(bubble).borderTopColor,
					tailFill: getComputedStyle(tail).fill,
					tailOutline: getComputedStyle(outline).stroke,
					connectionBackground: getComputedStyle(bubble, '::after').backgroundColor
				};
			});
			return colors;
		});

		expect(new Set(colorState.map((color) => color.avatarTone))).toEqual(new Set([
			'coral', 'lavender', 'mint', 'yellow', 'sky', 'peach', 'rose', 'blue'
		]));
		expect(colorState).toEqual(colorState.map((color) => ({
			...color,
			bubbleTone: color.avatarTone,
			tailFill: color.bubbleBackground,
			tailOutline: color.bubbleOutline,
			connectionBackground: color.bubbleBackground
		})));

		const mergedTailState = await mergedBubble.evaluate((bubble) => {
			const memberIds = [...bubble.querySelectorAll<HTMLElement>('.bubble-tail-connection')]
				.map((connection) => connection.dataset.tailParticipantId);
			return {
			memberIds,
			tailIds: [...document.querySelectorAll<SVGPolygonElement>('.tail-layer polygon')]
				.filter((tail) => memberIds.includes(tail.dataset.tailParticipantId))
				.map((tail) => tail.dataset.tailParticipantId),
			outlineIds: [...document.querySelectorAll<SVGPathElement>('.tail-layer path')]
				.filter((outline) => memberIds.includes(outline.dataset.tailParticipantId))
				.map((outline) => outline.dataset.tailParticipantId)
			};
		});
		expect(new Set(mergedTailState.memberIds).size).toBe(2);
		expect(new Set(mergedTailState.tailIds)).toEqual(new Set(mergedTailState.memberIds));
		expect(new Set(mergedTailState.outlineIds)).toEqual(new Set(mergedTailState.memberIds));
	});

	test('scales merged bubbles and distributes merged tail starts for 2, 3, and 4 members', async ({ page }) => {
		const fixtures = [
			{ query: 'merged2', count: 2, members: ['b', 'c'] },
			{ query: 'merged3', count: 3, members: ['b', 'c', 'd'] },
			{ query: 'merged4', count: 4, members: ['b', 'c', 'd', 'e'] }
		] as const;
		const geometries = [];

		for (const fixture of fixtures) {
			await page.goto(`/?devWorld=1&devSpeech=${fixture.query}`);
			await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
			await expect(page.locator('.bubble-merged')).toHaveAttribute('data-merged-members', String(fixture.count));
			await expect(page.locator('.bubble-merged small')).toHaveCount(0);

			const geometry = await readMergedBubbleGeometry(page, fixture.members);
			expect(geometry.memberCount).toBe(fixture.count);
			expect(geometry.tailStartXs).toHaveLength(fixture.count);
			expect(geometry.connectionMasks).toHaveLength(fixture.count);
			expect(geometry.tailOutlineCount).toBe(fixture.count + 1);
			expect(geometry.connectionMasks.every((mask) => mask.width === 9 && mask.height === 3)).toBe(true);
			expect(geometry.connectionMasks.every((mask) => mask.background === geometry.background)).toBe(true);
			expect(geometry.connectionMasks.map((mask) => mask.participantId).sort()).toEqual(fixture.members.map((prefix) => prefix.repeat(64)).sort());
			for (const [index, startX] of geometry.tailStartXs.entries()) {
				expect(Math.abs(startX - geometry.connectionMasks[index].centerX)).toBeLessThan(1);
			}
			expect(new Set(geometry.tailStartXs.map((x) => x.toFixed(3))).size).toBe(fixture.count);
			expect(Math.max(...geometry.tailStartXs) - Math.min(...geometry.tailStartXs)).toBeGreaterThan(40);
			geometries.push(geometry);
		}

		expect(geometries[1].width).toBeGreaterThan(geometries[0].width);
		expect(geometries[2].width).toBeGreaterThan(geometries[1].width);
		expect(geometries[1].height).toBeGreaterThan(geometries[0].height);
		expect(geometries[2].height).toBeGreaterThan(geometries[1].height);
		expect(geometries[1].fontSize).toBeGreaterThan(geometries[0].fontSize);
		expect(geometries[2].fontSize).toBeGreaterThan(geometries[1].fontSize);
		expect(geometries[1].paddingLeft).toBeGreaterThan(geometries[0].paddingLeft);
		expect(geometries[2].paddingLeft).toBeGreaterThan(geometries[1].paddingLeft);
		expect(geometries.every((geometry) => geometry.borderRadius === '18px')).toBe(true);
	});

	test('switches the self character through the sandbox selector', async ({ page }) => {
		await openDevWorld(page);

		const characterSelect = page.getByLabel('Select sandbox character');
		await characterSelect.selectOption('005');
		await expect(characterSelect).toHaveValue('005');

		const selectedLabel = (await characterSelect.locator('option:checked').textContent())?.trim() ?? '';
		const selectedName = selectedLabel.split(' — ')[1];
		expect(selectedName).toBeTruthy();

		const self = page.locator('.participant').first();
		await expect(self.locator('img')).toHaveAttribute('src', /characters\/005\.webp$/);
		await expect(self.locator('.participant-name')).toHaveText(selectedName ?? '');
	});

	test('uses a floating pointer joystick for mouse drag movement and removes cell movement affordances', async ({ page }) => {
		await openClockedDevWorld(page);
		await expect(page.locator('.field-movement-layer, .movement-cell, .movement-cell-chevron')).toHaveCount(0);

		const self = page.locator('.participant').first();
		const start = await fieldCellCenter(page, { x: 5, y: 5 });
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x + 8, start.y);
		await expect(page.locator('[data-pointer-joystick]')).toHaveCount(0);
		await page.mouse.move(start.x + 24, start.y);
		await expect(page.locator('[data-pointer-joystick="right"]')).toBeVisible();
		await expect(self).toHaveAttribute('data-position', '8,3');
		await page.clock.runFor(1_000);
		await expect(self).toHaveAttribute('data-position', '10,3');
		await page.mouse.up();
		await expect(page.locator('[data-pointer-joystick]')).toHaveCount(0);
		await page.clock.runFor(1_000);
		await expect(self).toHaveAttribute('data-position', '10,3');
	});

	test('moves one cell in each cardinal direction through the pointer path', async ({ page }) => {
		for (const [delta, expected] of [
			[{ x: 24, y: 0 }, '8,3'],
			[{ x: -24, y: 0 }, '6,3'],
			[{ x: 0, y: -24 }, '7,2'],
			[{ x: 0, y: 24 }, '7,4']
		] as const) {
			await openDevWorld(page);
			await dragJoystick(page, delta);
			await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', expected);
		}
	});

	test('moves one cell in each diagonal direction through the pointer path', async ({ page }) => {
		for (const [delta, expected] of [
			[{ x: 24, y: -24 }, '8,2'],
			[{ x: 24, y: 24 }, '8,4'],
			[{ x: -24, y: 24 }, '6,4'],
			[{ x: -24, y: -24 }, '6,2']
		] as const) {
			await openDevWorld(page);
			await dragJoystick(page, delta);
			await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', expected);
		}
	});

	test('continues diagonal pointer movement at the shared 500ms cadence', async ({ page }) => {
		await openClockedDevWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const start = await fieldCellCenter(page, { x: 5, y: 5 });
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x + 24, start.y - 24);
		await expect(page.locator('[data-pointer-joystick="up-right"]')).toBeVisible();
		await expect(self).toHaveAttribute('data-position', '8,2');
		await page.clock.runFor(500);
		await expect(self).toHaveAttribute('data-position', '9,1');
		await page.mouse.up();
		await page.clock.runFor(1_000);
		await expect(self).toHaveAttribute('data-position', '9,1');
	});

	test('accepts the touch PointerEvent path without changing the movement API', async ({ page }) => {
		await openDevWorld(page);
		const start = await fieldCellCenter(page, { x: 5, y: 5 });
		await page.locator('.field-area').evaluate((node, point) => {
			const init = { bubbles: true, pointerId: 17, pointerType: 'touch', isPrimary: true, button: 0 } as const;
			node.dispatchEvent(new PointerEvent('pointerdown', { ...init, clientX: point.x, clientY: point.y }));
			node.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: point.x + 24, clientY: point.y }));
			node.dispatchEvent(new PointerEvent('pointerup', { ...init, clientX: point.x + 24, clientY: point.y }));
		}, start);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '8,3');
		await expect(page.locator('[data-pointer-joystick]')).toHaveCount(0);
	});

	test('keeps tap selection separate from pointer movement and preserves participant trace menus', async ({ page }) => {
		await page.goto('/?devWorld=1&devTrace=lights');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await page.locator('[data-cell-position="8,4"]').click();
		await expect(page.getByRole('menu', { name: 'Cell actions' })).toHaveCount(0);

		const start = await fieldCellCenter(page, { x: 5, y: 5 });
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x + 24, start.y);
		await page.mouse.up();
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '8,3');

		await profileTrigger(page, '女の子').click();
		const menu = page.getByRole('menu', { name: 'Cell actions' });
		await expect(menu.getByRole('menuitem')).toHaveCount(2);
		await expect(menu.locator('[data-cell-action="movement"]')).toHaveCount(0);
		await expect(menu.locator('[data-cell-action="participant"]')).toHaveCount(1);
		await expect(menu.locator('[data-cell-action="trace"]')).toHaveCount(1);
	});

	test('does not render a field-external cell at the field edge', async ({ page }) => {
		await openDevWorld(page);

		const self = page.locator('.participant').first();
		for (let index = 0; index < 7; index += 1) await page.keyboard.press('ArrowLeft');
		await expect(self).toHaveAttribute('data-position', '0,3');
		const start = await fieldCellCenter(page, { x: 5, y: 5 });
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x - 24, start.y);
		await expect(page.locator('[data-pointer-joystick="left"]')).toBeVisible();
		await expect(self).toHaveAttribute('data-position', '0,3');
		await page.mouse.up();
	});

	test('does not move into an occupied cell through the pointer joystick', async ({ page }) => {
		await page.goto('/?devWorld=1&devSpeech=1');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();

		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '7,3');
		const start = await fieldCellCenter(page, { x: 5, y: 5 });
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x, start.y - 24);
		await expect(page.locator('[data-pointer-joystick="up"]')).toBeVisible();
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '7,3');
		await page.mouse.up();
	});

		test('allows a diagonal when only its orthogonal side cells are occupied', async ({ page }) => {
		await page.goto('/?devWorld=1&devSpeech=1');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();

		const self = page.locator('.participant[data-self="true"]');
		await expect(self).toHaveAttribute('data-position', '7,3');
		const start = await fieldCellCenter(page, { x: 5, y: 5 });
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x + 24, start.y - 24);
		await expect(page.locator('[data-pointer-joystick="up-right"]')).toBeVisible();
		await expect(self).toHaveAttribute('data-position', '8,2');
		await page.mouse.up();
	});

	test('blocks an occupied diagonal destination and a diagonal field edge', async ({ page }) => {
		await page.goto('/?devWorld=1&devSpeech=1');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		const self = page.locator('.participant[data-self="true"]');
		await expect(self).toHaveAttribute('data-position', '7,3');
		await page.keyboard.press('ArrowLeft');
		await expect(self).toHaveAttribute('data-position', '6,3');
		await dragJoystick(page, { x: 24, y: -24 });
		await expect(self).toHaveAttribute('data-position', '6,3');

		await page.goto('/?devWorld=1');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await expect(self).toHaveAttribute('data-position', '7,3');
		for (let index = 0; index < 7; index += 1) await page.keyboard.press('ArrowLeft');
		await expect(self).toHaveAttribute('data-position', '0,3');
		const start = await fieldCellCenter(page, { x: 5, y: 5 });
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x - 24, start.y - 24);
		await expect(page.locator('[data-pointer-joystick="up-left"]')).toBeVisible();
		await expect(self).toHaveAttribute('data-position', '0,3');
		await page.mouse.up();
	});

	test('keeps keyboard ownership during a pending pointer tap and safely takes over on drag', async ({ page }) => {
		await openClockedDevWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		await page.keyboard.down('ArrowRight');
		await expect(self).toHaveAttribute('data-position', '8,3');

		const start = await fieldCellCenter(page, { x: 5, y: 5 });
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.clock.runFor(500);
		await expect(self).toHaveAttribute('data-position', '9,3');
		await page.mouse.move(start.x, start.y - 24);
		await expect(page.locator('[data-pointer-joystick="up"]')).toBeVisible();
		await expect(self).toHaveAttribute('data-position', '9,2');
		await page.clock.runFor(500);
		await expect(self).toHaveAttribute('data-position', '9,1');
		await page.mouse.up();
		await page.clock.runFor(1_000);
		await expect(self).toHaveAttribute('data-position', '9,1');
		await page.keyboard.up('ArrowRight');
		await page.keyboard.press('ArrowLeft');
		await expect(self).toHaveAttribute('data-position', '8,1');
	});

	test('does not let keyboard input or keyup steal or stop pointer ownership', async ({ page }) => {
		await openClockedDevWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		await dragJoystick(page, { x: 24, y: 0 });
		await expect(self).toHaveAttribute('data-position', '8,3');

		const start = await fieldCellCenter(page, { x: 5, y: 5 });
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x + 24, start.y);
		await page.keyboard.down('ArrowLeft');
		await page.keyboard.up('ArrowLeft');
		await page.clock.runFor(500);
		await expect(self).toHaveAttribute('data-position', '10,3');
		await page.mouse.up();
	});

	test('updates pointer direction without an immediate request or timer restart', async ({ page }) => {
		await openClockedDevWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const start = await fieldCellCenter(page, { x: 5, y: 5 });
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x + 24, start.y);
		await expect(self).toHaveAttribute('data-position', '8,3');
		await page.clock.runFor(400);
		await page.mouse.move(start.x + 24, start.y - 24);
		await expect(page.locator('[data-pointer-joystick="up-right"]')).toBeVisible();
		await expect(self).toHaveAttribute('data-position', '8,3');
		await page.clock.runFor(100);
		await expect(self).toHaveAttribute('data-position', '9,2');
		await page.mouse.up();
	});

	test('continues one-cell movement on an explicit keyboard hold and stops on keyup', async ({ page }) => {
		await openClockedDevWorld(page);

		const self = page.locator('.participant').first();
		await page.keyboard.down('ArrowRight');
		await expect(self).toHaveAttribute('data-position', '8,3');
		await page.clock.runFor(1_000);
		await page.keyboard.up('ArrowRight');
		await expect(self).toHaveAttribute('data-position', '10,3');
		await page.clock.runFor(1_000);
		await expect(self).toHaveAttribute('data-position', '10,3');
	});

	test('moves in each direction with physical WASD keys', async ({ page }) => {
		await openDevWorld(page);

		const self = page.locator('.participant').first();
		for (const [key, expected] of [
			['w', '7,2'],
			['a', '6,2'],
			['s', '6,3'],
			['d', '7,3']
		] as const) {
			await page.keyboard.press(key);
			await expect(self).toHaveAttribute('data-position', expected);
		}
	});

	test('continues a held WASD movement at the existing two-per-second cadence', async ({ page }) => {
		await openClockedDevWorld(page);

		const self = page.locator('.participant').first();
		await page.keyboard.down('d');
		await expect(self).toHaveAttribute('data-position', '8,3');
		await page.clock.runFor(1_000);
		await page.keyboard.up('d');
		await expect(self).toHaveAttribute('data-position', '10,3');
		await page.clock.runFor(1_000);
		await expect(self).toHaveAttribute('data-position', '10,3');
	});

	test('does not turn WASD repeat events into direct movement requests', async ({ page }) => {
		await openDevWorld(page);

		const self = page.locator('.participant').first();
		await page.keyboard.down('d');
		await expect(self).toHaveAttribute('data-position', '8,3');
		await page.evaluate(() => {
			for (let index = 0; index < 10; index += 1) {
				window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', repeat: true, bubbles: true }));
			}
		});
		await expect(self).toHaveAttribute('data-position', '8,3');
		await page.keyboard.up('d');
	});

	test('does not leave a held movement running after window blur', async ({ page }) => {
		await openClockedDevWorld(page);

		const self = page.locator('.participant').first();
		await page.keyboard.down('ArrowRight');
		await expect(self).toHaveAttribute('data-position', '8,3');
		await page.evaluate(() => window.dispatchEvent(new Event('blur')));
		await page.clock.runFor(1_000);
		await page.keyboard.up('ArrowRight');
		await expect(self).toHaveAttribute('data-position', '8,3');
	});

	test('does not leave a held movement running after the page becomes hidden', async ({ page }) => {
		await openClockedDevWorld(page);

		const self = page.locator('.participant').first();
		await page.keyboard.down('ArrowRight');
		await expect(self).toHaveAttribute('data-position', '8,3');
		await page.evaluate(() => {
			Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
			document.dispatchEvent(new Event('visibilitychange'));
		});
		await page.clock.runFor(1_000);
		await page.keyboard.up('ArrowRight');
		await expect(self).toHaveAttribute('data-position', '8,3');
	});

	test('does not turn browser repeat events into direct movement requests', async ({ page }) => {
		await openDevWorld(page);

		const self = page.locator('.participant').first();
		await page.keyboard.down('ArrowRight');
		await expect(self).toHaveAttribute('data-position', '8,3');
		await page.evaluate(() => {
			for (let index = 0; index < 10; index += 1) {
				window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true, bubbles: true }));
			}
		});
		await expect(self).toHaveAttribute('data-position', '8,3');
		await page.keyboard.up('ArrowRight');
	});

	test('preserves native Arrow behavior for the DEV character select', async ({ page }) => {
		await openDevWorld(page);

		const self = page.locator('.participant').first();
		const characterSelect = page.getByLabel('Select sandbox character');
		await characterSelect.focus();
		await page.keyboard.press('ArrowDown');
		await expect(characterSelect).toHaveValue('002');
		await expect(self).toHaveAttribute('data-position', '7,3');
	});

	test('preserves native input behavior for WASD and N in the DEV character select', async ({ page }) => {
		await openDevWorld(page);

		const self = page.locator('.participant').first();
		const characterSelect = page.getByLabel('Select sandbox character');
		await characterSelect.focus();
		const before = await characterSelect.inputValue();
		for (const key of ['w', 'a', 's', 'd', 'n']) await page.keyboard.press(key);
		await expect(characterSelect).toHaveValue(before);
		await expect(self).toHaveAttribute('data-position', '7,3');
	});

	test('does not intercept WASD or N during composition or with modifiers', async ({ page }) => {
		await openDevWorld(page);

		const self = page.locator('.participant').first();
		await page.keyboard.press('Shift+d');
		await page.keyboard.press('Control+a');
		await page.keyboard.press('Alt+s');
		await page.keyboard.press('Meta+w');
		await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'd', code: 'KeyD', isComposing: true, bubbles: true
		})));
		await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'n', code: 'KeyN', isComposing: true, bubbles: true
		})));
		await expect(self).toHaveAttribute('data-position', '7,3');
	});

	test('opens a profile by pointer, restores it through history, and resumes movement after Back', async ({ page }) => {
		await openDevWorld(page);

		const self = page.locator('.participant').first();
		await openProfile(page, '女の子');
		await expectProfile(page, {
			name: '女の子',
			picture: '001.webp',
			about: '知らない場所でも、わりと平気そう。'
		});

		await page.keyboard.press('ArrowRight');
		await expect(self).toHaveAttribute('data-position', '7,3');

		await page.goBack();
		await expect(profileDialog(page)).toBeHidden();
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();

		await page.goForward();
		await expectProfile(page, {
			name: '女の子',
			picture: '001.webp',
			about: '知らない場所でも、わりと平気そう。'
		});

		await page.goBack();
		await expect(profileDialog(page)).toBeHidden();
		await page.keyboard.press('ArrowRight');
		await expect(self).toHaveAttribute('data-position', '8,3');
		await openProfile(page, '女の子');
		await expectProfile(page, {
			name: '女の子',
			picture: '001.webp',
			about: '知らない場所でも、わりと平気そう。'
		});
	});

	test('stops a held Arrow when a profile dialog opens', async ({ page }) => {
		await openClockedDevWorld(page);

		const self = page.locator('.participant').first();
		await page.keyboard.down('ArrowRight');
		await expect(self).toHaveAttribute('data-position', '8,3');
		await profileTrigger(page, '女の子').click();
		await expect(profileDialog(page)).toBeVisible();
		const positionWhenOpened = await self.getAttribute('data-position');
		await page.clock.runFor(1_000);
		await page.keyboard.up('ArrowRight');
		await expect(self).toHaveAttribute('data-position', positionWhenOpened ?? '');
	});

	test('opens a profile by keyboard', async ({ page }) => {
		await openDevWorld(page);

		await profileTrigger(page, '女の子').focus();
		await page.keyboard.press('Enter');
		await expect(profileDialog(page)).toBeVisible();
	});

	test('does not add a body pointer lock while a profile is open', async ({ page }) => {
		await openDevWorld(page);
		await openProfile(page, '女の子');

		expect(await page.evaluate(() => getComputedStyle(document.body).pointerEvents)).toBe('auto');
	});

	for (const closePath of ['close button', 'Escape', 'outside interaction'] as const) {
		test(`keeps profile history aligned and immediately reopens after ${closePath}`, async ({ page }) => {
			await openDevWorld(page);
			const self = page.locator('.participant').first();
			const triggerCenter = await profileTriggerCenter(page, '女の子');
			await openProfile(page, '女の子');

			if (closePath === 'close button') {
				await profileDialog(page).getByRole('button', { name: '閉じる' }).click();
			} else if (closePath === 'Escape') {
				await page.keyboard.press('Escape');
			} else {
				await page.locator('.profile-dialog-overlay').click({ position: { x: 4, y: 4 } });
			}

			await expect(profileDialog(page)).toBeHidden();
			await expect(profileTrigger(page, '女の子')).toBeFocused();
			await page.mouse.click(triggerCenter.x, triggerCenter.y);
			await expectProfile(page, {
				name: '女の子',
				picture: '001.webp',
				about: '知らない場所でも、わりと平気そう。'
			});
			if (closePath === 'close button') {
				await profileDialog(page).getByRole('button', { name: '閉じる' }).click();
				await expect(profileDialog(page)).toBeHidden();
				await page.mouse.click(triggerCenter.x, triggerCenter.y);
				await expect(profileDialog(page)).toBeVisible();
			}
			await page.goBack();
			await expect(profileDialog(page)).toBeHidden();
			await page.goForward();
			await expect(profileDialog(page)).toBeVisible();
			await page.goBack();
			await expect(profileDialog(page)).toBeHidden();
			await page.keyboard.press('ArrowRight');
			await expect(self).toHaveAttribute('data-position', '8,3');
		});
	}

	test('uses an Avatar fallback when a character image fails to load', async ({ page }) => {
		await page.route('**/characters/001.webp', (route) => route.fulfill({ status: 404 }));
		await openDevWorld(page);

		const trigger = profileTrigger(page, '女の子');
		await expect(trigger.locator('.avatar')).toHaveText('女');
		await trigger.click();
		await expect(profileDialog(page).locator('.profile-dialog-avatar')).toHaveText('女');
	});

	test('keeps a long profile usable on a mobile viewport', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 360 });
		await page.goto('/?devWorld=1&devCharacter=002');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await openProfile(page, '全裸中年男性');

		const dialog = profileDialog(page);
		const viewport = dialog.locator('.profile-dialog-scroll-viewport');
		await expect(viewport).toBeVisible();
		const scrollState = await viewport.evaluate((element) => ({
			scrollable: element.scrollHeight > element.clientHeight,
			initialTop: element.scrollTop
		}));
		expect(scrollState.scrollable).toBe(true);
		expect(scrollState.initialTop).toBe(0);
		await viewport.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
		expect(await viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

		const closeButton = dialog.getByRole('button', { name: '閉じる' });
		await expect(closeButton).toBeInViewport({ ratio: 1 });
		const closeBox = await closeButton.boundingBox();
		const viewportSize = page.viewportSize();
		expect(closeBox).not.toBeNull();
		expect(viewportSize).not.toBeNull();
		expect(closeBox!.x).toBeGreaterThanOrEqual(0);
		expect(closeBox!.y).toBeGreaterThanOrEqual(0);
		expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(viewportSize!.width);
		expect(closeBox!.y + closeBox!.height).toBeLessThanOrEqual(viewportSize!.height);
		await closeButton.click();
		await expect(dialog).toBeHidden();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	});

	test.describe('responsive field presentation', () => {
		for (const viewport of [
			{ name: 'mobile', width: 390, height: 844, sideMargin: '8px', fieldWidth: '374px', cell: '50px', avatar: '46px', worldWidth: '800px', worldHeight: '400px' },
			{ name: 'desktop', width: 1200, height: 900, sideMargin: '8px', fieldWidth: '1184px', cell: '76px', avatar: '72px', worldWidth: '1216px', worldHeight: '608px' }
		]) {
			test(`${viewport.name} uses the responsive cell and centered avatar`, async ({ page }) => {
				await page.setViewportSize({ width: viewport.width, height: viewport.height });
				await expectNoConsoleProblems(page, async () => {
					await openDevWorld(page);
					const scene = page.locator('.field-scene');
					const fieldArea = page.locator('.field-area');
					await expect(scene).toHaveCSS('width', viewport.worldWidth);
					await expect(scene).toHaveCSS('height', viewport.worldHeight);
					await expect(fieldArea).toHaveCSS('left', viewport.sideMargin);
					await expect(fieldArea).toHaveCSS('width', viewport.fieldWidth);

						const geometry = await readCharacterGeometry(page);
						expect(geometry.cellWidth).toBe(viewport.cell);
					expect(geometry.cellHeight).toBe(viewport.cell);
					expect(geometry.avatarWidth).toBe(viewport.avatar);
					expect(geometry.avatarHeight).toBe(viewport.avatar);
					expect(Math.abs(geometry.avatarCenter.x - geometry.participantCenter.x)).toBeLessThan(0.5);
					expect(Math.abs(geometry.avatarCenter.y - geometry.participantCenter.y)).toBeLessThan(0.5);
					expect(Math.abs(geometry.participantCenter.x - geometry.gridCellCenter.x)).toBeLessThan(0.01);
					expect(Math.abs(geometry.participantCenter.y - geometry.gridCellCenter.y)).toBeLessThan(0.01);
					await expect(page.locator('.participant-name')).toBeVisible();
					await expect(fieldArea).toHaveCSS('overflow', 'hidden');
					await expect(page.locator('.participant')).not.toHaveAttribute('data-movement-animation', 'active');
				});
			});
		}
	});

	test('keeps the centered character and camera follow after movement', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await expectNoConsoleProblems(page, async () => {
			await openDevWorld(page);
			const self = page.locator('.participant').first();
			const scene = page.locator('.field-scene');
			const before = await readCharacterGeometry(page);
			const beforeTransform = await scene.evaluate((element) => getComputedStyle(element).transform);

			const beforeLogicalStyle = await self.evaluate((element) => ({
				left: (element as HTMLElement).style.left,
				top: (element as HTMLElement).style.top
			}));
			await dragJoystick(page, { x: 24, y: -24 });
			await expect(self).toHaveAttribute('data-position', '8,2');
			await expect(self).toHaveAttribute('data-movement-animation', 'active');
			await expect(self).not.toHaveAttribute('data-movement-animation', 'active');
			await expect(scene).not.toHaveAttribute('data-camera-animation', 'active');
			const after = await readCharacterGeometry(page);
			const afterTransform = await scene.evaluate((element) => getComputedStyle(element).transform);
			const afterLogicalStyle = await self.evaluate((element) => ({
				left: (element as HTMLElement).style.left,
				top: (element as HTMLElement).style.top
			}));

			expect(afterTransform).not.toBe(beforeTransform);
			expect(afterLogicalStyle.left).not.toBe(beforeLogicalStyle.left);
			expect(afterLogicalStyle.top).not.toBe(beforeLogicalStyle.top);
			expect(Math.abs(after.avatarCenter.x - page.viewportSize()!.width / 2)).toBeLessThan(0.5);
			expect(Math.abs(after.avatarCenter.x - after.participantCenter.x)).toBeLessThan(0.5);
			expect(after.avatarWidth).toBe('46px');
			expect(after.avatarHeight).toBe('46px');
			expect(before.participantCenter.y).not.toBe(after.participantCenter.y);
		});
	});

	test('disables movement animation when reduced motion is preferred', async ({ page }) => {
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await openDevWorld(page);

		const self = page.locator('.participant').first();
		await dragJoystick(page, { x: 24, y: 0 });
		await expect(self).toHaveAttribute('data-position', '8,3');
		await expect(self).not.toHaveAttribute('data-movement-animation', 'active');
		await expect(page.locator('.field-scene')).not.toHaveAttribute('data-camera-animation', 'active');
	});
});
