import { expect, test, type Page } from '@playwright/test';

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

async function readMovementCellGeometry(page: Page) {
	return page.locator('.movement-cell').evaluateAll((cells) => {
		const grid = document.querySelector<HTMLElement>('.field-grid');
		const scene = document.querySelector<HTMLElement>('.field-scene');
		if (!grid || !scene) throw new Error('Expected the field grid and scene to be rendered.');
		const gridRect = grid.getBoundingClientRect();
		const cellSize = Number.parseFloat(getComputedStyle(scene).getPropertyValue('--cell-size'));

		return cells.map((cell) => {
			const rect = cell.getBoundingClientRect();
			const [x, y] = (cell.getAttribute('data-movement-position') ?? '').split(',').map(Number);
			return {
				direction: cell.getAttribute('data-movement-direction'),
				position: { x, y },
				width: rect.width,
				height: rect.height,
				leftOffset: rect.left - gridRect.left,
				topOffset: rect.top - gridRect.top,
				background: getComputedStyle(cell).backgroundColor,
				cursor: getComputedStyle(cell).cursor
			};
		});
	});
}

async function expectNoConsoleProblems(page: Page, action: () => Promise<void>): Promise<void> {
	const problems: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error' || message.type() === 'warning') problems.push(`${message.type()}: ${message.text()}`);
	});
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

	test('uses a subtle checkerboard field with a distinct boundary', async ({ page }) => {
		await openDevWorld(page);

		await expect(page.locator('.field-sun')).toHaveCount(0);
		const fieldGrid = page.locator('.field-grid');
		const background = await fieldGrid.evaluate((element) => {
			const style = getComputedStyle(element);
			const boundaryStyle = getComputedStyle(element, '::after');
			return {
				image: style.backgroundImage,
				size: style.backgroundSize,
				boundaryBorder: boundaryStyle.borderTopWidth,
				boundaryShadow: boundaryStyle.boxShadow
			};
		});

		expect(background.image).toContain('repeating-conic-gradient');
		expect(background.size).toContain('168px 168px');
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

	test('renders adjacent cells on the grid, moves by cell and follows the new position', async ({ page }) => {
		await openDevWorld(page);

		const self = page.locator('.participant').first();
		const movementCells = await readMovementCellGeometry(page);
		expect(movementCells.map((cell) => cell.direction)).toEqual(['up', 'down', 'left', 'right']);
		expect(movementCells.map((cell) => cell.position)).toEqual([
			{ x: 7, y: 2 },
			{ x: 7, y: 4 },
			{ x: 6, y: 3 },
			{ x: 8, y: 3 }
		]);
		for (const cell of movementCells) {
			expect(cell.width).toBeCloseTo(cell.height, 5);
			expect(cell.width).toBeGreaterThan(0);
			expect(cell.leftOffset).toBeCloseTo(cell.position.x * cell.width, 5);
			expect(cell.topOffset).toBeCloseTo(cell.position.y * cell.height, 5);
			expect(cell.background).not.toBe('rgba(0, 0, 0, 0)');
			expect(cell.cursor).toBe('pointer');
		}

		await page.getByRole('button', { name: 'Move right' }).click();
		await expect(self).toHaveAttribute('data-position', '8,3');
		await expect(page.locator('.movement-cell')).toHaveCount(4);
		await expect(page.locator('.movement-cell[data-movement-position="8,2"]')).toHaveCount(1);
		await expect(page.locator('.movement-cell[data-movement-position="8,4"]')).toHaveCount(1);
		await expect(page.locator('.movement-cell[data-movement-position="7,3"]')).toHaveCount(1);
		await expect(page.locator('.movement-cell[data-movement-position="9,3"]')).toHaveCount(1);

		await page.getByRole('button', { name: 'Reset sandbox' }).click();
		await expect(self).toHaveAttribute('data-position', '7,3');
	});

	test('operates an adjacent cell through keyboard focus and preserves Arrow movement', async ({ page }) => {
		await openDevWorld(page);

		const self = page.locator('.participant').first();
		const up = page.getByRole('button', { name: 'Move up' });
		await up.focus();
		await expect(up).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(self).toHaveAttribute('data-position', '7,2');

		await page.keyboard.press('ArrowDown');
		await expect(self).toHaveAttribute('data-position', '7,3');
	});

	test('does not render a field-external cell at the field edge', async ({ page }) => {
		await openDevWorld(page);

		const self = page.locator('.participant').first();
		for (let index = 0; index < 7; index += 1) await page.keyboard.press('ArrowLeft');
		await expect(self).toHaveAttribute('data-position', '0,3');
		await expect(page.getByRole('button', { name: 'Move left' })).toHaveCount(0);
		await expect(page.locator('.movement-cell[data-movement-position="-1,3"]')).toHaveCount(0);
	});

	test('does not render an occupied adjacent cell as interactive', async ({ page }) => {
		await page.goto('/?devWorld=1&devSpeech=1');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();

		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '7,3');
		await expect(page.getByRole('button', { name: 'Move up' })).toHaveCount(0);
		await expect(page.locator('.movement-cell[data-movement-position="7,2"]')).toHaveCount(0);
		await expect(page.locator('.movement-cell[data-movement-position="6,3"]')).toHaveCount(1);
		await expect(page.locator('.movement-cell[data-movement-position="8,3"]')).toHaveCount(1);
		await expect(page.locator('.movement-cell[data-movement-position="7,4"]')).toHaveCount(1);
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
			{ name: 'mobile', width: 390, height: 844, sideMargin: '8px', fieldWidth: '374px', cell: '60px', avatar: '56px', worldWidth: '960px', worldHeight: '480px' },
			{ name: 'desktop', width: 1200, height: 900, sideMargin: '8px', fieldWidth: '1184px', cell: '84px', avatar: '80px', worldWidth: '1344px', worldHeight: '672px' }
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
						const movementCells = await readMovementCellGeometry(page);
						expect(movementCells).toHaveLength(4);
						for (const cell of movementCells) {
							expect(cell.leftOffset).toBeCloseTo(cell.position.x * cell.width, 5);
							expect(cell.topOffset).toBeCloseTo(cell.position.y * cell.height, 5);
						}
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

			await page.getByRole('button', { name: 'Move right' }).click();
			await expect(self).toHaveAttribute('data-position', '8,3');
			await expect(self).toHaveAttribute('data-movement-animation', 'active');
			await expect(self).not.toHaveAttribute('data-movement-animation', 'active');
			await expect(scene).not.toHaveAttribute('data-camera-animation', 'active');
			const after = await readCharacterGeometry(page);
			const afterTransform = await scene.evaluate((element) => getComputedStyle(element).transform);

			expect(afterTransform).not.toBe(beforeTransform);
			expect(Math.abs(after.avatarCenter.x - page.viewportSize()!.width / 2)).toBeLessThan(0.5);
			expect(Math.abs(after.avatarCenter.x - after.participantCenter.x)).toBeLessThan(0.5);
			expect(after.avatarWidth).toBe('56px');
			expect(after.avatarHeight).toBe('56px');
			expect(before.participantCenter.y).toBe(after.participantCenter.y);
		});
	});

	test('disables movement animation when reduced motion is preferred', async ({ page }) => {
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await openDevWorld(page);

		const self = page.locator('.participant').first();
		await page.getByRole('button', { name: 'Move right' }).click();
		await expect(self).toHaveAttribute('data-position', '8,3');
		await expect(self).not.toHaveAttribute('data-movement-animation', 'active');
		await expect(page.locator('.field-scene')).not.toHaveAttribute('data-camera-animation', 'active');
	});
});
