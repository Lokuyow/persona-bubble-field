import { expect, test, type Page } from '@playwright/test';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { buildWorldStateEventTemplate } from '../../src/lib/nostrProtocol';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import {
	AUTHORITATIVE_RELAYS,
	CHANNEL_ID,
	fixtureSecret,
	installDelayedRelay,
	relayState,
	seedRelayAccount,
	testEvents,
	upcomingRegistrationSchedule
} from './helpers/relayHarness';

type Position = Readonly<{ x: number; y: number }>;
type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;

function overlaps(first: Rect, second: Rect): boolean {
	return first.x < second.x + second.width && first.x + first.width > second.x &&
		first.y < second.y + second.height && first.y + first.height > second.y;
}

async function startMobileRegistration(page: Page): Promise<Readonly<{ secret: Uint8Array; startTime: number }>> {
	const schedule = upcomingRegistrationSchedule();
	const startTime = schedule.registrationAtMs + 1_000;
	const secret = fixtureSecret(19);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.clock.install({ time: startTime });
	await installHostOwnedStub(page);
	await installDelayedRelay(page, { primaryEvents: testEvents(startTime), realtimeEvents: [] });
	await seedRelayAccount(page, secret, getPublicKey(secret));
	await page.goto('/');
	await expect(page.locator('.action-dock')).toBeVisible();
	await expect(page.locator('[data-realtime-panel]')).toContainText('参加受付');
	await page.evaluate(() => {
		const relay = (window as typeof window & { __relayStartupTest: { releasePrimaryEvents(): void; releasePrimary(): void } }).__relayStartupTest;
		relay.releasePrimaryEvents();
		relay.releasePrimary();
	});
	await expect(page.locator('.participant[data-self="true"]')).toBeVisible();
	return { secret, startTime };
}

async function setSelfPosition(page: Page, secret: Uint8Array, position: Position, createdAtMs: number): Promise<void> {
	const event = finalizeEvent(buildWorldStateEventTemplate({
		channel: { channelId: CHANNEL_ID, relayHint: AUTHORITATIVE_RELAYS[0]! },
		position,
		slot: 0,
		createdAt: Math.floor(createdAtMs / 1_000)
	}), secret);
	await page.evaluate((nextEvent) => {
		(window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(nextEvent);
	}, event);
	await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', `${position.x},${position.y}`);
}

async function readFrame(page: Page) {
	return page.locator('.field-viewport').evaluate((viewport) => {
		const rect = (element: Element): Rect => {
			const bounds = element.getBoundingClientRect();
			const view = viewport.getBoundingClientRect();
			return { x: bounds.left - view.left, y: bounds.top - view.top, width: bounds.width, height: bounds.height };
		};
		const fieldArea = document.querySelector<HTMLElement>('.field-area');
		const panel = document.querySelector<HTMLElement>('[data-realtime-panel]');
		const participant = document.querySelector<HTMLElement>('.participant[data-self="true"]');
		const profileTrigger = participant?.querySelector('.participant-profile-trigger');
		const name = participant?.querySelector('.participant-name');
		const scene = document.querySelector<HTMLElement>('.field-scene');
		if (!fieldArea || !panel || !participant || !profileTrigger || !name || !scene) throw new Error('Expected the mobile event and field surfaces to be mounted.');
		return {
			fieldArea: rect(fieldArea),
			panel: rect(panel),
			participant: rect(participant),
			profileTrigger: rect(profileTrigger),
			name: rect(name),
			cellSize: Number.parseFloat(getComputedStyle(scene).getPropertyValue('--cell-size'))
		};
	});
}

async function noninteractivePanelPoint(page: Page, within?: string): Promise<{ x: number; y: number }> {
	return page.locator('[data-realtime-panel]').evaluate((panel, requiredSelector) => {
		const bounds = panel.getBoundingClientRect();
		const interactive = 'button, input, textarea, select, summary, [contenteditable="true"], .details-layer, .cooperation-defection-choice-controls';
		for (let y = bounds.top + 8; y < bounds.bottom - 8; y += 9) {
			for (let x = bounds.left + 8; x < bounds.right - 8; x += 9) {
				const target = document.elementFromPoint(x, y);
				if (target && panel.contains(target) && !target.closest(interactive) && (!requiredSelector || target.closest(requiredSelector))) return { x, y };
			}
		}
		throw new Error('The event panel has no matching noninteractive point.');
	}, within);
}

async function tapWithTouch(page: Page, point: { x: number; y: number }): Promise<void> {
	const client = await page.context().newCDPSession(page);
	await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
	await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
	await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await client.detach();
}

async function swipeWithTouch(page: Page, start: { x: number; y: number }, end: { x: number; y: number }): Promise<void> {
	const client = await page.context().newCDPSession(page);
	await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
	await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] });
	await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...end, id: 1 }] });
	await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await client.detach();
}

