import { expect, test, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { expectIconCloseButton } from './helpers/iconCloseButton';
import { finalizeEvent, getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { buildTagGameActionTemplate, createTagGameSchedule, finalizeTagGameState, isFreshTagGameTouchAction, parseTagGameActionEvent, parseTagGameEvent, tagGameScheduledEffectAt, TAG_GAME_KIND, TAG_GAME_RESERVATION_RECOVERY_MS, TAG_GAME_TRANSFER_COOLDOWN_MS, type TagGameState } from '../../src/lib/tagGame';
import { MENDING_TERMINAL, TAG_GAME_TERMINAL } from '../../src/lib/fieldFacilities';
import { resolveCharacterFromPubkey } from '../../src/lib/characterAssignment';
import { buildWorldMessageTemplate, buildWorldStateEventTemplate, WORLD_STATE_KIND } from '../../src/lib/nostrProtocol';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { AUTHORITATIVE_RELAYS, CHANNEL_ID, clickRelayLogicalCell, fixtureSecret, installDelayedRelay, moveRelaySelfTo, relayState, seedRelayAccount, testEvents, dragRelayJoystick } from './helpers/relayHarness';

async function preparePlayer(page: Page, secret: Uint8Array, nowMs: number, points = 0, persistAcrossReload = false, observeWebSocketLifecycle = false): Promise<void> {
	await page.clock.install({ time: nowMs });
	await installHostOwnedStub(page);
	await installDelayedRelay(page, { primaryEvents: testEvents(nowMs), realtimeEvents: [], realtimePublishOutcome: 'echo', persistAcrossReload, observeWebSocketLifecycle });
	await seedRelayAccount(page, secret, getPublicKey(secret), nowMs + 14 * 24 * 60 * 60 * 1_000, points);
	await page.goto('/');
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	await expect(page.locator(`.participant[data-self="true"][data-participant-id="${getPublicKey(secret)}"]`)).toBeVisible();
	await expect.poll(async () => (await relayState(page)).state.requests.some((request) => request.filters.some((filter) => (filter.kinds as number[] | undefined)?.includes(7070)))).toBe(true);
}

async function expectButtonShape(button: Locator): Promise<void> {
	const style = await button.evaluate((element) => {
		const computed = getComputedStyle(element);
		return { background: computed.backgroundColor, border: computed.borderStyle, width: computed.borderWidth };
	});
	expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
	expect(style.border).toBe('solid');
	expect(style.width).toBe('1px');
}

type Box = Readonly<{ x: number; y: number; width: number; height: number }>;

async function readEffectSymbolLayout(holder: Locator): Promise<Readonly<{
	cell: Box;
	avatar: Box;
	name: Box;
	auraLeft: Box | null;
	auraRight: Box | null;
	auraLeftFillOpacity: number;
	auraRightFillOpacity: number;
	auraStrokeOpacity: number;
	auraStrokeWidth: number;
	fukuHaloRays: readonly Box[];
	fukuHaloRayCounts: Readonly<{ warm: number; light: number }>;
	fukuHaloRayColors: Readonly<{ warmFill: string; lightFill: string; lightStroke: string }>;
	fukuHaloRayOpacities: Readonly<{ warm: number; light: number }>;
	fukuHaloRingCount: number;
	fukuHaloLightRing: Box | null;
	leftHorn: Box | null;
	rightHorn: Box | null;
	mallet: Box | null;
	malletHead: Box | null;
	malletShaft: Box | null;
	malletGeometry: Readonly<{
		shaft: Readonly<{ tagName: string; x: number; y: number; width: number; height: number; rx: number }>;
		head: Readonly<{ tagName: string; x: number; y: number; width: number; height: number; rx: number }>;
		groupTransform: string | null;
		shaftTransform: string | null;
		headTransform: string | null;
		shaftSharesParentWithHead: boolean;
	}> | null;
	auraZ: number;
	visualZ: number;
	buttonZ: number;
	visualAnimationName: string;
	pointerEvents: string;
}>> {
	return holder.evaluate((element) => {
		const box = (target: Element | null): Box | null => {
			if (!target) return null;
			const rect = target.getBoundingClientRect();
			return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
		};
		const visual = element.querySelector<HTMLElement>('.tag-game-effect-visuals');
		const aura = element.querySelector<HTMLElement>('.tag-game-effect-aura');
		const button = element.querySelector<HTMLElement>('.participant-profile-trigger');
		const path = (selector: string) => box(element.querySelector(selector));
		const auraLeftSelector = '.oni-smoke-left > path';
		const auraRightSelector = '.oni-smoke-right > path';
		const auraLeftElement = element.querySelector<SVGGraphicsElement>(auraLeftSelector);
		const auraRightElement = element.querySelector<SVGGraphicsElement>(auraRightSelector);
		const warmRays = element.querySelector<SVGGElement>('.fuku-halo-rays-warm');
		const lightRays = element.querySelector<SVGGElement>('.fuku-halo-rays-light');
		const rayBoxes = [...element.querySelectorAll<SVGGraphicsElement>('.fuku-halo-rays path')].map((ray) => box(ray)!);
		const malletShaft = element.querySelector<SVGRectElement>('[data-fuku-mallet-handle]');
		const malletHead = element.querySelector<SVGRectElement>('[data-fuku-mallet-head]');
		const rectGeometry = (rect: SVGRectElement) => ({
			tagName: rect.tagName.toLowerCase(),
			x: Number(rect.getAttribute('x')),
			y: Number(rect.getAttribute('y')),
			width: Number(rect.getAttribute('width')),
			height: Number(rect.getAttribute('height')),
			rx: Number(rect.getAttribute('rx'))
		});
		return {
			cell: box(element)!,
			avatar: box(element.querySelector('.participant-profile-trigger .avatar'))!,
			name: box(element.querySelector('.participant-name'))!,
			auraLeft: box(auraLeftElement),
			auraRight: box(auraRightElement),
			auraLeftFillOpacity: auraLeftElement ? Number.parseFloat(getComputedStyle(auraLeftElement).fillOpacity) : 0,
			auraRightFillOpacity: auraRightElement ? Number.parseFloat(getComputedStyle(auraRightElement).fillOpacity) : 0,
			auraStrokeOpacity: auraLeftElement ? Number.parseFloat(getComputedStyle(auraLeftElement).strokeOpacity) : 0,
			auraStrokeWidth: auraLeftElement ? Number.parseFloat(getComputedStyle(auraLeftElement).strokeWidth) : 0,
			fukuHaloRays: rayBoxes,
			fukuHaloRayCounts: { warm: warmRays?.querySelectorAll('path').length ?? 0, light: lightRays?.querySelectorAll('path').length ?? 0 },
			fukuHaloRayColors: { warmFill: warmRays ? getComputedStyle(warmRays).fill : '', lightFill: lightRays ? getComputedStyle(lightRays).fill : '', lightStroke: lightRays ? getComputedStyle(lightRays).stroke : '' },
			fukuHaloRayOpacities: { warm: Number.parseFloat(warmRays ? getComputedStyle(warmRays).opacity : '0'), light: Number.parseFloat(lightRays ? getComputedStyle(lightRays).opacity : '0') },
			fukuHaloRingCount: element.querySelectorAll('.fuku-halo > circle').length,
			fukuHaloLightRing: box(element.querySelector('.fuku-halo-light-ring')),
			leftHorn: path('.oni-horn:nth-of-type(1)'),
			rightHorn: path('.oni-horn:nth-of-type(2)'),
			mallet: path('[data-fuku-mallet]'),
			malletHead: path('[data-fuku-mallet-head]'),
			malletShaft: path('[data-fuku-mallet-handle]'),
			malletGeometry: malletShaft && malletHead ? {
				shaft: rectGeometry(malletShaft),
				head: rectGeometry(malletHead),
				groupTransform: element.querySelector('[data-fuku-mallet]')?.getAttribute('transform') ?? null,
				shaftTransform: malletShaft.getAttribute('transform'),
				headTransform: malletHead.getAttribute('transform'),
				shaftSharesParentWithHead: malletShaft.parentElement === malletHead.parentElement
			} : null,
			auraZ: Number.parseInt(getComputedStyle(aura!).zIndex, 10),
			visualZ: Number.parseInt(getComputedStyle(visual!).zIndex, 10),
			buttonZ: Number.parseInt(getComputedStyle(button!).zIndex, 10),
			visualAnimationName: getComputedStyle(visual!).animationName,
			pointerEvents: getComputedStyle(visual!).pointerEvents
		};
	});
}

function expectAuraVisibleOutsideAvatar(layout: Awaited<ReturnType<typeof readEffectSymbolLayout>>): void {
	expect(layout.auraLeft).not.toBeNull();
	expect(layout.auraRight).not.toBeNull();
	const auraLeft = layout.auraLeft!;
	const auraRight = layout.auraRight!;
	const minVisibleOverflow = layout.cell.width * 0.04;
	expect(layout.avatar.x - auraLeft.x).toBeGreaterThan(minVisibleOverflow);
	expect(auraRight.x + auraRight.width - (layout.avatar.x + layout.avatar.width)).toBeGreaterThan(minVisibleOverflow);
	expect(layout.auraLeftFillOpacity).toBeGreaterThan(0.15);
	expect(layout.auraLeftFillOpacity).toBeLessThan(0.4);
	expect(layout.auraRightFillOpacity).toBeGreaterThan(0.15);
	expect(layout.auraRightFillOpacity).toBeLessThan(0.4);
	expect(layout.auraStrokeOpacity).toBeLessThan(0.5);
	expect(layout.auraStrokeWidth).toBeLessThan(2);
}

function expectFukuHaloVisibleAroundAvatar(layout: Awaited<ReturnType<typeof readEffectSymbolLayout>>): void {
	expect(layout.fukuHaloRingCount).toBe(2);
	expect(layout.fukuHaloRayCounts).toEqual({ warm: 4, light: 5 });
	expect(layout.fukuHaloRays).toHaveLength(9);
	const rgb = (value: string) => value.match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
	const warm = rgb(layout.fukuHaloRayColors.warmFill);
	const light = rgb(layout.fukuHaloRayColors.lightFill);
	const lightOutline = rgb(layout.fukuHaloRayColors.lightStroke);
	expect(warm).toHaveLength(3);
	expect(warm[0]).toBeGreaterThan(warm[1]);
	expect(warm[0]).toBeGreaterThan(warm[2]);
	expect(light).toHaveLength(3);
	expect(Math.min(...light)).toBeGreaterThan(220);
	expect(lightOutline[0]).toBeGreaterThan(lightOutline[1]);
	expect(lightOutline[0]).toBeGreaterThan(lightOutline[2]);
	expect(layout.fukuHaloRayOpacities.warm).toBeGreaterThan(0.5);
	expect(layout.fukuHaloRayOpacities.warm).toBeLessThan(0.9);
	expect(layout.fukuHaloRayOpacities.light).toBeGreaterThan(0.5);
	expect(layout.fukuHaloRayOpacities.light).toBeLessThan(0.9);
	const minX = Math.min(...layout.fukuHaloRays.map((ray) => ray.x));
	const minY = Math.min(...layout.fukuHaloRays.map((ray) => ray.y));
	const maxX = Math.max(...layout.fukuHaloRays.map((ray) => ray.x + ray.width));
	const lightRing = layout.fukuHaloLightRing!;
	const minVisibleOverflow = layout.cell.width * 0.04;
	expect(layout.avatar.x - minX).toBeGreaterThan(minVisibleOverflow);
	expect(maxX - (layout.avatar.x + layout.avatar.width)).toBeGreaterThan(minVisibleOverflow);
	expect(layout.avatar.y - minY).toBeGreaterThan(minVisibleOverflow);
	expect(layout.fukuHaloLightRing).not.toBeNull();
	expect(layout.avatar.x - lightRing.x).toBeGreaterThan(minVisibleOverflow);
	expect(lightRing.x + lightRing.width - (layout.avatar.x + layout.avatar.width)).toBeGreaterThan(minVisibleOverflow);
	expect(layout.avatar.y - lightRing.y).toBeGreaterThan(minVisibleOverflow);
	expect(lightRing.y + lightRing.height - (layout.avatar.y + layout.avatar.height)).toBeGreaterThan(minVisibleOverflow);
}

function expectHornsAboveAvatarAndClearOfName(layout: Awaited<ReturnType<typeof readEffectSymbolLayout>>): void {
	const iconBoxes = [layout.leftHorn, layout.rightHorn];
	expect(iconBoxes.every((box) => box !== null && box.width > 0 && box.height > 0)).toBe(true);
	const boxes = iconBoxes.filter((box): box is Box => box !== null);
	const cellCentre = layout.cell.x + layout.cell.width / 2;
	const avatarTopHalf = layout.avatar.y + layout.avatar.height * 0.48;
	for (const box of boxes) {
		expect(box.y).toBeLessThan(layout.cell.y + layout.cell.height * 0.25);
		expect(box.y + box.height).toBeLessThan(avatarTopHalf);
		expect(box.y + box.height <= layout.name.y || box.y >= layout.name.y + layout.name.height).toBe(true);
	}
	expect(boxes[0].x + boxes[0].width / 2).toBeLessThan(cellCentre);
	expect(boxes[1].x + boxes[1].width / 2).toBeGreaterThan(cellCentre);
	expect(layout.visualZ).toBeGreaterThan(layout.buttonZ);
	expect(layout.auraZ).toBeLessThan(layout.buttonZ);
	expect(layout.visualAnimationName).toBe('none');
	expect(layout.pointerEvents).toBe('none');
}

function expectMalletBottomRightOfAvatarAndOutsideFace(layout: Awaited<ReturnType<typeof readEffectSymbolLayout>>): void {
	const mallet = layout.mallet;
	const head = layout.malletHead;
	const shaft = layout.malletShaft;
	expect(mallet && mallet.width > 0 && mallet.height > 0).toBeTruthy();
	expect(head && head.width > 0 && head.height > 0).toBeTruthy();
	expect(shaft && shaft.width > 0 && shaft.height > 0).toBeTruthy();
	const headCentreX = head!.x + head!.width / 2;
	const headCentreY = head!.y + head!.height / 2;
	const avatarCentreX = layout.avatar.x + layout.avatar.width / 2;
	const avatarCentreY = layout.avatar.y + layout.avatar.height / 2;
	expect(headCentreX).toBeGreaterThan(avatarCentreX);
	expect(headCentreY).toBeGreaterThan(avatarCentreY);
	const overlaps = (first: Box, second: Box) => first.x < second.x + second.width && first.x + first.width > second.x && first.y < second.y + second.height && first.y + first.height > second.y;
	const faceSafeZone: Box = {
		x: layout.avatar.x + layout.avatar.width * 0.15,
		y: layout.avatar.y + layout.avatar.height * 0.15,
		width: layout.avatar.width * 0.7,
		height: layout.avatar.height * 0.7
	};
	// The mallet may sit beside the avatar edge, but must stay out of the central face area.
	expect(overlaps(head!, faceSafeZone)).toBe(false);
	const shaftCentreX = shaft!.x + shaft!.width / 2;
	const shaftCentreY = shaft!.y + shaft!.height / 2;
	expect(shaftCentreX).toBeGreaterThan(headCentreX);
	expect(shaftCentreY).toBeGreaterThan(headCentreY);
	expect(layout.visualZ).toBeGreaterThan(layout.buttonZ);
	expect(layout.auraZ).toBeLessThan(layout.buttonZ);
	expect(layout.visualAnimationName).toBe('none');
	expect(layout.pointerEvents).toBe('none');
}

async function expectMalletDoesNotCoverVisibleNameText(holder: Locator): Promise<void> {
	const name = holder.locator('.participant-name');
	const mallet = holder.locator('[data-fuku-mallet]');
	const textColor = await name.evaluate((element) => getComputedStyle(element).color);
	const rgb = textColor.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number);
	expect(rgb).toHaveLength(3);
	const actual = await name.screenshot({ animations: 'disabled' });
	const previousVisibility = await mallet.getAttribute('visibility');
	let unobscured: Buffer;
	try {
		await mallet.evaluate((element) => element.setAttribute('visibility', 'hidden'));
		unobscured = await name.screenshot({ animations: 'disabled' });
	} finally {
		await mallet.evaluate((element, visibility) => {
			if (visibility === null) element.removeAttribute('visibility');
			else element.setAttribute('visibility', visibility);
		}, previousVisibility);
	}
	const [actualImage, unobscuredImage] = await Promise.all([actual, unobscured!].map((image) => sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
	expect(actualImage.info.width).toBe(unobscuredImage.info.width);
	expect(actualImage.info.height).toBe(unobscuredImage.info.height);
	let visibleTextPixels = 0;
	let coveredTextPixels = 0;
	// Use captured pixels so CSS ellipsis clipping and the actual painted glyphs
	// are respected; DOM Range boxes include hidden text beyond the label edge.
	// Matching the text color's core pixels also excludes the badge border/background.
	for (let index = 0; index < unobscuredImage.data.length; index += 4) {
		const matchesText = rgb!.every((channel, component) => Math.abs(unobscuredImage.data[index + component] - channel) <= 40);
		if (!matchesText) continue;
		visibleTextPixels++;
		if (rgb!.some((channel, component) => Math.abs(actualImage.data[index + component] - unobscuredImage.data[index + component]) > 24)) coveredTextPixels++;
	}
	expect(visibleTextPixels).toBeGreaterThan(0);
	expect(coveredTextPixels).toBe(0);
}

function expectMalletHeadAndShaftToMeet(layout: Awaited<ReturnType<typeof readEffectSymbolLayout>>): void {
	expect(layout.malletGeometry).not.toBeNull();
	const { shaft, head, groupTransform, shaftTransform, headTransform, shaftSharesParentWithHead } = layout.malletGeometry!;
	expect(shaft.tagName).toBe('rect');
	expect(head.tagName).toBe('rect');
	expect(shaft.width).toBeLessThan(head.width);
	expect(shaft.height).toBeGreaterThan(head.height);
	expect(shaft.rx).toBeGreaterThan(0);
	expect(head.rx).toBeGreaterThan(0);
	expect(shaft.x + shaft.width / 2).toBe(head.x + head.width / 2);
	expect(shaft.y).toBeLessThan(head.y + head.height);
	expect(shaft.y + shaft.height).toBeGreaterThan(head.y + head.height);
	expect(shaftSharesParentWithHead).toBe(true);
	expect(groupTransform).toMatch(/rotate\(/);
	expect(shaftTransform).toBeNull();
	expect(headTransform).toBeNull();
}

async function synchronizeBrowserClocks(pages: readonly Page[]): Promise<void> {
	const nowMs = Math.max(...await Promise.all(pages.map((page) => page.evaluate(() => Date.now()))));
	await Promise.all(pages.map((page) => page.clock.setSystemTime(nowMs)));
}

async function injectRealtime(page: Page, event: NostrEvent): Promise<void> {
	await page.evaluate((next) => (window as typeof window & { __relayStartupTest: { injectRealtimeEvent(event: object): void } }).__relayStartupTest.injectRealtimeEvent(next), event);
}

async function injectPosition(page: Page, event: NostrEvent): Promise<void> {
	await page.evaluate((next) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(next), event);
}

async function injectWorldMessage(page: Page, event: NostrEvent): Promise<void> {
	await page.evaluate((next) => (window as typeof window & { __relayStartupTest: { injectMessage(event: object): void } }).__relayStartupTest.injectMessage(next), event);
}

async function setRealtimePublishDeferral(page: Page, deferred: boolean): Promise<void> {
	await page.evaluate((shouldDefer) => {
		const testRelay = (window as typeof window & { __relayStartupTest: { deferRealtimePublishes(): void; releaseRealtimePublishes(): void } }).__relayStartupTest;
		if (shouldDefer) testRelay.deferRealtimePublishes();
		else testRelay.releaseRealtimePublishes();
	}, deferred);
}

async function findLatestGameEvent(page: Page, gameId: string): Promise<NostrEvent | null> {
	const events = await page.evaluate((id) => {
		const published = (window as typeof window & { __relayStartupTest: { state: { published: Array<Record<string, unknown>> } } }).__relayStartupTest.state.published;
		return published.filter((candidate) => candidate.kind === 37070 && candidate.tags && (candidate.tags as string[][]).some((tag) => tag[0] === 'd' && tag[1] === id));
	}, gameId);
	const event = (events as unknown as NostrEvent[]).sort((first, second) => Number(second.created_at) - Number(first.created_at) ||
		(parseTagGameEvent(second, CHANNEL_ID)?.state.revision ?? -1) - (parseTagGameEvent(first, CHANNEL_ID)?.state.revision ?? -1))[0] ?? null;
	return event;
}

async function latestGameEvent(page: Page, gameId: string): Promise<NostrEvent> {
	const event = await findLatestGameEvent(page, gameId);
	if (!event) throw new Error(`No published tag-game state for ${gameId}.`);
	return event;
}

async function latestTagGameStateValue<T>(page: Page, gameId: string, select: (state: TagGameState) => T): Promise<T | null> {
	const event = await findLatestGameEvent(page, gameId);
	if (!event) return null;
	const state = parseTagGameEvent(event, CHANNEL_ID)?.state;
	return state ? select(state) : null;
}

async function latestWorldState(page: Page, author: string): Promise<NostrEvent> {
	return latestPublished(page, WORLD_STATE_KIND, author);
}

async function latestPublished(page: Page, kind: number, author?: string): Promise<NostrEvent> {
	const result = await page.evaluate(({ eventKind, pubkey }) => {
		const published = (window as typeof window & { __relayStartupTest: { state: { published: Array<Record<string, unknown>> } } }).__relayStartupTest.state.published;
		const matches = published.map((event, index) => ({ event, index })).filter(({ event }) => event.kind === eventKind && (!pubkey || event.pubkey === pubkey))
			.sort((first, second) => Number(second.event.created_at) - Number(first.event.created_at) || second.index - first.index)[0]?.event ?? null;
		return { event: matches, published: published.map((candidate) => ({ kind: candidate.kind, pubkey: candidate.pubkey })) };
	}, { eventKind: kind, pubkey: author });
	if (!result.event) throw new Error(`No published event of kind ${kind} by ${author ?? 'any author'}; saw ${JSON.stringify(result.published)}.`);
	return result.event as unknown as NostrEvent;
}

async function latestTagGameAction(page: Page, author: string, action: string): Promise<NostrEvent> {
	const events = await page.evaluate((pubkey) => (window as typeof window & { __relayStartupTest: { state: { published: Array<Record<string, unknown>> } } }).__relayStartupTest.state.published
		.filter((event) => event.kind === 27070 && event.pubkey === pubkey), author);
	const event = (events as unknown as NostrEvent[]).reverse().find((candidate) => parseTagGameActionEvent(candidate, CHANNEL_ID)?.action === action);
	if (!event) throw new Error(`No published ${action} action by ${author}.`);
	return event;
}

async function tagGamePersistence(page: Page): Promise<{ lock: unknown; reservation: unknown; receipt: unknown; savedPoints: number | null }> {
	return page.evaluate(() => new Promise((resolve, reject) => {
		const open = indexedDB.open('persona-bubble-field-account', 9);
		open.onerror = () => reject(open.error);
		open.onsuccess = () => {
			const database = open.result;
			const request = database.transaction('persona-bubble-field-player-state', 'readonly').objectStore('persona-bubble-field-player-state').get('player-lifecycle');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const state = request.result;
				resolve({ lock: state?.tagGame?.lock ?? null, reservation: state?.tagGame?.reservation ?? null, receipt: state?.realtimeSettlementLedger?.tagGameReceipt ?? null, savedPoints: state?.mode?.kind === 'running' ? state.mode.activeRun.gameState.points : null });
				database.close();
			};
		};
	}));
}

async function exerciseTagGameControlsAtViewport(page: Page, gameId: string, viewport: { width: number; height: number }): Promise<void> {
	await page.setViewportSize(viewport);
	const hud = page.locator(`[data-tag-game-hud-id="${gameId}"]`);
	const speaker = page.getByRole('button', { name: /Open sound settings/ });
	const leave = page.locator(`[data-tag-game-leave="${gameId}"]`);
	await expect(hud).toBeVisible();
	await expect(speaker).toBeVisible();
	await expect(leave).toBeVisible();
	await expect(page.locator('.action-dock').getByRole('button', { name: /Open sound settings/ })).toBeVisible();
	const [hudBox, speakerBox] = await Promise.all([hud.boundingBox(), speaker.boundingBox()]);
	expect(hudBox && speakerBox).toBeTruthy();
	if (speakerBox) {
		expect(speakerBox.x).toBeGreaterThanOrEqual(0);
		expect(speakerBox.y).toBeGreaterThanOrEqual(0);
		expect(speakerBox.x + speakerBox.width).toBeLessThanOrEqual(viewport.width);
		expect(speakerBox.y + speakerBox.height).toBeLessThanOrEqual(viewport.height);
	}
	const effectText = hud.locator('.game-hud-effect span');
	await expect(effectText).toBeVisible();
	const effectTextBox = await effectText.boundingBox();
	expect(effectTextBox && hudBox).toBeTruthy();
	if (effectTextBox && hudBox) {
		expect(effectTextBox.x).toBeGreaterThanOrEqual(hudBox.x);
		expect(effectTextBox.x + effectTextBox.width).toBeLessThanOrEqual(hudBox.x + hudBox.width);
	}
	const normalHud = page.locator('[data-unified-status-hud]');
	if (await normalHud.count()) {
		const [normalHudBox, gameHudBox] = await Promise.all([normalHud.boundingBox(), hud.boundingBox()]);
		expect(normalHudBox && gameHudBox).toBeTruthy();
		if (normalHudBox && gameHudBox) expect(gameHudBox.y).toBeGreaterThanOrEqual(normalHudBox.y + normalHudBox.height);
	}
	await speaker.click();
	const slider = page.getByRole('slider', { name: 'Sound volume' });
	await expect(slider).toBeVisible();
	const popoverBox = await page.getByRole('dialog', { name: 'Sound settings' }).boundingBox();
	const currentSpeakerBox = await speaker.boundingBox();
	expect(currentSpeakerBox && popoverBox).toBeTruthy();
	if (currentSpeakerBox && popoverBox) {
		expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(currentSpeakerBox.y + 1);
		expect(popoverBox.x).toBeGreaterThanOrEqual(0);
		expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(viewport.width);
		expect(popoverBox.y).toBeGreaterThanOrEqual(0);
	}
	await slider.fill('35');
	await expect(slider).toHaveValue('35');
	await speaker.click();
	await expect(slider).toBeHidden();
	const actionCount = (await relayState(page)).state.published.filter((event) => event.kind === 27070).length;
	await leave.click();
	await expect.poll(async () => (await relayState(page)).state.published.filter((event) => event.kind === 27070).length).toBeGreaterThan(actionCount);
	await expect(leave).toBeVisible();
}

async function installTagGameAudioRecorder(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const key = 'tag-game-audio-recording';
	const record = (duration: number) => {
		const values = JSON.parse(sessionStorage.getItem(key) ?? '[]') as number[];
		values.push(duration);
		sessionStorage.setItem(key, JSON.stringify(values));
	};
		class TestAudioContext {
			state: AudioContextState = 'suspended';
			currentTime = 0;
			sampleRate = 10_000;
			destination = {} as AudioDestinationNode;
			createGain() { return { gain: { value: 1, cancelScheduledValues() {}, setTargetAtTime() {} }, connect() {} } as unknown as GainNode; }
			createBuffer(_channels: number, length: number, sampleRate: number) {
				const channel = new Float32Array(length);
				return { duration: length / sampleRate, getChannelData: () => channel } as unknown as AudioBuffer;
			}
			createBufferSource() {
				let buffer: AudioBuffer | null = null;
				return {
					set buffer(value: AudioBuffer | null) { buffer = value; },
					get buffer() { return buffer; },
					connect() {},
					start() { if (buffer) record(buffer.duration); }
				} as unknown as AudioBufferSourceNode;
			}
			resume() { this.state = 'running'; return Promise.resolve(); }
			close() { this.state = 'closed'; return Promise.resolve(); }
		}
		Object.defineProperty(window, 'AudioContext', { configurable: true, value: TestAudioContext });
	});
}

async function recordedTagGameSounds(page: Page): Promise<number[]> {
	return page.evaluate(() => JSON.parse(sessionStorage.getItem('tag-game-audio-recording') ?? '[]') as number[]);
}

function createAudioTestGame(selfPubkey: string, hostPubkey: string, startAt: number, seed: string, suffix: string) {
	const proposalId = 'd'.repeat(32);
	const gameId = `${hostPubkey}:${startAt - 1}:${suffix.repeat(64)}`;
	const participant = [selfPubkey, hostPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: startAt - 10,
		consentProposalId: proposalId, consented: true, status: 'registered' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 }));
	const countdown: TagGameState = { gameId, hostPubkey, phase: 'countdown', revision: 0, updatedAt: startAt - 1, proposalId,
		startAt, participant, settledAtMs: (startAt - 1) * 1_000 };
	const running: TagGameState = { ...countdown, phase: 'running', revision: 1, updatedAt: startAt, startedAt: startAt,
		endsAt: startAt + 120, seed, ownerPubkey: selfPubkey, effect: 'benefit', transferAt: startAt * 1_000,
		lastHolderResponseAtMs: startAt * 1_000, participant: participant.map((member) => ({ ...member, status: 'active' as const })),
		settledAtMs: startAt * 1_000 };
	return { gameId, participant, countdown, running };
}

async function setFakeDocumentHidden(page: Page, hidden: boolean): Promise<void> {
	await page.evaluate((nextHidden) => {
		Object.defineProperty(document, 'hidden', { configurable: true, value: nextHidden });
		document.dispatchEvent(new Event('visibilitychange'));
	}, hidden);
}

async function unlockSoundFromTheUI(page: Page): Promise<void> {
	await page.getByRole('button', { name: /Open sound settings/ }).click();
	await expect(page.getByRole('dialog', { name: 'Sound settings' })).toBeVisible();
	await page.keyboard.press('Escape');
}

async function injectSelfOwnedProjection(page: Page, secret: Uint8Array, effect: 'benefit' | 'calamity', seed: string, nowMs: number): Promise<void> {
	const pubkey = getPublicKey(secret);
	const startedAt = Math.floor(nowMs / 1_000);
	const gameId = `${pubkey}:${startedAt}:${effect === 'benefit' ? 'a'.repeat(64) : 'b'.repeat(64)}`;
	const state: TagGameState = {
		gameId, hostPubkey: pubkey, phase: 'running', revision: 0, updatedAt: startedAt, startedAt, endsAt: startedAt + 120,
		seed, ownerPubkey: pubkey, effect, transferAt: nowMs, lastHolderResponseAtMs: nowMs,
		participant: [{ pubkey, runNumber: 1, registeredAt: startedAt, status: 'active', points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 }],
		settledAtMs: nowMs
	};
	await injectRealtime(page, finalizeTagGameState(state, CHANNEL_ID, startedAt, secret));
}

async function seedTagGameRunLock(page: Page, gameId: string, startedAtMs: number): Promise<void> {
	await page.evaluate(({ id, start }) => new Promise<void>((resolve, reject) => {
		const open = indexedDB.open('persona-bubble-field-account', 9);
		open.onerror = () => reject(open.error);
		open.onsuccess = () => {
			const database = open.result;
			const transaction = database.transaction('persona-bubble-field-player-state', 'readwrite');
			const store = transaction.objectStore('persona-bubble-field-player-state');
			const request = store.get('player-lifecycle');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const player = request.result;
				const run = player.mode.activeRun;
				const scope = { gameId: id, identity: run.identity, runNumber: run.runNumber };
				const endsAtMs = start + 120_000;
				store.put({ ...player, tagGame: { reservation: scope, lock: { ...scope, startedAtMs: start, endsAtMs, finalDeadlineMs: endsAtMs + 30_000, phase: 'running', points: 0, lifespanLossMs: 0 } } }, 'player-lifecycle');
			};
			transaction.oncomplete = () => { database.close(); resolve(); };
			transaction.onerror = () => reject(transaction.error);
		};
	}), { id: gameId, start: startedAtMs });
}

