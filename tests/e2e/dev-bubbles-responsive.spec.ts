import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { readMergedBubbleGeometry, fieldOwnedBlankPoint, openDevTraceWorld, profileDialog } from './helpers/devWorldHarness';


test.describe('DEV World Sandbox', () => {
	test.beforeEach(async ({ page }) => {
		await installHostOwnedStub(page);
	});

	test('prevents field UI selection while keeping speech and profile text selectable', async ({ page }) => {
		await page.setViewportSize({ width: 1200, height: 900 });
		await page.goto('/?devWorld=1&devScenario=speech-comparison');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();

		const blank = await fieldOwnedBlankPoint(page, { x: 2, y: 2 });
		const fieldText = page.locator('.participant-profile-trigger .participant-name').first();
		const fieldTextBox = await fieldText.boundingBox();
		if (!fieldTextBox) throw new Error('Expected field UI text to be visible.');
		await page.evaluate(() => window.getSelection()?.removeAllRanges());
		await page.mouse.move(blank.x, blank.y);
		await page.mouse.down();
		await page.mouse.move(fieldTextBox.x + fieldTextBox.width / 2, fieldTextBox.y + fieldTextBox.height / 2);
		await page.mouse.up();
		expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');

		const liveText = page.locator('.bubble-normal[data-speech-type="shout"] .bubble-content');
		const fieldViewport = page.locator('.field-viewport');
		const dragSelect = async (locator: Locator): Promise<string> => {
			await expect(fieldViewport).toHaveClass(/initial-field-geometry-ready/);
			let textRect: { x: number; y: number; width: number; height: number } | undefined;
			await expect.poll(async () => {
				const sample = await locator.evaluate(async (element) => {
					const read = () => {
						const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
						const rects: DOMRect[] = [];
						while (walker.nextNode()) {
							const textNode = walker.currentNode;
							if (!textNode.textContent?.trim()) continue;
							const range = document.createRange();
							range.selectNodeContents(textNode);
							for (const rect of range.getClientRects()) {
								if (rect.width > 4 && rect.height > 4) rects.push(rect);
							}
							range.detach();
						}
						const glyph = rects.sort((left, right) => right.width - left.width)[0];
						const bubble = element.closest<HTMLElement>('.bubble')?.getBoundingClientRect();
						if (!glyph) return null;
						return {
							text: { x: glyph.x, y: glyph.y, width: glyph.width, height: glyph.height },
							bubble: bubble && { x: bubble.x, y: bubble.y, width: bubble.width, height: bubble.height }
						};
					};
					await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
					const first = read();
					await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
					const second = read();
					if (!first || !second) return null;
					const values = [
						first.text.x - second.text.x,
						first.text.y - second.text.y,
						first.text.width - second.text.width,
						first.text.height - second.text.height,
						...(first.bubble && second.bubble ? [
							first.bubble.x - second.bubble.x,
							first.bubble.y - second.bubble.y,
							first.bubble.width - second.bubble.width,
							first.bubble.height - second.bubble.height
						] : [])
					];
					return { stable: values.every((value) => Math.abs(value) <= 0.1), text: second.text };
				});
				if (sample?.stable) textRect = sample.text;
				return sample?.stable ?? false;
			}).toBe(true);
			if (!textRect) throw new Error('Expected stable selectable text glyph geometry.');
			await page.evaluate(() => window.getSelection()?.removeAllRanges());
			const inset = Math.min(2, Math.max(0.5, textRect.width / 10));
			const y = textRect.y + textRect.height / 2;
			await page.mouse.move(textRect.x + textRect.width - inset, y);
			await page.mouse.down();
			await page.mouse.move(textRect.x + inset, y, { steps: 5 });
			await page.mouse.up();
			return page.evaluate(() => window.getSelection()?.toString() ?? '');
		};
		await expect(liveText).toBeVisible();
		await page.evaluate(() => window.getSelection()?.removeAllRanges());
		expect(await dragSelect(liveText)).not.toBe('');
		expect(await dragSelect(page.locator('.bubble-merged .bubble-content'))).not.toBe('');
		await page.goto('/?devWorld=1&devScenario=chatter-timeline');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await page.keyboard.press('c');
		await expect(page.locator('aside[aria-label="Chatter"]')).toBeVisible();
		expect(await dragSelect(page.locator('.timeline-content').first())).not.toBe('');
		expect(await dragSelect(page.locator('.timeline-name').first())).not.toBe('');

		await openDevTraceWorld(page, 'trace-replies');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await page.locator('[data-cell-position="8,4"]').click();
		const traceRoot = page.locator('.trace-root-bubble');
		const traceContent = traceRoot.locator('.bubble-content');
		await expect(traceContent).toBeVisible();
		expect(await dragSelect(traceContent)).not.toBe('');

		await page.goto('/?devWorld=1&devScenario=chatter-timeline');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await page.locator('.timeline-name').first().click();
		const dialog = profileDialog(page);
		for (const selector of ['[data-dialog-title]', '.profile-dialog-about']) {
			const text = dialog.locator(selector);
			const box = await text.boundingBox();
			if (!box) throw new Error(`Expected profile text ${selector} to be visible.`);
			await page.evaluate(() => window.getSelection()?.removeAllRanges());
			await page.mouse.move(box.x + 2, box.y + box.height / 2);
			await page.mouse.down();
			await page.mouse.move(box.x + Math.max(3, box.width - 2), box.y + box.height / 2);
			await page.mouse.up();
			expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).not.toBe('');
		}
	});

	test('renders the full speech showcase with eight colors and a merged bubble', async ({ page }) => {
		await page.goto('/?devWorld=1&devScenario=speech-showcase');
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
		const nameColors = await page.locator('.participant').evaluateAll((participants) => {
			const selfName = participants
				.find((participant) => participant.getAttribute('data-self') === 'true')
				?.querySelector<HTMLElement>('.participant-name');
			const nonSelfName = participants
				.find((participant) => participant.getAttribute('data-self') !== 'true')
				?.querySelector<HTMLElement>('.participant-name');
			if (!selfName || !nonSelfName) throw new Error('Expected self and non-self participant names');

			const accentProbe = document.createElement('div');
			accentProbe.style.border = '2px solid var(--color-accent)';
			accentProbe.style.backgroundColor = 'var(--color-accent-soft)';
			const neutralProbe = document.createElement('div');
			neutralProbe.style.backgroundColor = 'rgba(247, 247, 239, 0.74)';
			document.body.append(accentProbe, neutralProbe);
			const accentStyle = getComputedStyle(accentProbe);
			const neutralStyle = getComputedStyle(neutralProbe);
			const selfStyle = getComputedStyle(selfName);
			const nonSelfStyle = getComputedStyle(nonSelfName);
			const colors = {
				accent: accentStyle.borderTopColor,
				accentSoft: accentStyle.backgroundColor,
				selfBorder: selfStyle.borderTopColor,
				selfBackground: selfStyle.backgroundColor,
				neutral: neutralStyle.backgroundColor,
				nonSelfBackground: nonSelfStyle.backgroundColor
			};
			accentProbe.remove();
			neutralProbe.remove();
			return colors;
		});
		expect(nameColors.selfBorder).toBe(nameColors.accent);
		expect(nameColors.selfBackground).toBe(nameColors.accentSoft);
		expect(nameColors.nonSelfBackground).toBe(nameColors.neutral);

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
			{ query: 'speech-merged-2', count: 2, members: ['b', 'c'] },
			{ query: 'speech-merged-3', count: 3, members: ['b', 'c', 'd'] },
			{ query: 'speech-merged-4', count: 4, members: ['b', 'c', 'd', 'e'] }
		] as const;
		const geometries = [];

		for (const fixture of fixtures) {
			await page.goto(`/?devWorld=1&devScenario=${fixture.query}`);
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

	test('uses compact mobile presentation values and remeasures normal bubbles across the breakpoint', async ({ page }) => {
		await page.setViewportSize({ width: 1100, height: 850 });
		await page.goto('/?devWorld=1&devScenario=speech-long');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		const readNormalStyle = () => page.locator('.bubble-normal').first().evaluate((element) => {
			const style = getComputedStyle(element);
			return {
				fontSize: style.fontSize,
				maxWidth: Number.parseFloat(style.maxWidth.match(/[\d.]+px/)?.[0] ?? 'NaN'),
				padding: style.padding,
				width: element.getBoundingClientRect().width
			};
		});
		expect(await readNormalStyle()).toMatchObject({ fontSize: '16px', maxWidth: 240, padding: '12px 15px' });

		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/?devWorld=1&devScenario=speech-long');
		await expect(page.locator('.bubble-normal')).toBeVisible();
		await expect.poll(readNormalStyle).toMatchObject({ fontSize: '13px', maxWidth: 180, padding: '8px 10px' });
		const mobileLongWidth = (await readNormalStyle()).width;
		expect(mobileLongWidth).toBeLessThanOrEqual(200);

		await page.setViewportSize({ width: 700, height: 844 });
		await expect.poll(readNormalStyle).toMatchObject({ fontSize: '13px', maxWidth: 180, padding: '8px 10px' });
		await page.setViewportSize({ width: 701, height: 844 });
		await expect.poll(readNormalStyle).toMatchObject({ fontSize: '16px', maxWidth: 240, padding: '12px 15px' });
	});

	test('keeps merged mobile emphasis while applying compact widths and padding', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const geometries = [];
		for (const fixture of [
			{ query: 'speech-merged-2', count: 2, fontSize: '15px', minWidth: '72px', maxWidth: '220px', padding: '9px 12px', members: ['b', 'c'] },
			{ query: 'speech-merged-3', count: 3, fontSize: '16px', minWidth: '88px', maxWidth: '232px', padding: '10px 14px', members: ['b', 'c', 'd'] },
			{ query: 'speech-merged-4', count: 4, fontSize: '17px', minWidth: '104px', maxWidth: '244px', padding: '11px 16px', members: ['b', 'c', 'd', 'e'] }
		] as const) {
			await page.goto(`/?devWorld=1&devScenario=${fixture.query}`);
			await expect(page.locator('.bubble-merged')).toHaveAttribute('data-merged-members', String(fixture.count));
			const style = await page.locator('.bubble-merged').evaluate((element) => {
				const computed = getComputedStyle(element);
				return { fontSize: computed.fontSize, minWidth: computed.minWidth, maxWidth: Number.parseFloat(computed.maxWidth.match(/[\d.]+px/)?.[0] ?? 'NaN'), padding: computed.padding, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height };
			});
			expect(style).toMatchObject({ fontSize: fixture.fontSize, minWidth: fixture.minWidth, maxWidth: Number.parseFloat(fixture.maxWidth), padding: fixture.padding });
			expect(style.width).toBeLessThanOrEqual(Number.parseFloat(fixture.maxWidth));
			geometries.push(style);
		}
		expect(geometries[1].width).toBeGreaterThan(geometries[0].width);
		expect(geometries[2].width).toBeGreaterThan(geometries[1].width);
		expect(geometries[1].height).toBeGreaterThan(geometries[0].height);
		expect(geometries[2].height).toBeGreaterThan(geometries[1].height);

		await page.goto('/?devWorld=1&devScenario=speech-long');
		await expect.poll(() => page.locator('.bubble-merged').evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(220);
	});

	test('compacts Trace root and replies on mobile and restores desktop values after resize', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await openDevTraceWorld(page, 'trace-replies');
		await page.locator('[data-cell-position="8,4"]').click();
		await expect(page.locator('.trace-root-card')).toHaveAttribute('data-trace-geometry-ready', 'ready');
		const root = page.locator('.trace-root-bubble');
		const reply = page.locator('.trace-reply-card').first();
		const readTraceStyles = () => page.locator('.trace-root-bubble').evaluate((root) => {
			const style = getComputedStyle(root);
			const replyCard = document.querySelector<HTMLElement>('.trace-reply-card');
			const author = replyCard?.querySelector<HTMLElement>('.trace-reply-author-profile');
			const avatar = replyCard?.querySelector<HTMLElement>('.trace-reply-author-avatar');
			const name = replyCard?.querySelector<HTMLElement>('.trace-reply-author-name');
			if (!replyCard || !author || !avatar || !name) throw new Error('Expected Trace reply presentation.');
			const replyStyle = getComputedStyle(replyCard);
			return {
				root: { fontSize: style.fontSize, maxWidth: Number.parseFloat(style.maxWidth.match(/[\d.]+px/)?.[0] ?? 'NaN'), padding: style.padding },
				reply: { fontSize: replyStyle.fontSize, maxWidth: Number.parseFloat(replyStyle.maxWidth.match(/[\d.]+px/)?.[0] ?? 'NaN'), minWidth: replyStyle.minWidth, padding: replyStyle.padding, columnGap: replyStyle.columnGap },
				author: { fontSize: getComputedStyle(author).fontSize, avatar: getComputedStyle(avatar).width, nameMaxWidth: getComputedStyle(name).maxWidth }
			};
		});
		expect(await readTraceStyles()).toEqual({
			root: { fontSize: '13px', maxWidth: 180, padding: '8px 10px' },
			reply: { fontSize: '13px', maxWidth: 180, minWidth: '112px', padding: '8px 10px', columnGap: '4px' },
			author: { fontSize: '10px', avatar: '28px', nameMaxWidth: '48px' }
		});
		await expect(root).toBeVisible();
		await expect(reply).toBeVisible();

		await page.setViewportSize({ width: 701, height: 844 });
		await expect.poll(readTraceStyles).toEqual({
			root: { fontSize: '16px', maxWidth: 240, padding: '12px 15px' },
			reply: { fontSize: '16px', maxWidth: 240, minWidth: '144px', padding: '12px 15px', columnGap: '6px' },
			author: { fontSize: '12px', avatar: '36px', nameMaxWidth: '60px' }
		});
		await page.setViewportSize({ width: 700, height: 844 });
		await expect.poll(readTraceStyles).toEqual({
			root: { fontSize: '13px', maxWidth: 180, padding: '8px 10px' },
			reply: { fontSize: '13px', maxWidth: 180, minWidth: '112px', padding: '8px 10px', columnGap: '4px' },
			author: { fontSize: '10px', avatar: '28px', nameMaxWidth: '48px' }
		});
	});
});