test.describe('mobile Cooperation and Defection panel framing and input', () => {
	test('keeps the self visible and blocks hidden-region pointer gestures while preserving field and panel actions', async ({ page }) => {
		const { secret, startTime } = await startMobileRegistration(page);
		const self = page.locator('.participant[data-self="true"]');

		for (const [index, position] of [{ x: 11, y: 2 }, { x: 0, y: 1 }].entries()) {
			await setSelfPosition(page, secret, position, startTime + (index + 2) * 1_000);
			const frame = await readFrame(page);
			expect(frame.fieldArea.y).toBeGreaterThanOrEqual(frame.panel.y + frame.panel.height);
			expect(frame.fieldArea.height).toBeGreaterThanOrEqual(frame.cellSize * 2);
			expect(overlaps(frame.participant, frame.panel)).toBe(false);
			expect(overlaps(frame.profileTrigger, frame.panel)).toBe(false);
			expect(overlaps(frame.name, frame.panel)).toBe(false);
			expect(frame.participant.y).toBeGreaterThanOrEqual(frame.fieldArea.y);
			expect(frame.participant.y + frame.participant.height).toBeLessThanOrEqual(frame.fieldArea.y + frame.fieldArea.height);

			const hiddenPoint = await noninteractivePanelPoint(page);
			const fieldArea = await page.locator('.field-area').boundingBox();
			if (!fieldArea) throw new Error('Expected measured field-area bounds.');
			expect(hiddenPoint.y).toBeLessThan(fieldArea.y);
			const startPosition = await self.getAttribute('data-position');
			await page.mouse.click(hiddenPoint.x, hiddenPoint.y);
			await expect(page.locator('.field-action-menu, [role="dialog"][aria-modal="true"]')).toHaveCount(0);
			await page.mouse.move(hiddenPoint.x, hiddenPoint.y);
			await page.mouse.down();
			await page.mouse.move(hiddenPoint.x + 34, hiddenPoint.y);
			await expect(page.locator('[data-pointer-joystick]')).toHaveCount(0);
			await page.mouse.up();
			await expect(self).toHaveAttribute('data-position', startPosition!);

			const crossIntoField = { x: hiddenPoint.x, y: fieldArea.y + Math.min(24, fieldArea.height / 3) };
			await page.mouse.move(hiddenPoint.x, hiddenPoint.y);
			await page.mouse.down();
			await page.mouse.move(crossIntoField.x, crossIntoField.y);
			await expect(page.locator('[data-pointer-joystick]')).toHaveCount(0);
			await page.mouse.up();
			await expect(self).toHaveAttribute('data-position', startPosition!);
		}
		const profile = self.locator('.participant-profile-trigger');
		const profileBounds = await profile.boundingBox();
		if (!profileBounds) throw new Error('Expected the visible self profile target.');
		await page.mouse.move(profileBounds.x + profileBounds.width / 2, profileBounds.y + profileBounds.height / 2);
		await page.mouse.down();
		await page.mouse.move(profileBounds.x + profileBounds.width / 2 + 30, profileBounds.y + profileBounds.height / 2);
		await expect(page.locator('[data-pointer-joystick="right"]')).toBeVisible();
		await expect(self).toHaveAttribute('data-position', '1,1');
		await page.mouse.up();
		await page.locator('.participant[data-self="true"] .participant-profile-trigger').click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await page.keyboard.down('ArrowRight');
		await page.clock.runFor(50);
		await expect(self).toHaveAttribute('data-position', '2,1');
		await page.keyboard.up('ArrowRight');

		const summary = page.locator('.cooperation-defection-rules-disclosure summary');
		const summaryBounds = await summary.boundingBox();
		if (!summaryBounds) throw new Error('Expected the visible event rules control.');
		await tapWithTouch(page, { x: summaryBounds.x + summaryBounds.width / 2, y: summaryBounds.y + summaryBounds.height / 2 });
		await expect(page.locator('.cooperation-defection-rules-disclosure')).toHaveJSProperty('open', true);
		await expect(page.locator('.cooperation-defection-rules-inline')).toBeVisible();
		const rules = page.locator('.cooperation-defection-rules-inline');
		const rulesScroll = await rules.evaluate((element) => element.scrollHeight > element.clientHeight);
		if (rulesScroll) {
			const rulesBounds = await rules.boundingBox();
			if (!rulesBounds) throw new Error('Expected the expanded event rules to be visible.');
			const client = await page.context().newCDPSession(page);
			await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rulesBounds.x + rulesBounds.width / 2, y: rulesBounds.y + rulesBounds.height * 0.8, id: 1 }] });
			await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: rulesBounds.x + rulesBounds.width / 2, y: rulesBounds.y + rulesBounds.height * 0.25, id: 1 }] });
			await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
			await client.detach();
			await expect.poll(() => rules.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
		}
		await summary.click();
		await expect(page.locator('.cooperation-defection-rules-disclosure')).toHaveJSProperty('open', false);

		await page.setViewportSize({ width: 700, height: 844 });
		await expect.poll(async () => {
			const frame = await readFrame(page);
			return frame.fieldArea.y - (frame.panel.y + frame.panel.height);
		}).toBeGreaterThanOrEqual(0);
		await page.setViewportSize({ width: 701, height: 800 });
		await expect.poll(async () => (await readFrame(page)).fieldArea.y).toBe(0);
		await expect(page.locator('[data-realtime-panel]')).toHaveCSS('pointer-events', 'none');
		await page.setViewportSize({ width: 390, height: 844 });
		await expect.poll(async () => {
			const frame = await readFrame(page);
			return frame.fieldArea.y - (frame.panel.y + frame.panel.height);
		}).toBeGreaterThanOrEqual(0);
		const restored = await readFrame(page);
		expect(restored.fieldArea.y).toBeGreaterThanOrEqual(restored.panel.y + restored.panel.height);
		await expect(page.locator('[data-realtime-panel]')).toHaveCSS('pointer-events', 'auto');
		await page.setViewportSize({ width: 390, height: 480 });
		const shortFrame = await readFrame(page);
		expect(shortFrame.fieldArea.height).toBeGreaterThanOrEqual(shortFrame.cellSize * 2);
		const eventPanel = page.locator('[data-realtime-panel]');
		const hasPanelOverflow = await eventPanel.evaluate((element) => element.scrollHeight > element.clientHeight);
		expect(hasPanelOverflow).toBe(true);
		const headingBounds = await eventPanel.locator('h2').boundingBox();
		if (!headingBounds) throw new Error('Expected the event panel heading to remain visible.');
		const scrollPoint = await noninteractivePanelPoint(page);
		await swipeWithTouch(page, scrollPoint, { x: scrollPoint.x, y: scrollPoint.y - 64 });
		await expect.poll(() => eventPanel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
		const shortRulesSummary = eventPanel.locator('.cooperation-defection-rules-disclosure summary');
		await shortRulesSummary.scrollIntoViewIfNeeded();
		await expect(shortRulesSummary).toBeVisible();
		await shortRulesSummary.click();
		await expect(page.locator('.cooperation-defection-rules-disclosure')).toHaveJSProperty('open', true);
		const shortRules = page.locator('.cooperation-defection-rules-inline');
		const shortRulesScrolls = await shortRules.evaluate((element) => element.scrollHeight > element.clientHeight);
		expect(shortRulesScrolls).toBe(true);
		const revealRulesPoint = await noninteractivePanelPoint(page);
		const panelScrollBeforeReveal = await eventPanel.evaluate((element) => element.scrollTop);
		await swipeWithTouch(page, revealRulesPoint, { x: revealRulesPoint.x, y: revealRulesPoint.y - 64 });
		await expect.poll(() => eventPanel.evaluate((element) => element.scrollTop)).toBeGreaterThan(panelScrollBeforeReveal);
		const shortRulesScrollPoint = await noninteractivePanelPoint(page, '.cooperation-defection-rules-inline');
		const panelBounds = await eventPanel.boundingBox();
		if (!panelBounds) throw new Error('Expected measured bounds for the scrollable event panel.');
		const rulesDrag = Math.min(16, Math.max(4, shortRulesScrollPoint.y - panelBounds.y - 2));
		await swipeWithTouch(page, shortRulesScrollPoint, { x: shortRulesScrollPoint.x, y: shortRulesScrollPoint.y - rulesDrag });
		await expect.poll(() => shortRules.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
		await expect.poll(async () => (await relayState(page)).state.published.filter((event) => event.kind === 30079).length).toBeGreaterThan(0);
	});
});