test('keeps the tag-game benefit pulse in phase during repeated point gains and ignores ordinary lifespan countdown', async ({ page }) => {
	const nowMs = Date.now();
	const secret = fixtureSecret(53);
	await installTagGameAudioRecorder(page);
	await preparePlayer(page, secret, nowMs);
	await expect(page.locator('main')).toHaveAttribute('data-realtime-status', 'active');
	await moveRelaySelfTo(page, { x: 7, y: 5 });
	await unlockSoundFromTheUI(page);
	// Movement advances the Playwright clock to respect the World position
	// publish limit. Start the projection at the resulting, frozen time so the
	// initial HUD baseline cannot accrue points while the test is setting up.
	const projectionStartedAtMs = await page.evaluate(() => Math.ceil((Date.now() + 5_000) / 1_000) * 1_000);
	await page.clock.pauseAt(projectionStartedAtMs);
	const seed = Array.from({ length: 10_000 }, (_, index) => `hud-points-${index}`).find((candidate) => createTagGameSchedule(candidate)[0].effect === 'benefit')!;
	await injectSelfOwnedProjection(page, secret, 'benefit', seed, projectionStartedAtMs);
	const hud = page.locator('[data-unified-status-hud]');
	const points = hud.locator('[data-points-value]');
	const lifespan = hud.locator('[data-lifespan-value]');
	await expect(hud).toHaveAttribute('data-tag-game-projection', 'true');
	await expect(hud).toHaveAttribute('data-current-points', '0');
	await expect(points).not.toHaveAttribute('data-value-change', /.+/);
	await expect(points).toHaveAttribute('data-tag-game-flash', 'benefit');
	await expect(points).toHaveCSS('animation-name', /tag-game-value-pulse$/);
	await expect.poll(async () => (await recordedTagGameSounds(page)).filter((duration) => Math.abs(duration - 0.26) < 0.001)).toHaveLength(1);
	expect((await recordedTagGameSounds(page)).filter((duration) => Math.abs(duration - 0.52) < 0.001)).toHaveLength(0);
	await page.evaluate(() => {
		(window as typeof window & { __tagGamePulseIterations?: number }).__tagGamePulseIterations = 0;
		document.addEventListener('animationiteration', (event) => {
			if (event.target instanceof HTMLElement && event.target.matches('[data-points-value]') && event.animationName.endsWith('tag-game-value-pulse')) {
				const target = window as typeof window & { __tagGamePulseIterations?: number };
				target.__tagGamePulseIterations = (target.__tagGamePulseIterations ?? 0) + 1;
			}
		});
	});
	await page.waitForFunction(() => (window as typeof window & { __tagGamePulseIterations?: number }).__tagGamePulseIterations === 1,
		undefined, { polling: 'raf', timeout: 3_000 });
	await expect.poll(async () => (await recordedTagGameSounds(page)).filter((duration) => Math.abs(duration - 0.26) < 0.001)).toHaveLength(2);
	await expect(points).toHaveCSS('animation-duration', '1.5s');
	const pulseOffsets = await points.evaluate((element) => {
		const animation = element.getAnimations().find((candidate): candidate is CSSAnimation =>
			candidate instanceof CSSAnimation && candidate.animationName.endsWith('tag-game-value-pulse'));
		const effect = animation?.effect;
		return effect instanceof KeyframeEffect ? effect.getKeyframes().map((frame) => frame.computedOffset) : [];
	});
	expect(pulseOffsets).toHaveLength(4);
	expect(pulseOffsets[1]).toBeCloseTo(0.2999, 3);
	expect(pulseOffsets[2]).toBeCloseTo(0.3, 3);
	await page.clock.runFor(1_000);
	await expect(points).toHaveAttribute('data-value-change', 'increase');
	const firstSequence = Number(await points.getAttribute('data-value-change-sequence'));
	const pulseStartTime = await points.evaluate((element) => element.getAnimations().find((animation): animation is CSSAnimation =>
		animation instanceof CSSAnimation && animation.animationName.endsWith('tag-game-value-pulse'))?.startTime ?? null);
	expect(pulseStartTime).not.toBeNull();
	await expect(lifespan).not.toHaveAttribute('data-value-change', /.+/);
	const meter = hud.locator('[data-points-meter]');
	const firstMeterBox = await meter.boundingBox();
	const firstRightEdge = await points.evaluate((element) => element.getBoundingClientRect().right);
	await page.clock.runFor(1_000);
	await expect.poll(async () => Number(await points.getAttribute('data-value-change-sequence'))).toBeGreaterThan(firstSequence);
	await expect(points).toHaveAttribute('data-tag-game-flash', 'benefit');
	expect(await points.evaluate((element) => element.getAnimations().find((animation): animation is CSSAnimation =>
		animation instanceof CSSAnimation && animation.animationName.endsWith('tag-game-value-pulse'))?.startTime ?? null)).toBe(pulseStartTime);
	const nextMeterBox = await meter.boundingBox();
	const nextRightEdge = await points.evaluate((element) => element.getBoundingClientRect().right);
	expect(nextMeterBox?.x).toBe(firstMeterBox?.x);
	expect(nextMeterBox?.y).toBe(firstMeterBox?.y);
	expect(nextRightEdge).toBeCloseTo(firstRightEdge, 1);
	await expect.poll(async () => Number(await hud.getAttribute('data-current-points'))).toBeGreaterThan(0);
});

test('signals calamity lifespan loss while ignoring clock-only ticks', async ({ page }) => {
	const nowMs = Date.now();
	const secret = fixtureSecret(59);
	await installTagGameAudioRecorder(page);
	await preparePlayer(page, secret, nowMs);
	await expect(page.locator('main')).toHaveAttribute('data-realtime-status', 'active');
	await moveRelaySelfTo(page, { x: 7, y: 5 });
	await unlockSoundFromTheUI(page);
	const projectionStartedAtMs = await page.evaluate(() => Math.ceil((Date.now() + 5_000) / 1_000) * 1_000);
	await page.clock.pauseAt(projectionStartedAtMs);
	const seed = Array.from({ length: 10_000 }, (_, index) => `hud-life-${index}`).find((candidate) => createTagGameSchedule(candidate)[0].effect === 'calamity')!;
	await injectSelfOwnedProjection(page, secret, 'calamity', seed, projectionStartedAtMs);
	const hud = page.locator('[data-unified-status-hud]');
	const lifespan = hud.locator('[data-lifespan-value]');
	const points = hud.locator('[data-points-value]');
	const savedExpiry = Number(await hud.getAttribute('data-base-expires-at-ms'));
	await page.clock.runFor(1_000);
	await expect(lifespan).toHaveAttribute('data-value-change', 'decrease');
	await expect(lifespan).toHaveAttribute('data-tag-game-flash', 'calamity');
	await expect(lifespan).toHaveCSS('animation-name', /tag-game-value-pulse$/);
	await expect(lifespan).toHaveCSS('animation-duration', '1.5s');
	await expect(lifespan).toHaveCSS('color', 'rgb(255, 104, 117)');
	await expect(points).not.toHaveAttribute('data-value-change', /.+/);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect(lifespan).toHaveCSS('animation-name', 'none');
	await expect(lifespan).toHaveCSS('color', 'rgb(255, 104, 117)');
	const calamitySoundCount = (await recordedTagGameSounds(page)).filter((duration) => Math.abs(duration - 0.11) < 0.001).length;
	expect(calamitySoundCount).toBeGreaterThan(0);
	await page.clock.runFor(2_000);
	await expect.poll(async () => (await recordedTagGameSounds(page)).filter((duration) => Math.abs(duration - 0.11) < 0.001)).toHaveLength(calamitySoundCount);
	const effectiveExpiry = Number(await hud.getAttribute('data-current-expires-at-ms'));
	await expect(hud).toHaveAttribute('data-current-expires-at-ms', String(effectiveExpiry));
	await expect(hud).toHaveAttribute('data-base-expires-at-ms', String(savedExpiry));
});

test('plays tag-game start, scheduled switch, confirmed transfer, and end cues from current signed state', async ({ page }) => {
	const nowMs = Date.now();
	const selfSecret = fixtureSecret(61);
	const hostSecret = fixtureSecret(63);
	await installTagGameAudioRecorder(page);
	await preparePlayer(page, selfSecret, nowMs);
	await unlockSoundFromTheUI(page);
	await moveRelaySelfTo(page, { x: TAG_GAME_TERMINAL.position.x - 1, y: TAG_GAME_TERMINAL.position.y });
	await openTagGameTerminal(page);
	const selfPubkey = getPublicKey(selfSecret);
	const hostPubkey = getPublicKey(hostSecret);
	const startAt = Math.ceil((await page.evaluate(() => Date.now()) + 5_000) / 1_000);
	await page.clock.pauseAt((startAt - 5) * 1_000);
	const seed = Array.from({ length: 10_000 }, (_, index) => `tag-audio-${index}`).find((candidate) => {
		const schedule = createTagGameSchedule(candidate);
		return schedule[0].effect === 'benefit' && schedule[0].durationMs <= 20_000;
	});
	if (!seed) throw new Error('Expected a short opening benefit interval.');
	const proposalId = 'd'.repeat(32);
	const gameId = `${hostPubkey}:${startAt - 5}:${'e'.repeat(64)}`;
	const participant = [selfPubkey, hostPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: startAt - 10,
		consentProposalId: proposalId, consented: true, status: 'registered' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 }));
	const countdown: TagGameState = { gameId, hostPubkey, phase: 'countdown', revision: 0, updatedAt: startAt - 5, proposalId,
		startAt, participant, settledAtMs: (startAt - 5) * 1_000 };
	await page.setViewportSize({ width: 390, height: 844 });
	await injectRealtime(page, finalizeTagGameState(countdown, CHANNEL_ID, startAt - 5, hostSecret));
	await expect(page.getByRole('dialog', { name: '鬼ごっこ' })).toBeHidden();
	await expect(page.locator('[data-tag-game-countdown]')).toBeVisible();
	await expect(page.locator('[data-tag-game-countdown]')).toHaveAttribute('data-countdown-seconds', /[1-5]/);
	const mobileOverlay = await page.locator('[data-tag-game-countdown]').boundingBox();
	expect(mobileOverlay).toEqual({ x: 0, y: 0, width: 390, height: 844 });
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect(page.locator('[data-tag-game-countdown] strong')).toBeVisible();
	await page.setViewportSize({ width: 1280, height: 800 });
	const desktopOverlay = await page.locator('[data-tag-game-countdown]').boundingBox();
	expect(desktopOverlay).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
	await page.clock.setSystemTime(startAt * 1_000);
	await page.clock.runFor(250);
	await expect(page.locator('[data-tag-game-countdown]')).toHaveCount(0);
	const running: TagGameState = { ...countdown, phase: 'running', revision: 1, updatedAt: startAt, startedAt: startAt, endsAt: startAt + 120,
		seed, ownerPubkey: selfPubkey, effect: 'benefit', transferAt: startAt * 1_000, lastHolderResponseAtMs: startAt * 1_000,
		participant: participant.map((member) => ({ ...member, status: 'active' as const })), settledAtMs: startAt * 1_000 };
	await injectRealtime(page, finalizeTagGameState(running, CHANNEL_ID, startAt, hostSecret));
	await injectRealtime(page, finalizeTagGameState(running, CHANNEL_ID, startAt, hostSecret));
	await expect(page.locator('[data-tag-game-hud]')).toBeVisible();
	await expect.poll(async () => (await recordedTagGameSounds(page)).filter((duration) => Math.abs(duration - 0.52) < 0.001)).toHaveLength(1);

	await page.clock.runFor(1_000);
	const pauseAt = startAt + 2;
	await page.clock.setSystemTime(pauseAt * 1_000);
	const stoppedTemporarilyIneligible: TagGameState = { ...running, revision: 2, updatedAt: pauseAt,
		holderChallengeId: 'a'.repeat(32), holderChallengeStartedAtMs: pauseAt * 1_000,
		participant: participant.map((member) => ({ ...member, status: member.pubkey === selfPubkey ? 'temporarily-ineligible' as const : 'active' as const })) };
	await injectRealtime(page, finalizeTagGameState(stoppedTemporarilyIneligible, CHANNEL_ID, pauseAt, hostSecret));
	const firstInterval = createTagGameSchedule(seed)[0].durationMs;
	await page.clock.runFor(firstInterval - 1_000);
	await expect.poll(async () => (await recordedTagGameSounds(page)).filter((duration) => Math.abs(duration - 0.30) < 0.001)).toHaveLength(1);

	const transferAt = Math.floor((await page.evaluate(() => Date.now())) / 1_000) + 1;
	await page.clock.setSystemTime(transferAt * 1_000);
	const transferred: TagGameState = { ...stoppedTemporarilyIneligible, revision: 3, updatedAt: transferAt, ownerPubkey: hostPubkey,
		holderChallengeId: undefined, holderChallengeStartedAtMs: undefined, transferAt: transferAt * 1_000, settledAtMs: transferAt * 1_000 };
	await injectRealtime(page, finalizeTagGameState(transferred, CHANNEL_ID, transferAt, hostSecret));
	await expect.poll(async () => (await recordedTagGameSounds(page)).filter((duration) => Math.abs(duration - 0.34) < 0.001)).toHaveLength(1);

	const endsAt = transferred.endsAt!;
	await page.clock.setSystemTime(endsAt * 1_000 + 200);
	const ended: TagGameState = { ...transferred, phase: 'ended', revision: 4, updatedAt: endsAt, finalizedAt: endsAt, endReason: 'normal' };
	await injectRealtime(page, finalizeTagGameState(ended, CHANNEL_ID, endsAt, hostSecret));
	await expect.poll(async () => (await recordedTagGameSounds(page)).filter((duration) => Math.abs(duration - 0.52) < 0.001)).toHaveLength(2);

	const restoredStartAt = Math.floor((await page.evaluate(() => Date.now())) / 1_000) + 1;
	const restoredGameId = `${hostPubkey}:${restoredStartAt}:${'f'.repeat(64)}`;
	await page.clock.setSystemTime(restoredStartAt * 1_000);
	const restoredRunning: TagGameState = { ...running, gameId: restoredGameId, revision: 0, updatedAt: restoredStartAt,
		startedAt: restoredStartAt, endsAt: restoredStartAt + 120, transferAt: restoredStartAt * 1_000,
		lastHolderResponseAtMs: restoredStartAt * 1_000, settledAtMs: restoredStartAt * 1_000 };
	await injectRealtime(page, finalizeTagGameState(restoredRunning, CHANNEL_ID, restoredStartAt, hostSecret));
	await expect.poll(async () => (await recordedTagGameSounds(page)).filter((duration) => Math.abs(duration - 0.52) < 0.001)).toHaveLength(2);
	const interruptionAt = restoredStartAt + 1;
	await page.clock.setSystemTime(interruptionAt * 1_000);
	const interrupted: TagGameState = { ...restoredRunning, phase: 'interrupted', revision: 1, updatedAt: interruptionAt,
		endReason: 'host-unavailable' };
	await injectRealtime(page, finalizeTagGameState(interrupted, CHANNEL_ID, interruptionAt, hostSecret));
	await expect.poll(async () => (await recordedTagGameSounds(page)).filter((duration) => Math.abs(duration - 0.52) < 0.001)).toHaveLength(3);
});

test('does not replay restored start and transfer cues during initial Realtime bootstrap', async ({ page }) => {
	const nowMs = Date.now();
	const selfSecret = fixtureSecret(33);
	const hostSecret = fixtureSecret(37);
	const selfPubkey = getPublicKey(selfSecret);
	const hostPubkey = getPublicKey(hostSecret);
	const startAt = Math.floor(nowMs / 1_000);
	const seed = Array.from({ length: 10_000 }, (_, index) => `tag-audio-bootstrap-${index}`).find((candidate) => createTagGameSchedule(candidate)[0].effect === 'benefit')!;
	const game = createAudioTestGame(selfPubkey, hostPubkey, startAt, seed, 'a');
	const countdownEvent = finalizeTagGameState(game.countdown, CHANNEL_ID, startAt - 1, hostSecret);
	const runningEvent = finalizeTagGameState(game.running, CHANNEL_ID, startAt, hostSecret);
	await page.clock.install({ time: nowMs });
	await installTagGameAudioRecorder(page);
	await installHostOwnedStub(page);
	await installDelayedRelay(page, { primaryEvents: testEvents(nowMs), realtimeEvents: [countdownEvent, runningEvent], deferRealtimeEvents: true });
	await seedRelayAccount(page, selfSecret, selfPubkey, nowMs + 14 * 24 * 60 * 60 * 1_000);
	await page.goto('/');
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toBeVisible();
	await unlockSoundFromTheUI(page);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseRealtimeEvents(): void } }).__relayStartupTest.releaseRealtimeEvents());
	await expect(page.locator('main')).toHaveAttribute('data-realtime-status', 'active');
	await expect(page.locator('[data-tag-game-hud]')).toBeVisible();
	const restoredSounds = await recordedTagGameSounds(page);
	for (const oneShotDuration of [0.30, 0.34, 0.52]) {
		expect(restoredSounds.filter((duration) => Math.abs(duration - oneShotDuration) < 0.001)).toHaveLength(0);
	}

	const liveAt = startAt + 2;
	await page.clock.setSystemTime(liveAt * 1_000);
	const liveTransfer: TagGameState = { ...game.running, revision: 2, updatedAt: liveAt, ownerPubkey: hostPubkey,
		transferAt: liveAt * 1_000, settledAtMs: liveAt * 1_000 };
	await injectRealtime(page, finalizeTagGameState(liveTransfer, CHANNEL_ID, liveAt, hostSecret));
	await expect.poll(async () => (await recordedTagGameSounds(page)).filter((duration) => Math.abs(duration - 0.34) < 0.001)).toHaveLength(1);
});

test('does not replay a restored owner transfer during a Realtime reconnect', async ({ page }) => {
	const nowMs = Date.now();
	const selfSecret = fixtureSecret(39);
	const hostSecret = fixtureSecret(41);
	await installTagGameAudioRecorder(page);
	await preparePlayer(page, selfSecret, nowMs);
	await unlockSoundFromTheUI(page);
	const selfPubkey = getPublicKey(selfSecret);
	const hostPubkey = getPublicKey(hostSecret);
	const startAt = Math.floor(nowMs / 1_000) + 1;
	const seed = Array.from({ length: 10_000 }, (_, index) => `tag-audio-reconnect-${index}`).find((candidate) => createTagGameSchedule(candidate)[0].effect === 'benefit')!;
	const game = createAudioTestGame(selfPubkey, hostPubkey, startAt, seed, 'b');
	await page.clock.setSystemTime((startAt - 1) * 1_000);
	await injectRealtime(page, finalizeTagGameState(game.countdown, CHANNEL_ID, startAt - 1, hostSecret));
	await page.clock.setSystemTime(startAt * 1_000);
	await injectRealtime(page, finalizeTagGameState(game.running, CHANNEL_ID, startAt, hostSecret));
	await expect.poll(async () => (await recordedTagGameSounds(page)).filter((duration) => Math.abs(duration - 0.52) < 0.001)).toHaveLength(1);

	const restoredAt = startAt + 6;
	const restoredTransfer: TagGameState = { ...game.running, revision: 2, updatedAt: restoredAt, ownerPubkey: hostPubkey,
		transferAt: restoredAt * 1_000, settledAtMs: restoredAt * 1_000 };
	const restoredEvent = finalizeTagGameState(restoredTransfer, CHANNEL_ID, restoredAt, hostSecret);
	await page.clock.setSystemTime((startAt + 1) * 1_000);
	await page.evaluate((event) => {
		const state = (window as typeof window & { __relayStartupTest: { state: { realtimeHistory: Array<Record<string, unknown>> }; disconnectRealtime(): void } }).__relayStartupTest;
		state.state.realtimeHistory.push(event as unknown as Record<string, unknown>);
		state.disconnectRealtime();
	}, restoredEvent);
	await page.clock.runFor(5_000);
	await expect.poll(async () => (await relayState(page)).state.requests.filter((request) => request.filters.some((filter) => (filter.kinds as number[] | undefined)?.includes(TAG_GAME_KIND))).length).toBeGreaterThan(1);
	await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toHaveAttribute('data-tag-game-role', 'participant');
	expect((await recordedTagGameSounds(page)).filter((duration) => Math.abs(duration - 0.34) < 0.001)).toHaveLength(0);
});

test('rebases hidden-tab game audio cues on resume and keeps the resumed pulse audio in sync', async ({ page }) => {
	const nowMs = Date.now();
	const selfSecret = fixtureSecret(43);
	const hostSecret = fixtureSecret(47);
	await installTagGameAudioRecorder(page);
	await preparePlayer(page, selfSecret, nowMs);
	await unlockSoundFromTheUI(page);
	const selfPubkey = getPublicKey(selfSecret);
	const hostPubkey = getPublicKey(hostSecret);
	const startAt = Math.floor(nowMs / 1_000) + 1;
	const seed = Array.from({ length: 10_000 }, (_, index) => `tag-audio-hidden-${index}`).find((candidate) => {
		const first = createTagGameSchedule(candidate)[0];
		return first.effect === 'benefit' && first.durationMs <= 11_000;
	})!;
	const game = createAudioTestGame(selfPubkey, hostPubkey, startAt, seed, 'c');
	await page.clock.setSystemTime((startAt - 1) * 1_000);
	await injectRealtime(page, finalizeTagGameState(game.countdown, CHANNEL_ID, startAt - 1, hostSecret));
	await page.clock.setSystemTime(startAt * 1_000);
	await injectRealtime(page, finalizeTagGameState(game.running, CHANNEL_ID, startAt, hostSecret));
	await expect.poll(async () => (await recordedTagGameSounds(page)).filter((duration) => Math.abs(duration - 0.52) < 0.001)).toHaveLength(1);
	await page.clock.runFor(1_000);
	const firstInterval = createTagGameSchedule(seed)[0].durationMs;
	await page.clock.pauseAt(startAt * 1_000 + Math.floor(firstInterval / 2));
	await setFakeDocumentHidden(page, true);
	const resumedAt = startAt * 1_000 + firstInterval + 100;
	await page.clock.setSystemTime(resumedAt);
	await setFakeDocumentHidden(page, false);
	const hud = page.locator('[data-tag-game-hud]');
	await expect(hud.locator('.game-hud-effect')).toHaveAttribute('data-tag-game-effect', 'calamity');
	await expect(page.locator('[data-unified-status-hud] [data-lifespan-value]')).toHaveCSS('animation-name', /tag-game-value-pulse$/);
	expect((await recordedTagGameSounds(page)).filter((duration) => Math.abs(duration - 0.30) < 0.001)).toHaveLength(0);
	await expect.poll(async () => (await recordedTagGameSounds(page)).filter((duration) => Math.abs(duration - 0.11) < 0.001), { timeout: 4_000 }).toHaveLength(1);

	await setFakeDocumentHidden(page, true);
	const endsAt = game.running.endsAt!;
	await page.clock.setSystemTime((endsAt + 1) * 1_000);
	const ended: TagGameState = { ...game.running, revision: 2, phase: 'ended', updatedAt: endsAt, finalizedAt: endsAt, endReason: 'normal' };
	await injectRealtime(page, finalizeTagGameState(ended, CHANNEL_ID, endsAt, hostSecret));
	const endSoundCount = (await recordedTagGameSounds(page)).filter((duration) => Math.abs(duration - 0.52) < 0.001).length;
	await setFakeDocumentHidden(page, false);
	await page.clock.runFor(500);
	expect((await recordedTagGameSounds(page)).filter((duration) => Math.abs(duration - 0.52) < 0.001)).toHaveLength(endSoundCount);
});

async function openTagGameTerminal(page: Page): Promise<void> {
	const facility = page.locator('[data-field-facility="tag-game-terminal"]');
	await expect(facility.locator('img')).toHaveAttribute('src', /field\/objects\/tag-game-terminal\.webp$/);
	await expect(facility).not.toContainText('鬼');
	const chatter = page.locator('aside[aria-label="Chatter"]');
	if (await chatter.isVisible()) {
		await page.keyboard.press('c');
		await expect(chatter).toBeHidden();
	}
	const self = page.locator('.participant[data-self="true"]');
	const position = await self.getAttribute('data-position');
	const action = page.locator('[data-cell-action="tag-game-terminal"]');
	const dialog = page.getByRole('dialog', { name: '鬼ごっこ' });
	await expect.poll(async () => {
		if (await dialog.isVisible()) return true;
		await clickRelayLogicalCell(page, TAG_GAME_TERMINAL.position);
		if (await action.isVisible()) await action.click();
		return dialog.isVisible();
	}, { timeout: 10_000, message: `Expected the tag-game terminal to open from self position ${position}.` }).toBe(true);
	await expectIconCloseButton(page.getByRole('dialog', { name: '鬼ごっこ' }).getByRole('button', { name: '閉じる' }), '閉じる');
}

test('tag game rules stay usable across desktop and mobile terminal states', async ({ page }) => {
	const secret = fixtureSecret(53);
	const nowMs = Date.now();
	await page.setViewportSize({ width: 1280, height: 800 });
	await preparePlayer(page, secret, nowMs);
	await moveRelaySelfTo(page, { x: TAG_GAME_TERMINAL.position.x - 1, y: TAG_GAME_TERMINAL.position.y });
	await openTagGameTerminal(page);
	const dialog = page.getByRole('dialog', { name: '鬼ごっこ' });
	const rules = dialog.locator('.tag-game-rules');
	await expect(dialog.getByText('2〜8人 · 2分')).toBeVisible();
	await expect(dialog.getByText('鬼になった者は、毎秒1時間の寿命を失います。寿命が尽きれば死亡します。')).toBeVisible();
	await expect(rules).not.toHaveAttribute('open', '');
	const summary = rules.locator('summary');
	await summary.focus();
	await page.keyboard.press('Enter');
	await expect(rules).toHaveAttribute('open', '');
	await expect(summary).toContainText('ルールを閉じる');
	await expect(rules.getByText('福を持たない者は、所持者にタッチして福を奪えます。')).toBeVisible();
	await expect(rules.getByText('鬼は他の参加者にタッチして、鬼を押し付けられます。')).toBeVisible();
	await expect(rules.getByText('福と鬼は交互に切り替わります。')).toBeVisible();
	await expect(rules.getByText('隣接した相手にのみタッチできます。')).toBeVisible();
	const fukuRuleIcon = rules.locator('.tag-game-effect-benefit .tag-game-effect-symbol-icon');
	const oniRuleIcon = rules.locator('.tag-game-effect-calamity .tag-game-effect-symbol-icon');
	await expect(fukuRuleIcon).toHaveAttribute('aria-hidden', 'true');
	await expect(oniRuleIcon).toHaveAttribute('aria-hidden', 'true');
	await expect(fukuRuleIcon.locator('[data-tag-game-effect-symbol="benefit"] [data-fuku-mallet-head]')).toHaveCount(1);
	await expect(fukuRuleIcon.locator('[data-fuku-mallet-handle]')).toHaveCount(1);
	await expect(oniRuleIcon.locator('[data-tag-game-effect-symbol="calamity"] .oni-horn')).toHaveCount(2);
	await expect(rules.locator('.tag-game-effect-symbol-icon .fuku-halo, .tag-game-effect-symbol-icon .oni-smoke')).toHaveCount(0);
	for (const icon of [fukuRuleIcon, oniRuleIcon]) {
		const iconBounds = await icon.boundingBox();
		const symbolBounds = await icon.locator('[data-tag-game-effect-symbol]').boundingBox();
		expect(iconBounds && symbolBounds && symbolBounds.width > 0 && symbolBounds.height > 0).toBe(true);
		const strokeOverflowTolerance = 1.25;
		expect(symbolBounds!.x).toBeGreaterThanOrEqual(iconBounds!.x - strokeOverflowTolerance);
		expect(symbolBounds!.y).toBeGreaterThanOrEqual(iconBounds!.y - strokeOverflowTolerance);
		expect(symbolBounds!.x + symbolBounds!.width).toBeLessThanOrEqual(iconBounds!.x + iconBounds!.width + strokeOverflowTolerance);
		expect(symbolBounds!.y + symbolBounds!.height).toBeLessThanOrEqual(iconBounds!.y + iconBounds!.height + strokeOverflowTolerance);
	}
	await expect(rules.getByRole('heading', { name: '参加と開始' })).toHaveCount(0);
	await expect(rules.getByRole('heading', { name: 'ゲーム中' })).toHaveCount(0);
	const [benefitBox, calamityBox] = await Promise.all([
		rules.locator('.tag-game-effect-benefit').boundingBox(),
		rules.locator('.tag-game-effect-calamity').boundingBox()
	]);
	expect(benefitBox && calamityBox && calamityBox.y >= benefitBox.y + benefitBox.height).toBe(true);
	await expect(dialog.getByRole('button', { name: '鬼ごっこを開催' })).toHaveAttribute('data-action-variant', 'primary');
	await summary.focus();
	await page.keyboard.press('Enter');
	await expect(rules).not.toHaveAttribute('open', '');
	await expect(rules.locator('.tag-game-rules-content')).toBeHidden();
	await summary.focus();
	await page.keyboard.press('Enter');
	await expect(rules).toHaveAttribute('open', '');
	await dialog.getByRole('button', { name: '鬼ごっこを開催' }).click();
	await expect(dialog.getByText('あなたの開催')).toBeVisible();
	await expect(rules).toHaveAttribute('open', '');

	await page.setViewportSize({ width: 390, height: 640 });
	await dialog.evaluate((element) => { element.scrollTop = 0; });
	await summary.focus();
	await page.keyboard.press('Enter');
	await expect(rules).not.toHaveAttribute('open', '');
	await summary.focus();
	await page.keyboard.press('Enter');
	await expect(rules).toHaveAttribute('open', '');
	await dialog.evaluate((element) => { element.scrollTop = 0; });
	const [mobileBenefitBox, mobileCalamityBox] = await Promise.all([
		rules.locator('.tag-game-effect-benefit').boundingBox(),
		rules.locator('.tag-game-effect-calamity').boundingBox()
	]);
	expect(mobileBenefitBox && mobileCalamityBox && mobileCalamityBox.y >= mobileBenefitBox.y + mobileBenefitBox.height).toBe(true);
	await summary.focus();
	await page.keyboard.press('Enter');
	await expect(rules).not.toHaveAttribute('open', '');
	await expect(rules.locator('.tag-game-rules-content')).toBeHidden();
	await summary.focus();
	await page.keyboard.press('Enter');
	await expect(rules).toHaveAttribute('open', '');
	await dialog.evaluate((element) => { element.scrollTop = element.scrollHeight; });
	await expect(dialog.getByRole('button', { name: '閉じる' })).toBeVisible();
	await expect(dialog.getByRole('button', { name: '開始を提案' })).toBeVisible();
	await dialog.getByRole('button', { name: '閉じる' }).click();
	await expect(dialog).toHaveCount(0);
	await openTagGameTerminal(page);
	await expect(page.getByRole('dialog', { name: '鬼ごっこ' }).locator('.tag-game-rules')).not.toHaveAttribute('open', '');
});

