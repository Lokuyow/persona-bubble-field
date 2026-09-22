import { expect, test } from '@playwright/test';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { openDevWorld, readCharacterGeometry, expectNoConsoleProblems, expectProfile, openProfile } from './helpers/devWorldHarness';


test.describe('DEV World Sandbox', () => {
	test.beforeEach(async ({ page }) => {
		await installHostOwnedStub(page);
	});

	test('uses the prototype courtyard background beneath the field grid', async ({ page }) => {
		await openDevWorld(page);

		await expect(page.locator('.field-sun')).toHaveCount(0);
		const background = await page.evaluate(() => {
			const artwork = document.querySelector<HTMLElement>('.field-artwork');
			const grid = document.querySelector<HTMLElement>('.field-grid');
			const scene = document.querySelector<HTMLElement>('.field-scene');
			if (!artwork || !grid || !scene) throw new Error('Expected the field artwork and logical grid to be rendered.');
			const artworkStyle = getComputedStyle(artwork);
			const gridStyle = getComputedStyle(grid);
			const sceneRect = scene.getBoundingClientRect();
			const artworkRect = artwork.getBoundingClientRect();
			const gridRect = grid.getBoundingClientRect();
			const boundaryStyle = getComputedStyle(grid, '::after');
			return {
				artworkImage: artworkStyle.backgroundImage,
				artworkSize: artworkStyle.backgroundSize,
				artworkRepeat: artworkStyle.backgroundRepeat,
				artworkPointerEvents: artworkStyle.pointerEvents,
				artworkRect: artworkRect.toJSON(),
				gridImage: gridStyle.backgroundImage,
				gridSize: gridStyle.backgroundSize,
				gridRepeat: gridStyle.backgroundRepeat,
				gridRect: gridRect.toJSON(),
				sceneRect: sceneRect.toJSON(),
				boundaryBorder: boundaryStyle.borderTopWidth,
				boundaryShadow: boundaryStyle.boxShadow
			};
		});

		expect(background.artworkImage).toContain('prototype-danchi-courtyard.webp');
		expect((background.artworkImage.match(/url\(/g) ?? [])).toHaveLength(1);
		expect(background.artworkSize).toBe('100% 100%');
		expect(background.artworkRepeat).toBe('no-repeat');
		expect(background.artworkPointerEvents).toBe('none');
		expect(background.gridImage).not.toContain('prototype-danchi-courtyard.webp');
		expect(background.gridImage).not.toContain('repeating-conic-gradient');
		expect(background.gridSize).toContain('76px 76px');
		expect(background.gridSize).toContain('100% 100%');
		expect(background.gridRepeat).toBe('repeat, repeat, no-repeat');
		expect(background.sceneRect.width).toBe(background.gridRect.width);
		expect(background.sceneRect.height).toBe(background.gridRect.height);
		expect(Math.abs(
		(background.artworkRect.x + background.artworkRect.width / 2) -
		(background.gridRect.x + background.gridRect.width / 2)
	)).toBeLessThan(0.01);
		expect(Math.abs(
		(background.artworkRect.y + background.artworkRect.height / 2) -
		(background.gridRect.y + background.gridRect.height / 2)
	)).toBeLessThan(0.01);
		expect(background.artworkRect.x).toBeLessThan(background.gridRect.x);
		expect(background.artworkRect.right).toBeGreaterThan(background.gridRect.right);
		expect(background.artworkRect.y).toBeLessThan(background.gridRect.y);
		expect(background.artworkRect.bottom).toBeGreaterThan(background.gridRect.bottom);
		expect(background.boundaryBorder).toBe('2px');
		expect(background.boundaryShadow).toContain('inset');
		const characterGeometry = await readCharacterGeometry(page);
		expect(Math.abs(characterGeometry.participantCenter.x - characterGeometry.gridCellCenter.x)).toBeLessThan(0.01);
		expect(Math.abs(characterGeometry.participantCenter.y - characterGeometry.gridCellCenter.y)).toBeLessThan(0.01);
	});

	test('keeps live and merged bubble bodies above overscanned artwork on desktop and mobile', async ({ page }) => {
		for (const viewport of [{ width: 1200, height: 900 }, { width: 390, height: 844 }]) {
			await page.setViewportSize(viewport);
			await page.goto('/?devWorld=1&devScenario=speech-merged-2');
			await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
			await expect(page.locator('.participant')).toHaveCount(4);
			await expect(page.locator('.bubble-normal')).toHaveCount(1);
			await expect(page.locator('.bubble-merged')).toHaveCount(1);

			const stacking = await page.evaluate(() => {
				const rect = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
				const viewport = rect('.field-viewport');
				const bubbleLayer = rect('.bubble-layer');
				const artwork = rect('.field-artwork');
				const fieldArea = document.querySelector<HTMLElement>('.field-area');
				const bubbleLayerElement = document.querySelector<HTMLElement>('.bubble-layer');
				const liveBubbles = [...document.querySelectorAll<HTMLElement>('.bubble')];
				const tailLayer = document.querySelector<SVGElement>('.tail-layer');
				if (!viewport || !bubbleLayer || !artwork || !fieldArea || !bubbleLayerElement || !tailLayer) {
					throw new Error('Expected the viewport stacking layers.');
				}
				const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
				return {
					viewport,
					bubbleLayer,
					fieldZIndex: getComputedStyle(fieldArea).zIndex,
					bubbleZIndex: getComputedStyle(bubbleLayerElement).zIndex,
					tailZIndex: getComputedStyle(tailLayer).zIndex,
					bubblePointerEvents: getComputedStyle(bubbleLayerElement).pointerEvents,
					bubbleSurfacePointerEvents: liveBubbles.map((bubble) => getComputedStyle(bubble).pointerEvents),
					artworkOverlap: liveBubbles.map((bubble) => overlaps(bubble.getBoundingClientRect(), artwork)),
					artworkCoversBubbleLayer: overlaps(artwork, bubbleLayer)
				};
			});

			expect(stacking.bubbleLayer).toEqual(stacking.viewport);
			expect(stacking.fieldZIndex).toBe('2');
			expect(stacking.bubbleZIndex).toBe('3');
			expect(stacking.tailZIndex).toBe('4');
			expect(stacking.bubblePointerEvents).toBe('none');
			expect(stacking.bubbleSurfacePointerEvents.every((value) => value === 'auto')).toBe(true);
			expect(stacking.artworkCoversBubbleLayer).toBe(true);
			if (viewport.width > 700) expect(stacking.artworkOverlap.some(Boolean)).toBe(true);
		}
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
		await page.goto('/?devWorld=1&devScenario=speech-merged-2');
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
		await page.goto('/?devWorld=1&devScenario=speech-types');
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
		expect(await page.locator('.tail-layer .tail-outline')).toHaveCount(7);

		const liveTailOcclusion = await page.locator('.tail-layer').evaluate((layer) => {
			const group = layer.querySelector<SVGGElement>('[data-live-surface-occlusion]');
			const groupMaskId = group?.getAttribute('mask')?.replace(/^url\(#|\)$/g, '');
			const mask = groupMaskId ? layer.querySelector<SVGMaskElement>(`mask#${groupMaskId}`) : null;
			const specialTails = [...(group?.querySelectorAll<SVGPolygonElement>('polygon[data-tail-participant-id]') ?? [])];
			const normalTails = [...layer.querySelectorAll<SVGPolygonElement>(':scope > polygon[data-tail-participant-id]')];
			const occluders = [...(mask?.querySelectorAll<SVGPathElement>('path[fill="black"]') ?? [])];
			const pointInsideOccluder = (tail: SVGPolygonElement) => {
				const first = tail.points.getItem(0);
				const second = tail.points.getItem(1);
				const midpoint = new DOMPoint((first.x + second.x) / 2, (first.y + second.y) / 2);
				return occluders.some((occluder) => {
					const inverse = occluder.getScreenCTM()?.inverse();
					const tailMatrix = tail.getScreenCTM();
					const tailPoint = tailMatrix ? midpoint.matrixTransform(tailMatrix) : null;
					return Boolean(inverse && tailPoint && occluder.isPointInFill(tailPoint.matrixTransform(inverse)));
				});
			};
			return {
				groupMask: group?.getAttribute('mask'),
				maskId: groupMaskId,
				occluderCount: occluders.length,
				specialTailCount: specialTails.length,
				normalTailCount: normalTails.length,
				specialUnderlapPointsOccluded: specialTails.map(pointInsideOccluder),
				normalTailMasks: normalTails.map((tail) => tail.parentElement?.getAttribute('mask'))
			};
		});
		expect(liveTailOcclusion.groupMask).toMatch(/^url\(#live-surface-occlusion\)$/);
		expect(liveTailOcclusion.maskId).toBe('live-surface-occlusion');
		expect(liveTailOcclusion.occluderCount).toBe(4);
		expect(liveTailOcclusion.specialTailCount).toBe(6);
		expect(liveTailOcclusion.normalTailCount).toBe(1);
		expect(liveTailOcclusion.specialUnderlapPointsOccluded).toEqual([true, true, true, true, true, true]);
		expect(liveTailOcclusion.normalTailMasks).toEqual([null]);

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
			await page.goto('/?devWorld=1&devScenario=speech-merged-2-shout-long');
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
});
