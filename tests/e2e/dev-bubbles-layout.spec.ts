import { expect, test } from '@playwright/test';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { readMergedBubbleGeometry, expectNoConsoleProblems } from './helpers/devWorldHarness';


test.describe('DEV World Sandbox', () => {
	test.beforeEach(async ({ page }) => {
		await installHostOwnedStub(page);
	});

	test('remeasures mounted bubble bodies after height-only viewport resize', async ({ page }) => {
		for (const speechType of ['shout', 'monologue'] as const) {
			await page.setViewportSize({ width: 1440, height: 1000 });
			await expectNoConsoleProblems(page, async () => {
				await page.goto(`/?devWorld=1&devScenario=speech-merged-2-${speechType}-long`);
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
			await page.goto('/?devWorld=1&devScenario=speech-types');
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
			await page.goto(`/?devWorld=1&devScenario=speech-merged-2-${speechType}-long`);
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
		await page.goto('/?devWorld=1&devScenario=speech-linebreak');
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
			'speech-long',
			[
				'Normal bubble message that wraps repeatedly inside the speech bubble width. '.repeat(8).trim(),
				'Merged bubble message that wraps repeatedly inside the speech bubble width. '.repeat(8).trim()
			]
		],
		[
			'speech-linebreak-overflow',
			[
				'normal line 1\nnormal line 2\nnormal line 3\nnormal line 4\nnormal line 5\nnormal line 6',
				'merged line 1\nmerged line 2\nmerged line 3\nmerged line 4\nmerged line 5\nmerged line 6'
			]
		]
	] as const) {
		test(`clamps ${query === 'speech-long' ? 'wrapped long text' : 'explicit six-line text'} in normal and merged bubbles`, async ({ page }) => {
			await page.setViewportSize({ width: 390, height: 844 });
			await page.goto(`/?devWorld=1&devScenario=${query}`);
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
		await page.goto('/?devWorld=1&devScenario=speech-normal-sizes');
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
			{ query: 'speech-merged-2', longQuery: 'speech-merged-2-long', count: 2, maxWidth: 330, members: ['b', 'c'] },
			{ query: 'speech-merged-3', longQuery: 'speech-merged-3-long', count: 3, maxWidth: 345, members: ['b', 'c', 'd'] },
			{ query: 'speech-merged-4', longQuery: 'speech-merged-4-long', count: 4, maxWidth: 360, members: ['b', 'c', 'd', 'e'] }
		] as const;

		for (const fixture of fixtures) {
			await page.goto(`/?devWorld=1&devScenario=${fixture.query}`);
			await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
			await expect(page.locator('.bubble-merged')).toHaveAttribute('data-merged-members', String(fixture.count));
			const short = await readMergedBubbleGeometry(page, fixture.members);

			await page.goto(`/?devWorld=1&devScenario=${fixture.longQuery}`);
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
		const fixtures = ['speech-merged-2', 'speech-linebreak', 'speech-linebreak-five', 'speech-linebreak-overflow'] as const;
		const normalHeights: number[] = [];
		const mergedHeights: number[] = [];

		for (const query of fixtures) {
			await page.goto(`/?devWorld=1&devScenario=${query}`);
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
		await page.goto('/?devWorld=1&devScenario=speech-linebreak-five');
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
		await page.goto('/?devWorld=1&devScenario=speech-comparison');
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
		await page.goto('/?devWorld=1&devScenario=speech-linebreak-overflow');
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
});