test('three Fake Relay clients create, join, consent, start, touch, and settle through the field UI', async ({ browser }) => {
	test.setTimeout(90_000);
	const hostPage = await browser.newPage();
	const participantPage = await browser.newPage();
	const participantTwoPage = await browser.newPage();
	const nowMs = Date.now();
	const hostSecret = fixtureSecret(41);
	const participantSecret = fixtureSecret(43);
	const participantTwoSecret = fixtureSecret(47);
	const hostPubkey = getPublicKey(hostSecret);
	const participantPubkey = getPublicKey(participantSecret);
	const participantTwoPubkey = getPublicKey(participantTwoSecret);
	try {
		await Promise.all([preparePlayer(hostPage, hostSecret, nowMs), preparePlayer(participantPage, participantSecret, nowMs), preparePlayer(participantTwoPage, participantTwoSecret, nowMs)]);
		await Promise.all([moveRelaySelfTo(hostPage, { x: 7, y: 5 }), moveRelaySelfTo(participantPage, { x: 7, y: 6 }), moveRelaySelfTo(participantTwoPage, { x: 8, y: 5 })]);
		const hostPosition = await latestPublished(hostPage, WORLD_STATE_KIND, hostPubkey);
		const participantPosition = await latestPublished(participantPage, WORLD_STATE_KIND, participantPubkey);
		const participantTwoPosition = await latestPublished(participantTwoPage, WORLD_STATE_KIND, participantTwoPubkey);
		await Promise.all([injectPosition(participantPage, hostPosition), injectPosition(participantTwoPage, hostPosition), injectPosition(hostPage, participantPosition), injectPosition(hostPage, participantTwoPosition)]);
		await synchronizeBrowserClocks([hostPage, participantPage, participantTwoPage]);
		await moveRelaySelfTo(participantTwoPage, { x: MENDING_TERMINAL.position.x - 1, y: MENDING_TERMINAL.position.y });
		await participantTwoPage.getByRole('button', { name: '作業端末' }).click();
		const mendingDialog = participantTwoPage.getByRole('dialog', { name: '作業中' });
		await expect(mendingDialog).toBeVisible();
		await expect(participantTwoPage.locator('[data-unified-status-hud] [data-mending-row]')).toBeVisible();
		await mendingDialog.getByRole('button', { name: '閉じる', exact: true }).click();
		await moveRelaySelfTo(participantTwoPage, { x: 8, y: 5 });

		await openTagGameTerminal(hostPage);
		await expect(hostPage.getByRole('button', { name: '鬼ごっこを開催' })).toHaveAttribute('data-action-variant', 'primary');
		await hostPage.getByRole('button', { name: '鬼ごっこを開催' }).click();
		await expect.poll(async () => (await relayState(hostPage)).state.published.some((event) => event.kind === TAG_GAME_KIND)).toBe(true);
		const firstState = await latestPublished(hostPage, TAG_GAME_KIND);
		const parsedLobby = parseTagGameEvent(firstState, CHANNEL_ID);
		expect(parsedLobby).not.toBeNull();
		const gameId = parsedLobby!.state.gameId;
		await expect(hostPage.getByRole('button', { name: '鬼ごっこを開催' })).toHaveCount(0);
		await expect(hostPage.getByText('あなたの開催').first()).toBeVisible();
		const hostCard = hostPage.getByRole('dialog', { name: '鬼ごっこ' }).locator('li').filter({ hasText: 'あなたの開催' });
		await expect(hostCard.getByText('参加者 1 / 8人')).toBeVisible();
		await expect(hostCard.locator('[data-tag-game-participant-slot]')).toHaveCount(1);
		await expect(hostCard.locator('.participant-slot-empty')).toHaveCount(7);
		await Promise.all([injectRealtime(participantPage, firstState), injectRealtime(participantTwoPage, firstState)]);
		await Promise.all([openTagGameTerminal(participantPage), openTagGameTerminal(participantTwoPage)]);
		await Promise.all([expect(participantPage.locator('main')).toHaveAttribute('data-realtime-status', 'active'), expect(participantTwoPage.locator('main')).toHaveAttribute('data-realtime-status', 'active')]);
		await Promise.all([injectRealtime(participantPage, firstState), injectRealtime(participantTwoPage, firstState)]);
		const hostCharacter = resolveCharacterFromPubkey(hostPubkey)!.name;
		await expect(participantPage.getByText(`開催者 ${hostCharacter}`)).toBeVisible();
		await Promise.all([expect(participantPage.getByRole('button', { name: '参加申請' })).toBeVisible(), expect(participantTwoPage.getByRole('button', { name: '参加申請' })).toBeVisible()]);
		await expect(participantPage.getByRole('button', { name: '参加申請' })).toHaveAttribute('data-action-variant', 'primary');
		await expect(participantPage.getByRole('dialog', { name: '鬼ごっこ' }).locator('[data-action-variant="primary"]')).toHaveCount(1);
		await expect(hostPage.getByRole('button', { name: '鬼ごっこを開催' })).toHaveCount(0);
		const participantCard = participantPage.getByRole('dialog', { name: '鬼ごっこ' }).locator('li').filter({ hasText: `開催者 ${hostCharacter}` });
		const participantGrid = participantCard.locator('.participant-slots');
		const participantTwoCard = participantTwoPage.getByRole('dialog', { name: '鬼ごっこ' }).locator('li').filter({ hasText: `開催者 ${hostCharacter}` });
		const participantTwoGrid = participantTwoCard.locator('.participant-slots');
		const hostGrid = hostCard.locator('.participant-slots');
		const hostViewport = hostPage.viewportSize();
		const hostGridBeforeFirstJoin = await hostGrid.boundingBox();
		expect(hostGridBeforeFirstJoin).toBeTruthy();
		await Promise.all([participantPage.getByRole('button', { name: '参加申請' }).click(), participantTwoPage.getByRole('button', { name: '参加申請' }).click()]);
		await Promise.all([expect(participantPage.getByText('参加申請済み（受理待ち）').first()).toBeVisible(), expect(participantTwoPage.getByText('参加申請済み（受理待ち）').first()).toBeVisible()]);
		await Promise.all([participantPage, participantTwoPage].map((participant) => expect.poll(async () => (await relayState(participant)).state.published.filter((event) => event.kind === 27070).length).toBeGreaterThan(0)));
		const [joinAction, joinActionTwo] = await Promise.all([latestPublished(participantPage, 27070, participantPubkey), latestPublished(participantTwoPage, 27070, participantTwoPubkey)]);
		await injectRealtime(hostPage, joinAction);
		await expect.poll(async () => latestTagGameStateValue(hostPage, gameId, (state) => state.participant.length)).toBe(2);
		const firstRegisteredEvent = await latestGameEvent(hostPage, gameId);
		await Promise.all([injectRealtime(participantPage, firstRegisteredEvent), injectRealtime(participantTwoPage, firstRegisteredEvent)]);
		await expect(participantPage.getByText('参加申請済み（参加登録済み）').first()).toBeVisible();
		await expect(participantPage.locator('.tag-game-arrival')).toHaveCount(0);
		await expect(participantTwoPage.locator('.tag-game-arrival')).toHaveCount(0);
		await expect(participantTwoGrid.locator('.participant-slot-arrival')).toHaveCount(1);
		await expect(participantTwoGrid.locator(`[data-tag-game-participant-slot="${participantPubkey}"].participant-slot-arrival`)).toHaveCount(1);
		const hostGridAfterFirstJoin = await hostGrid.boundingBox();
		expect(hostGridAfterFirstJoin && hostGridBeforeFirstJoin).toBeTruthy();
		if (hostGridAfterFirstJoin && hostGridBeforeFirstJoin) expect(hostGridAfterFirstJoin.y).toBe(hostGridBeforeFirstJoin.y);
		const participantViewport = participantPage.viewportSize();
		await participantPage.setViewportSize({ width: 390, height: 844 });
		const participantGridBeforeOtherJoin = await participantGrid.boundingBox();
		expect(participantGridBeforeOtherJoin).toBeTruthy();
		await hostPage.setViewportSize({ width: 390, height: 844 });
		const hostGridBeforeSecondJoin = await hostGrid.boundingBox();
		expect(hostGridBeforeSecondJoin).toBeTruthy();
		await injectRealtime(hostPage, joinActionTwo);
		await expect.poll(async () => latestTagGameStateValue(hostPage, gameId, (state) => state.participant.length)).toBe(3);
		const registeredEvent = await latestGameEvent(hostPage, gameId);
		await Promise.all([injectRealtime(participantPage, registeredEvent), injectRealtime(participantTwoPage, registeredEvent)]);
		await expect(participantPage.getByText('参加申請済み（参加登録済み）').first()).toBeVisible();
		await expect(participantPage.locator('.tag-game-arrival')).toHaveCount(0);
		await expect(participantTwoPage.locator('.tag-game-arrival')).toHaveCount(0);
		await expect(participantPage.getByText(/参加しました/)).toHaveCount(0);
		await expect(participantTwoPage.getByText(/参加しました/)).toHaveCount(0);
		await expect(hostPage.locator('.tag-game-arrival')).toHaveCount(0);
		await expect(participantPage.locator('[data-tag-game-participant-slot]')).toHaveCount(3);
		await expect(participantPage.locator('.participant-slot-empty')).toHaveCount(5);
		await expect.poll(async () => participantGrid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(4);
		await expect(participantGrid.locator('.participant-slot-arrival')).toHaveCount(1);
		await expect(participantGrid.locator(`[data-tag-game-participant-slot="${participantTwoPubkey}"].participant-slot-arrival`)).toHaveCount(1);
		await expect(participantTwoGrid.locator(`[data-tag-game-participant-slot="${participantTwoPubkey}"].participant-slot-arrival`)).toHaveCount(1);
		const participantGridAfterOtherJoin = await participantGrid.boundingBox();
		expect(participantGridAfterOtherJoin && participantGridBeforeOtherJoin).toBeTruthy();
		if (participantGridAfterOtherJoin && participantGridBeforeOtherJoin) expect(participantGridAfterOtherJoin.y).toBe(participantGridBeforeOtherJoin.y);
		const hostGridAfterSecondJoin = await hostGrid.boundingBox();
		expect(hostGridAfterSecondJoin && hostGridBeforeSecondJoin).toBeTruthy();
		if (hostGridAfterSecondJoin && hostGridBeforeSecondJoin) expect(hostGridAfterSecondJoin.y).toBe(hostGridBeforeSecondJoin.y);
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => page.clock.runFor(3_500)));
		await Promise.all([hostGrid, participantGrid, participantTwoGrid].map((grid) => expect(grid.locator('.participant-slot-arrival')).toHaveCount(0)));
		const cancelApplication = participantCard.getByRole('button', { name: '申請を取り消す' });
		await expect(cancelApplication).toBeVisible();
		await expect(cancelApplication).toHaveAttribute('data-action-intent', 'cancel');
		await expectButtonShape(cancelApplication);
		const [gridBox, cancelBox] = await Promise.all([participantGrid.boundingBox(), cancelApplication.boundingBox()]);
		expect(gridBox && cancelBox).toBeTruthy();
		if (gridBox && cancelBox) expect(cancelBox.y).toBeGreaterThanOrEqual(gridBox.y + gridBox.height);
		await expect(participantTwoPage.locator('[data-tag-game-participant-slot]')).toHaveCount(3);
		if (participantViewport) await participantPage.setViewportSize(participantViewport);
		if (hostViewport) await hostPage.setViewportSize(hostViewport);

		await expect(hostPage.getByRole('button', { name: '開始を提案' })).toHaveAttribute('data-action-variant', 'primary');
		await expect(hostCard.getByRole('button', { name: '募集を取り消す' })).toHaveAttribute('data-action-variant', 'tertiary');
		await expect(hostCard.getByRole('button', { name: '募集を取り消す' })).toHaveAttribute('data-action-intent', 'cancel');
		await hostPage.getByRole('button', { name: '開始を提案' }).click();
		await expect.poll(async () => latestTagGameStateValue(hostPage, gameId, (state) => state.phase)).toBe('proposed');
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => expect(page.getByRole('dialog', { name: '鬼ごっこ' })).toBeVisible()));
		const proposal = await latestGameEvent(hostPage, gameId);
		await Promise.all([injectRealtime(participantPage, proposal), injectRealtime(participantTwoPage, proposal)]);
		await Promise.all([expect(participantPage.getByRole('button', { name: '開始に同意' })).toBeVisible(), expect(participantTwoPage.getByRole('button', { name: '開始に同意' })).toBeVisible()]);
		await expect(participantPage.getByRole('button', { name: '開始に同意' })).toHaveAttribute('data-action-variant', 'primary');
		await expect(participantPage.getByRole('button', { name: '今回は辞退' })).toHaveAttribute('data-action-intent', 'cancel');
		await expect(participantPage.getByRole('dialog', { name: '鬼ごっこ' }).locator('[data-action-variant="primary"]')).toHaveCount(1);
		await expect(hostCard.getByText('開催者は同意済み')).toBeVisible();
		await expect(hostCard.getByRole('button', { name: '開始に同意' })).toHaveCount(0);
		await expect(hostCard.getByRole('button', { name: '今回は辞退' })).toHaveCount(0);
		const hostLeave = finalizeEvent(buildTagGameActionTemplate({ channelId: CHANNEL_ID, gameId, action: 'leave', runNumber: 1, nonce: 'a'.repeat(32), createdAt: Math.floor(await hostPage.evaluate(() => Date.now() / 1000)) }), hostSecret);
		await injectRealtime(hostPage, hostLeave);
		await expect.poll(async () => latestTagGameStateValue(hostPage, gameId, (state) => state.participant.length)).toBe(3);
		await Promise.all([participantPage.getByRole('button', { name: '開始に同意' }).click(), participantTwoPage.getByRole('button', { name: '開始に同意' }).click()]);
		await Promise.all([participantPage, participantTwoPage].map((participant) => expect.poll(async () => (await relayState(participant)).state.published.filter((event) => event.kind === 27070).length).toBeGreaterThan(1)));
		const [consent, consentTwo] = await Promise.all([latestPublished(participantPage, 27070, participantPubkey), latestPublished(participantTwoPage, 27070, participantTwoPubkey)]);
		await Promise.all([injectRealtime(hostPage, consent), injectRealtime(hostPage, consentTwo)]);
		expect((await relayState(hostPage)).state.published.filter((event) => event.kind === 27070 && parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'consent')).toHaveLength(0);
		await expect.poll(async () => latestTagGameStateValue(hostPage, gameId, (state) => state.phase)).toBe('countdown');
		const countdownEvent = await latestGameEvent(hostPage, gameId);
		const countdownState = parseTagGameEvent(countdownEvent, CHANNEL_ID)!.state;
		await Promise.all([injectRealtime(participantPage, countdownEvent), injectRealtime(participantTwoPage, countdownEvent)]);
		await Promise.all([hostPage, participantPage, participantTwoPage].map(async (page) => {
			await expect(page.getByRole('dialog', { name: '鬼ごっこ' })).toBeHidden();
			const remainingMs = countdownState.startAt! * 1_000 - await page.evaluate(() => Date.now());
			if (remainingMs > 0 && remainingMs <= 5_000) {
				await expect(page.locator('[data-tag-game-countdown]')).toBeVisible();
				await expect(page.locator('[data-tag-game-countdown]')).toHaveAttribute('data-countdown-seconds', String(Math.ceil(remainingMs / 1_000)));
			} else {
				await expect(page.locator('[data-tag-game-countdown]')).toHaveCount(0);
			}
		}));
		await hostPage.clock.runFor(6_000);
		await expect.poll(async () => latestTagGameStateValue(hostPage, gameId, (state) => state.phase)).toBe('running');
		const runningEvent = await latestGameEvent(hostPage, gameId);
		const running = parseTagGameEvent(runningEvent, CHANNEL_ID)!.state;
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => page.clock.setFixedTime(running.startedAt! * 1_000 + 5_000)));
		await Promise.all([injectRealtime(participantPage, runningEvent), injectRealtime(participantTwoPage, runningEvent)]);
		const touchActivityAt = running.startedAt! + 5;
		const touchActivity = [
			[hostSecret, { x: 7, y: 5 }], [participantSecret, { x: 7, y: 6 }], [participantTwoSecret, { x: 8, y: 5 }]
		] as const;
		for (const [secret, position] of touchActivity) {
			const activity = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' }, createdAt: touchActivityAt, position, slot: 1, runNumber: 1 }), secret);
			await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => injectPosition(page, activity)));
		}
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => expect(page.getByRole('dialog', { name: '鬼ごっこ' })).toHaveCount(0)));
		await expect(hostPage.locator('[data-tag-game-hud]')).toBeVisible();
		await expect(participantPage.locator('[data-tag-game-hud]')).toBeVisible();
		await expect(participantTwoPage.locator('[data-tag-game-hud]')).toBeVisible();
		const participantHudHolder = running.ownerPubkey === participantPubkey ? 'あなた' : resolveCharacterFromPubkey(running.ownerPubkey!)!.name;
		await expect(participantPage.locator('[data-tag-game-hud]')).toContainText(participantHudHolder);
		await expect(participantPage.locator('[data-tag-game-hud] [data-tag-game-effect]')).toHaveAttribute('data-tag-game-effect', running.effect!);
		await expect(hostPage.locator('[data-tag-game-remaining]')).toHaveText(/01:5\d/);
		if (await hostPage.locator('[data-tag-game-hud] [data-tag-game-effect]').getAttribute('data-tag-game-effect-active') === 'true') {
			await expect(hostPage.locator('[data-tag-game-hud]')).toContainText(running.effect === 'benefit' ? '所持者以外が追いかけて奪う' : '所持者が追いかけて押し付ける');
		} else {
			await expect(hostPage.locator('[data-tag-game-hud]')).toContainText('応答確認中・効果停止');
		}
		const gamePages = new Map([[hostPubkey, hostPage], [participantPubkey, participantPage], [participantTwoPubkey, participantTwoPage]]);
		const holderHudPage = gamePages.get(running.ownerPubkey!)!;
		const holderUnifiedHud = holderHudPage.locator('[data-unified-status-hud]');
		await expect(holderUnifiedHud).toHaveAttribute('data-tag-game-projection', 'true');
		await expect(holderUnifiedHud.locator('[data-tag-game-projection-row]')).toHaveCount(0);
		await expect(holderUnifiedHud).not.toContainText(/予測中|未確定予測|確定分・保存待ち/);
		await expect.poll(async () => {
			const data = await holderUnifiedHud.evaluate((element) => {
				const hud = element as HTMLElement;
				return {
					points: hud.dataset.currentPoints,
					pointMeter: hud.querySelector<HTMLElement>('[data-points-meter]')?.dataset.meterValue,
					remaining: hud.dataset.currentRemainingMs,
					lifespanMeter: hud.querySelector<HTMLElement>('[data-lifespan-meter]')?.dataset.meterValue,
					lifespanMaximum: hud.dataset.maximumLifespanMs
				};
			});
			return data.points === data.pointMeter && data.lifespanMeter === String(Math.min(Number(data.lifespanMaximum), Number(data.remaining)));
		}).toBe(true);
		if (await holderHudPage.locator('[data-tag-game-hud] [data-tag-game-effect-active]').getAttribute('data-tag-game-effect-active') === 'true') {
			if (running.effect === 'benefit') {
				await expect.poll(async () => Number(await holderUnifiedHud.getAttribute('data-current-points'))).toBeGreaterThan(Number(await holderUnifiedHud.getAttribute('data-saved-points')));
			} else {
				await expect.poll(async () => Number(await holderUnifiedHud.getAttribute('data-current-expires-at-ms'))).toBeLessThan(Number(await holderUnifiedHud.getAttribute('data-base-expires-at-ms')));
			}
		}
		for (const [pubkey, page] of gamePages) {
			if (pubkey === running.ownerPubkey) continue;
			const hud = page.locator('[data-unified-status-hud]');
			await expect(hud.locator('[data-tag-game-projection-row]')).toHaveCount(0);
			await expect(hud).toHaveAttribute('data-current-points', await hud.getAttribute('data-saved-points') ?? '');
		}
		const firstRemaining = await hostPage.locator('[data-tag-game-remaining]').textContent();
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => page.clock.setSystemTime(running.startedAt! * 1_000 + 6_000)));
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => page.clock.runFor(250)));
		await expect(hostPage.locator('[data-tag-game-remaining]')).not.toHaveText(firstRemaining ?? '');
		await expect(hostPage.locator('[data-tag-game-remaining]')).toHaveText(/01:5\d/);
		await Promise.all([openTagGameTerminal(hostPage), openTagGameTerminal(participantPage)]);
		const refreshedAt = Math.floor(await hostPage.evaluate(() => Date.now() / 1_000)) + 1;
		const sameGameRunning = finalizeTagGameState({ ...running, revision: running.revision + 1, updatedAt: refreshedAt }, CHANNEL_ID, refreshedAt, hostSecret);
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => injectRealtime(page, sameGameRunning)));
		await Promise.all([hostPage, participantPage].map((page) => expect(page.getByRole('dialog', { name: '鬼ごっこ' })).toBeVisible()));
		await Promise.all([hostPage, participantPage].map(async (page) => {
			await page.getByRole('button', { name: '閉じる', exact: true }).click();
		}));
		const participantTwoViewport = participantTwoPage.viewportSize();
		await exerciseTagGameControlsAtViewport(participantTwoPage, gameId, { width: 1200, height: 900 });
		await exerciseTagGameControlsAtViewport(participantTwoPage, gameId, { width: 390, height: 844 });
		await exerciseTagGameControlsAtViewport(participantTwoPage, gameId, { width: 390, height: 480 });
		if (participantTwoViewport) await participantTwoPage.setViewportSize(participantTwoViewport);
		await Promise.all([moveRelaySelfTo(hostPage, { x: 7, y: 5 }), moveRelaySelfTo(participantPage, { x: 7, y: 6 }), moveRelaySelfTo(participantTwoPage, { x: 8, y: 5 })]);
		const [latestHostPosition, latestParticipantPosition, latestParticipantTwoPosition] = await Promise.all([
			latestWorldState(hostPage, hostPubkey), latestWorldState(participantPage, participantPubkey), latestWorldState(participantTwoPage, participantTwoPubkey)
		]);
		await injectPosition(hostPage, latestParticipantPosition);
		await injectPosition(hostPage, latestParticipantTwoPosition);
		await injectPosition(participantPage, latestHostPosition);
		await injectPosition(participantPage, latestParticipantTwoPosition);
		await injectPosition(participantTwoPage, latestHostPosition);
		await injectPosition(participantTwoPage, latestParticipantPosition);

		const cells = new Map([[hostPubkey, { page: hostPage, position: { x: 7, y: 5 } }], [participantPubkey, { page: participantPage, position: { x: 7, y: 6 } }], [participantTwoPubkey, { page: participantTwoPage, position: { x: 8, y: 5 } }]]);
		const holderPage = cells.get(running.ownerPubkey!)!.page;
		const holderMarker = holderPage.locator(`.participant[data-participant-id="${running.ownerPubkey}"]`);
		await expect(holderMarker).toHaveAttribute('data-tag-game-role', 'holder');
		await expect(holderMarker).toHaveAttribute('data-tag-game-effect', running.effect!);
		const displayedEffect = holderPage.locator('[data-tag-game-hud] [data-tag-game-effect]');
		await expect(holderMarker).toHaveAttribute('data-tag-game-effect-active', await displayedEffect.getAttribute('data-tag-game-effect-active') ?? 'false');
		const fieldEffectVisuals = holderMarker.locator('.tag-game-effect-visuals');
		const effectName = running.effect === 'benefit' ? '福' : '鬼';
		await expect(holderMarker.locator('.tag-game-holder-label')).toHaveCount(0);
		await expect(fieldEffectVisuals).toHaveCount(1);
		await expect(fieldEffectVisuals).toHaveAttribute('aria-label', `${effectName}${await displayedEffect.getAttribute('data-tag-game-effect-active') === 'true' ? '' : '・効果停止中'}`);
		await expect(fieldEffectVisuals.locator('svg[aria-hidden="true"]')).toHaveCount(1);
		const visualsBox = await fieldEffectVisuals.boundingBox();
		const holderBox = await holderMarker.boundingBox();
		const holderNameBox = await holderMarker.locator('.participant-name').boundingBox();
		const avatarBox = await holderMarker.locator('.participant-profile-trigger .avatar').boundingBox();
		expect(visualsBox && holderBox && holderNameBox && avatarBox).toBeTruthy();
		if (visualsBox && holderBox && holderNameBox && avatarBox) {
			expect(visualsBox.x).toBeGreaterThanOrEqual(holderBox.x - 1);
			expect(visualsBox.x + visualsBox.width).toBeLessThanOrEqual(holderBox.x + holderBox.width + 1);
			expect(holderBox.width).toBe(76);
			expect(avatarBox.width).toBeGreaterThan(0);
			expect(holderNameBox.width).toBeGreaterThan(0);
		}
		expect(await fieldEffectVisuals.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
		expect(await holderMarker.locator('.participant-profile-trigger').evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('auto');
		const desktopSymbolLayout = await readEffectSymbolLayout(holderMarker);
		if (running.effect === 'calamity') expectHornsAboveAvatarAndClearOfName(desktopSymbolLayout);
		else {
			expectMalletBottomRightOfAvatarAndOutsideFace(desktopSymbolLayout);
			await expectMalletDoesNotCoverVisibleNameText(holderMarker);
		}
		const holderViewport = holderPage.viewportSize();
		await holderPage.setViewportSize({ width: 390, height: 844 });
		await expect(fieldEffectVisuals.locator('svg')).toBeVisible();
		await expect.poll(async () => holderMarker.evaluate((element) => Number.parseFloat(getComputedStyle(element).width))).toBe(50);
		await expect(holderMarker.locator('.participant-profile-trigger')).toBeVisible();
		await expect(holderMarker.locator('.participant-name')).toBeVisible();
		const mobileSymbolLayout = await readEffectSymbolLayout(holderMarker);
		if (running.effect === 'calamity') expectHornsAboveAvatarAndClearOfName(mobileSymbolLayout);
		else {
			expectMalletBottomRightOfAvatarAndOutsideFace(mobileSymbolLayout);
			await expectMalletDoesNotCoverVisibleNameText(holderMarker);
		}
		await holderPage.emulateMedia({ reducedMotion: 'reduce' });
		await expect(fieldEffectVisuals.locator('svg')).toBeVisible();
		const reducedMotionAnimations = await fieldEffectVisuals.evaluate((element) => [...element.querySelectorAll<SVGElement>('*')]
			.map((child) => getComputedStyle(child).animationName).filter((name) => name !== 'none'));
		expect(reducedMotionAnimations).toEqual([]);
		await holderPage.emulateMedia({ reducedMotion: 'no-preference' });
		if (holderViewport) await holderPage.setViewportSize(holderViewport);
		const currentTouchState = parseTagGameEvent(await latestGameEvent(hostPage, gameId), CHANNEL_ID)!.state;
		await Promise.all([hostPage, participantPage, participantTwoPage].map(async (page) => {
			const pageNow = await page.evaluate(() => Date.now());
			await page.clock.setSystemTime(Math.max(pageNow, (currentTouchState.transferAt ?? pageNow) + 4_000));
		}));
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => page.clock.runFor(300)));
		let touchStateEvent = await latestGameEvent(hostPage, gameId);
		let touchState = parseTagGameEvent(touchStateEvent, CHANNEL_ID)!.state;
		const activeAt = Math.max(...await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => page.evaluate(() => Math.floor(Date.now() / 1_000)))));
		for (const [secret, position] of [[hostSecret, { x: 7, y: 5 }], [participantSecret, { x: 7, y: 6 }], [participantTwoSecret, { x: 8, y: 5 }]] as const) {
			const activity = finalizeEvent(buildWorldMessageTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' }, createdAt: activeAt, position, content: 'active touch E2E participant', speechType: 'normal' }), secret);
			await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => injectWorldMessage(page, activity)));
		}
		await hostPage.clock.runFor(300);
		touchStateEvent = await latestGameEvent(hostPage, gameId);
		touchState = parseTagGameEvent(touchStateEvent, CHANNEL_ID)!.state;
		await Promise.all([participantPage, participantTwoPage].map((page) => injectRealtime(page, touchStateEvent)));
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => expect(page.locator(`.participant[data-participant-id="${touchState.ownerPubkey}"]`)).toHaveAttribute('data-tag-game-role', 'holder')));
		const holder = cells.get(touchState.ownerPubkey!)!;
		const target = [...cells.entries()].find(([pubkey, candidate]) => pubkey !== touchState.ownerPubkey && Math.abs(candidate.position.x - holder.position.x) + Math.abs(candidate.position.y - holder.position.y) === 1)!;
		const actorEntry = touchState.effect === 'benefit' ? target : [touchState.ownerPubkey!, holder] as const;
		const actorPubkey = actorEntry[0];
		const actor = actorEntry[1].page;
		const touchTargetPubkey = touchState.effect === 'benefit' ? touchState.ownerPubkey! : target[0];
		let transferredEvent = touchStateEvent;
		let transferred = touchState;
		await expect(actor.locator(`.participant[data-participant-id="${touchTargetPubkey}"]`)).toHaveAttribute('data-tag-game-touch-target', 'true');
		await expect(actor.locator(`.participant[data-participant-id="${actorPubkey}"]`)).toHaveAttribute('data-position', `${actorEntry[1].position.x},${actorEntry[1].position.y}`);
		await expect(actor.locator(`.participant[data-participant-id="${touchTargetPubkey}"]`)).toHaveAttribute('data-position', `${cells.get(touchTargetPubkey)!.position.x},${cells.get(touchTargetPubkey)!.position.y}`);
		const dx = cells.get(touchTargetPubkey)!.position.x - actorEntry[1].position.x;
		const dy = cells.get(touchTargetPubkey)!.position.y - actorEntry[1].position.y;
		await expect(actor.locator('main')).toHaveAttribute('data-realtime-status', 'active');
		// Hold the host's signed 37070 before any touch can reach the organizer;
		// setting this after input races the live 27070 echo and publication.
		await setRealtimePublishDeferral(hostPage, true);
		const actionCountBeforeTouch = (await relayState(actor)).state.published.filter((event) => event.kind === 27070 && event.pubkey === actorPubkey).length;
		await dragRelayJoystick(actor, { x: dx * 100, y: dy * 100 }, actorEntry[1].position);
		await expect(actor.locator(`.participant[data-participant-id="${actorPubkey}"]`)).toHaveAttribute('data-tag-game-touch-attempt', /\d+/);
		await expect.poll(async () => (await relayState(actor)).state.published.filter((event) => event.kind === 27070 && event.pubkey === actorPubkey).length).toBeGreaterThan(actionCountBeforeTouch);
		await expect.poll(async () => latestTagGameAction(actor, actorPubkey, 'touch').then(() => true, () => false)).toBe(true);
		const touchAction = await latestTagGameAction(actor, actorPubkey, 'touch');
		await expect(actor.locator('[data-tag-game-touch-status]')).toHaveText('判定待ち・開催者未確認');
		const parsedTouch = parseTagGameActionEvent(touchAction, CHANNEL_ID);
		expect(parsedTouch?.action).toBe('touch');
		expect(parsedTouch?.payload.actorProof).toMatchObject({ worldStateEventId: expect.any(String), positionEvidenceEventId: expect.any(String) });
		expect(parsedTouch?.payload.targetProof).toMatchObject({ worldStateEventId: expect.any(String), positionEvidenceEventId: expect.any(String) });
		await injectRealtime(hostPage, touchAction);
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => page.clock.runFor(2_100)));
		// The organizer creates its own signed state locally; only remote
		// submitters need the temporary unconfirmed status while that state is held.
		if (actorPubkey !== hostPubkey) await expect(actor.locator('[data-tag-game-touch-status]')).toHaveText('転移未確認');
		await setRealtimePublishDeferral(hostPage, false);
		await expect.poll(async () => latestTagGameStateValue(hostPage, gameId, (state) => state.transferAt)).toBeGreaterThan(touchState.transferAt ?? 0);
		transferredEvent = await latestGameEvent(hostPage, gameId);
		transferred = parseTagGameEvent(transferredEvent, CHANNEL_ID)!.state;
		expect(transferredEvent.kind).toBe(TAG_GAME_KIND);
		expect(transferredEvent.pubkey).toBe(hostPubkey);
		expect(transferred.ownerPubkey).toBe(touchState.effect === 'benefit' ? actorPubkey : touchTargetPubkey);
		await Promise.all([participantPage, participantTwoPage].map((page) => injectRealtime(page, transferredEvent)));
		if (actorPubkey !== hostPubkey) {
			await expect(actor.locator('[data-tag-game-touch-status]')).toHaveText('所持者が更新されました');
			await actor.clock.runFor(1_900);
			await expect(actor.locator('[data-tag-game-touch-status]')).toHaveCount(0);
		}
		const receivedAtMs = await actor.evaluate(() => Date.now());
		const officialCooldownRemainingMs = Math.max(0, (transferred.transferAt ?? transferred.startedAt! * 1_000) + TAG_GAME_TRANSFER_COOLDOWN_MS - receivedAtMs);
		const cooldownLine = actor.locator('[data-tag-game-cooldown-line]');
		if (officialCooldownRemainingMs === 0) await expect(cooldownLine).toHaveCount(0);
		else {
			const displayedCooldownMs = Number(await cooldownLine.getAttribute('aria-valuenow'));
			expect(Math.abs(displayedCooldownMs - officialCooldownRemainingMs)).toBeLessThanOrEqual(250);
		}
		await expect(actor.locator('[data-tag-game-hud]')).toBeVisible();
		const presenceAt = Math.max(transferredEvent.created_at, ...await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => page.evaluate(() => Math.floor(Date.now() / 1_000))))) + 1;
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => page.clock.setSystemTime(presenceAt * 1_000)));
		for (const [secret, position] of [[hostSecret, { x: 7, y: 5 }], [participantSecret, { x: 7, y: 6 }], [participantTwoSecret, { x: 8, y: 5 }]] as const) {
			const activity = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' }, createdAt: presenceAt, position, slot: 1, runNumber: 1 }), secret);
			await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => injectPosition(page, activity)));
		}
		const confirmedTransfer = finalizeTagGameState({ ...transferred, revision: transferred.revision + 1, updatedAt: presenceAt }, CHANNEL_ID, presenceAt, hostSecret);
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => injectRealtime(page, confirmedTransfer)));
		const transferredHolderPage = cells.get(transferred.ownerPubkey!)!.page;
		await expect(transferredHolderPage.locator(`.participant[data-participant-id="${transferred.ownerPubkey}"]`)).toHaveAttribute('data-tag-game-role', 'holder');
		await expect(transferredHolderPage.locator('[data-tag-game-hud] [data-tag-game-effect]')).toBeVisible();
		const effectAtDisplayTime = tagGameScheduledEffectAt(transferred, presenceAt * 1_000);
		expect(effectAtDisplayTime).not.toBeNull();
		const scheduledDisplayEffect = effectAtDisplayTime!;
		await Promise.all([hostPage, participantPage, participantTwoPage].map(async (page) => {
			const currentOwner = page.locator(`.participant[data-participant-id="${transferred.ownerPubkey}"]`);
			const expectedName = scheduledDisplayEffect === 'benefit' ? '福' : '鬼';
			await expect(currentOwner).toHaveAttribute('data-tag-game-effect', scheduledDisplayEffect);
			await expect(currentOwner.locator('.tag-game-effect-visuals')).toHaveAttribute('aria-label', expectedName);
			const previousOwner = page.locator(`.participant[data-participant-id="${touchState.ownerPubkey}"]`);
			if (touchState.ownerPubkey !== transferred.ownerPubkey) await expect(previousOwner.locator('.tag-game-effect-aura, .tag-game-effect-visuals')).toHaveCount(0);
		}));

		const endsAt = running.endsAt! * 1000;
		const channel = { channelId: CHANNEL_ID, relayHint: latestHostPosition.tags.find((tag) => tag[0] === 'e')?.[2] ?? 'wss://relay.test/' };
		const finalActivityAt = Math.floor(endsAt / 1_000) - 1;
		await hostPage.clock.setSystemTime(finalActivityAt * 1_000);
		const finalActivity = [
			[hostSecret, { x: 7, y: 5 }], [participantSecret, { x: 7, y: 6 }], [participantTwoSecret, { x: 8, y: 5 }]
		] as const;
		// Keep ordinary signed World activity fresh at the end while fast-forwarding the host clock.
		for (const [secret, position] of finalActivity) {
			const event = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt: finalActivityAt, position, slot: 1, runNumber: 1 }), secret);
			await injectPosition(hostPage, event);
		}
		const beforeFinal = await latestGameEvent(hostPage, gameId);
	await hostPage.clock.setSystemTime(Math.max(endsAt + 1_000, (beforeFinal.created_at + 1) * 1_000));
	await hostPage.clock.runFor(1_250);
		await expect.poll(async () => latestTagGameStateValue(hostPage, gameId, (state) => state.phase)).toBe('ended');
		await expect(hostPage.locator('[data-tag-game-hud]')).toHaveCount(0);
		const finalStateEvent = await latestGameEvent(hostPage, gameId);
		await injectRealtime(participantPage, finalStateEvent);
		await injectRealtime(participantTwoPage, finalStateEvent);
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => expect(page.locator('.tag-game-effect-aura, .tag-game-effect-visuals')).toHaveCount(0)));
		const finalState = parseTagGameEvent(finalStateEvent, CHANNEL_ID)!.state;
		const finalLocal = finalState.participant.find((member) => member.pubkey === participantPubkey)!;
		await expect.poll(async () => (await tagGamePersistence(participantPage)).receipt).toMatchObject({ gameId, points: finalLocal.points, lifespanLossMs: finalLocal.lifespanLossMs });
		await expect(participantPage.locator('[data-unified-status-hud]')).toHaveAttribute('data-saved-points', String((await tagGamePersistence(participantPage)).savedPoints));
		await expect(participantPage.locator('[data-unified-status-hud]')).not.toHaveAttribute('data-tag-game-projection', 'true');
		const results = await Promise.all([hostPage, participantPage, participantTwoPage].map(async (page) => {
			const dialog = page.getByRole('dialog', { name: '鬼ごっこ終了' });
			await expect(dialog).toHaveAttribute('data-tag-game-result-game', gameId);
			const rows = dialog.locator('[data-tag-game-result-participant]');
			await expect(rows).toHaveCount(3);
			for (const member of finalState.participant) {
				const row = dialog.locator(`[data-tag-game-result-participant="${member.pubkey}"]`);
				await expect(row).toBeVisible();
				await expect(row.locator('.result-values')).toHaveCount(2);
				await expect(row).toContainText(`ポイント +${member.points}pt`);
			}
			return { dialog };
		}));
		const hostResultRow = results[1]!.dialog.locator(`[data-tag-game-result-participant="${hostPubkey}"]`);
		await expect(hostResultRow).toContainText(resolveCharacterFromPubkey(hostPubkey)!.name);
		const localResultRow = results[1]!.dialog.locator(`[data-tag-game-result-participant="${participantPubkey}"]`);
		await expect(localResultRow).toHaveAttribute('data-tag-game-result-self', 'true');
		await expect(localResultRow).toContainText('あなた');
		await Promise.all(results.map(({ dialog }) => dialog.getByRole('button', { name: '閉じる' }).click()));
		await openTagGameTerminal(participantPage);
		const history = participantPage.locator('[data-tag-game-history-section] details');
		await history.locator('summary').click();
		const historicalGame = history.locator(`[data-tag-game-history="${gameId}"]`);
		await historicalGame.getByRole('button', { name: '結果を見る' }).click();
		const reopenedResult = participantPage.getByRole('dialog', { name: '鬼ごっこ終了' });
		await expect(reopenedResult).toHaveAttribute('data-tag-game-result-game', gameId);
		await expect(reopenedResult.locator('[data-tag-game-result-participant]')).toHaveCount(3);
		await expect(reopenedResult.locator(`[data-tag-game-result-participant="${participantPubkey}"]`)).toHaveAttribute('data-tag-game-result-self', 'true');
		await reopenedResult.getByRole('button', { name: '閉じる' }).click();
	} finally {
		await Promise.all([hostPage.close(), participantPage.close(), participantTwoPage.close()]);
	}
});

