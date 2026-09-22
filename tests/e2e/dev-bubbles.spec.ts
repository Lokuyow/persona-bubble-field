import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { installFieldFrameSampling, sampleRenderedField } from './helpers/fieldFrames';
import { openDevWorld, readMergedBubbleGeometry, readCharacterGeometry, fieldOwnedBlankPoint, expectNoConsoleProblems, profileDialog, expectProfile, openProfile } from './helpers/devWorldHarness';


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

		await page.goto('/?devWorld=1&devScenario=trace-replies');
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
		await page.goto('/?devWorld=1&devScenario=trace-replies');
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
