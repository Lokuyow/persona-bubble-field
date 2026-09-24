import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { installFieldFrameSampling, sampleRenderedField } from './helpers/fieldFrames';
import { profileDialog } from './helpers/devWorldHarness';
import { installDelayedRelay, traceRuntimeEvents, seedRelayAccount } from './helpers/relayHarness';


test.describe('DEV World Sandbox', () => {
	test.beforeEach(async ({ page }) => {
		await installHostOwnedStub(page);
	});

	test('shows a finite recent-message overlay with semantic colors and existing profile focus restoration', async ({ page }) => {
		await page.setViewportSize({ width: 1200, height: 1600 });
		await page.goto('/?devWorld=1&devScenario=chatter-timeline');
		const timeline = page.getByLabel('Chatter', { exact: true });
		const visibleEntries = timeline.locator('.timeline-visible-entries .timeline-entry');
		await expect(timeline).toBeVisible();
		await expect.poll(() => page.evaluate(() => localStorage.getItem('persona-bubble-field:chatter-open'))).toBeNull();
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
				backgroundImage: style.backgroundImage,
				backdropFilter: style.backdropFilter,
				boxShadow: style.boxShadow,
				borderStyle: style.borderStyle,
				overflowY: entries ? getComputedStyle(entries).overflowY : ''
			};
		});
		expect(presentation.backgroundImage).toContain('linear-gradient');
		expect(presentation.boxShadow).not.toBe('none');
		expect(presentation.borderStyle).toBe('solid');
		expect(presentation.backdropFilter).toBe('none');
		expect(presentation.overflowY).toBe('visible');

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
		await page.goto('/?devWorld=1&devScenario=chatter-timeline');
		const chatter = page.locator('aside.recent-message-timeline');
		await expect(chatter).toBeVisible();
		const beforeIds = await page.locator('.timeline-visible-entries .timeline-entry').evaluateAll((entries) =>
			entries.map((entry) => entry.getAttribute('data-timeline-event-id')));

		await page.keyboard.press('c');
		await expect(chatter).toBeHidden();
		await page.keyboard.press('C');
		await expect(chatter).toBeVisible();
		await expect(page.locator('.timeline-visible-entries .timeline-entry')).toHaveCount(beforeIds.length);

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
		await page.goto('/?devWorld=1&devScenario=chatter-timeline');
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
		await page.goto('/?devWorld=1&devScenario=chatter-timeline');
		const timeline = page.locator('aside.recent-message-timeline');
		await expect(page.locator('.field-viewport')).toHaveClass(/initial-field-geometry-ready/);
		await expect(timeline).toBeHidden();
		await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', bubbles: true })));
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
		await page.keyboard.press('c');
		await expect(timeline).toBeVisible();
		await page.keyboard.press('c');
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
		await page.keyboard.press('c');
		await expect(timeline).toBeVisible();

		await page.setViewportSize({ width: 390, height: 844 });
		await expect(timeline).toBeVisible();
	});

	test('persists ActionDock button selection across reloads and prefers the saved value at every width', async ({ page }) => {
		const trace = traceRuntimeEvents();
		await installDelayedRelay(page, { persistAcrossReload: true });
		await seedRelayAccount(page, trace.selfSecret, trace.selfPubkey);
		await page.setViewportSize({ width: 1200, height: 900 });
		await page.goto('/');
		const chatter = page.locator('aside.recent-message-timeline');
		const toggle = page.locator('.chatter-toggle');
		await expect(chatter).toBeVisible();
		await toggle.click();
		await expect(chatter).toBeHidden();
		await expect.poll(() => page.evaluate(() => localStorage.getItem('persona-bubble-field:chatter-open'))).toBe('false');
		await page.reload();
		await expect(chatter).toBeHidden();
		await page.setViewportSize({ width: 390, height: 844 });
		await expect(chatter).toBeHidden();
		await page.reload();
		await expect(chatter).toBeHidden();
	});

	test('persists the C shortcut preference across reload and ignores later viewport changes', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/?devWorld=1&devScenario=chatter-timeline');
		const chatter = page.locator('aside.recent-message-timeline');
		await expect(page.locator('.field-viewport')).toHaveClass(/initial-field-geometry-ready/);
		await expect(chatter).toBeHidden();
		await expect.poll(() => page.evaluate(() => localStorage.getItem('persona-bubble-field:chatter-open'))).toBeNull();
		await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', bubbles: true })));
		await expect(chatter).toBeVisible();
		await expect.poll(() => page.evaluate(() => localStorage.getItem('persona-bubble-field:chatter-open'))).toBe('true');
		await page.setViewportSize({ width: 1200, height: 900 });
		await expect(chatter).toBeVisible();
		await page.reload();
		await expect(chatter).toBeVisible();
		await page.setViewportSize({ width: 390, height: 844 });
		await expect(chatter).toBeVisible();
	});

	test('keeps Chatter operable when localStorage writes are unavailable', async ({ page }) => {
		const trace = traceRuntimeEvents();
		await page.addInitScript(() => {
			const originalSetItem = Storage.prototype.setItem;
			Storage.prototype.setItem = function (key: string, value: string) {
				if (key === 'persona-bubble-field:chatter-open') throw new DOMException('Blocked', 'SecurityError');
				return originalSetItem.call(this, key, value);
			};
		});
		await installDelayedRelay(page, { persistAcrossReload: true });
		await seedRelayAccount(page, trace.selfSecret, trace.selfPubkey);
		await page.setViewportSize({ width: 1200, height: 900 });
		await page.goto('/');
		const chatter = page.locator('aside.recent-message-timeline');
		await expect(chatter).toBeVisible();
		await page.locator('.chatter-toggle').click();
		await expect(chatter).toBeHidden();
		await page.locator('main').evaluate((element) => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', bubbles: true })));
		await expect(chatter).toBeVisible();
	});
});