test('keeps join actions primary and equally emphasized when multiple tag-game lobbies are available', async ({ browser }) => {
	const firstHostPage = await browser.newPage();
	const secondHostPage = await browser.newPage();
	const joinerPage = await browser.newPage();
	const nowMs = Date.now();
	const firstHostSecret = fixtureSecret(61);
	const secondHostSecret = fixtureSecret(63);
	const joinerSecret = fixtureSecret(51);
	try {
		await Promise.all([preparePlayer(firstHostPage, firstHostSecret, nowMs), preparePlayer(secondHostPage, secondHostSecret, nowMs), preparePlayer(joinerPage, joinerSecret, nowMs)]);
		await Promise.all([
			moveRelaySelfTo(firstHostPage, { x: 7, y: 5 }),
			moveRelaySelfTo(secondHostPage, { x: 8, y: 5 }),
			moveRelaySelfTo(joinerPage, { x: 7, y: 6 })
		]);
		await Promise.all([openTagGameTerminal(firstHostPage), openTagGameTerminal(secondHostPage)]);
		await Promise.all([
			expect(firstHostPage.getByRole('button', { name: '鬼ごっこを開催' })).toHaveAttribute('data-action-variant', 'primary'),
			expect(secondHostPage.getByRole('button', { name: '鬼ごっこを開催' })).toHaveAttribute('data-action-variant', 'primary')
		]);
		await expect(joinerPage.locator('main')).toHaveAttribute('data-realtime-status', 'active');
		await Promise.all([
			firstHostPage.getByRole('button', { name: '鬼ごっこを開催' }).click(),
			secondHostPage.getByRole('button', { name: '鬼ごっこを開催' }).click()
		]);
		await Promise.all([firstHostPage, secondHostPage].map(async (hostPage) =>
			expect.poll(async () => (await relayState(hostPage)).state.published.some((event) => event.kind === TAG_GAME_KIND)).toBe(true)
		));
		const lobbies = await Promise.all([
			latestPublished(firstHostPage, TAG_GAME_KIND, getPublicKey(firstHostSecret)),
			latestPublished(secondHostPage, TAG_GAME_KIND, getPublicKey(secondHostSecret))
		]);
		await joinerPage.setViewportSize({ width: 1280, height: 900 });
		await openTagGameTerminal(joinerPage);
		const dialog = joinerPage.getByRole('dialog', { name: '鬼ごっこ' });
		await expect.poll(async () => (await relayState(joinerPage)).state.requests.some((request) => request.filters.some((filter) =>
			(filter.kinds as number[] | undefined)?.includes(TAG_GAME_KIND) && !filter['#d']
		))).toBe(true);
		for (const [index, event] of lobbies.entries()) {
			await injectRealtime(joinerPage, event);
			await expect.poll(async () => joinerPage.evaluate((id) => (window as typeof window & { __relayStartupTest: { state: { realtimeHistory: Array<{ id: string }> } } }).__relayStartupTest.state.realtimeHistory.some((received) => received.id === id), event.id)).toBe(true);
			await expect.poll(() => dialog.locator('[data-tag-game-current-section] .current-game-list > li[data-tag-game-current]').count()).toBe(index + 1);
		}
		const joinButtons = dialog.getByRole('button', { name: '参加申請' });
		await expect(joinButtons).toHaveCount(2);
		await expectButtonShape(joinButtons.nth(0));
		await expectButtonShape(joinButtons.nth(1));
		await expect(joinButtons.nth(0)).toHaveAttribute('data-action-variant', 'primary');
		await expect(joinButtons.nth(1)).toHaveAttribute('data-action-variant', 'primary');
		await expect(dialog.getByRole('button', { name: '鬼ごっこを開催' })).toHaveAttribute('data-action-variant', 'secondary');
		await expect(dialog.locator('[data-action-variant="primary"]')).toHaveCount(2);
		const joinBackgrounds = await joinButtons.evaluateAll((buttons) => buttons.map((button) => getComputedStyle(button).backgroundColor));
		expect(joinBackgrounds[0]).toBe(joinBackgrounds[1]);
		for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
			await joinerPage.setViewportSize(viewport);
			await expectIconCloseButton(dialog.getByRole('button', { name: '閉じる' }), '閉じる');
			await expectButtonShape(joinButtons.nth(0));
			await expectButtonShape(joinButtons.nth(1));
			await expect(joinButtons.nth(0)).toBeVisible();
			await expect(joinButtons.nth(1)).toBeVisible();
			await joinButtons.nth(1).scrollIntoViewIfNeeded();
			const secondJoinHitArea = await joinButtons.nth(1).evaluate((button) => {
				const rect = button.getBoundingClientRect();
				return { height: rect.height, insideViewport: rect.top >= 0 && rect.bottom <= innerHeight };
			});
			expect(secondJoinHitArea.height).toBeGreaterThanOrEqual(44);
			expect(secondJoinHitArea.insideViewport).toBe(true);
		}
		await joinerPage.setViewportSize({ width: 390, height: 640 });
		const dialogScroll = await dialog.evaluate((element) => {
			const dialogElement = element as HTMLElement;
			dialogElement.scrollTop = dialogElement.scrollHeight;
			return { top: dialogElement.scrollTop, maximum: dialogElement.scrollHeight - dialogElement.clientHeight };
		});
		expect(dialogScroll.maximum).toBeGreaterThan(0);
		expect(dialogScroll.top).toBe(dialogScroll.maximum);
		const closePoint = await dialog.getByRole('button', { name: '閉じる' }).evaluate((button) => {
			const rect = button.getBoundingClientRect();
			const dialogRect = button.closest('[role="dialog"]')!.getBoundingClientRect();
			const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
			return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, inViewport: rect.top >= dialogRect.top && rect.bottom <= dialogRect.bottom, receivesPointer: Boolean(hit && button.contains(hit)) };
		});
		expect(closePoint.inViewport).toBe(true);
		expect(closePoint.receivesPointer).toBe(true);
		await joinerPage.mouse.click(closePoint.x, closePoint.y);
		await expect(dialog).toHaveCount(0);
	} finally {
		await Promise.all([firstHostPage.close(), secondHostPage.close(), joinerPage.close()]);
	}
});

test('organizer accepts a touch with the seed-derived role before the ordinary switch is republished', async ({ page }) => {
	const nowMs = Date.now();
	const nowSeconds = Math.floor(nowMs / 1_000);
	const hostSecret = fixtureSecret(41);
	const holderSecret = fixtureSecret(43);
	const hostPubkey = getPublicKey(hostSecret);
	const holderPubkey = getPublicKey(holderSecret);
	await preparePlayer(page, hostSecret, nowMs, 200_000);
	await moveRelaySelfTo(page, { x: 7, y: 5 });
	await openTagGameTerminal(page);
	const startedAt = Math.floor(await page.evaluate(() => Date.now() / 1_000)) - 11;
	const seed = Array.from({ length: 10_000 }, (_, index) => `switch-touch-${index}`).find((candidate) => {
		const schedule = createTagGameSchedule(candidate);
		return schedule[0].effect === 'calamity' && schedule[0].durationMs === 10_000 && schedule[1].effect === 'benefit' && schedule[1].durationMs >= 30_000;
	});
	expect(seed).toBeTruthy();
	const schedule = createTagGameSchedule(seed!);
	const switchedAtMs = startedAt * 1_000 + schedule[0].durationMs;
	const gameId = `${hostPubkey}:${startedAt}:${'e'.repeat(64)}`;
	const running: TagGameState = {
		gameId, hostPubkey, phase: 'running', revision: 0, updatedAt: nowSeconds,
		startedAt, endsAt: startedAt + 120, seed: seed!, ownerPubkey: holderPubkey, effect: 'calamity', transferAt: startedAt * 1_000,
		lastHolderResponseAtMs: nowSeconds * 1_000,
		participant: [
			{ pubkey: hostPubkey, runNumber: 1, registeredAt: startedAt, status: 'active', points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 },
			{ pubkey: holderPubkey, runNumber: 1, registeredAt: startedAt, status: 'active', points: 0, lifespanLossMs: 36_000_000, benefitMs: 0, calamityMs: 10_000 }
		], settledAtMs: switchedAtMs
	};
	const channel = { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' };
	const holderPosition = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt: nowSeconds, position: { x: 8, y: 5 }, slot: 1, runNumber: 1 }), holderSecret);
	const holderActivity = finalizeEvent(buildWorldMessageTemplate({ channel, createdAt: nowSeconds, position: { x: 8, y: 5 }, content: 'fresh holder activity', speechType: 'normal' }), holderSecret);
	await injectPosition(page, holderPosition);
	await injectWorldMessage(page, holderActivity);
	const signedRunning = finalizeTagGameState(running, CHANNEL_ID, nowSeconds, hostSecret);
	await injectRealtime(page, signedRunning);
	const holder = page.locator(`.participant[data-participant-id="${holderPubkey}"]`);
	await expect(page.locator('[data-tag-game-hud]')).toBeVisible();
	await expect(page.locator('[data-tag-game-hud] [data-tag-game-effect]')).toHaveAttribute('data-tag-game-effect', 'benefit');
	await expect(holder).toHaveAttribute('data-tag-game-touch-target', 'true');
	const before = (await relayState(page)).state.published.filter((event) => event.kind === TAG_GAME_KIND).length;
	await page.keyboard.down('ArrowRight');
	const actor = page.locator(`.participant[data-participant-id="${hostPubkey}"]`);
	await expect(actor).toHaveAttribute('data-tag-game-touch-attempt', /\d+/);
	await expect.poll(async () => (await relayState(page)).state.published.filter((event) => event.kind === 27070 && parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'touch').length).toBeGreaterThan(0);
	await page.keyboard.up('ArrowRight');
	const touch = await latestTagGameAction(page, hostPubkey, 'touch');
	expect(parseTagGameActionEvent(touch, CHANNEL_ID)?.payload.targetPubkey).toBe(holderPubkey);
	await injectRealtime(page, touch);
	await expect.poll(async () => latestTagGameStateValue(page, gameId, (state) => state.ownerPubkey)).toBe(hostPubkey);
	const finalized = parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)!.state;
	expect(finalized.effect).toBe('benefit');
	expect(finalized.participant.find((member) => member.pubkey === holderPubkey)?.calamityMs).toBe(10_000);
	expect((await relayState(page)).state.published.filter((event) => event.kind === TAG_GAME_KIND).length).toBeGreaterThan(before);
});

test('same-target long press keeps touch status stable while Relay acknowledgements are delayed', async ({ browser }) => {
	test.setTimeout(60_000);
	const hostPage = await browser.newPage();
	const actorPage = await browser.newPage();
	const nowMs = Date.now();
	const hostSecret = fixtureSecret(53);
	const actorSecret = fixtureSecret(59);
	const hostPubkey = getPublicKey(hostSecret);
	const actorPubkey = getPublicKey(actorSecret);
	try {
		await Promise.all([preparePlayer(hostPage, hostSecret, nowMs), preparePlayer(actorPage, actorSecret, nowMs)]);
		await Promise.all([moveRelaySelfTo(hostPage, { x: 8, y: 5 }), moveRelaySelfTo(actorPage, { x: 7, y: 5 })]);
		const [hostPosition, actorPosition] = await Promise.all([latestWorldState(hostPage, hostPubkey), latestWorldState(actorPage, actorPubkey)]);
		await Promise.all([hostPage, actorPage].flatMap((page) => [injectPosition(page, hostPosition), injectPosition(page, actorPosition)]));
		const channel = { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' };
		const gameNowMs = Date.now();
		await Promise.all([hostPage, actorPage].map((page) => page.clock.setSystemTime(gameNowMs)));
		const nowSeconds = Math.floor(gameNowMs / 1_000);
		const startedAt = nowSeconds - 4;
		const seed = Array.from({ length: 1_000 }, (_, index) => `held-touch-${index}`).find((candidate) => {
			const firstInterval = createTagGameSchedule(candidate)[0];
			return firstInterval.effect === 'benefit' && firstInterval.durationMs >= 30_000;
		})!;
		const gameId = `${hostPubkey}:${startedAt}:${'8'.repeat(64)}`;
		const running: TagGameState = {
			gameId, hostPubkey, phase: 'running', revision: 0, updatedAt: startedAt,
			startedAt, endsAt: startedAt + 120, seed, ownerPubkey: hostPubkey, effect: 'benefit', transferAt: startedAt * 1_000,
			participant: [hostPubkey, actorPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: startedAt, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
			settledAtMs: startedAt * 1_000, lastHolderResponseAtMs: startedAt * 1_000
		};
		const runningEvent = finalizeTagGameState(running, CHANNEL_ID, nowSeconds, hostSecret);
		await Promise.all([injectRealtime(hostPage, runningEvent), injectRealtime(actorPage, runningEvent)]);
		const activeMessage = finalizeEvent(buildWorldMessageTemplate({ channel, createdAt: nowSeconds, position: { x: 8, y: 5 }, content: 'holder active for held-touch test', speechType: 'normal' }), hostSecret);
		const actorMessage = finalizeEvent(buildWorldMessageTemplate({ channel, createdAt: nowSeconds, position: { x: 7, y: 5 }, content: 'actor active for held-touch test', speechType: 'normal' }), actorSecret);
		for (const page of [hostPage, actorPage]) await Promise.all([injectWorldMessage(page, activeMessage), injectWorldMessage(page, actorMessage)]);
		await expect(hostPage.locator(`.participant[data-participant-id="${hostPubkey}"]`)).toHaveAttribute('data-tag-game-role', 'holder');
		await expect(hostPage.locator(`.participant[data-participant-id="${actorPubkey}"]`)).toHaveAttribute('data-tag-game-role', 'participant');
		await expect(hostPage.locator(`.participant[data-participant-id="${hostPubkey}"]`)).toHaveAttribute('data-position', '8,5');
		await expect(hostPage.locator(`.participant[data-participant-id="${actorPubkey}"]`)).toHaveAttribute('data-position', '7,5');
		await expect(actorPage.locator(`.participant[data-participant-id="${hostPubkey}"]`)).toHaveAttribute('data-tag-game-touch-target', 'true');
		await actorPage.evaluate(() => (window as typeof window & { __relayStartupTest: { setRealtimePublishOutcome(outcome: string): void } }).__relayStartupTest.setRealtimePublishOutcome('accepted'));
		await actorPage.keyboard.down('ArrowRight');
		await expect.poll(async () => latestTagGameAction(actorPage, actorPubkey, 'touch').then(() => true, () => false)).toBe(true);
		await expect(actorPage.locator('[data-tag-game-touch-status]')).toHaveText('判定待ち・開催者未確認');
		await actorPage.evaluate(() => {
			const hud = document.querySelector('[data-tag-game-hud]');
			const status = document.querySelector('[data-tag-game-touch-status]');
			if (!hud || !status) throw new Error('Expected the pending touch status before the long-press observation.');
			const trace: Array<string | null> = [status.textContent?.trim() ?? null];
			(window as typeof window & { __touchStatusTrace?: Array<string | null>; __touchStatusObserver?: MutationObserver }).__touchStatusTrace = trace;
			const observer = new MutationObserver(() => trace.push(document.querySelector('[data-tag-game-touch-status]')?.textContent?.trim() ?? null));
			observer.observe(hud, { childList: true, subtree: true, characterData: true });
			(window as typeof window & { __touchStatusObserver?: MutationObserver }).__touchStatusObserver = observer;
		});
		await setRealtimePublishDeferral(actorPage, true);
		await actorPage.clock.runFor(1_300);
		await expect.poll(async () => (await relayState(actorPage)).state.published.filter((event) => event.kind === 27070 && event.pubkey === actorPubkey && parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'touch').length).toBeGreaterThanOrEqual(3);
		await expect(actorPage.locator('[data-tag-game-touch-status]')).toHaveText('判定待ち・開催者未確認');
		const traceDuringHold = await actorPage.evaluate(() => (window as typeof window & { __touchStatusTrace: Array<string | null> }).__touchStatusTrace);
		expect(traceDuringHold).not.toContain(null);
		expect(traceDuringHold.every((text) => text === '判定待ち・開催者未確認')).toBe(true);
		await actorPage.evaluate(() => (window as typeof window & { __touchStatusObserver?: MutationObserver }).__touchStatusObserver?.disconnect());
		await actorPage.keyboard.up('ArrowRight');
		await actorPage.clock.runFor(2_100);
		await expect(actorPage.locator('[data-tag-game-touch-status]')).toHaveText('転移未確認');
		const firstTouch = await latestTagGameAction(actorPage, actorPubkey, 'touch');
		const parsedTouch = parseTagGameActionEvent(firstTouch, CHANNEL_ID);
		expect(parsedTouch?.payload.actorProof).toBeTruthy();
		expect(parsedTouch?.payload.targetProof).toBeTruthy();
		const actorCurrentPosition = await latestWorldState(actorPage, actorPubkey);
		expect(parsedTouch?.payload.actorProof).toMatchObject({ worldStateEventId: actorCurrentPosition.id, positionEvidenceEventId: actorCurrentPosition.id });
		// Each browser has an independent Fake Relay. Forward the exact signed
		// Run-position proof referenced by the touch before delivering the action.
		await injectPosition(hostPage, actorCurrentPosition);
		const actorCell = await actorPage.locator(`.participant[data-participant-id="${actorPubkey}"]`).getAttribute('data-position');
		await expect(hostPage.locator(`.participant[data-participant-id="${actorPubkey}"]`)).toHaveAttribute('data-position', actorCell!);
		// Keep the request inside the sender's freshness window while placing the
		// organizer beyond the last published 37070 second, so queue ordering does
		// not wait on a same-second addressable-state slot.
		const [actorNowMs, latestHostState] = await Promise.all([actorPage.evaluate(() => Date.now()), findLatestGameEvent(hostPage, gameId)]);
		const latestPublishedSecond = latestHostState?.created_at ?? runningEvent.created_at;
		const hostReceiveSlotMs = Math.max(actorNowMs, (latestPublishedSecond + 1) * 1_000 + 50);
		await hostPage.clock.setSystemTime(hostReceiveSlotMs);
		const hostReceiveAtMs = await hostPage.evaluate(() => Date.now());
		expect(isFreshTagGameTouchAction({ createdAtSeconds: firstTouch.created_at, nowMs: hostReceiveAtMs, elapsedSinceFirstReceiptMs: 0 })).toBe(true);
		await injectRealtime(hostPage, firstTouch);
		await expect.poll(async () => latestTagGameStateValue(hostPage, gameId, (state) => state.ownerPubkey)).toBe(actorPubkey);
		const confirmedState = await latestGameEvent(hostPage, gameId);
		expect(confirmedState.kind).toBe(TAG_GAME_KIND);
		expect(confirmedState.pubkey).toBe(hostPubkey);
		await injectRealtime(actorPage, confirmedState);
		await expect(actorPage.locator(`.participant[data-participant-id="${actorPubkey}"]`)).toHaveAttribute('data-tag-game-role', 'holder');
		await expect(actorPage.locator('[data-tag-game-touch-status]')).toHaveText('所持者が更新されました');
		await setRealtimePublishDeferral(actorPage, false);
		await actorPage.clock.runFor(10);
		await expect(actorPage.locator('[data-tag-game-touch-status]')).toHaveText('所持者が更新されました');
		await actorPage.clock.runFor(1_900);
		await expect(actorPage.locator('[data-tag-game-touch-status]')).toHaveCount(0);
		await expect(actorPage.locator('[data-tag-game-hud]')).toBeVisible();
	} finally {
		await Promise.all([hostPage.close(), actorPage.close()]);
	}
});

test('the 23-second cutoff survives reload and recovery excludes the stopped interval', async ({ page }) => {
	test.setTimeout(60_000);
	const nowMs = Date.now();
	const hostSecret = fixtureSecret(61);
	const ownerSecret = fixtureSecret(63);
	const hostPubkey = getPublicKey(hostSecret);
	const ownerPubkey = getPublicKey(ownerSecret);
	await preparePlayer(page, hostSecret, nowMs, 0, true);
	await moveRelaySelfTo(page, { x: 7, y: 5 });
	const nowSeconds = Math.floor(await page.evaluate(() => Date.now() / 1_000));
	const channel = { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' };
	const ownerPosition = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt: nowSeconds, position: { x: 8, y: 5 }, slot: 1, runNumber: 1 }), ownerSecret);
	await injectPosition(page, ownerPosition);
	const seed = Array.from({ length: 10_000 }, (_, index) => `pause-recovery-${index}`).find((candidate) => {
		const schedule = createTagGameSchedule(candidate);
		return schedule[0].effect === 'calamity' && schedule[0].durationMs >= 30_000;
	})!;
	const gameId = `${hostPubkey}:${nowSeconds}:${'6'.repeat(64)}`;
	const running: TagGameState = {
		gameId, hostPubkey, phase: 'running', revision: 0, updatedAt: nowSeconds,
		startedAt: nowSeconds, endsAt: nowSeconds + 120, seed, ownerPubkey, effect: 'calamity', transferAt: nowSeconds * 1_000,
		participant: [hostPubkey, ownerPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: nowSeconds, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
		settledAtMs: nowSeconds * 1_000, lastHolderResponseAtMs: nowSeconds * 1_000
	};
	await injectRealtime(page, finalizeTagGameState(running, CHANNEL_ID, nowSeconds, hostSecret));
	await expect(page.locator('[data-tag-game-hud]')).toBeVisible();
	await page.clock.runFor(15_500);
	const precheck = await latestTagGameAction(page, hostPubkey, 'response-challenge');
	expect(parseTagGameActionEvent(precheck, CHANNEL_ID)?.payload).toMatchObject({ stage: 'precheck' });
	await page.clock.runFor(8_000);
	await expect.poll(async () => latestTagGameStateValue(page, gameId, (state) => state.holderChallengeId)).toBeTruthy();
	const stopped = parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)!.state;
	const stoppedEvent = await latestGameEvent(page, gameId);
	expect(stopped.settledAtMs).toBe(nowSeconds * 1_000 + 23_000);
	const stoppedOwner = stopped.participant.find((member) => member.pubkey === ownerPubkey)!;
	expect(stoppedOwner.calamityMs).toBe(23_000);

	await page.reload();
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	await expect(page.locator(`.participant[data-self="true"][data-participant-id="${hostPubkey}"]`)).toBeVisible();
	await injectRealtime(page, stoppedEvent);
	await expect(page.locator('[data-tag-game-hud]')).toBeVisible();
	await page.clock.runFor(1_500);
	const replayedStates = await page.evaluate((id) => (window as typeof window & { __relayStartupTest: { state: { realtimeHistory: Array<Record<string, unknown>> } } }).__relayStartupTest.state.realtimeHistory
		.filter((event) => event.kind === 37070 && (event.tags as string[][]).some((tag) => tag[0] === 'd' && tag[1] === id)), gameId) as unknown as NostrEvent[];
	const replayedStop = parseTagGameEvent(replayedStates.at(-1)!, CHANNEL_ID)!.state;
	expect(replayedStop.holderChallengeId).toBeTruthy();
	expect(replayedStop.settledAtMs).toBe(stopped.settledAtMs);
	expect(replayedStop.participant.find((member) => member.pubkey === ownerPubkey)?.calamityMs).toBe(stoppedOwner.calamityMs);

	const resumeAtMs = await page.evaluate(() => Date.now());
	const resumeBoundaryMs = Math.floor(resumeAtMs / 1_000) * 1_000;
	const resumedActivity = finalizeEvent(buildWorldMessageTemplate({ channel,
		createdAt: Math.floor(resumeAtMs / 1_000), position: { x: 8, y: 5 }, content: 'holder resumed World activity', speechType: 'normal' }), ownerSecret);
	await injectWorldMessage(page, resumedActivity);
	await page.clock.runFor(500);
	await expect.poll(async () => latestTagGameStateValue(page, gameId, (state) => state.holderChallengeId)).toBeUndefined();
	const resumed = parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)!.state;
	expect(resumed.settledAtMs).toBeGreaterThanOrEqual(resumeBoundaryMs);
	expect(resumed.lastHolderResponseAtMs).toBeGreaterThanOrEqual(resumeBoundaryMs);
	expect(resumed.participant.find((member) => member.pubkey === ownerPubkey)?.calamityMs).toBe(stoppedOwner.calamityMs);
});

test('organizer local safety stop hides touch targets and resumes presentation after activity returns', async ({ page }) => {
	test.setTimeout(60_000);
	const nowMs = Date.now();
	const organizerSecret = fixtureSecret(47);
	const targetSecret = fixtureSecret(51);
	const organizerPubkey = getPublicKey(organizerSecret);
	const targetPubkey = getPublicKey(targetSecret);
	await preparePlayer(page, organizerSecret, nowMs, 0);
	await moveRelaySelfTo(page, { x: 7, y: 5 });
	const safetyStartedAtMs = await page.evaluate(() => Date.now());
	const nowSeconds = Math.floor(safetyStartedAtMs / 1_000);
	const channel = { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' };
	const targetPosition = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt: nowSeconds, position: { x: 8, y: 5 }, slot: 1, runNumber: 1 }), targetSecret);
	const targetActivity = finalizeEvent(buildWorldMessageTemplate({ channel, createdAt: nowSeconds, position: { x: 8, y: 5 }, content: 'active target', speechType: 'normal' }), targetSecret);
	await injectPosition(page, targetPosition);
	await injectWorldMessage(page, targetActivity);
	const seed = Array.from({ length: 10_000 }, (_, index) => `local-pause-${index}`).find((candidate) => {
		const schedule = createTagGameSchedule(candidate);
		return schedule[0].effect === 'calamity' && schedule[0].durationMs >= 30_000;
	})!;
	const gameId = `${organizerPubkey}:${nowSeconds}:${'7'.repeat(64)}`;
	const running: TagGameState = {
		gameId, hostPubkey: organizerPubkey, phase: 'running', revision: 0, updatedAt: nowSeconds,
		startedAt: nowSeconds, endsAt: nowSeconds + 120, seed, ownerPubkey: organizerPubkey, effect: 'calamity', transferAt: safetyStartedAtMs,
		participant: [organizerPubkey, targetPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: nowSeconds, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
		settledAtMs: safetyStartedAtMs, lastHolderResponseAtMs: safetyStartedAtMs
	};
	await injectRealtime(page, finalizeTagGameState(running, CHANNEL_ID, nowSeconds, organizerSecret));
	const target = page.locator(`.participant[data-participant-id="${targetPubkey}"]`);
	const hud = page.locator('[data-tag-game-hud]');
	await expect(target).toHaveAttribute('data-tag-game-touch-target', 'true');
	await expect(hud.locator('[data-tag-game-effect]')).toHaveAttribute('data-tag-game-effect-active', 'true');
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { rejectTagGameStatePublishes(): void } }).__relayStartupTest.rejectTagGameStatePublishes());
	await page.clock.runFor(23_500);
	await expect.poll(async () => {
		const event = await latestGameEvent(page, gameId);
		return parseTagGameEvent(event, CHANNEL_ID)?.state.holderChallengeId ?? null;
	}).toBeTruthy();
	const locallyStoppedAttempt = parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)!.state;
	expect(locallyStoppedAttempt.settledAtMs).toBe(safetyStartedAtMs + 23_000);
	await expect(hud.locator('[data-tag-game-effect]')).toHaveAttribute('data-tag-game-effect-active', 'false');
	await expect(hud.locator('[data-tag-game-effect] span')).toHaveText('安全停止中・効果停止');
	await expect(hud.locator('[data-tag-game-cooldown]')).toHaveText('効果停止中');
	await expect(target).not.toHaveAttribute('data-tag-game-touch-target', 'true');
	const unifiedHud = page.locator('[data-unified-status-hud]');
	await expect(unifiedHud.locator('[data-lifespan-value]')).not.toHaveAttribute('data-tag-game-flash', 'calamity');
	const pausedExpiry = await unifiedHud.getAttribute('data-current-expires-at-ms');
	const pausedPoints = await unifiedHud.getAttribute('data-current-points');
	await page.clock.runFor(2_000);
	await expect(unifiedHud).toHaveAttribute('data-current-expires-at-ms', pausedExpiry ?? '');
	await expect(unifiedHud).toHaveAttribute('data-current-points', pausedPoints ?? '');
	const touchCountBefore = (await relayState(page)).state.published.filter((event) => event.kind === 27070 && parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'touch').length;
	await page.keyboard.press('ArrowRight');
	await expect(page.locator(`.participant[data-participant-id="${organizerPubkey}"]`)).toHaveAttribute('data-position', '7,5');
	expect((await relayState(page)).state.published.filter((event) => event.kind === 27070 && parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'touch')).toHaveLength(touchCountBefore);

	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { allowTagGameStatePublishes(): void } }).__relayStartupTest.allowTagGameStatePublishes());
	const resumedAtMs = await page.evaluate(() => Date.now());
	const resumedActivity = finalizeEvent(buildWorldMessageTemplate({ channel, createdAt: Math.floor(resumedAtMs / 1_000),
		position: { x: 7, y: 5 }, content: 'organizer activity resumed', speechType: 'normal' }), organizerSecret);
	await injectWorldMessage(page, resumedActivity);
	await page.clock.runFor(500);
	await expect(hud.locator('[data-tag-game-effect]')).toHaveAttribute('data-tag-game-effect-active', 'true');
	await expect(hud.locator('[data-tag-game-effect] span')).toHaveText('所持者が追いかけて押し付ける');
	await expect(unifiedHud.locator('[data-lifespan-value]')).toHaveAttribute('data-tag-game-flash', 'calamity');
	await expect(target).toHaveAttribute('data-tag-game-touch-target', 'true');
});

test('freezes integrated HUD at 120 seconds until a delayed final state corrects it', async ({ browser }) => {
	const page = await browser.newPage();
	const nowMs = Date.now();
	const hostSecret = fixtureSecret(41);
	const otherSecret = fixtureSecret(43);
	const hostPubkey = getPublicKey(hostSecret);
	const otherPubkey = getPublicKey(otherSecret);
	const startedAt = Math.floor(nowMs / 1_000) - 119;
	const gameId = `${hostPubkey}:${startedAt}:${'e'.repeat(64)}`;
	try {
		await preparePlayer(page, hostSecret, nowMs, 0);
		await expect(page.locator('main')).toHaveAttribute('data-realtime-status', 'active');
		await moveRelaySelfTo(page, { x: 7, y: 5 });
		await page.clock.setSystemTime((startedAt + 119) * 1_000);
		await seedTagGameRunLock(page, gameId, startedAt * 1_000);
		const seed = Array.from({ length: 10_000 }, (_, index) => `end-freeze-${index}`).find((candidate) => createTagGameSchedule(candidate)[5].effect === 'calamity')!;
		const at119Ms = (startedAt + 119) * 1_000;
		const participants = [hostPubkey, otherPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: startedAt, status: 'active' as const,
			points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 }));
		const running: TagGameState = { gameId, hostPubkey, phase: 'running', revision: 0, updatedAt: startedAt + 119, startedAt, endsAt: startedAt + 120,
			seed, ownerPubkey: hostPubkey, effect: createTagGameSchedule(seed)[5].effect, transferAt: startedAt * 1_000, lastHolderResponseAtMs: at119Ms,
			settledAtMs: startedAt * 1_000, participant: participants };
		await injectRealtime(page, finalizeTagGameState(running, CHANNEL_ID, startedAt + 119, hostSecret));
		const hud = page.locator('[data-unified-status-hud]');
		await expect(hud).toHaveAttribute('data-tag-game-projection', 'true');
		const pointsAt119 = Number(await hud.getAttribute('data-current-points'));
		const expiryAt119 = Number(await hud.getAttribute('data-current-expires-at-ms'));
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { rejectTagGameStatePublishes(): void } }).__relayStartupTest.rejectTagGameStatePublishes());
		await page.clock.runFor(1_000);
		await expect.poll(async () => Number(await hud.getAttribute('data-current-points'))).toBeGreaterThanOrEqual(pointsAt119);
		await page.clock.runFor(1_000);
		const pointsAt120 = Number(await hud.getAttribute('data-current-points'));
		const expiryAt120 = Number(await hud.getAttribute('data-current-expires-at-ms'));
		expect(pointsAt120).toBeGreaterThanOrEqual(pointsAt119);
		expect(expiryAt120).toBeLessThanOrEqual(expiryAt119);
		await page.clock.runFor(5_000);
		await expect(hud).toHaveAttribute('data-current-points', String(pointsAt120));
		await expect(hud).toHaveAttribute('data-current-expires-at-ms', String(expiryAt120));
		await expect(page.getByRole('dialog', { name: '鬼ごっこ終了' })).toHaveCount(0);

		const finalAt = startedAt + 120;
		const finalState: TagGameState = {
			...running, phase: 'ended', revision: 1, updatedAt: finalAt, finalizedAt: finalAt, endReason: 'normal', settledAtMs: finalAt * 1_000,
			participant: participants.map((member) => ({ ...member, points: member.pubkey === hostPubkey ? 3_000 : 0,
				lifespanLossMs: member.pubkey === hostPubkey ? 216_000_000 : 0, benefitMs: member.pubkey === hostPubkey ? 60_000 : 0, calamityMs: member.pubkey === hostPubkey ? 60_000 : 0 }))
		};
		const finalEvent = finalizeTagGameState(finalState, CHANNEL_ID, finalAt, hostSecret);
		await injectRealtime(page, finalEvent);
		await expect.poll(async () => Number(await hud.getAttribute('data-current-points'))).toBe(3_000);
		const result = page.getByRole('dialog', { name: '鬼ごっこ終了' });
		await expect(result).toBeVisible();
		const resultRows = result.locator('[data-tag-game-result-participant]');
		await expect(resultRows).toHaveCount(2);
		await expect(resultRows.first()).toHaveAttribute('data-tag-game-result-participant', hostPubkey);
		await expect(resultRows.first()).toContainText('福 60秒');
		await expect(resultRows.first()).toContainText('ポイント +3000pt');
		await expect(resultRows.first()).toContainText('鬼 60秒');
		await expect(resultRows.first()).toContainText('寿命 −2日12時間');
		const secondStartedAt = Math.floor(await page.evaluate(() => Date.now() / 1_000));
		const secondGameId = `${hostPubkey}:${secondStartedAt}:${'f'.repeat(64)}`;
		await seedTagGameRunLock(page, secondGameId, secondStartedAt * 1_000);
		const secondRunning: TagGameState = { ...running, gameId: secondGameId, phase: 'running', revision: 0, updatedAt: secondStartedAt,
			startedAt: secondStartedAt, endsAt: secondStartedAt + 120, settledAtMs: secondStartedAt * 1_000,
			participant: participants.map((member) => ({ ...member, registeredAt: secondStartedAt })) };
		await injectRealtime(page, finalizeTagGameState(secondRunning, CHANNEL_ID, secondStartedAt, hostSecret));
		const secondFinalAt = secondStartedAt + 120;
		const secondEnded: TagGameState = { ...secondRunning, phase: 'ended', revision: 1, updatedAt: secondFinalAt, finalizedAt: secondFinalAt,
			endReason: 'normal', settledAtMs: secondFinalAt * 1_000,
			participant: secondRunning.participant.map((member) => member.pubkey === hostPubkey
				? { ...member, points: 500, lifespanLossMs: 3_600_000, benefitMs: 10_000, calamityMs: 1_000 } : member) };
		await injectRealtime(page, finalizeTagGameState(secondEnded, CHANNEL_ID, secondFinalAt, hostSecret));
		await expect(result).toHaveAttribute('data-tag-game-result-game', gameId);
		await expect(resultRows.first()).toContainText('ポイント +3000pt');
		await result.getByRole('button', { name: '閉じる' }).click();
		await expect(result).toHaveAttribute('data-tag-game-result-game', secondGameId);
		await expect(result.locator('[data-tag-game-result-participant]').first()).toContainText('ポイント +500pt');
		await result.getByRole('button', { name: '閉じる' }).click();
		await injectRealtime(page, finalizeTagGameState({ ...finalState, revision: 2, updatedAt: finalAt + 1 }, CHANNEL_ID, finalAt + 1, hostSecret));
		await expect(page.getByRole('dialog', { name: '鬼ごっこ終了' })).toHaveCount(0);
		await page.clock.runFor(800);
		await expect(hud.locator('[data-points-value]')).not.toHaveAttribute('data-value-change', /.+/);
		await expect.poll(async () => await hud.getAttribute('data-current-expires-at-ms') === await hud.getAttribute('data-base-expires-at-ms')).toBe(true);
		await expect(hud.locator('[data-points-meter]')).toHaveAttribute('data-meter-value', '3500');
	} finally { await page.close(); }
});

test('shows the game result after a midgame death presentation without settling the Run twice', async ({ page }) => {
	const nowMs = Date.now();
	const selfSecret = fixtureSecret(37);
	const otherSecret = fixtureSecret(39);
	const selfPubkey = getPublicKey(selfSecret);
	const otherPubkey = getPublicKey(otherSecret);
	const hostPubkey = selfPubkey;
	const startedAt = Math.floor(nowMs / 1_000) - 10;
	const gameId = `${hostPubkey}:${startedAt}:${'a'.repeat(64)}`;
	await preparePlayer(page, selfSecret, nowMs);
	await moveRelaySelfTo(page, { x: 7, y: 5 });
	await seedTagGameRunLock(page, gameId, startedAt * 1_000);
	await page.evaluate(() => new Promise<void>((resolve, reject) => {
		const request = indexedDB.open('persona-bubble-field-account', 9);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			const database = request.result;
			const transaction = database.transaction('persona-bubble-field-player-state', 'readwrite');
			const store = transaction.objectStore('persona-bubble-field-player-state');
			const read = store.get('player-lifecycle');
			read.onsuccess = () => {
				const current = read.result;
				const run = current.mode.activeRun;
				store.put({ ...current, mode: { ...current.mode, activeRun: { ...run, gameState: { ...run.gameState, lifespanExpiresAtMs: Date.now() + 1_000 } } } }, 'player-lifecycle');
			};
			transaction.oncomplete = () => { database.close(); resolve(); };
			transaction.onerror = () => reject(transaction.error);
		};
	}), undefined);
	const running: TagGameState = { gameId, hostPubkey, phase: 'running', revision: 0, updatedAt: startedAt, startedAt, endsAt: startedAt + 120,
		seed: 'midgame-death', ownerPubkey: hostPubkey, effect: 'benefit', transferAt: startedAt * 1_000, settledAtMs: startedAt * 1_000,
		participant: [{ pubkey: selfPubkey, runNumber: 1, registeredAt: startedAt, status: 'active', points: 700, lifespanLossMs: 3_600_000, benefitMs: 30_000, calamityMs: 0 },
			{ pubkey: otherPubkey, runNumber: 1, registeredAt: startedAt + 1, status: 'active', points: 200, lifespanLossMs: 0, benefitMs: 10_000, calamityMs: 0 }] };
	await injectRealtime(page, finalizeTagGameState(running, CHANNEL_ID, startedAt, selfSecret));
	const death = page.locator('[data-death-presentation]');
	await expect(death).toBeVisible();
	await expect.poll(async () => (await tagGamePersistence(page)).receipt).toEqual({ gameId, points: 700, lifespanLossMs: 3_600_000 });
	const endAt = startedAt + 120;
	const ended: TagGameState = { ...running, phase: 'ended', revision: 1, updatedAt: endAt, finalizedAt: endAt, endReason: 'normal', settledAtMs: endAt * 1_000,
		participant: running.participant.map((member) => member.pubkey === selfPubkey
			? { ...member, status: 'dead', points: 2_900, lifespanLossMs: 7_200_000, benefitMs: 60_000, calamityMs: 60_000 }
			: { ...member, points: 600, benefitMs: 20_000 }) };
	await injectRealtime(page, finalizeTagGameState(ended, CHANNEL_ID, endAt, selfSecret));
	await expect(page.getByRole('dialog', { name: '鬼ごっこ終了' })).toHaveCount(0);
	await expect(death.locator('textarea')).toBeVisible();
	await death.locator('textarea').fill('鬼ごっこの結果を確認しました');
	await death.getByRole('button', { name: '遺言を残して進む' }).click();
	const result = page.getByRole('dialog', { name: '鬼ごっこ終了' });
	await expect(result).toBeVisible();
	const selfRow = result.locator(`[data-tag-game-result-participant="${selfPubkey}"]`);
	await expect(selfRow).toHaveAttribute('data-tag-game-result-self', 'true');
	await expect(selfRow).toContainText('ポイント +700pt');
	await expect(selfRow).toContainText('福 30秒');
	await expect(selfRow).toContainText('鬼 0秒');
	await expect(selfRow).toContainText('寿命 −1時間');
	await expect(selfRow).toContainText('死亡');
	await expect(result.locator(`[data-tag-game-result-participant="${otherPubkey}"]`)).toContainText('ポイント +600pt');
	await expect(result.locator('.settlement-note')).toContainText('ゲーム途中の死亡時に確定');
	await expect(result.locator('.settlement-note')).toContainText('開催者が確定した最終状態');
	const savedReceipt = await tagGamePersistence(page);
	expect(savedReceipt.receipt).toEqual({ gameId, points: 700, lifespanLossMs: 3_600_000 });
	const published = await page.evaluate(() => {
		const state = (window as typeof window & { __relayStartupTest: { state: { published: Array<{ kind: number; pubkey?: string; content: string; tags: string[][] }> } } }).__relayStartupTest.state;
		return state.published;
	});
	expect(published.some((event) => event.kind === 30079 && event.pubkey === selfPubkey && event.tags.some((tag) => tag[0] === 'd' && tag[1]?.endsWith(':exit')))).toBe(true);
	expect(published.some((event) => event.kind === 42 && event.pubkey === selfPubkey && event.content === '鬼ごっこの結果を確認しました')).toBe(true);
});

test('midgame death followed by host exit labels other results as last confirmed state', async ({ page }) => {
	test.setTimeout(60_000);
	const nowMs = Date.now();
	const selfSecret = fixtureSecret(41);
	const hostSecret = fixtureSecret(43);
	const selfPubkey = getPublicKey(selfSecret);
	const hostPubkey = getPublicKey(hostSecret);
	await preparePlayer(page, selfSecret, nowMs);
	await moveRelaySelfTo(page, { x: 7, y: 5 });
	const startedAtMs = await page.evaluate(() => Date.now());
	const startedAt = Math.floor(startedAtMs / 1_000);
	const gameId = `${hostPubkey}:${startedAt}:${'e'.repeat(64)}`;
	await seedTagGameRunLock(page, gameId, startedAt * 1_000);
	await page.evaluate(() => new Promise<void>((resolve, reject) => {
		const request = indexedDB.open('persona-bubble-field-account', 9);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			const database = request.result;
			const transaction = database.transaction('persona-bubble-field-player-state', 'readwrite');
			const store = transaction.objectStore('persona-bubble-field-player-state');
			const read = store.get('player-lifecycle');
			read.onsuccess = () => {
				const current = read.result;
				const run = current.mode.activeRun;
				store.put({ ...current, mode: { ...current.mode, activeRun: { ...run, gameState: { ...run.gameState, lifespanExpiresAtMs: Date.now() + 1_000 } } } }, 'player-lifecycle');
			};
			transaction.oncomplete = () => { database.close(); resolve(); };
			transaction.onerror = () => reject(transaction.error);
		};
	}), undefined);
	const running: TagGameState = { gameId, hostPubkey, phase: 'running', revision: 0, updatedAt: startedAt, startedAt, endsAt: startedAt + 120,
		seed: 'midgame-death-host-silence', ownerPubkey: hostPubkey, effect: 'benefit', transferAt: startedAt * 1_000, settledAtMs: startedAt * 1_000,
		participant: [{ pubkey: hostPubkey, runNumber: 1, registeredAt: startedAt, status: 'active', points: 100, lifespanLossMs: 0, benefitMs: 5_000, calamityMs: 0 },
			{ pubkey: selfPubkey, runNumber: 1, registeredAt: startedAt + 1, status: 'active', points: 700, lifespanLossMs: 3_600_000, benefitMs: 30_000, calamityMs: 0 }] };
	const hostActivity = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' },
		createdAt: startedAt, position: { x: 8, y: 5 }, slot: 1, runNumber: 1 }), hostSecret);
	await injectPosition(page, hostActivity);
	await injectRealtime(page, finalizeTagGameState(running, CHANNEL_ID, startedAt, hostSecret));
	const death = page.locator('[data-death-presentation]');
	await expect(death).toBeVisible();
	await expect.poll(async () => (await tagGamePersistence(page)).receipt).toEqual({ gameId, points: 700, lifespanLossMs: 3_600_000 });
	const hostExit = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' },
		createdAt: startedAt + 1, position: { x: 8, y: 5 }, slot: 'exit', runNumber: 1, exitReason: 'death' }), hostSecret);
	await injectPosition(page, hostExit);
	await expect(death.locator('textarea')).toBeVisible();
	await death.locator('textarea').fill('結果確認');
	await death.getByRole('button', { name: '遺言を残して進む' }).click();
	const result = page.getByRole('dialog', { name: '鬼ごっこ中断' });
	await expect(result).toBeVisible();
	await expect(result.locator('.settlement-note')).toContainText('開催者の正式な最終状態を取得できなかった');
	await expect(result.locator('.settlement-note')).toContainText('最後に確認した開催状態');
	await expect(result.locator(`[data-tag-game-result-participant="${selfPubkey}"]`)).toContainText('ポイント +700pt');
	await expect(result.locator(`[data-tag-game-result-participant="${hostPubkey}"]`)).toContainText('ポイント +100pt');
	await expect(result.locator(`[data-tag-game-result-participant="${hostPubkey}"]`)).toContainText('福 5秒');
});

test('restores auto-result eligibility from the active Run lock after bootstrap, but not for terminal history', async ({ browser }) => {
	const page = await browser.newPage();
	const nowMs = Date.now();
	const selfSecret = fixtureSecret(35);
	const otherSecret = fixtureSecret(36);
	const hostSecret = fixtureSecret(32);
	const selfPubkey = getPublicKey(selfSecret);
	const otherPubkey = getPublicKey(otherSecret);
	const hostPubkey = getPublicKey(hostSecret);
	const startedAt = Math.floor(nowMs / 1_000) - 119;
	const gameId = `${hostPubkey}:${startedAt}:${'b'.repeat(64)}`;
	try {
		await preparePlayer(page, selfSecret, nowMs, 0, true);
		await moveRelaySelfTo(page, { x: 7, y: 5 });
		await seedTagGameRunLock(page, gameId, startedAt * 1_000);
		const running: TagGameState = { gameId, hostPubkey, phase: 'running', revision: 0, updatedAt: startedAt, startedAt, endsAt: startedAt + 120,
			seed: 'reload-current-run', ownerPubkey: hostPubkey, effect: 'benefit', transferAt: startedAt * 1_000, settledAtMs: startedAt * 1_000,
			participant: [{ pubkey: hostPubkey, runNumber: 1, registeredAt: startedAt, status: 'active', points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 },
				{ pubkey: selfPubkey, runNumber: 1, registeredAt: startedAt + 1, status: 'active', points: 300, lifespanLossMs: 0, benefitMs: 6_000, calamityMs: 0 },
				{ pubkey: otherPubkey, runNumber: 1, registeredAt: startedAt + 1, status: 'active', points: 50, lifespanLossMs: 0, benefitMs: 1_000, calamityMs: 0 }] };
		const bootstrapRunning = finalizeTagGameState(running, CHANNEL_ID, startedAt, hostSecret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { queueRealtimeBootstrapEvent(event: object): void } }).__relayStartupTest.queueRealtimeBootstrapEvent(event), bootstrapRunning);
		await page.reload();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toBeVisible();
		await expect.poll(async () => page.evaluate((id) => (window as typeof window & { __relayStartupTest: { state: { realtimeHistory: Array<{ id: string }> } } }).__relayStartupTest.state.realtimeHistory.some((event) => event.id === id), bootstrapRunning.id)).toBe(true);
		await expect(page.locator('main')).toHaveAttribute('data-realtime-status', 'active');
		await openTagGameTerminal(page);
		await expect(page.locator(`[data-tag-game-current="${gameId}"]`)).toBeVisible();
		await expect.poll(async () => (await tagGamePersistence(page)).lock).toMatchObject({ gameId, runNumber: 1 });
		const finalAt = startedAt + 120;
		const ended: TagGameState = { ...running, phase: 'ended', revision: 1, updatedAt: finalAt, finalizedAt: finalAt, endReason: 'normal', settledAtMs: finalAt * 1_000,
			participant: running.participant.map((member) => member.pubkey === selfPubkey
				? { ...member, points: 3_000, lifespanLossMs: 216_000_000, benefitMs: 60_000, calamityMs: 60_000 }
				: { ...member, points: member.pubkey === hostPubkey ? 0 : 50 }) };
		const finalEvent = finalizeTagGameState(ended, CHANNEL_ID, finalAt, hostSecret);
		await injectRealtime(page, finalEvent);
		await expect.poll(async () => page.evaluate((id) => (window as typeof window & { __relayStartupTest: { state: { realtimeHistory: Array<{ id: string }> } } }).__relayStartupTest.state.realtimeHistory.some((event) => event.id === id), finalEvent.id)).toBe(true);
		await expect.poll(async () => (await tagGamePersistence(page)).receipt).toEqual({ gameId, points: 3_000, lifespanLossMs: 216_000_000 });
		const result = page.getByRole('dialog', { name: '鬼ごっこ終了' });
		await expect(result).toBeVisible();
		await expect(result.locator(`[data-tag-game-result-participant="${selfPubkey}"]`)).toHaveAttribute('data-tag-game-result-self', 'true');
		await result.getByRole('button', { name: '閉じる' }).click();
		await injectRealtime(page, finalizeTagGameState({ ...ended, revision: 2, updatedAt: finalAt + 1 }, CHANNEL_ID, finalAt + 1, hostSecret));
		await expect(result).toHaveCount(0);
	} finally { await page.close(); }

	const terminalBootstrapPage = await browser.newPage();
	try {
		const bootstrapAt = Math.floor(nowMs / 1_000) - 130;
		const bootstrapId = `${hostPubkey}:${bootstrapAt}:${'d'.repeat(64)}`;
		await preparePlayer(terminalBootstrapPage, selfSecret, nowMs, 0, true);
		await moveRelaySelfTo(terminalBootstrapPage, { x: 7, y: 5 });
		await seedTagGameRunLock(terminalBootstrapPage, bootstrapId, bootstrapAt * 1_000);
		await expect.poll(async () => (await tagGamePersistence(terminalBootstrapPage)).lock).toMatchObject({ gameId: bootstrapId, runNumber: 1 });
		const terminalState: TagGameState = { gameId: bootstrapId, hostPubkey, phase: 'ended', revision: 1, updatedAt: bootstrapAt + 120,
			startedAt: bootstrapAt, endsAt: bootstrapAt + 120, finalizedAt: bootstrapAt + 120, endReason: 'normal', seed: 'terminal-bootstrap-current-run',
			ownerPubkey: hostPubkey, effect: 'benefit', transferAt: bootstrapAt * 1_000, settledAtMs: (bootstrapAt + 120) * 1_000,
			participant: [{ pubkey: hostPubkey, runNumber: 1, registeredAt: bootstrapAt, status: 'active', points: 100, lifespanLossMs: 0, benefitMs: 2_000, calamityMs: 0 },
				{ pubkey: selfPubkey, runNumber: 1, registeredAt: bootstrapAt + 1, status: 'active', points: 900, lifespanLossMs: 7_200_000, benefitMs: 30_000, calamityMs: 0 }] };
		const bootstrapFinal = finalizeTagGameState(terminalState, CHANNEL_ID, bootstrapAt + 120, hostSecret);
		await terminalBootstrapPage.evaluate((event) => (window as typeof window & { __relayStartupTest: { queueRealtimeBootstrapEvent(event: object): void } }).__relayStartupTest.queueRealtimeBootstrapEvent(event), bootstrapFinal);
		await terminalBootstrapPage.reload();
		await terminalBootstrapPage.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(terminalBootstrapPage.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toBeVisible();
		await expect.poll(async () => terminalBootstrapPage.evaluate((id) => (window as typeof window & { __relayStartupTest: { state: { realtimeHistory: Array<{ id: string }> } } }).__relayStartupTest.state.realtimeHistory.some((event) => event.id === id), bootstrapFinal.id)).toBe(true);
		const result = terminalBootstrapPage.getByRole('dialog', { name: '鬼ごっこ終了' });
		await expect.poll(async () => (await tagGamePersistence(terminalBootstrapPage)).receipt).toEqual({ gameId: bootstrapId, points: 900, lifespanLossMs: 7_200_000 });
		await expect(result).toBeVisible();
		await expect(result.locator(`[data-tag-game-result-participant="${selfPubkey}"]`)).toHaveAttribute('data-tag-game-result-self', 'true');
		await result.getByRole('button', { name: '閉じる' }).click();
		await injectRealtime(terminalBootstrapPage, finalizeTagGameState({ ...terminalState, revision: 2, updatedAt: bootstrapAt + 121 }, CHANNEL_ID, bootstrapAt + 121, hostSecret));
		await expect(result).toHaveCount(0);
	} finally { await terminalBootstrapPage.close(); }

	const historyPage = await browser.newPage();
	try {
		const oldHostSecret = fixtureSecret(33);
		const oldHostPubkey = getPublicKey(oldHostSecret);
		const historyAt = Math.floor(nowMs / 1_000) - 120;
		const historyId = `${oldHostPubkey}:${historyAt}:${'c'.repeat(64)}`;
		await preparePlayer(historyPage, selfSecret, nowMs, 0, true);
		const historical: TagGameState = { gameId: historyId, hostPubkey: oldHostPubkey, phase: 'ended', revision: 1, updatedAt: historyAt + 120, startedAt: historyAt, endsAt: historyAt + 120,
			finalizedAt: historyAt + 120, endReason: 'normal', seed: 'old-finished-game', ownerPubkey: oldHostPubkey, effect: 'benefit', transferAt: historyAt * 1_000,
			settledAtMs: (historyAt + 120) * 1_000, participant: [{ pubkey: selfPubkey, runNumber: 1, registeredAt: historyAt, status: 'active', points: 100, lifespanLossMs: 0, benefitMs: 2_000, calamityMs: 0 }] };
		await historyPage.evaluate((event) => (window as typeof window & { __relayStartupTest: { queueRealtimeBootstrapEvent(event: object): void } }).__relayStartupTest.queueRealtimeBootstrapEvent(event), finalizeTagGameState(historical, CHANNEL_ID, historyAt + 120, oldHostSecret));
		await historyPage.reload();
		await historyPage.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(historyPage.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toBeVisible();
		await expect.poll(async () => historyPage.evaluate((kind) => (window as typeof window & { __relayStartupTest: { state: { realtimeHistory: Array<{ kind: number }> } } }).__relayStartupTest.state.realtimeHistory.some((event) => event.kind === kind), TAG_GAME_KIND)).toBe(true);
		await expect(historyPage.getByRole('dialog', { name: '鬼ごっこ終了' })).toHaveCount(0);
	} finally { await historyPage.close(); }
});

test('shows all eight historical results within a mobile result dialog', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const nowMs = Date.now();
	const hostSecret = fixtureSecret(19);
	const selfSecret = fixtureSecret(34);
	const currentHostSecret = fixtureSecret(20);
	const currentPlayerSecret = fixtureSecret(21);
	const hostPubkey = getPublicKey(hostSecret);
	const selfPubkey = getPublicKey(selfSecret);
	const currentHostPubkey = getPublicKey(currentHostSecret);
	const startedAt = Math.floor(nowMs / 1_000) - 130;
	const gameId = `${hostPubkey}:${startedAt}:${'c'.repeat(64)}`;
	await preparePlayer(page, selfSecret, nowMs, 300_000);
	await moveRelaySelfTo(page, { x: 7, y: 5 });
	await openTagGameTerminal(page);
	const registered = [19, 20, 21, 23, 29, 30, 31, 34].map((fixture) => getPublicKey(fixtureSecret(fixture)));
	const participants: TagGameState['participant'][number][] = registered.map((pubkey, index) => ({
		pubkey, runNumber: 1, registeredAt: startedAt + index, status: index === 2 ? 'dead' : index === 4 ? 'left' : 'active',
		points: index * 25, lifespanLossMs: index * 1_800_000, benefitMs: index * 500, calamityMs: index * 500
	}));
	const ended: TagGameState = { gameId, hostPubkey, phase: 'ended', revision: 1, updatedAt: startedAt + 120, startedAt,
		endsAt: startedAt + 120, finalizedAt: startedAt + 120, endReason: 'normal', seed: 'a'.repeat(64), ownerPubkey: hostPubkey,
		effect: 'benefit', settledAtMs: (startedAt + 120) * 1_000, participant: participants };
	await injectRealtime(page, finalizeTagGameState(ended, CHANNEL_ID, startedAt + 120, hostSecret));
	await expect(page.getByRole('dialog', { name: '鬼ごっこ終了' })).toHaveCount(0);
	const currentCreatedAt = Math.floor(nowMs / 1_000);
	const currentGameId = `${currentHostPubkey}:${currentCreatedAt}:${'b'.repeat(64)}`;
	const currentGame: TagGameState = { gameId: currentGameId, hostPubkey: currentHostPubkey, phase: 'lobby', revision: 0,
		updatedAt: currentCreatedAt, participant: [currentHostPubkey, getPublicKey(currentPlayerSecret)].map((pubkey) => ({ pubkey, runNumber: 1,
			registeredAt: currentCreatedAt, status: 'registered' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })), settledAtMs: nowMs };
	await injectRealtime(page, finalizeTagGameState(currentGame, CHANNEL_ID, currentCreatedAt, currentHostSecret));
	const panel = page.getByRole('dialog', { name: '鬼ごっこ' });
	const currentSection = panel.locator('[data-tag-game-current-section]');
	const currentCard = currentSection.locator(`[data-tag-game-current="${currentGameId}"]`);
	await expect(currentCard).toHaveClass(/current-game-lobby/);
	await expect(currentCard).toContainText('募集中');
	const currentBounds = await currentSection.boundingBox();
	const historyBounds = await panel.locator('[data-tag-game-history-section]').boundingBox();
	expect(currentBounds).not.toBeNull();
	expect(historyBounds).not.toBeNull();
	expect(currentBounds!.y).toBeLessThan(historyBounds!.y);
	const history = panel.locator('[data-tag-game-history-section] details');
	await expect(history).not.toHaveAttribute('open', '');
	await history.locator('summary').click();
	const showResult = history.getByRole('button', { name: '結果を見る' });
	await showResult.click();
	const result = page.getByRole('dialog', { name: '鬼ごっこ終了' });
	const rows = result.locator('[data-tag-game-result-participant]');
	await expect(rows).toHaveCount(8);
	await expect(rows.first()).toHaveAttribute('data-tag-game-result-participant', selfPubkey);
	await expect(rows.nth(1)).toHaveAttribute('data-tag-game-result-participant', registered[0]);
	await expect(rows.nth(2)).toHaveAttribute('data-tag-game-result-participant', registered[1]);
	await expect(rows.nth(3)).toContainText('死亡');
	await expect(rows.nth(5)).toContainText('退出');
	for (let index = 0; index < 8; index += 1) {
		const row = rows.nth(index);
		await row.scrollIntoViewIfNeeded();
		const box = await row.boundingBox();
		expect(box).not.toBeNull();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(390);
		await expect(row.locator('.result-values')).toHaveCount(2);
	}
	await page.keyboard.press('Escape');
	await expect(result).toHaveCount(0);
	await expect.poll(() => showResult.evaluate((element) => element === document.activeElement)).toBe(true);
});

test('a still holder updates its integrated HUD from successful precheck responses without World activity', async ({ browser }) => {
	test.setTimeout(90_000);
	const hostPage = await browser.newPage();
	const holderPage = await browser.newPage();
	const nowMs = Date.now();
	const hostSecret = fixtureSecret(19);
	const holderSecret = fixtureSecret(20);
	const hostPubkey = getPublicKey(hostSecret);
	const holderPubkey = getPublicKey(holderSecret);
	try {
		await Promise.all([preparePlayer(hostPage, hostSecret, nowMs), preparePlayer(holderPage, holderSecret, nowMs)]);
		await expect(hostPage.locator('main')).toHaveAttribute('data-realtime-status', 'active');
		await expect(holderPage.locator('main')).toHaveAttribute('data-realtime-status', 'active');
		await Promise.all([moveRelaySelfTo(hostPage, { x: 7, y: 5 }), moveRelaySelfTo(holderPage, { x: 8, y: 5 })]);
		await injectPosition(hostPage, await latestPublished(holderPage, WORLD_STATE_KIND, holderPubkey));
		const startedAt = Math.floor(await holderPage.evaluate(() => Date.now() / 1_000));
		const channel = { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' };
		const holderActivity = finalizeEvent(buildWorldMessageTemplate({ channel, createdAt: startedAt, position: { x: 8, y: 5 }, content: 'holder active at start', speechType: 'normal' }), holderSecret);
		await injectWorldMessage(hostPage, holderActivity);
		const seed = Array.from({ length: 10_000 }, (_, index) => `still-holder-${index}`).find((candidate) => {
			const schedule = createTagGameSchedule(candidate);
			return schedule[0].effect === 'benefit' && schedule[0].durationMs === 20_000;
		})!;
		const gameId = `${hostPubkey}:${startedAt}:${'8'.repeat(64)}`;
		const running: TagGameState = {
			gameId, hostPubkey, phase: 'running', revision: 0, updatedAt: startedAt, startedAt, endsAt: startedAt + 120, seed,
			ownerPubkey: holderPubkey, effect: 'benefit', transferAt: startedAt * 1_000, lastHolderResponseAtMs: startedAt * 1_000,
			participant: [hostPubkey, holderPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: startedAt, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
			settledAtMs: startedAt * 1_000
		};
		const stateEvent = finalizeTagGameState(running, CHANNEL_ID, startedAt, hostSecret);
		await Promise.all([injectRealtime(hostPage, stateEvent), injectRealtime(holderPage, stateEvent)]);
		const holderHud = holderPage.locator('[data-unified-status-hud]');
		await expect(holderHud).toHaveAttribute('data-tag-game-projection', 'true');
		const holderWorldMessageCount = await holderPage.evaluate(() => (window as typeof window & { __relayStartupTest: { state: { published: Array<{ kind: number }> } } }).__relayStartupTest.state.published.filter((event) => event.kind === 42).length);
		const hostStatePublishCount = await hostPage.evaluate((gameKind) => (window as typeof window & { __relayStartupTest: { state: { published: Array<{ kind: number }> } } }).__relayStartupTest.state.published.filter((event) => event.kind === gameKind).length, TAG_GAME_KIND);
		await holderPage.evaluate(() => (window as typeof window & { __relayStartupTest: { setRealtimePublishOutcome(outcome: 'accepted'): void } }).__relayStartupTest.setRealtimePublishOutcome('accepted'));

		await holderPage.clock.runFor(15_000);
		await expect.poll(async () => Number(await holderHud.getAttribute('data-current-points'))).toBeGreaterThan(0);
		const challengeId = 'c'.repeat(32);
		const challenge = finalizeEvent(buildTagGameActionTemplate({ channelId: CHANNEL_ID, gameId, action: 'response-challenge', runNumber: 1,
			nonce: 'd'.repeat(32), createdAt: await holderPage.evaluate(() => Math.floor(Date.now() / 1_000)), payload: { challengeId, stage: 'precheck' } }), hostSecret);
		await injectRealtime(holderPage, challenge);
		await expect.poll(async () => new Set((await relayState(holderPage)).state.published.filter((event) => event.kind === 27070 &&
			parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'response' &&
			parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.payload.challengeId === challengeId).map((event) => event.id)).size).toBe(1);
		const response = (await relayState(holderPage)).state.published.filter((event) => event.kind === 27070 && event.pubkey === holderPubkey)
			.map((event) => event as unknown as NostrEvent).filter((event) => parseTagGameActionEvent(event, CHANNEL_ID)?.action === 'response' &&
				parseTagGameActionEvent(event, CHANNEL_ID)?.payload.challengeId === challengeId).at(-1)!;
		expect(parseTagGameActionEvent(response, CHANNEL_ID)?.payload.challengeId).toBe(challengeId);
		await injectRealtime(hostPage, response);
		await holderPage.clock.runFor(10_000);
		const renewedAt = startedAt + 25;
		await injectRealtime(holderPage, finalizeTagGameState({ ...running, revision: running.revision + 1, updatedAt: renewedAt }, CHANNEL_ID, renewedAt, hostSecret));
		await holderPage.clock.runFor(13_000);

		await expect.poll(async () => Number(await holderHud.getAttribute('data-current-points'))).toBeGreaterThan(Number(await holderHud.getAttribute('data-saved-points')));
		await expect.poll(async () => Number(await holderHud.getAttribute('data-base-expires-at-ms')) - Number(await holderHud.getAttribute('data-current-expires-at-ms'))).toBeGreaterThan(3 * 3_600_000);
		const worldMessageCountAfter = await holderPage.evaluate(() => (window as typeof window & { __relayStartupTest: { state: { published: Array<{ kind: number }> } } }).__relayStartupTest.state.published.filter((event) => event.kind === 42).length);
		const hostStatePublishCountAfter = await hostPage.evaluate((gameKind) => (window as typeof window & { __relayStartupTest: { state: { published: Array<{ kind: number }> } } }).__relayStartupTest.state.published.filter((event) => event.kind === gameKind).length, TAG_GAME_KIND);
		expect(worldMessageCountAfter).toBe(holderWorldMessageCount);
		expect(hostStatePublishCountAfter).toBe(hostStatePublishCount);
	} finally {
		await Promise.all([hostPage.close(), holderPage.close()]);
	}
});

test('keeps a valid precheck response as local activity when 37070 updates fail', async ({ page }) => {
	test.setTimeout(60_000);
	const nowMs = Date.now();
	const hostSecret = fixtureSecret(36);
	const holderSecret = fixtureSecret(38);
	const hostPubkey = getPublicKey(hostSecret);
	const holderPubkey = getPublicKey(holderSecret);
	await preparePlayer(page, hostSecret, nowMs, 0, false);
	await moveRelaySelfTo(page, { x: 7, y: 5 });
	const startedAt = await page.evaluate(() => Math.floor(Date.now() / 1_000));
	const channel = { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' };
	const holderActivity = finalizeEvent(buildWorldMessageTemplate({ channel, createdAt: startedAt, position: { x: 8, y: 5 },
		content: 'holder is active', speechType: 'normal' }), holderSecret);
	await injectWorldMessage(page, holderActivity);
	const seed = Array.from({ length: 10_000 }, (_, index) => `precheck-response-${index}`).find((candidate) => {
		const schedule = createTagGameSchedule(candidate);
		return schedule[0].effect === 'benefit' && schedule[0].durationMs >= 40_000;
	})!;
	const gameId = `${hostPubkey}:${startedAt}:${'e'.repeat(64)}`;
	const running: TagGameState = {
		gameId, hostPubkey, phase: 'running', revision: 0, updatedAt: startedAt,
		startedAt, endsAt: startedAt + 120, seed, ownerPubkey: holderPubkey, effect: 'benefit', transferAt: startedAt * 1_000,
		participant: [hostPubkey, holderPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: startedAt, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
		settledAtMs: startedAt * 1_000, lastHolderResponseAtMs: startedAt * 1_000
	};
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { rejectTagGameStatePublishes(): void } }).__relayStartupTest.rejectTagGameStatePublishes());
	await injectRealtime(page, finalizeTagGameState(running, CHANNEL_ID, startedAt, hostSecret));
	await expect(page.locator('[data-tag-game-hud] [data-tag-game-effect-active]')).toHaveAttribute('data-tag-game-effect-active', 'true');
	await page.clock.runFor(15_500);
	const precheck = await latestTagGameAction(page, hostPubkey, 'response-challenge');
	expect(parseTagGameActionEvent(precheck, CHANNEL_ID)?.payload).toMatchObject({ stage: 'precheck' });
	const challengeId = parseTagGameActionEvent(precheck, CHANNEL_ID)!.payload.challengeId as string;
	await page.clock.runFor(500);
	const response = finalizeEvent(buildTagGameActionTemplate({ channelId: CHANNEL_ID, gameId, action: 'response', runNumber: 1,
		nonce: 'f'.repeat(32), createdAt: await page.evaluate(() => Math.floor(Date.now() / 1_000)), payload: { challengeId } }), holderSecret);
	await injectRealtime(page, response);
	const precheckCountAfterResponse = await page.evaluate((pubkey) => (window as typeof window & { __relayStartupTest: { state: { published: Array<{ kind: number; pubkey?: string; tags: string[][]; content: string }> } } }).__relayStartupTest.state.published
		.filter((event) => event.kind === 27070 && event.pubkey === pubkey && JSON.parse(event.content).stage === 'precheck').length, hostPubkey);
	await page.clock.runFor(8_000);
	await expect(page.locator('[data-tag-game-hud] [data-tag-game-effect-active]')).toHaveAttribute('data-tag-game-effect-active', 'true');
	await expect(page.locator('[data-tag-game-hud]')).not.toContainText('応答確認中・効果停止');
	const hostStates = (await relayState(page)).state.published.filter((event) => event.kind === TAG_GAME_KIND && event.pubkey === hostPubkey);
	expect(hostStates.some((event) => parseTagGameEvent(event as unknown as NostrEvent, CHANNEL_ID)?.state.holderChallengeId)).toBe(false);
	await page.clock.runFor(6_000);
	await expect(page.locator('[data-tag-game-hud] [data-tag-game-effect-active]')).toHaveAttribute('data-tag-game-effect-active', 'true');
	await expect.poll(async () => (await relayState(page)).state.published.filter((event) => event.kind === 27070 &&
		parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'response-challenge' &&
		parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.payload.stage === 'precheck').length).toBe(precheckCountAfterResponse);
});

test('responds to a formal holder challenge after a missed precheck and resumes only from organizer-signed state', async ({ browser }) => {
	test.setTimeout(60_000);
	const hostPage = await browser.newPage();
	const holderPage = await browser.newPage();
	const nowMs = Date.now();
	const hostSecret = fixtureSecret(55);
	const holderSecret = fixtureSecret(57);
	const hostPubkey = getPublicKey(hostSecret);
	const holderPubkey = getPublicKey(holderSecret);
	try {
		await Promise.all([preparePlayer(hostPage, hostSecret, nowMs), preparePlayer(holderPage, holderSecret, nowMs)]);
		await Promise.all([expect(hostPage.locator('main')).toHaveAttribute('data-realtime-status', 'active'), expect(holderPage.locator('main')).toHaveAttribute('data-realtime-status', 'active')]);
		await Promise.all([moveRelaySelfTo(hostPage, { x: 7, y: 5 }), moveRelaySelfTo(holderPage, { x: 8, y: 5 })]);
		const setupNowMs = await holderPage.evaluate(() => Date.now());
		const startedAt = Math.floor(setupNowMs / 1_000) - 20;
		const gameId = `${hostPubkey}:${startedAt}:${'9'.repeat(64)}`;
		const seed = Array.from({ length: 10_000 }, (_, index) => `formal-response-after-precheck-${index}`).find((candidate) => {
			const firstEffect = createTagGameSchedule(candidate)[0];
			return firstEffect.effect === 'benefit' && firstEffect.durationMs >= 40_000;
		})!;
		const participant = [
			{ pubkey: hostPubkey, runNumber: 1, registeredAt: startedAt, status: 'temporarily-ineligible' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 },
			{ pubkey: holderPubkey, runNumber: 1, registeredAt: startedAt, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 }
		];
		const running: TagGameState = {
			gameId, hostPubkey, phase: 'running', revision: 0, updatedAt: startedAt, startedAt, endsAt: startedAt + 120,
			seed, ownerPubkey: holderPubkey, effect: 'benefit', transferAt: startedAt * 1_000,
			participant, settledAtMs: setupNowMs, lastHolderResponseAtMs: setupNowMs
		};
		const initial = finalizeTagGameState(running, CHANNEL_ID, startedAt, hostSecret);
		await Promise.all([injectRealtime(hostPage, initial), injectRealtime(holderPage, initial)]);
		await holderPage.evaluate(() => (window as typeof window & { __relayStartupTest: { setRealtimePublishOutcome(outcome: 'rejected'): void } }).__relayStartupTest.setRealtimePublishOutcome('rejected'));
		const missedPrecheckId = '1'.repeat(32);
		const precheck = finalizeEvent(buildTagGameActionTemplate({ channelId: CHANNEL_ID, gameId, action: 'response-challenge', runNumber: 1,
			nonce: '2'.repeat(32), createdAt: Math.floor(nowMs / 1_000), payload: { challengeId: missedPrecheckId, stage: 'precheck' } }), hostSecret);
		await injectRealtime(holderPage, precheck);
		await holderPage.clock.runFor(100);
		expect((await relayState(hostPage)).state.published.some((event) => event.kind === 27070 && event.pubkey === holderPubkey &&
			parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'response' &&
			parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.payload.challengeId === missedPrecheckId)).toBe(false);

		const stoppedAtMs = Math.floor(setupNowMs / 1_000) * 1_000 + 1_000;
		const stoppedId = '3'.repeat(32);
		const stopped: TagGameState = { ...running, revision: 1, updatedAt: Math.floor(stoppedAtMs / 1_000), settledAtMs: stoppedAtMs,
			holderChallengeId: stoppedId, holderChallengeStartedAtMs: stoppedAtMs, participant };
		const stoppedEvent = finalizeTagGameState(stopped, CHANNEL_ID, Math.floor(stoppedAtMs / 1_000) - 1, hostSecret);
		await Promise.all([hostPage.clock.setSystemTime(stoppedAtMs), holderPage.clock.setSystemTime(stoppedAtMs)]);
		await holderPage.evaluate(() => (window as typeof window & { __relayStartupTest: { setRealtimePublishOutcome(outcome: 'accepted'): void } }).__relayStartupTest.setRealtimePublishOutcome('accepted'));
		const formal = finalizeEvent(buildTagGameActionTemplate({ channelId: CHANNEL_ID, gameId, action: 'response-challenge', runNumber: 1,
			nonce: '4'.repeat(32), createdAt: await holderPage.evaluate(() => Math.floor(Date.now() / 1_000)), payload: { challengeId: stoppedId, stage: 'formal' } }), hostSecret);
		await injectRealtime(holderPage, formal);
		await holderPage.clock.runFor(100);
		expect((await relayState(holderPage)).state.published.some((event) => event.kind === 27070 && event.pubkey === holderPubkey &&
			parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'response' &&
			parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.payload.challengeId === stoppedId)).toBe(false);
		await Promise.all([injectRealtime(hostPage, stoppedEvent), injectRealtime(holderPage, stoppedEvent)]);
		await expect.poll(async () => new Set((await relayState(holderPage)).state.published.filter((event) => event.kind === 27070 && event.pubkey === holderPubkey &&
			parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'response' &&
			parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.payload.challengeId === stoppedId).map((event) => event.id)).size).toBe(1);
		const response = (await relayState(holderPage)).state.published.filter((event) => event.kind === 27070 && event.pubkey === holderPubkey)
			.map((event) => event as unknown as NostrEvent).filter((event) => parseTagGameActionEvent(event, CHANNEL_ID)?.action === 'response' &&
				parseTagGameActionEvent(event, CHANNEL_ID)?.payload.challengeId === stoppedId).at(-1)!;
		await expect(holderPage.locator('[data-tag-game-hud] [data-tag-game-effect-active]')).toHaveAttribute('data-tag-game-effect-active', 'false');
		await injectRealtime(hostPage, response);
		await hostPage.clock.runFor(1_100);
		await expect.poll(async () => {
			const event = await latestGameEvent(hostPage, gameId);
			return parseTagGameEvent(event, CHANNEL_ID)?.state.holderChallengeId;
		}).toBeUndefined();
		const resumed = await latestGameEvent(hostPage, gameId);
		expect(resumed.pubkey).toBe(hostPubkey);
		const resumedState = parseTagGameEvent(resumed, CHANNEL_ID)!.state;
		expect(resumedState.participant.find((member) => member.pubkey === hostPubkey)?.status).toBe('temporarily-ineligible');
		expect(resumedState.lastHolderResponseAtMs).toBeGreaterThanOrEqual(stoppedAtMs);
		await holderPage.clock.setSystemTime(resumedState.lastHolderResponseAtMs!);
		await injectRealtime(holderPage, resumed);
		await holderPage.clock.runFor(1_100);
		await expect(holderPage.locator('[data-tag-game-hud] [data-tag-game-effect-active]')).toHaveAttribute('data-tag-game-effect-active', 'true');
	} finally {
		await Promise.all([hostPage.close(), holderPage.close()]);
	}
});

test('rejects formal challenges with a wrong id, stale Run, or former holder', async ({ page }) => {
	const nowMs = Date.now();
	const hostSecret = fixtureSecret(30);
	const holderSecret = fixtureSecret(31);
	const replacementSecret = fixtureSecret(32);
	const hostPubkey = getPublicKey(hostSecret);
	const holderPubkey = getPublicKey(holderSecret);
	const replacementPubkey = getPublicKey(replacementSecret);
	await preparePlayer(page, holderSecret, nowMs);
	await expect(page.locator('main')).toHaveAttribute('data-realtime-status', 'active');
	const startedAt = Math.floor(nowMs / 1_000) - 10;
	const gameId = `${hostPubkey}:${startedAt}:${'a'.repeat(64)}`;
	const challengeId = 'b'.repeat(32);
	let revision = 0;
	let requestNonce = 10;
	const publishChallenge = async (state: TagGameState, requestedChallengeId: string) => {
		const event = finalizeTagGameState(state, CHANNEL_ID, state.updatedAt, hostSecret);
		await injectRealtime(page, event);
		const request = finalizeEvent(buildTagGameActionTemplate({ channelId: CHANNEL_ID, gameId, action: 'response-challenge', runNumber: 1,
			nonce: String(requestNonce++).padStart(32, '0'), createdAt: Math.floor(await page.evaluate(() => Date.now() / 1_000)),
			payload: { challengeId: requestedChallengeId, stage: 'formal' } }), hostSecret);
		await injectRealtime(page, request);
		await page.clock.runFor(100);
	};
	const sentResponses = async () => (await relayState(page)).state.published.filter((event) => event.kind === 27070 && event.pubkey === holderPubkey &&
		parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'response').length;
	const base: TagGameState = {
		gameId, hostPubkey, phase: 'running', revision, updatedAt: startedAt, startedAt, endsAt: startedAt + 120,
		seed: 'reject-stale-formal-challenges', ownerPubkey: holderPubkey, effect: 'benefit', transferAt: startedAt * 1_000,
		participant: [hostPubkey, holderPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: startedAt, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
		settledAtMs: nowMs, holderChallengeId: challengeId, holderChallengeStartedAtMs: nowMs
	};
	await publishChallenge(base, 'c'.repeat(32));
	expect(await sentResponses()).toBe(0);
	revision++;
	await publishChallenge({ ...base, revision, updatedAt: startedAt + 1,
		participant: base.participant.map((member) => member.pubkey === holderPubkey ? { ...member, runNumber: 2 } : member) }, challengeId);
	expect(await sentResponses()).toBe(0);
	revision++;
	await publishChallenge({ ...base, revision, updatedAt: startedAt + 2, ownerPubkey: replacementPubkey,
		participant: [...base.participant, { pubkey: replacementPubkey, runNumber: 1, registeredAt: startedAt, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 }],
		holderChallengeId: 'd'.repeat(32) }, 'd'.repeat(32));
	expect(await sentResponses()).toBe(0);
});

test('expires a reordered formal challenge unless its matching stop arrives for the current holder and Run', async ({ page }) => {
	test.setTimeout(60_000);
	const nowMs = Date.now();
	const hostSecret = fixtureSecret(34);
	const holderSecret = fixtureSecret(35);
	const replacementSecret = fixtureSecret(36);
	const hostPubkey = getPublicKey(hostSecret);
	const holderPubkey = getPublicKey(holderSecret);
	const replacementPubkey = getPublicKey(replacementSecret);
	await preparePlayer(page, holderSecret, nowMs);
	await expect(page.locator('main')).toHaveAttribute('data-realtime-status', 'active');
	const startedAt = Math.floor(nowMs / 1_000) - 10;
	let nonce = 40;
	const makeState = (suffix: string, revision = 0): TagGameState => {
		const gameId = `${hostPubkey}:${startedAt}:${suffix.repeat(64)}`;
		return { gameId, hostPubkey, phase: 'running', revision, updatedAt: startedAt + revision, startedAt, endsAt: startedAt + 120,
			seed: `held-formal-challenge-${suffix}`, ownerPubkey: holderPubkey, effect: 'benefit', transferAt: startedAt * 1_000,
			participant: [hostPubkey, holderPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: startedAt, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
			settledAtMs: nowMs };
	};
	const injectState = async (state: TagGameState) => {
		await injectRealtime(page, finalizeTagGameState(state, CHANNEL_ID, state.updatedAt, hostSecret));
	};
	const injectFormal = async (state: TagGameState, challengeId: string) => {
		const request = finalizeEvent(buildTagGameActionTemplate({ channelId: CHANNEL_ID, gameId: state.gameId, action: 'response-challenge', runNumber: 1,
			nonce: String(nonce++).padStart(32, '0'), createdAt: Math.floor(await page.evaluate(() => Date.now() / 1_000)),
			payload: { challengeId, stage: 'formal' } }), hostSecret);
		await injectRealtime(page, request);
		await page.clock.runFor(100);
	};
	const sentResponses = async () => (await relayState(page)).state.published.filter((event) => event.kind === 27070 && event.pubkey === holderPubkey &&
		parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'response').length;

	const missingStop = makeState('e');
	await injectState(missingStop);
	await injectFormal(missingStop, '1'.repeat(32));
	expect(await sentResponses()).toBe(0);
	await page.clock.runFor(2_100);
	expect(await sentResponses()).toBe(0);

	const changedHolder = makeState('f');
	await injectState(changedHolder);
	await injectFormal(changedHolder, '2'.repeat(32));
	await injectState({ ...changedHolder, revision: 1, updatedAt: changedHolder.updatedAt + 1, ownerPubkey: replacementPubkey,
		participant: [...changedHolder.participant, { pubkey: replacementPubkey, runNumber: 1, registeredAt: startedAt, status: 'active', points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 }] });
	expect(await sentResponses()).toBe(0);

	const changedRun = makeState('a');
	await injectState(changedRun);
	await injectFormal(changedRun, '3'.repeat(32));
	await injectState({ ...changedRun, revision: 1, updatedAt: changedRun.updatedAt + 1,
		participant: changedRun.participant.map((member) => member.pubkey === holderPubkey ? { ...member, runNumber: 2 } : member) });
	expect(await sentResponses()).toBe(0);

	const changedChallenge = makeState('b');
	await injectState(changedChallenge);
	await injectFormal(changedChallenge, '4'.repeat(32));
	await injectState({ ...changedChallenge, revision: 1, updatedAt: changedChallenge.updatedAt + 1,
		holderChallengeId: '5'.repeat(32), holderChallengeStartedAtMs: nowMs });
	expect(await sentResponses()).toBe(0);
});

test('host silence is detected only while the local Relay connection is active', async ({ page }) => {
	test.setTimeout(60_000);
	const nowMs = Date.now();
	const selfSecret = fixtureSecret(43);
	await preparePlayer(page, selfSecret, nowMs);
	await moveRelaySelfTo(page, { x: 7, y: 5 });
	await openTagGameTerminal(page);
	const remoteHostSecret = fixtureSecret(20);
	const remoteHostPubkey = getPublicKey(remoteHostSecret);
	const joinerPubkey = getPublicKey(selfSecret);
	const transitionSeed = Array.from({ length: 10_000 }, (_, index) => `host-silence-${index}`).find((candidate) => {
		const schedule = createTagGameSchedule(candidate);
		return schedule[0].effect === 'calamity' && schedule[0].durationMs === 10_000 && schedule[1].effect === 'benefit';
	});
	expect(transitionSeed).toBeTruthy();
	const startedAtMs = await page.evaluate(() => Date.now());
	const startedAt = Math.floor(startedAtMs / 1_000);
	const gameId = `${remoteHostPubkey}:${startedAt}:${'d'.repeat(64)}`;
	await seedTagGameRunLock(page, gameId, startedAtMs);
	const active: TagGameState = {
		gameId, hostPubkey: remoteHostPubkey, phase: 'running', revision: 0, updatedAt: startedAt,
		startedAt, endsAt: startedAt + 120, seed: transitionSeed!, ownerPubkey: remoteHostPubkey, effect: 'calamity', transferAt: startedAtMs,
		participant: [remoteHostPubkey, joinerPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: startedAt, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
		settledAtMs: startedAtMs
	};
	const signed = finalizeTagGameState(active, CHANNEL_ID, startedAt, remoteHostSecret);
	const channel = { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' };
	const hostActivity = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt: startedAt, position: { x: 8, y: 5 }, slot: 1, runNumber: 1 }), remoteHostSecret);
	await injectPosition(page, hostActivity);
	const relayStateBeforeProbe = (await relayState(page)).state.requests.length;
	await injectRealtime(page, signed);
	await expect(page.locator('[data-tag-game-hud]')).toBeVisible();
	await expect(page.locator('[data-tag-game-hud]')).toHaveAttribute('data-realtime-status', 'active');
	const holder = page.locator(`.participant[data-participant-id="${remoteHostPubkey}"]`);
	await expect(holder).toHaveAttribute('data-tag-game-effect', 'calamity');
	await expect(holder).toHaveAttribute('data-tag-game-effect-active', 'true');
	const effectVisuals = holder.locator('.tag-game-effect-visuals');
	await expect(effectVisuals).toHaveAttribute('aria-label', '鬼');
	await expect(effectVisuals).toHaveText('');
	await expect(holder.locator('.tag-game-holder-label')).toHaveCount(0);
	await expect(effectVisuals.locator('[data-tag-game-effect-symbol="calamity"]')).toHaveCount(1);
	await expect(effectVisuals.locator('.oni-horn')).toHaveCount(2);
	await expect(holder.locator('.tag-game-effect-aura .oni-smoke-left, .tag-game-effect-aura .oni-smoke-right')).toHaveCount(2);
	await expect(holder.locator('.tag-game-effect-aura .oni-smoke-trail')).toHaveCount(1);
	await expect(holder.locator('.tag-game-effect-aura .oni-smoke-particle')).toHaveCount(1);
	const oniViewport = page.viewportSize();
	if (!oniViewport) throw new Error('Expected a fixed viewport for Oni symbol layout checks');
	await expect.poll(() => holder.evaluate((element) => element.getBoundingClientRect().width)).toBe(76);
	const initialOniLayout = await readEffectSymbolLayout(holder);
	expectHornsAboveAvatarAndClearOfName(initialOniLayout);
	expectAuraVisibleOutsideAvatar(initialOniLayout);
	const cooldownLine = page.locator('[data-tag-game-cooldown-line]');
	await expect(cooldownLine).toBeVisible();
	const cooldownInitialWidth = await cooldownLine.locator('span').evaluate((element) => element.getBoundingClientRect().width);
	await page.clock.runFor(1_100);
	const cooldownShortenedWidth = await cooldownLine.locator('span').evaluate((element) => element.getBoundingClientRect().width);
	expect(cooldownShortenedWidth).toBeLessThan(cooldownInitialWidth);
	await page.clock.runFor(1_500);
	await expect(cooldownLine).toHaveCount(0);
	await expect(page.locator('[data-tag-game-hud] [data-tag-game-effect]')).toContainText('所持者が追いかけて押し付ける');
	await page.setViewportSize({ width: 390, height: 844 });
	await expect.poll(() => holder.evaluate((element) => element.getBoundingClientRect().width)).toBe(50);
	const mobileOniLayout = await readEffectSymbolLayout(holder);
	expectHornsAboveAvatarAndClearOfName(mobileOniLayout);
	expectAuraVisibleOutsideAvatar(mobileOniLayout);
	await page.setViewportSize(oniViewport);
	await expect.poll(() => holder.evaluate((element) => element.getBoundingClientRect().width)).toBe(76);
		await page.clock.runFor(10_000);
		await expect(holder).toHaveAttribute('data-tag-game-effect', 'benefit');
		await expect(holder).toHaveAttribute('data-tag-game-effect-active', 'true');
		await expect(page.locator('[data-tag-game-hud] [data-tag-game-effect]')).toContainText('所持者以外が追いかけて奪う');
		await expect(page.locator('[data-tag-game-cooldown]')).toHaveCount(0);
	const benefit = { ...active, revision: 1, updatedAt: startedAt + 1, effect: 'benefit' as const };
	await injectRealtime(page, finalizeTagGameState(benefit, CHANNEL_ID, startedAt + 1, remoteHostSecret));
	await expect(holder).toHaveAttribute('data-tag-game-effect', 'benefit');
	await expect(effectVisuals).toHaveAttribute('aria-label', '福');
	await expect(holder.locator('.tag-game-effect-aura .fuku-smoke, .tag-game-effect-aura .fuku-smoke-trail, .tag-game-effect-aura .fuku-smoke-particle')).toHaveCount(0);
	await expect(holder.locator('.tag-game-effect-aura .fuku-halo-soft-ring, .tag-game-effect-aura .fuku-halo-light-ring')).toHaveCount(2);
	await expect(holder.locator('.tag-game-effect-aura .fuku-halo-rays-warm path')).toHaveCount(4);
	await expect(holder.locator('.tag-game-effect-aura .fuku-halo-rays-light path')).toHaveCount(5);
	await expect(effectVisuals.locator('[data-fuku-mallet]')).toHaveCount(1);
	await expect(effectVisuals.locator('[data-tag-game-effect-symbol="benefit"]')).toHaveCount(1);
	await expect(holder.locator('.tag-game-effect-aura .oni-aura-outline')).toHaveCount(0);
	const fukuViewport = page.viewportSize();
	if (!fukuViewport) throw new Error('Expected a fixed viewport for Fuku symbol layout checks');
	await page.getByRole('dialog', { name: '鬼ごっこ' }).getByRole('button', { name: '閉じる' }).click();
	await expect(page.getByRole('dialog', { name: '鬼ごっこ' })).toBeHidden();
	await page.setViewportSize({ width: 1280, height: 800 });
	await expect.poll(() => holder.evaluate((element) => element.getBoundingClientRect().width)).toBe(76);
	const desktopFukuLayout = await readEffectSymbolLayout(holder);
	expectMalletBottomRightOfAvatarAndOutsideFace(desktopFukuLayout);
	await expectMalletDoesNotCoverVisibleNameText(holder);
	await page.setViewportSize({ width: 390, height: 844 });
	await expect.poll(() => holder.evaluate((element) => element.getBoundingClientRect().width)).toBe(50);
	const mobileFukuLayout = await readEffectSymbolLayout(holder);
	expectMalletHeadAndShaftToMeet(desktopFukuLayout);
	expectFukuHaloVisibleAroundAvatar(desktopFukuLayout);
	expectMalletBottomRightOfAvatarAndOutsideFace(mobileFukuLayout);
	await expectMalletDoesNotCoverVisibleNameText(holder);
	expectMalletHeadAndShaftToMeet(mobileFukuLayout);
	expectFukuHaloVisibleAroundAvatar(mobileFukuLayout);
	await page.setViewportSize(fukuViewport);
	await expect.poll(() => holder.evaluate((element) => element.getBoundingClientRect().width)).toBe(76);
	await openTagGameTerminal(page);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	const reducedMotionAnimations = await holder.evaluate((element) => [...element.querySelectorAll<SVGElement>('*')]
		.map((child) => getComputedStyle(child).animationName).filter((name) => name !== 'none'));
	expect(reducedMotionAnimations).toEqual([]);
	const reducedMotionFukuLayout = await readEffectSymbolLayout(holder);
	expectMalletBottomRightOfAvatarAndOutsideFace(reducedMotionFukuLayout);
	expectMalletHeadAndShaftToMeet(reducedMotionFukuLayout);
	expectFukuHaloVisibleAroundAvatar(reducedMotionFukuLayout);
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await expect(page.locator('[data-tag-game-cooldown]')).toHaveCount(0);
	await expect(page.locator('[data-tag-game-hud] [data-tag-game-effect]')).toContainText('所持者以外が追いかけて奪う');
	const challenge = finalizeTagGameState({ ...benefit, revision: 2, updatedAt: startedAt + 10, holderChallengeId: 'f'.repeat(32), holderChallengeStartedAtMs: (startedAt + 10) * 1_000 }, CHANNEL_ID, startedAt + 10, remoteHostSecret);
	await injectRealtime(page, challenge);
	await expect(page.locator('[data-tag-game-hud]')).toContainText('応答確認中・効果停止');
	await expect(page.locator('[data-tag-game-cooldown]')).toHaveText('効果停止中');
	await expect(page.locator('[data-tag-game-leave]')).toBeVisible();
	await expect(holder).toHaveAttribute('data-tag-game-effect-active', 'false');
	const pausedEffectName = await holder.getAttribute('data-tag-game-effect') === 'benefit' ? '福' : '鬼';
	await expect(effectVisuals).toHaveAttribute('aria-label', `${pausedEffectName}・効果停止中`);
	const pausedVisualAnimations = await holder.evaluate((element) => [...element.querySelectorAll<SVGElement>('*')]
		.map((child) => getComputedStyle(child).animationName).filter((name) => name !== 'none'));
	expect(pausedVisualAnimations).toEqual([]);
	await page.clock.runFor(31_000);
	await expect.poll(async () => (await relayState(page)).state.requests.length).toBeGreaterThan(relayStateBeforeProbe);
	await page.clock.runFor(6_000);
	await expect(page.getByText('中断')).toBeVisible();
	await expect(page.locator('[data-tag-game-hud]')).toHaveCount(0);
	await expect(holder.locator('.tag-game-effect-aura, .tag-game-effect-visuals')).toHaveCount(0);
	const result = page.getByRole('dialog', { name: '鬼ごっこ中断' });
	await expect(result).toBeVisible();
	await expect(result.locator('.settlement-note')).toContainText('最後に確認済みの値で確定');
	await expect(result.locator(`[data-tag-game-result-participant="${joinerPubkey}"]`)).toHaveAttribute('data-tag-game-result-self', 'true');
	const fallbackSelfRow = result.locator(`[data-tag-game-result-participant="${joinerPubkey}"]`);
	const fallbackSelfText = await fallbackSelfRow.innerText();
	const delayedOfficialFinal: TagGameState = {
		...active, phase: 'ended', revision: 3, updatedAt: active.endsAt!, finalizedAt: active.endsAt, endReason: 'normal',
		settledAtMs: active.endsAt! * 1_000,
		participant: active.participant.map((member) => member.pubkey === joinerPubkey
			? { ...member, points: 2_500, lifespanLossMs: 10_800_000, benefitMs: 45_000, calamityMs: 45_000 }
			: { ...member, points: 2_000, lifespanLossMs: 3_600_000, benefitMs: 15_000, calamityMs: 15_000 })
	};
	await injectRealtime(page, finalizeTagGameState(delayedOfficialFinal, CHANNEL_ID, active.endsAt!, remoteHostSecret));
	await result.getByRole('button', { name: '閉じる' }).click();
	await openTagGameTerminal(page);
	const history = page.locator(`[data-tag-game-history="${gameId}"]`);
	await page.locator('[data-tag-game-history-section] summary').click();
	await history.getByRole('button', { name: '結果を見る' }).click();
	const reviewedResult = page.getByRole('dialog', { name: '鬼ごっこ終了' });
	await expect(reviewedResult).toBeVisible();
	const reviewedSelfRow = reviewedResult.locator(`[data-tag-game-result-participant="${joinerPubkey}"]`);
	await expect(reviewedSelfRow).toHaveText(fallbackSelfText);
	await expect(reviewedSelfRow).toContainText('福');
	await expect(reviewedSelfRow).toContainText('鬼');
	await expect(reviewedResult.locator(`[data-tag-game-result-participant="${remoteHostPubkey}"]`)).toContainText('ポイント +2000pt');
	await expect(reviewedResult.locator('.settlement-note')).toContainText('ほかの参加者は開催者の最終状態');
});

test('organizer is auto-consented, and proposal expiry removes nonresponders before a fresh proposal', async ({ page }) => {
	test.setTimeout(60_000);
	const nowMs = Date.now();
	const hostSecret = fixtureSecret(41);
	const consentSecret = fixtureSecret(43);
	const silentSecret = fixtureSecret(47);
	const hostPubkey = getPublicKey(hostSecret);
	const consentPubkey = getPublicKey(consentSecret);
	const silentPubkey = getPublicKey(silentSecret);
	await preparePlayer(page, hostSecret, nowMs);
	await moveRelaySelfTo(page, { x: 7, y: 5 });
	await openTagGameTerminal(page);
	await page.getByRole('button', { name: '鬼ごっこを開催' }).click();
	await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === TAG_GAME_KIND)).toBe(true);
	const gameId = parseTagGameEvent(await latestPublished(page, TAG_GAME_KIND, hostPubkey), CHANNEL_ID)!.state.gameId;
	const lobby = parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)!.state;
	const createdAt = lobby.updatedAt + 1;
	const populatedLobby: TagGameState = { ...lobby, updatedAt: createdAt, participant: [hostPubkey, consentPubkey, silentPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: createdAt, status: 'registered' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })) };
	await injectRealtime(page, finalizeTagGameState(populatedLobby, CHANNEL_ID, createdAt, hostSecret));
	await page.clock.runFor(2_000);
	await page.getByRole('button', { name: '開始を提案' }).click();
	await expect.poll(async () => latestTagGameStateValue(page, gameId, (state) => state.phase)).toBe('proposed');
	const firstProposal = parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)!.state;
	expect(firstProposal.participant.find((member) => member.pubkey === hostPubkey)).toMatchObject({ consentProposalId: firstProposal.proposalId, consented: true });
	const consent = finalizeEvent(buildTagGameActionTemplate({ channelId: CHANNEL_ID, gameId, action: 'consent', runNumber: 1, nonce: 'c'.repeat(32), createdAt: createdAt + 1, payload: { proposalId: firstProposal.proposalId! } }), consentSecret);
	await injectRealtime(page, consent);
	await expect.poll(() => latestTagGameStateValue(page, gameId, (state) => state.participant.find((member) => member.pubkey === consentPubkey)?.consented)).toBe(true);
	await page.clock.runFor(31_000);
	await expect.poll(async () => latestTagGameStateValue(page, gameId, (state) => state.phase)).toBe('lobby');
	const returned = parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)!.state;
	expect(returned.participant.map((member) => member.pubkey)).toEqual([hostPubkey, consentPubkey]);
	await expect(page.getByRole('button', { name: '開始を提案' })).toBeVisible();
	await page.getByRole('button', { name: '開始を提案' }).click();
	await expect.poll(async () => {
		const event = await findLatestGameEvent(page, gameId);
		return event ? parseTagGameEvent(event, CHANNEL_ID)?.state.proposalId : firstProposal.proposalId;
	}).not.toBe(firstProposal.proposalId);
	const secondProposal = parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)!.state;
	expect(secondProposal.participant.find((member) => member.pubkey === hostPubkey)).toMatchObject({ consentProposalId: secondProposal.proposalId, consented: true });
	const resetConsent = secondProposal.participant.find((member) => member.pubkey === consentPubkey)!;
	expect(resetConsent.consentProposalId).toBeUndefined();
	expect(resetConsent.consented).toBe(false);
	await expect(page.getByRole('dialog', { name: '鬼ごっこ' }).locator('li').getByText('開催者は同意済み')).toBeVisible();
});

test('same-second death exit ends a two-player game when the non-holder leaves', async ({ browser }) => {
	test.setTimeout(60_000);
	const hostPage = await browser.newPage();
	const participantPage = await browser.newPage();
	const nowMs = Date.now();
	const startedAt = Math.floor(nowMs / 1_000);
	const hostSecret = fixtureSecret(53);
	const participantSecret = fixtureSecret(59);
	const hostPubkey = getPublicKey(hostSecret);
	const participantPubkey = getPublicKey(participantSecret);
	try {
		await Promise.all([preparePlayer(hostPage, hostSecret, nowMs), preparePlayer(participantPage, participantSecret, nowMs)]);
		await moveRelaySelfTo(hostPage, { x: 7, y: 5 });
		await moveRelaySelfTo(participantPage, { x: 8, y: 5 });
		const gameId = `${hostPubkey}:${startedAt}:${'f'.repeat(64)}`;
		const state: TagGameState = {
			gameId, hostPubkey, phase: 'running', revision: 0, updatedAt: startedAt,
			startedAt, endsAt: startedAt + 120, seed: 'a'.repeat(64), ownerPubkey: hostPubkey, effect: 'benefit', transferAt: startedAt * 1_000,
			participant: [{ pubkey: hostPubkey, runNumber: 1 }, { pubkey: participantPubkey, runNumber: 2 }].map(({ pubkey, runNumber }) => ({ pubkey, runNumber, registeredAt: startedAt, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
			settledAtMs: startedAt * 1_000
		};
		const running = finalizeTagGameState(state, CHANNEL_ID, startedAt, hostSecret);
		const channel = { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' };
		const worldSecond = startedAt + 1;
		const delayedOldRunExit = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt: startedAt, position: { x: 8, y: 5 }, slot: 'exit', runNumber: 1, exitReason: 'death' }), participantSecret);
		const activePosition = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt: worldSecond, position: { x: 8, y: 5 }, slot: 1, runNumber: 2 }), participantSecret);
		const deathExit = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt: worldSecond, position: { x: 8, y: 5 }, slot: 'exit', runNumber: 2, exitReason: 'death' }), participantSecret);
		await injectRealtime(hostPage, running);
		await injectRealtime(participantPage, running);
		await injectPosition(hostPage, delayedOldRunExit);
		await expect(hostPage.locator('[data-tag-game-hud]')).toBeVisible();
		await injectPosition(hostPage, activePosition);
		await expect(hostPage.locator(`.participant[data-participant-id="${participantPubkey}"]`)).toHaveAttribute('data-tag-game-role', 'participant');
		await expect(hostPage.locator(`.participant[data-participant-id="${hostPubkey}"]`)).toHaveAttribute('data-tag-game-role', 'holder');
		await injectPosition(hostPage, deathExit);
		await expect.poll(async () => latestTagGameStateValue(hostPage, gameId, (state) => state.phase)).toBe('interrupted');
		const final = parseTagGameEvent(await latestGameEvent(hostPage, gameId), CHANNEL_ID)?.state;
		expect(final?.endReason).toBe('too-few-participants');
		expect(final?.participant.find((member) => member.pubkey === participantPubkey)?.status).toBe('dead');
	} finally {
		await Promise.all([hostPage.close(), participantPage.close()]);
	}
});

test('organizer-confirmed leave settles the two-player game and releases the quitter lock', async ({ browser }) => {
	test.setTimeout(90_000);
	const hostPage = await browser.newPage();
	const participantPage = await browser.newPage();
	const nowMs = Date.now();
	const hostSecret = fixtureSecret(61);
	const participantSecret = fixtureSecret(63);
	const hostPubkey = getPublicKey(hostSecret);
	const participantPubkey = getPublicKey(participantSecret);
	try {
		await Promise.all([
			preparePlayer(hostPage, hostSecret, nowMs, 200_000), preparePlayer(participantPage, participantSecret, nowMs, 200_000)
		]);
		await Promise.all([moveRelaySelfTo(hostPage, { x: 7, y: 5 }), moveRelaySelfTo(participantPage, { x: 7, y: 6 })]);
		const hostPosition = await latestWorldState(hostPage, hostPubkey);
		const participantPosition = await latestWorldState(participantPage, participantPubkey);
		await Promise.all([injectPosition(hostPage, participantPosition), injectPosition(participantPage, hostPosition)]);

		await openTagGameTerminal(hostPage);
		await hostPage.getByRole('button', { name: '鬼ごっこを開催' }).click();
		await expect.poll(async () => (await relayState(hostPage)).state.published.some((event) => event.kind === TAG_GAME_KIND)).toBe(true);
		const lobbyEvent = await latestPublished(hostPage, TAG_GAME_KIND, hostPubkey);
		const lobby = parseTagGameEvent(lobbyEvent, CHANNEL_ID)!.state;
		await injectRealtime(participantPage, lobbyEvent);
		await openTagGameTerminal(participantPage);
		await expect(participantPage.locator('main')).toHaveAttribute('data-realtime-status', 'active');
		await injectRealtime(participantPage, lobbyEvent);
		await expect(participantPage.getByRole('button', { name: '参加申請' })).toBeVisible();
		await participantPage.getByRole('button', { name: '参加申請' }).click();
		await expect.poll(async () => (await relayState(participantPage)).state.published.some((event) => event.kind === 27070 && event.pubkey === participantPubkey)).toBe(true);
		const join = await latestPublished(participantPage, 27070, participantPubkey);
		await injectRealtime(hostPage, join);
		await expect.poll(async () => latestTagGameStateValue(hostPage, lobby.gameId, (state) => state.participant.length)).toBe(2);
		await injectRealtime(participantPage, await latestGameEvent(hostPage, lobby.gameId));

		await hostPage.getByRole('button', { name: '開始を提案' }).click();
		await expect.poll(async () => latestTagGameStateValue(hostPage, lobby.gameId, (state) => state.phase)).toBe('proposed');
		const proposal = await latestGameEvent(hostPage, lobby.gameId);
		await injectRealtime(participantPage, proposal);
		await expect(participantPage.getByRole('button', { name: '開始に同意' })).toBeVisible();
		const hostCard = hostPage.getByRole('dialog', { name: '鬼ごっこ' }).locator('li').filter({ hasText: 'あなたの開催' });
		await expect(hostCard.getByText('開催者は同意済み')).toBeVisible();
		await expect(hostCard.getByRole('button', { name: '開始に同意' })).toHaveCount(0);
		await expect(hostCard.getByRole('button', { name: '今回は辞退' })).toHaveCount(0);
		await participantPage.getByRole('button', { name: '開始に同意' }).click();
		await expect.poll(async () => (await relayState(participantPage)).state.published.some((event) => event.kind === 27070 && parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'consent')).toBe(true);
		const participantConsent = await latestPublished(participantPage, 27070, participantPubkey);
		await injectRealtime(hostPage, participantConsent);
		expect((await relayState(hostPage)).state.published.filter((event) => event.kind === 27070 && parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'consent')).toHaveLength(0);
		await expect.poll(async () => latestTagGameStateValue(hostPage, lobby.gameId, (state) => state.phase)).toBe('countdown');
		await injectRealtime(participantPage, await latestGameEvent(hostPage, lobby.gameId));
		await hostPage.clock.runFor(6_000);
		const runningEvent = await latestGameEvent(hostPage, lobby.gameId);
		const running = parseTagGameEvent(runningEvent, CHANNEL_ID)!.state;
		expect(running.phase).toBe('running');
		await Promise.all([hostPage, participantPage].map((page) => page.clock.setSystemTime(running.startedAt! * 1_000 + 5_000)));
		await injectRealtime(participantPage, runningEvent);
		await Promise.all([hostPage, participantPage].map((page) => expect(page.getByRole('dialog', { name: '鬼ごっこ' })).toHaveCount(0)));
		await expect.poll(async () => (await tagGamePersistence(participantPage)).lock).toMatchObject({ gameId: lobby.gameId });
		await Promise.all([openTagGameTerminal(hostPage), openTagGameTerminal(participantPage)]);
		await Promise.all([hostPage, participantPage].map((page) => page.getByRole('button', { name: '閉じる', exact: true }).click()));

		const leaverPage = running.ownerPubkey === hostPubkey ? hostPage : participantPage;
		const leaverPubkey = leaverPage === hostPage ? hostPubkey : participantPubkey;
		const leaveButton = leaverPage.locator(`[data-tag-game-leave="${lobby.gameId}"]`);
		await expect(leaveButton).toBeVisible();
		await leaveButton.click();
		await expect(leaveButton).toBeVisible();
		expect(await tagGamePersistence(leaverPage)).toMatchObject({ lock: { gameId: lobby.gameId } });
		const leaveAction = await latestPublished(leaverPage, 27070, leaverPubkey);
		expect(parseTagGameActionEvent(leaveAction, CHANNEL_ID)?.action).toBe('leave');
		await injectRealtime(hostPage, leaveAction);
		await expect.poll(async () => latestTagGameStateValue(hostPage, lobby.gameId, (state) => state.phase)).toBe('interrupted');
		const finalEvent = await latestGameEvent(hostPage, lobby.gameId);
		const finalState = parseTagGameEvent(finalEvent, CHANNEL_ID)!.state;
		const quitter = finalState.participant.find((member) => member.pubkey === leaverPubkey)!;
		expect(finalState.endReason).toBe(leaverPubkey === hostPubkey ? 'host-exit' : 'too-few-participants');
		expect(quitter.status).toBe('left');
		expect(quitter.benefitMs + quitter.calamityMs).toBeGreaterThan(0);
		if (leaverPage !== hostPage) await injectRealtime(leaverPage, finalEvent);
		await expect.poll(async () => tagGamePersistence(leaverPage)).toMatchObject({
			lock: null,
			receipt: { gameId: lobby.gameId, points: quitter.points, lifespanLossMs: quitter.lifespanLossMs }
		});
		await expect(leaverPage.locator('[data-tag-game-hud]')).toHaveCount(0);
		const automaticResult = leaverPage.getByRole('dialog', { name: '鬼ごっこ中断' });
		await expect(automaticResult).toBeVisible();
		await expect(automaticResult.locator('.settlement-note')).toHaveCount(0);
		await expect(automaticResult.locator(`[data-tag-game-result-participant="${leaverPubkey}"]`)).toHaveAttribute('data-tag-game-result-self', 'true');
		await expect(automaticResult.locator(`[data-tag-game-result-participant="${leaverPubkey}"]`)).toContainText('退出');
		await automaticResult.getByRole('button', { name: '閉じる', exact: true }).click();
		await openTagGameTerminal(leaverPage);
		const history = leaverPage.getByRole('dialog', { name: '鬼ごっこ' }).locator('[data-tag-game-history-section] details');
		await expect(history).not.toHaveAttribute('open', '');
		await history.locator('summary').click();
		await history.getByRole('button', { name: '結果を見る' }).click();
		const historicalResult = leaverPage.getByRole('dialog', { name: '鬼ごっこ中断' });
		await expect(historicalResult.locator(`[data-tag-game-result-participant="${leaverPubkey}"]`)).toContainText('退出');
		await historicalResult.getByRole('button', { name: '閉じる', exact: true }).click();
		await leaverPage.getByRole('dialog', { name: '鬼ごっこ' }).getByRole('button', { name: '閉じる', exact: true }).click();

		await leaverPage.clock.setSystemTime(running.startedAt! * 1_000 + 10_000);
		await moveRelaySelfTo(leaverPage, { x: 13, y: 3 });
		await leaverPage.getByRole('button', { name: '能力強化端末' }).click();
		const dialog = leaverPage.getByRole('dialog', { name: '能力強化' });
		await expect(dialog).toBeVisible();
		await dialog.getByRole('button', { name: '推論効率をLv2へ強化（必要1pt）' }).click();
		await expect(dialog).toContainText('推論効率 Lv2');
	} finally {
		await Promise.all([hostPage.close(), participantPage.close()]);
	}
});

test('organizer cancellation terminates the lobby, clears pending reservations, and ignores delayed joins', async ({ browser }) => {
	test.setTimeout(45_000);
	const hostPage = await browser.newPage();
	const joinerPage = await browser.newPage();
	const nowMs = Date.now();
	const hostSecret = fixtureSecret(41);
	const joinerSecret = fixtureSecret(43);
	const hostPubkey = getPublicKey(hostSecret);
	const joinerPubkey = getPublicKey(joinerSecret);
	try {
		await Promise.all([preparePlayer(hostPage, hostSecret, nowMs, 0, true), preparePlayer(joinerPage, joinerSecret, nowMs)]);
		await Promise.all([moveRelaySelfTo(hostPage, { x: 7, y: 6 }), moveRelaySelfTo(joinerPage, { x: 8, y: 5 })]);
		await synchronizeBrowserClocks([hostPage, joinerPage]);
		await openTagGameTerminal(hostPage);
		await hostPage.getByRole('button', { name: '鬼ごっこを開催' }).click();
		await expect.poll(async () => (await relayState(hostPage)).state.published.some((event) => event.kind === TAG_GAME_KIND)).toBe(true);
		const lobbyEvent = await latestPublished(hostPage, TAG_GAME_KIND, hostPubkey);
		const lobby = parseTagGameEvent(lobbyEvent, CHANNEL_ID)!.state;
		await injectRealtime(joinerPage, lobbyEvent);
		await openTagGameTerminal(joinerPage);
		await expect(joinerPage.locator('main')).toHaveAttribute('data-realtime-status', 'active');
		await injectRealtime(joinerPage, lobbyEvent);
		await expect(joinerPage.getByRole('button', { name: '参加申請' })).toBeVisible();
		await joinerPage.getByRole('button', { name: '参加申請' }).click();
		await expect.poll(async () => (await tagGamePersistence(joinerPage)).reservation).toMatchObject({ gameId: lobby.gameId, expiresAtMs: expect.any(Number) });
		await expect.poll(async () => (await relayState(joinerPage)).state.published.some((event) => event.kind === 27070 && event.pubkey === joinerPubkey)).toBe(true);
		const delayedJoin = await latestPublished(joinerPage, 27070, joinerPubkey);
		await injectRealtime(hostPage, delayedJoin);
		await expect.poll(async () => latestTagGameStateValue(hostPage, lobby.gameId, (state) => state.participant.length)).toBe(2);
		await injectRealtime(joinerPage, await latestGameEvent(hostPage, lobby.gameId));
		await expect.poll(async () => (await tagGamePersistence(joinerPage)).reservation).toEqual({ gameId: lobby.gameId,
			identity: expect.any(Object), runNumber: 1 });
		await expect(hostPage.getByRole('button', { name: '募集を取り消す' })).toBeVisible();
		await hostPage.getByRole('button', { name: '募集を取り消す' }).click();
		await expect.poll(async () => latestTagGameStateValue(hostPage, lobby.gameId, (state) => state.endReason)).toBe('host-cancelled');
		const cancelled = await latestGameEvent(hostPage, lobby.gameId);
		await injectRealtime(hostPage, delayedJoin);
		await expect.poll(async () => latestTagGameStateValue(hostPage, lobby.gameId, (state) => state.endReason)).toBe('host-cancelled');
		await expect(hostPage.getByText('あなたの開催').first()).toHaveCount(0);
		await expect(hostPage.getByRole('dialog', { name: /鬼ごっこ(終了|中断)/ })).toHaveCount(0);
		await expect(hostPage.getByRole('button', { name: '鬼ごっこを開催' })).toBeVisible();
		await hostPage.reload();
		await moveRelaySelfTo(hostPage, { x: 7, y: 6 });
		await expect(hostPage.locator('.participant[data-self="true"]')).toBeVisible();
		await openTagGameTerminal(hostPage);
		await injectRealtime(hostPage, cancelled);
		await expect(hostPage.getByText('あなたの開催').first()).toHaveCount(0);
		await expect(hostPage.getByRole('dialog', { name: /鬼ごっこ(終了|中断)/ })).toHaveCount(0);
		await expect(hostPage.getByRole('button', { name: '鬼ごっこを開催' })).toBeVisible();
		await expect.poll(async () => (await tagGamePersistence(hostPage)).reservation).toBeNull();
		await hostPage.getByRole('button', { name: '鬼ごっこを開催' }).click();
		await expect.poll(async () => (await relayState(hostPage)).state.published.some((event) => event.kind === TAG_GAME_KIND)).toBe(true);
		const replacement = parseTagGameEvent(await latestPublished(hostPage, TAG_GAME_KIND, hostPubkey), CHANNEL_ID)!.state;
		expect(replacement.gameId).not.toBe(lobby.gameId);
		await expect(hostPage.getByText('あなたの開催').first()).toBeVisible();
		await joinerPage.evaluate((event) => (window as typeof window & { __relayStartupTest: { queueRealtimeBootstrapEvent(event: object): void } }).__relayStartupTest.queueRealtimeBootstrapEvent(event), cancelled);
		await expect.poll(async () => (await tagGamePersistence(joinerPage)).reservation).not.toBeNull();
		const activeRealtimeCountBeforeReload = await joinerPage.evaluate(() => (window as typeof window & { __relayStartupTest: { activeRealtimeCount(): number } }).__relayStartupTest.activeRealtimeCount());
		expect(await joinerPage.evaluate((id) => sessionStorage.getItem('relay-startup-queued-realtime-bootstrap-events')?.includes(id) ?? false, cancelled.id)).toBe(true);
		await joinerPage.clock.setSystemTime(cancelled.created_at * 1_000 + 91_000);
		await joinerPage.reload();
		await expect.poll(async () => joinerPage.evaluate((id) => (window as typeof window & { __relayStartupTest: { state: { realtimeHistory: Array<{ id: string }> } } }).__relayStartupTest.state.realtimeHistory.some((event) => event.id === id), cancelled.id)).toBe(true);
		await openTagGameTerminal(joinerPage);
		await expect.poll(async () => (await relayState(joinerPage)).state.requests.some((request) => request.filters.some((filter) => (filter['#d'] as string[] | undefined)?.includes(lobby.gameId)))).toBe(true);
		await expect.poll(async () => (await tagGamePersistence(joinerPage)).reservation).toBeNull();
		const recoveryRequests = (await relayState(joinerPage)).state.requests.filter((request) => request.filters.some((filter) =>
			(filter.kinds as number[] | undefined)?.includes(TAG_GAME_KIND)));
		expect(recoveryRequests.length).toBeGreaterThan(0);
		const recoveryRequest = recoveryRequests.find((request) => request.filters.some((filter) => (filter['#d'] as string[] | undefined)?.includes(lobby.gameId)));
		expect(recoveryRequest).toBeDefined();
		const discoverySince = recoveryRequest?.filters.find((filter) => (filter.kinds as number[] | undefined)?.includes(TAG_GAME_KIND) && !filter['#d'])?.since as number;
		expect(discoverySince).toBeGreaterThan(cancelled.created_at);
		expect(discoverySince).toBeLessThan(cancelled.created_at + 15);
		await expect.poll(async () => joinerPage.evaluate(() => (window as typeof window & { __relayStartupTest: { activeRealtimeCount(): number } }).__relayStartupTest.activeRealtimeCount())).toBe(activeRealtimeCountBeforeReload);
		await expect(joinerPage.getByRole('button', { name: '鬼ごっこを開催' })).toBeVisible();
	} finally {
		await Promise.all([hostPage.close(), joinerPage.close()]);
	}
});

test('reuses the anonymous Relay session for restored reservation states without closing connecting sockets', async ({ browser }) => {
	test.setTimeout(90_000);
	const cases = ['none', 'confirmed', 'provisional', 'locked'] as const;
	const observations: Array<{ reservation: typeof cases[number]; relayConnections: number; connectingAppCloses: number; pagehideRelayCloses: number; connectingPagehideCloses: number }> = [];
	for (const reservationCase of cases) {
		const page = await browser.newPage();
		const nowMs = Date.now();
		const nowSeconds = Math.floor(nowMs / 1_000);
		const selfSecret = fixtureSecret(reservationCase === 'none' ? 19 : reservationCase === 'confirmed' ? 20 : reservationCase === 'provisional' ? 21 : 23);
		const selfPubkey = getPublicKey(selfSecret);
		const hostSecret = fixtureSecret(47);
		const hostPubkey = getPublicKey(hostSecret);
		const validGameId = `${hostPubkey}:${nowSeconds}:${(reservationCase === 'locked' ? 'd' : 'c').repeat(64)}`;
		const runningGame: TagGameState = {
			gameId: validGameId, hostPubkey, phase: 'running', revision: 0, updatedAt: nowSeconds,
			startedAt: nowSeconds - 1, endsAt: nowSeconds + 119, seed: 'a'.repeat(64), ownerPubkey: hostPubkey,
			effect: 'benefit', transferAt: nowMs - 1_000, settledAtMs: nowMs,
			participant: [hostPubkey, selfPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: nowSeconds - 1,
				status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 }))
		};
		const lobbyGame: TagGameState = {
			gameId: validGameId, hostPubkey, phase: 'lobby', revision: 0, updatedAt: nowSeconds,
			settledAtMs: nowMs,
			participant: [hostPubkey, selfPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: nowSeconds,
				status: 'registered' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 }))
		};
		const recoveredGame = reservationCase === 'locked' ? runningGame : lobbyGame;
		const recoveredEvent = finalizeTagGameState(recoveredGame, CHANNEL_ID, nowSeconds, hostSecret);
		try {
			await page.clock.install({ time: nowMs });
			await installHostOwnedStub(page);
			await installDelayedRelay(page, {
				primaryEvents: testEvents(nowMs), realtimeEvents: [], realtimePublishOutcome: 'echo',
				persistAcrossReload: true, observeWebSocketLifecycle: true
			});
			await seedRelayAccount(page, selfSecret, selfPubkey, nowMs + 14 * 24 * 60 * 60 * 1_000);
			await page.goto('/');
			await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
			await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toBeVisible();
			await expect.poll(async () => (await relayState(page)).state.requests.some((request) => request.filters.some((filter) => (filter.kinds as number[] | undefined)?.includes(7070)))).toBe(true);
			if (reservationCase !== 'none') {
				await page.evaluate(({ reservationCase, gameId, nowMs }) => new Promise<void>((resolve, reject) => {
					const request = indexedDB.open('persona-bubble-field-account', 9);
					request.onerror = () => reject(request.error);
					request.onsuccess = () => {
						const database = request.result;
						const transaction = database.transaction('persona-bubble-field-player-state', 'readwrite');
						const store = transaction.objectStore('persona-bubble-field-player-state');
						const read = store.get('player-lifecycle');
						read.onsuccess = () => {
							const current = read.result;
							const scope = { gameId, identity: current.mode.activeRun.identity, runNumber: current.mode.activeRun.runNumber };
							const reservation = { ...scope, ...(reservationCase === 'provisional' ? { expiresAtMs: nowMs + 60_000 } : {}) };
							const lock = reservationCase === 'locked' ? {
								...scope, startedAtMs: nowMs - 1_000, endsAtMs: nowMs + 119_000, finalDeadlineMs: nowMs + 149_000,
								phase: 'running', points: 0, lifespanLossMs: 0
							} : undefined;
							store.put({ ...current, tagGame: { reservation, ...(lock ? { lock } : {}) } }, 'player-lifecycle');
						};
						transaction.oncomplete = () => { database.close(); resolve(); };
						transaction.onerror = () => { database.close(); reject(transaction.error); };
					};
				}), { reservationCase, gameId: validGameId, nowMs });
			}
			await page.evaluate((event) => {
				if (event) (window as typeof window & { __relayStartupTest: { queueRealtimeBootstrapEvent(event: object): void } }).__relayStartupTest.queueRealtimeBootstrapEvent(event);
			}, reservationCase === 'confirmed' || reservationCase === 'locked' ? recoveredEvent : null);
			await page.evaluate(() => (window as typeof window & { __relayStartupTest: { deferNextWebSocketOpen(): void } }).__relayStartupTest.deferNextWebSocketOpen());
			await page.reload();
			await expect(page.locator('[data-unified-status-hud]')).toBeVisible();
			if (reservationCase === 'confirmed') {
				await expect.poll(async () => (await tagGamePersistence(page)).reservation).toMatchObject({ recoveryDeadlineMs: expect.any(Number) });
			}
			const startupState = await relayState(page);
			const currentGeneration = Math.max(...startupState.state.webSocketConnections.map((connection) => connection.generation));
		const authoritativeRelayHosts = new Set(AUTHORITATIVE_RELAYS.map((url) => new URL(url).host));
		const relayConnections = startupState.state.webSocketConnections.filter((connection) => connection.generation === currentGeneration && authoritativeRelayHosts.has(new URL(connection.url).host)).length;
		const connectingAppCloses = startupState.state.webSocketCloses.filter((close) => close.generation === currentGeneration && close.origin === 'application' && close.readyState === 0 && authoritativeRelayHosts.has(new URL(close.url).host)).length;
			const pagehideRelayCloses = startupState.state.previousWebSocketCloses.filter((close) => close.origin === 'pagehide' && authoritativeRelayHosts.has(new URL(close.url).host)).length;
			const connectingPagehideCloses = startupState.state.previousWebSocketCloses.filter((close) => close.origin === 'pagehide' && close.readyState === 0 && authoritativeRelayHosts.has(new URL(close.url).host)).length;
			observations.push({ reservation: reservationCase, relayConnections, connectingAppCloses, pagehideRelayCloses, connectingPagehideCloses });
			await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseWebSocketOpens(): void } }).__relayStartupTest.releaseWebSocketOpens());
			await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
			await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toBeVisible();
			await expect(page.locator('main')).toHaveAttribute('data-realtime-status', 'active');
			if (reservationCase === 'confirmed') {
				const request = (await relayState(page)).state.requests.find((candidate) => candidate.filters.some((filter) => (filter['#d'] as string[] | undefined)?.includes(validGameId)));
				expect(request).toBeDefined();
				await expect.poll(async () => (await tagGamePersistence(page)).reservation).toMatchObject({ gameId: validGameId, identity: expect.any(Object), runNumber: 1 });
			} else if (reservationCase === 'provisional') {
				await expect.poll(async () => (await tagGamePersistence(page)).reservation).toMatchObject({ gameId: validGameId, expiresAtMs: nowMs + 60_000 });
			} else if (reservationCase === 'locked') {
				const request = (await relayState(page)).state.requests.find((candidate) => candidate.filters.some((filter) => (filter['#d'] as string[] | undefined)?.includes(validGameId)));
				expect(request).toBeDefined();
				await expect(page.locator(`[data-tag-game-hud-id="${validGameId}"]`)).toBeVisible();
				await expect.poll(async () => (await tagGamePersistence(page)).lock).toMatchObject({ gameId: validGameId });
				expect(['running', 'settling']).toContain(((await tagGamePersistence(page)).lock as { phase: string }).phase);
			}
		} finally {
			await page.close();
		}
	}
	expect(observations).toEqual(cases.map((reservation) => ({ reservation, relayConnections: 5, connectingAppCloses: 0, pagehideRelayCloses: 5, connectingPagehideCloses: 0 })));
});

test('releases an approved reservation after finite known-game recovery when Relay has no retained state', async ({ browser }) => {
	test.setTimeout(60_000);
	const nowMs = Date.now();
	const page = await browser.newPage();
	const selfSecret = fixtureSecret(53);
		const gameId = `${getPublicKey(fixtureSecret(47))}:${Math.floor(nowMs / 1_000)}:${'c'.repeat(64)}`;
	try {
		await preparePlayer(page, selfSecret, nowMs, 0, true, true);
		await moveRelaySelfTo(page, { x: 8, y: 5 });
		await page.evaluate((reservationGameId) => new Promise<void>((resolve, reject) => {
			const request = indexedDB.open('persona-bubble-field-account', 9);
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction('persona-bubble-field-player-state', 'readwrite');
				const store = transaction.objectStore('persona-bubble-field-player-state');
				const read = store.get('player-lifecycle');
				read.onsuccess = () => {
					const current = read.result;
					const activeRun = current.mode.activeRun;
					store.put({ ...current, tagGame: { reservation: { gameId: reservationGameId, identity: activeRun.identity, runNumber: activeRun.runNumber } } }, 'player-lifecycle');
				};
				transaction.oncomplete = () => { database.close(); resolve(); };
				transaction.onerror = () => { database.close(); reject(transaction.error); };
			};
		}), gameId);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { deferNextWebSocketOpen(): void } }).__relayStartupTest.deferNextWebSocketOpen());
		const recoveryStartedAtMs = nowMs + 91_000;
		await page.clock.setFixedTime(recoveryStartedAtMs);
		await page.reload();
		await expect(page.locator('[data-unified-status-hud]')).toBeVisible();
		const startupState = await relayState(page);
		const currentGeneration = Math.max(...startupState.state.webSocketConnections.map((connection) => connection.generation));
		const authoritativeRelayHosts = new Set(AUTHORITATIVE_RELAYS.map((url) => new URL(url).host));
		expect(startupState.state.webSocketConnections.filter((connection) => connection.generation === currentGeneration && authoritativeRelayHosts.has(new URL(connection.url).host))).toHaveLength(5);
		expect(startupState.state.webSocketCloses.filter((close) => close.generation === currentGeneration && close.origin === 'application' && close.readyState === 0 && authoritativeRelayHosts.has(new URL(close.url).host))).toEqual([]);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseWebSocketOpens(): void } }).__relayStartupTest.releaseWebSocketOpens());
		await openTagGameTerminal(page);
		await expect(page.locator(`[data-tag-game-cancel-reservation="${gameId}"]`)).toBeVisible();
		await expect(page.locator(`[data-tag-game-cancel-reservation="${gameId}"]`)).toHaveAttribute('data-action-intent', 'cancel');
		let observedReservation: { recoveryDeadlineMs?: number } | null = null;
		await expect.poll(async () => {
			observedReservation = (await tagGamePersistence(page)).reservation as { recoveryDeadlineMs?: number } | null;
			return observedReservation?.recoveryDeadlineMs ?? null;
		}).not.toBeNull();
		const firstDeadline = observedReservation!.recoveryDeadlineMs!;
		expect(firstDeadline).toBe(recoveryStartedAtMs + TAG_GAME_RESERVATION_RECOVERY_MS);
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => request.filters.some((filter) => (filter['#d'] as string[] | undefined)?.includes(gameId)))).toBe(true);
		await page.reload();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${getPublicKey(selfSecret)}"]`)).toBeVisible();
		await expect.poll(async () => (await tagGamePersistence(page)).reservation).toMatchObject({ recoveryDeadlineMs: firstDeadline });
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => request.filters.some((filter) => (filter['#d'] as string[] | undefined)?.includes(gameId)))).toBe(true);
		await page.clock.setFixedTime(firstDeadline + 1);
		await page.clock.runFor(2_000);
		await expect.poll(async () => (await tagGamePersistence(page)).reservation).toBeNull();
	} finally {
		await page.close();
	}
});

test('requests a missing remote Run position proof and accepts the next input after it arrives', async ({ browser }) => {
	test.setTimeout(90_000);
	const hostPage = await browser.newPage();
	const participantPage = await browser.newPage();
	const nowMs = Date.now();
	const hostSecret = fixtureSecret(61);
	const participantSecret = fixtureSecret(63);
	const hostPubkey = getPublicKey(hostSecret);
	const participantPubkey = getPublicKey(participantSecret);
	try {
		await Promise.all([preparePlayer(hostPage, hostSecret, nowMs, 200_000), preparePlayer(participantPage, participantSecret, nowMs, 200_000)]);
		await Promise.all([moveRelaySelfTo(hostPage, { x: 7, y: 5 }), moveRelaySelfTo(participantPage, { x: 8, y: 5 })]);
		const startedAt = Math.floor(await hostPage.evaluate(() => Date.now() / 1_000));
		const nowSeconds = startedAt;
		const freshHostPosition = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' }, createdAt: startedAt, position: { x: 7, y: 5 }, slot: 1, runNumber: 1 }), hostSecret);
		const freshParticipantPosition = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' }, createdAt: startedAt, position: { x: 8, y: 5 }, slot: 1, runNumber: 1 }), participantSecret);
		await injectPosition(participantPage, freshHostPosition);
		await injectPosition(participantPage, freshParticipantPosition);
		const activeMessage = finalizeEvent(buildWorldMessageTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' }, createdAt: startedAt,
			position: { x: 8, y: 5 }, content: 'fresh World activity', speechType: 'normal'
		}), participantSecret);
		await hostPage.evaluate((next) => (window as typeof window & { __relayStartupTest: { injectMessage(event: object): void } }).__relayStartupTest.injectMessage(next), activeMessage);
		await participantPage.evaluate((next) => (window as typeof window & { __relayStartupTest: { injectMessage(event: object): void } }).__relayStartupTest.injectMessage(next), activeMessage);

		const seed = Array.from({ length: 10_000 }, (_, index) => `missing-proof-${index}`).find((candidate) => {
			const first = createTagGameSchedule(candidate)[0];
			return first.effect === 'calamity' && first.durationMs === 40_000;
		})!;
		const gameId = `${hostPubkey}:${startedAt}:${'9'.repeat(64)}`;
		const running: TagGameState = {
			gameId, hostPubkey, phase: 'running', revision: 0, updatedAt: startedAt,
			startedAt, endsAt: startedAt + 120, seed, ownerPubkey: hostPubkey, effect: 'calamity', transferAt: startedAt * 1_000,
			participant: [hostPubkey, participantPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: startedAt, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
			settledAtMs: startedAt * 1_000
		};
		const runningEvent = finalizeTagGameState(running, CHANNEL_ID, startedAt, hostSecret);
		// The participant's one-time Run proof refresh starts when its own
		// signed running state arrives. Block it before that transition so this
		// scenario exercises recovery after the initial publication fails.
		await participantPage.evaluate(() => (window as typeof window & { __relayStartupTest: { rejectPositionPublishes(): void } }).__relayStartupTest.rejectPositionPublishes());
		await Promise.all([injectRealtime(hostPage, runningEvent), injectRealtime(participantPage, runningEvent)]);
		await expect(hostPage.locator(`.participant[data-participant-id="${participantPubkey}"]`)).toHaveAttribute('data-tag-game-touch-target', 'true');
		await expect(hostPage.locator(`.participant[data-participant-id="${hostPubkey}"]`)).toHaveAttribute('data-tag-game-role', 'holder');

		await dragRelayJoystick(hostPage, { x: 100, y: 0 }, { x: 7, y: 5 });
		await expect(hostPage.locator(`.participant[data-participant-id="${hostPubkey}"]`)).toHaveAttribute('data-tag-game-touch-attempt', /\d+/);
		await expect.poll(async () => latestTagGameAction(hostPage, hostPubkey, 'touch').then(() => true, () => false)).toBe(true);
		const firstTouch = await latestTagGameAction(hostPage, hostPubkey, 'touch');
		const firstPayload = parseTagGameActionEvent(firstTouch, CHANNEL_ID)!.payload;
		expect(firstPayload.targetProof).toBeUndefined();
		await injectRealtime(hostPage, firstTouch);
		await expect.poll(async () => latestTagGameAction(hostPage, hostPubkey, 'position-refresh-request').then(() => true, () => false)).toBe(true);
		const refreshRequest = await latestTagGameAction(hostPage, hostPubkey, 'position-refresh-request');
		expect(parseTagGameActionEvent(refreshRequest, CHANNEL_ID)?.payload).toMatchObject({ targetPubkey: participantPubkey, targetRunNumber: 1 });
		const duplicateRefreshRequest = finalizeEvent(buildTagGameActionTemplate({ channelId: CHANNEL_ID, gameId, action: 'position-refresh-request', runNumber: 1,
			nonce: 'b'.repeat(32), createdAt: nowSeconds, payload: { targetPubkey: participantPubkey, targetRunNumber: 1 } }), hostSecret);
		await Promise.all([injectRealtime(participantPage, refreshRequest), injectRealtime(participantPage, duplicateRefreshRequest)]);
		await participantPage.clock.runFor(2_500);
		const rejectedPositionIds = await participantPage.evaluate(() => [...new Set((window as typeof window & { __relayStartupTest: { state: { rejectedPositionPublishIds: string[] } } }).__relayStartupTest.state.rejectedPositionPublishIds)]);
		expect(rejectedPositionIds.length).toBeGreaterThan(0);
		await participantPage.evaluate(() => (window as typeof window & { __relayStartupTest: { allowPositionPublishes(): void } }).__relayStartupTest.allowPositionPublishes());
		// Retry timing and the existing 30079 per-second slot planner are
		// independent bounds; allow both to advance after the Relay recovers.
		await participantPage.clock.runFor(2_200);
		await synchronizeBrowserClocks([hostPage, participantPage]);
		await expect.poll(async () => {
			const latest = await latestWorldState(participantPage, participantPubkey);
			return !rejectedPositionIds.includes(latest.id) && latest.tags.some((tag) => tag[0] === 'r' && tag[1] === '1');
		}).toBe(true);
		const refreshedPosition = await latestWorldState(participantPage, participantPubkey);
		expect(refreshedPosition.tags).toContainEqual(['r', '1']);
		expect(refreshedPosition.id).not.toBe((await latestWorldState(hostPage, participantPubkey).catch(() => null))?.id);
		await injectPosition(hostPage, refreshedPosition);
		await injectPosition(participantPage, refreshedPosition);
		await hostPage.clock.runFor(600);
		await dragRelayJoystick(hostPage, { x: 100, y: 0 }, { x: 7, y: 5 });
		await expect.poll(async () => (await relayState(hostPage)).state.published.filter((event) => event.kind === 27070 && parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'touch').length).toBeGreaterThan(1);
		const retryTouch = (await relayState(hostPage)).state.published.filter((event) => event.kind === 27070 && event.pubkey === hostPubkey)
			.map((event) => event as unknown as NostrEvent).reverse().find((event) => parseTagGameActionEvent(event, CHANNEL_ID)?.action === 'touch')!;
		const retryProof = parseTagGameActionEvent(retryTouch, CHANNEL_ID)!.payload.targetProof as { positionEvidenceEventId: string };
		expect(retryProof.positionEvidenceEventId).toBe(refreshedPosition.id);
		await injectRealtime(hostPage, retryTouch);
		await expect.poll(async () => latestTagGameStateValue(hostPage, gameId, (state) => state.ownerPubkey)).toBe(participantPubkey);
	} finally {
		await Promise.all([hostPage.close(), participantPage.close()]);
	}
});

test('does not show unselected games and lets a spectator choose and clear one target', async ({ page }) => {
	const nowMs = Date.now();
	const spectatorSecret = fixtureSecret(19);
	const ownerASecret = fixtureSecret(20);
	const runnerASecret = fixtureSecret(21);
	const ownerBSecret = fixtureSecret(23);
	const runnerBSecret = fixtureSecret(29);
	const startedAt = Math.floor(nowMs / 1_000);
	const channel = { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' };
	await preparePlayer(page, spectatorSecret, nowMs);
	await moveRelaySelfTo(page, { x: 7, y: 5 });
	const players = [
		{ secret: ownerASecret, position: { x: 2, y: 2 } }, { secret: runnerASecret, position: { x: 3, y: 2 } },
		{ secret: ownerBSecret, position: { x: 5, y: 2 } }, { secret: runnerBSecret, position: { x: 6, y: 2 } }
	] as const;
	for (const player of players) {
		const event = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt: startedAt + 1, position: player.position, slot: 1, runNumber: 1 }), player.secret);
		await injectPosition(page, event);
	}
	await page.clock.setSystemTime(startedAt * 1_000 + 250);
	await page.clock.runFor(1_000);
	const cooldownNowMs = await page.evaluate(() => Date.now());
	await page.clock.pauseAt(cooldownNowMs);
	const benefitSeed = Array.from({ length: 1_000 }, (_, index) => `watch-benefit-${index}`).find((candidate) => createTagGameSchedule(candidate)[0].effect === 'benefit')!;
	function hostedGame(hostSecret: Uint8Array, otherSecret: Uint8Array, marker: string, phase: 'countdown' | 'running' = 'running'): NostrEvent {
		const host = getPublicKey(hostSecret);
		const other = getPublicKey(otherSecret);
		const state: TagGameState = {
			gameId: `${host}:${startedAt}:${marker.repeat(64)}`, hostPubkey: host, phase, revision: 0, updatedAt: startedAt,
			...(phase === 'countdown' ? { startAt: startedAt + 10 } : {}),
		startedAt, endsAt: startedAt + 120, seed: benefitSeed, ownerPubkey: host, effect: 'benefit', transferAt: startedAt * 1_000,
			participant: [host, other].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: startedAt, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
			settledAtMs: startedAt * 1_000
		};
		return finalizeTagGameState(state, CHANNEL_ID, startedAt, hostSecret);
	}
	const gameA = hostedGame(ownerASecret, runnerASecret, 'a', 'countdown');
	const initialGameB = parseTagGameEvent(hostedGame(ownerBSecret, runnerBSecret, 'b'), CHANNEL_ID)!.state;
	const gameBUpdatedAt = Math.floor(cooldownNowMs / 1_000);
	const gameB = finalizeTagGameState({ ...initialGameB, updatedAt: gameBUpdatedAt, transferAt: cooldownNowMs + 500 }, CHANNEL_ID, gameBUpdatedAt, ownerBSecret);
	const gameAId = parseTagGameEvent(gameA, CHANNEL_ID)!.state.gameId;
	const gameBId = parseTagGameEvent(gameB, CHANNEL_ID)!.state.gameId;
	await Promise.all([injectRealtime(page, gameA), injectRealtime(page, gameB)]);
	await expect(page.locator('[data-tag-game-hud]')).toHaveCount(0);
	await expect(page.locator('.participant[data-tag-game-role]')).toHaveCount(0);

	await openTagGameTerminal(page);
	await page.locator(`[data-tag-game-watch="${gameBId}"]`).click();
	await expect(page.locator('[data-tag-game-hud]')).toHaveAttribute('data-tag-game-hud-id', gameBId);
	await expect(page.locator('[data-tag-game-hud] [data-tag-game-effect]')).toContainText('所持者以外が追いかけて奪う');
	await page.getByRole('dialog', { name: '鬼ごっこ' }).getByRole('button', { name: '閉じる' }).click();
	await expect(page.getByRole('dialog', { name: '鬼ごっこ' })).toHaveCount(0);
	await expect(page.locator('[data-tag-game-hud]')).toHaveAttribute('data-tag-game-hud-id', gameBId);
	await openTagGameTerminal(page);
	await expect(page.getByRole('dialog', { name: '鬼ごっこ' }).getByRole('button', { name: '観戦を解除' })).toBeVisible();
	const watchedGame = parseTagGameEvent(gameB, CHANNEL_ID)!.state;
	const desktopHud = page.locator('[data-tag-game-hud]');
	await expect(desktopHud.locator('[data-tag-game-hud-footer]')).toHaveCount(0);
	const desktopHeight = await desktopHud.evaluate((element) => element.getBoundingClientRect().height);
	const desktopLine = desktopHud.locator('[data-tag-game-cooldown-line]');
	await expect(desktopLine).toBeVisible();
	const desktopAnimationDelaySeconds = Number.parseFloat(await desktopLine.evaluate((element) => getComputedStyle(element.querySelector('span')!).animationDelay));
	expect(desktopAnimationDelaySeconds * 1_000).toBe(watchedGame.transferAt! - cooldownNowMs);
	expect(desktopAnimationDelaySeconds).toBeGreaterThan(0);
	const animationFrames = await desktopLine.evaluate((element) => {
		const fill = element.querySelector('span')!;
		const animation = fill.getAnimations()[0];
		if (!animation?.effect) throw new Error('Expected the cooldown CSS animation to be active.');
		const timing = animation.effect.getTiming();
		animation.pause();
		const progressAt = (currentTime: number) => {
			animation.currentTime = currentTime;
			return new DOMMatrixReadOnly(getComputedStyle(fill).transform).a;
		};
		const delay = Number(timing.delay);
		const duration = Number(timing.duration);
		return { delay, duration, start: progressAt(0), middle: progressAt(delay + duration / 2), end: progressAt(delay + duration) };
	});
	expect(animationFrames.delay).toBe(watchedGame.transferAt! - cooldownNowMs);
	expect(animationFrames.duration).toBe(TAG_GAME_TRANSFER_COOLDOWN_MS);
	expect(animationFrames.start).toBeGreaterThan(0.99);
	expect(animationFrames.middle).toBeGreaterThan(0);
	expect(animationFrames.middle).toBeLessThan(1);
	expect(animationFrames.end).toBeLessThan(0.01);
	await page.clock.runFor(2_200);
	await expect(desktopLine).toBeVisible();
	await page.clock.runFor(1_000);
	await expect(desktopLine).toHaveCount(0);
	expect(await desktopHud.evaluate((element) => element.getBoundingClientRect().height)).toBe(desktopHeight);

	await page.setViewportSize({ width: 390, height: 844 });
	const mobileHeight = await desktopHud.evaluate((element) => element.getBoundingClientRect().height);
	const mobileNowMs = await page.evaluate(() => Date.now());
	const mobileTransfer = finalizeTagGameState({ ...watchedGame, revision: 1, updatedAt: Math.floor(mobileNowMs / 1_000), transferAt: mobileNowMs + 500 }, CHANNEL_ID, Math.floor(mobileNowMs / 1_000), ownerBSecret);
	await injectRealtime(page, mobileTransfer);
	await expect(desktopHud.locator('[data-tag-game-hud-footer]')).toHaveCount(0);
	await expect(desktopHud.locator('[data-tag-game-cooldown-line]')).toBeVisible();
	await page.clock.runFor(3_000);
	await expect(desktopHud.locator('[data-tag-game-cooldown-line]')).toHaveCount(0);
	expect(await desktopHud.evaluate((element) => element.getBoundingClientRect().height)).toBe(mobileHeight);

	await page.clock.setSystemTime(watchedGame.endsAt! * 1_000 + 1_000);
	await page.clock.runFor(1_100);
	await expect(page.locator('[data-tag-game-remaining]')).toHaveText('00:00');
	await expect(page.locator('[data-tag-game-cooldown]')).toHaveText('最終精算中');
	await expect(page.locator('[data-tag-game-leave]')).toHaveCount(0);
	await injectRealtime(page, gameB);
	await expect(page.getByRole('dialog', { name: '鬼ごっこ' })).toBeVisible();
	const startAAt = Math.max(Math.floor(Date.now() / 1_000), startedAt + 1);
	const countdownA = parseTagGameEvent(gameA, CHANNEL_ID)!.state;
	const runningA = finalizeTagGameState({ ...countdownA, phase: 'running', revision: 1, updatedAt: startAAt, startedAt: startAAt, endsAt: startAAt + 120, settledAtMs: startAAt * 1_000 }, CHANNEL_ID, startAAt, ownerASecret);
	await injectRealtime(page, runningA);
	await expect(page.getByRole('dialog', { name: '鬼ごっこ' })).toBeVisible();
	await expect(page.locator('[data-tag-game-hud]')).toHaveAttribute('data-tag-game-hud-id', gameBId);
	await expect(page.locator(`.participant[data-participant-id="${getPublicKey(ownerBSecret)}"]`)).toHaveAttribute('data-tag-game-role', 'holder');
	await expect(page.locator(`.participant[data-participant-id="${getPublicKey(runnerBSecret)}"]`)).toHaveAttribute('data-tag-game-role', 'participant');
	await expect(page.locator(`.participant[data-participant-id="${getPublicKey(ownerASecret)}"][data-tag-game-role]`)).toHaveCount(0);
	await expect(page.locator(`.participant[data-participant-id="${getPublicKey(runnerASecret)}"][data-tag-game-role]`)).toHaveCount(0);
	await page.getByRole('button', { name: '観戦を解除' }).click();
	await expect(page.locator('[data-tag-game-hud]')).toHaveCount(0);
	await expect(page.locator('.participant[data-tag-game-role]')).toHaveCount(0);
});

test('keeps the tag-game close button keyboard-focusable with a visible focus ring', async ({ page }) => {
	const nowMs = Date.now();
	const secret = fixtureSecret(31);
	await preparePlayer(page, secret, nowMs);
	await moveRelaySelfTo(page, { x: 7, y: 5 });
	await openTagGameTerminal(page);
	const close = page.getByRole('dialog', { name: '鬼ごっこ' }).getByRole('button', { name: '閉じる' });
	await close.focus();
	await page.keyboard.press('Tab');
	await expect(close).not.toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await expect(close).toBeFocused();
	const focus = await close.evaluate((button) => {
		const style = getComputedStyle(button);
		const tokenProbe = document.createElement('span');
		tokenProbe.style.cssText = 'position:fixed;visibility:hidden;outline:3px solid var(--action-focus-ring)';
		button.insertAdjacentElement('afterend', tokenProbe);
		const focusToken = getComputedStyle(tokenProbe).outlineColor;
		tokenProbe.remove();
		return { visible: button.matches(':focus-visible'), outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor, token: focusToken };
	});
	expect(focus.visible).toBe(true);
	expect(focus.outlineStyle).toBe('solid');
	expect(focus.outlineWidth).toBe('3px');
	expect(focus.outlineColor).toBe(focus.token);
});

test('dismisses the tag-game dialog with Escape, outside click, and Close without losing terminal access', async ({ page }) => {
	const nowMs = Date.now();
	const secret = fixtureSecret(32);
	await preparePlayer(page, secret, nowMs);
	await moveRelaySelfTo(page, { x: 7, y: 5 });
	await openTagGameTerminal(page);
	const dialog = page.getByRole('dialog', { name: '鬼ごっこ' });
	const close = dialog.getByRole('button', { name: '閉じる' });

	await dialog.getByRole('heading', { name: '鬼ごっこ' }).click();
	await dialog.hover();
	await page.mouse.wheel(0, 120);
	await expect(dialog).toBeVisible();

	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);

	await openTagGameTerminal(page);
	await page.locator('.tag-game-dialog-overlay').click({ position: { x: 8, y: 8 } });
	await expect(dialog).toHaveCount(0);

	await openTagGameTerminal(page);
	await close.click();
	await expect(dialog).toHaveCount(0);
	await openTagGameTerminal(page);
	await expect(dialog).toBeVisible();
});
