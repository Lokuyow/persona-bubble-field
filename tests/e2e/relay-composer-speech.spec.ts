import { expect, test, type Locator, type Page } from '@playwright/test';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import { finalizeEvent, getPublicKey, verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure';
import {
	buildWorldStateEventTemplate,
	WORLD_STATE_KIND,
	buildDeathTraceEventTemplate,
	buildTraceReplyTemplate,
	buildWorldMessageTemplate,
	parseTraceReplyCandidate,
	parseWorldMessage,
	validateTraceReplyCandidate
} from '../../src/lib/nostrProtocol';
import {
	buildRiftActionTemplate,
	buildRiftCommitAction,
	buildRiftRevealAction,
	buildManualRiftInstanceId,
	deriveRiftHolePositions,
	getRiftRoundSchedule,
	getRiftSchedule,
	getRiftScheduleForInstance,
	RIFT_CONSULTATION_MS,
	RIFT_PROTOCOL_KEY,
	type RiftAction
} from '../../src/lib/rift';
import { buildRealtimeControlEventTemplate, finalizeRealtimeEvent } from '../../src/lib/realtimeEvents';
import { SPEECH_SHORTCUT_IDS } from '../../src/lib/speechSubmission';
import { characterPicturePath } from '../../src/lib/character';
import { requireCharacterFromPubkey, resolveCharacterFromPubkey } from '../../src/lib/characterAssignment';
import { deriveBip85NostrEntropy } from '../../src/lib/bip85';
import { ADJUSTMENT_TERMINAL, MENDING_TERMINAL } from '../../src/lib/fieldFacilities';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { installFieldFrameSampling, readFieldFrames, sampleRenderedField } from './helpers/fieldFrames';
import { fixtureSecret, installDelayedRelay, publishedMessages, waitForPublishedMessageCount, openReadyRelayWorld, installPromptApiStub, seedRelayAccount, composerContextCalls, readActionDockControlOrder } from './helpers/relayHarness';


test.describe('Relay startup', () => {
	test('shows ActionDock tooltips for the current control meanings', async ({ page }) => {
		await installPromptApiStub(page);
		const editor = await openReadyRelayWorld(page, 1);
		const tooltip = page.getByRole('tooltip');
		const moveAway = async (): Promise<void> => { await page.mouse.move(1, 1); };
		const expectTooltip = async (trigger: Locator, text: string): Promise<void> => {
			await moveAway();
			await trigger.hover();
			await expect(tooltip).toHaveText(text);
			await expect(tooltip).toBeVisible();
		};

		const profile = page.locator('.profile-trigger');
		const chatter = page.locator('.chatter-toggle');
		const speechType = page.locator('.speech-type-toggle');
		const suggestions = page.locator('.suggestions-tooltip-trigger');
		await expect(profile).not.toHaveAttribute('title');
		await expect(chatter).not.toHaveAttribute('title');
		await expect(speechType).not.toHaveAttribute('title');
		await expect(page.locator('.suggestions-toggle')).not.toHaveAttribute('title');

		await expectTooltip(profile, '自分のプロフィール');
		await expectTooltip(chatter, 'Chatterを閉じる');
		await chatter.click();
		await expect(chatter).toHaveAttribute('aria-pressed', 'false');
		await expectTooltip(chatter, 'Chatterを開く');
		await chatter.click();

		await expectTooltip(speechType, '発言タイプ：通常');
		await speechType.click();
		await expectTooltip(speechType, '発言タイプ：叫び');

		await expectTooltip(suggestions, 'AI発言候補を生成');
		await editor.fill('disabled candidate tooltip');
		await expect(page.locator('.suggestions-toggle')).toBeDisabled();
		await expectTooltip(suggestions, 'AI発言候補を生成');
	});

	test('renders ActionDock controls in order on desktop and mobile without an unread slot', async ({ page }) => {
		await installPromptApiStub(page);
		for (const width of [1200, 390]) {
			await page.setViewportSize({ width, height: 844 });
			await openReadyRelayWorld(page, 1);
			const chatterToggle = page.locator('.chatter-toggle');
			const suggestionsToggle = page.locator('.suggestions-toggle');
			await expect(page.getByRole('button', { name: 'AI発言候補を生成' })).toBeVisible();
			await expect(suggestionsToggle.locator('svg')).toHaveCount(1);
			await expect(suggestionsToggle).not.toContainText('候補');
			await expect(suggestionsToggle).toHaveAccessibleName('AI発言候補を生成');
			const suggestionsButtonBox = await suggestionsToggle.boundingBox();
			const suggestionsIconBox = await suggestionsToggle.locator('svg').boundingBox();
			expect(suggestionsButtonBox && suggestionsIconBox).toBeTruthy();
			if (suggestionsButtonBox && suggestionsIconBox) {
				expect(suggestionsButtonBox.width).toBeGreaterThanOrEqual(44);
				expect(suggestionsButtonBox.height).toBeGreaterThanOrEqual(44);
				expect(Math.abs((suggestionsIconBox.x + suggestionsIconBox.width / 2) - (suggestionsButtonBox.x + suggestionsButtonBox.width / 2))).toBeLessThan(1);
				expect(Math.abs((suggestionsIconBox.y + suggestionsIconBox.height / 2) - (suggestionsButtonBox.y + suggestionsButtonBox.height / 2))).toBeLessThan(1);
			}
			await expect(chatterToggle.locator('svg')).toHaveCount(1);
			await expect(chatterToggle).not.toContainText('Chatter');
			const buttonBox = await chatterToggle.boundingBox();
			const iconBox = await chatterToggle.locator('svg').boundingBox();
			expect(buttonBox && iconBox).toBeTruthy();
			if (buttonBox && iconBox) {
				expect(Math.abs((iconBox.x + iconBox.width / 2) - (buttonBox.x + buttonBox.width / 2))).toBeLessThan(1);
				expect(Math.abs((iconBox.y + iconBox.height / 2) - (buttonBox.y + buttonBox.height / 2))).toBeLessThan(1);
			}
			const initiallyOpen = width > 700;
			await expect(chatterToggle).toHaveAttribute('aria-label', initiallyOpen ? 'Chatterを閉じる' : 'Chatterを開く');
			await expect(chatterToggle).toHaveAttribute('aria-pressed', String(initiallyOpen));
			const toggleBox = await chatterToggle.boundingBox();
			expect(toggleBox?.width ?? 0).toBeGreaterThanOrEqual(44);
			expect(toggleBox?.height ?? 0).toBeGreaterThanOrEqual(44);
			await chatterToggle.click();
			await expect(chatterToggle).toHaveAttribute('aria-label', initiallyOpen ? 'Chatterを開く' : 'Chatterを閉じる');
			await expect(chatterToggle).toHaveAttribute('aria-pressed', String(!initiallyOpen));
			await expect(page.locator('.trace-unread-indicator')).toHaveCount(0);
			expect(await readActionDockControlOrder(page)).toEqual([
				'profile-trigger', 'chatter-toggle', 'speech-type-toggle', 'suggestions-anchor'
			]);
		}
	});

	test('passes the Host-owned editor submit button option without enabling the keyboard button bar', async ({ page }) => {
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await page.goto('/');
		await expect(page.locator('ehagaki-composer')).toBeVisible();

		const options = await page.evaluate(() => {
			const options = (window as typeof window & {
				__ehagakiHostOwnedOptions?: {
					editorSubmitButtonEnabled?: boolean;
					keyboardButtonBarEnabled?: boolean;
					enterKeyBehavior?: string;
					editorMinLines?: number;
					editorMaxLines?: number;
					submitShortcuts?: Array<{ id: string; modifiers: string[] }>;
				};
			}).__ehagakiHostOwnedOptions;
			return options && {
				editorSubmitButtonEnabled: options.editorSubmitButtonEnabled,
				keyboardButtonBarEnabled: options.keyboardButtonBarEnabled,
				enterKeyBehavior: options.enterKeyBehavior,
				editorMinLines: options.editorMinLines,
				editorMaxLines: options.editorMaxLines,
				submitShortcuts: options.submitShortcuts
			};
		});

		expect(options).toEqual({
			editorSubmitButtonEnabled: true,
			keyboardButtonBarEnabled: false,
			enterKeyBehavior: 'submit',
			editorMinLines: 1,
			editorMaxLines: 3,
			submitShortcuts: [
				{ id: SPEECH_SHORTCUT_IDS.shout, modifiers: ['ctrlOrMeta'] },
				{ id: SPEECH_SHORTCUT_IDS.monologue, modifiers: ['alt'] }
			]
		});
	});

	test('bridges the site accent to the Host-owned Composer theme', async ({ page }) => {
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await page.goto('/');
		const composer = page.locator('ehagaki-composer');
		await expect(composer).toBeVisible();
		await expect(composer.getByRole('textbox', { name: '投稿エディター' })).toBeVisible();

		const colors = await composer.evaluate((element) => {
			const accentValue = getComputedStyle(element).getPropertyValue('--ehagaki-accent-color').trim();
			const probe = document.createElement('span');
			probe.style.color = 'var(--color-accent)';
			document.body.append(probe);
			const siteAccent = getComputedStyle(probe).color;
			probe.style.color = accentValue;
			const composerAccent = getComputedStyle(probe).color;
			probe.remove();
			return { accentValue, siteAccent, composerAccent };
		});

		expect(colors.accentValue).not.toBe('');
		expect(colors.composerAccent).toBe(colors.siteAccent);
	});

	test('generates on-device candidates and directly sends the primary action once', async ({ page }) => {
		await installPromptApiStub(page);
		const selfSecret = fixtureSecret(19);
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		const editor = await openReadyRelayWorld(page, 1);
		await page.getByRole('button', { name: /発言タイプ: 通常/ }).click();
		const candidateButton = page.getByRole('button', { name: 'AI発言候補を生成' });
		await expect(candidateButton).toBeVisible();
		await editor.fill('既存のdraft');
		await expect(candidateButton).toBeDisabled();
		await editor.fill('');
		await expect(candidateButton).toBeEnabled();
		const publishedBefore = (await publishedMessages(page)).length;
		await candidateButton.click();
		const primary = page.locator('.suggestion-primary').first();
		await expect(primary).toBeVisible();
		const prompt = await page.evaluate(() => (window as typeof window & {
			__promptApiState: { prompts: string[] }
		}).__promptApiState.prompts.at(-1));
		expect(prompt).toContain('名前:');
		expect(prompt).toContain('直近の会話本文');
		await primary.dblclick();
		await expect.poll(async () => (await publishedMessages(page)).filter((event) => event.content === 'まずは自然な返答です。')).toHaveLength(1);
		await expect(editor).toHaveValue('');
		const published = (await publishedMessages(page)).filter((event) => event.content === 'まずは自然な返答です。');
		expect(published).toHaveLength(1);
		expect(published[0].kind).toBe(42);
		expect(published[0].tags).toEqual(expect.arrayContaining([['l', 'speech:shout', expect.any(String)]]));
		expect((await publishedMessages(page)).length).toBe(publishedBefore + 1);
		expect((await composerContextCalls(page)).filter((call) => Object.hasOwn(call, 'content'))).toEqual([]);
		await expect(page.locator('.suggestion-panel')).toHaveCount(0);
	});

	test('adds a candidate through Composer without publishing and preserves the draft guard', async ({ page }) => {
		await installPromptApiStub(page);
		const selfSecret = fixtureSecret(19);
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		const editor = await openReadyRelayWorld(page, 1);
		const candidateButton = page.getByRole('button', { name: 'AI発言候補を生成' });
		await editor.fill('既存のdraft');
		await expect(candidateButton).toBeDisabled();
		await editor.fill('');
		await candidateButton.click();
		await expect(page.locator('.suggestion-primary').first()).toBeVisible();
		const publishedBefore = (await publishedMessages(page)).length;
		await page.getByRole('button', { name: '候補1をコンポーザーに追加' }).click();
		await expect(editor).toHaveValue('まずは自然な返答です。');
		expect((await publishedMessages(page)).length).toBe(publishedBefore);
		await expect(page.locator('.suggestion-panel')).toHaveCount(0);
	});

	test('closes the candidate panel from its explicit close button without side effects', async ({ page }) => {
		await installPromptApiStub(page);
		const selfSecret = fixtureSecret(19);
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		const editor = await openReadyRelayWorld(page, 1);
		const candidateButton = page.getByRole('button', { name: 'AI発言候補を生成' });
		await candidateButton.click();
		await expect(page.locator('.suggestion-panel')).toBeVisible();
		const publishedBefore = (await publishedMessages(page)).length;
		const close = page.getByRole('button', { name: '発言候補を閉じる' });
		const closeBox = await close.boundingBox();
		const closeIconBox = await close.locator('svg').boundingBox();
		expect(closeBox && closeIconBox).toBeTruthy();
		if (closeBox && closeIconBox) {
			expect(closeBox.width).toBeGreaterThanOrEqual(44);
			expect(closeBox.height).toBeGreaterThanOrEqual(44);
			expect(Math.abs((closeIconBox.x + closeIconBox.width / 2) - (closeBox.x + closeBox.width / 2))).toBeLessThan(1);
			expect(Math.abs((closeIconBox.y + closeIconBox.height / 2) - (closeBox.y + closeBox.height / 2))).toBeLessThan(1);
		}
		await expect(close.locator('svg')).toBeVisible();

		await close.click();

		await expect(page.locator('.suggestion-panel')).toHaveCount(0);
		expect((await publishedMessages(page)).length).toBe(publishedBefore);
		await expect(editor).toHaveValue('');
		await expect(page.getByRole('button', { name: /発言タイプ: 通常/ })).toBeVisible();
	});

	test('keeps the candidate panel open while an outside speech-type toggle is used', async ({ page }) => {
		await installPromptApiStub(page);
		const selfSecret = fixtureSecret(19);
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		const editor = await openReadyRelayWorld(page, 1);
		const candidateButton = page.getByRole('button', { name: 'AI発言候補を生成' });
		const speechTypeToggle = page.getByRole('button', { name: /発言タイプ: 通常/ });
		await candidateButton.click();
		await expect(page.locator('.suggestion-panel')).toBeVisible();
		const publishedBefore = (await publishedMessages(page)).length;

		await speechTypeToggle.click();

		await expect(page.locator('.suggestion-panel')).toBeVisible();
		await expect(page.getByRole('button', { name: /発言タイプ: 叫び/ })).toBeVisible();
		expect((await publishedMessages(page)).length).toBe(publishedBefore);
		await expect(editor).toHaveValue('');
	});

	test('keeps candidates open after direct publish failure and allows retry', async ({ page }) => {
		await installPromptApiStub(page);
		const selfSecret = fixtureSecret(19);
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		await openReadyRelayWorld(page, 1);
		const candidateButton = page.getByRole('button', { name: 'AI発言候補を生成' });
		await candidateButton.click();
		const primary = page.locator('.suggestion-primary').first();
		await expect(primary).toBeVisible();
		await page.evaluate(() => (window as unknown as { __relayStartupTest: { rejectMessagePublishes(): void } }).__relayStartupTest.rejectMessagePublishes());
		await primary.click();
		await expect(page.getByRole('status')).toContainText('候補を送信できませんでした');
		await expect(page.locator('.suggestion-panel')).toBeVisible();
		await page.evaluate(() => (window as unknown as { __relayStartupTest: { allowMessagePublishes(): void } }).__relayStartupTest.allowMessagePublishes());
		await primary.click();
		await expect.poll(async () => (await publishedMessages(page)).some((event) => event.kind === 42 && event.content === 'まずは自然な返答です。')).toBe(true);
		await expect(page.locator('.suggestion-panel')).toHaveCount(0);
	});

	test('keeps the normal Composer when Prompt API availability is unavailable', async ({ page }) => {
		await installPromptApiStub(page, 'unavailable');
		const selfSecret = fixtureSecret(19);
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		const editor = await openReadyRelayWorld(page, 1);
		await expect(editor).toBeVisible();
		await expect(page.getByRole('button', { name: 'AI発言候補を生成' })).toHaveCount(0);
	});

	test('publishes normal, shout, and monologue through the editor button and Enter shortcuts', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const send = page.locator('ehagaki-composer').getByRole('button', { name: 'Send' });

		const submitAndRead = async (content: string, submit: () => Promise<void>) => {
			const before = (await publishedMessages(page)).length;
			await editor.fill(content);
			await submit();
			await waitForPublishedMessageCount(page, before + 1);
			await expect(editor).toHaveValue('');
			const event = (await publishedMessages(page))[before];
			await expect(page.locator(`[data-timeline-event-id="${event.id}"]`)).toHaveCount(1);
			return event;
		};

		const normalByButton = await submitAndRead('button normal', () => send.click());
		const normalByEnter = await submitAndRead('plain Enter', () => editor.press('Enter'));
		const shoutByControl = await submitAndRead('Control shout', () => editor.press('Control+Enter'));
		const shoutByMeta = await submitAndRead('Meta shout', () => editor.press('Meta+Enter'));
		const monologueByAlt = await submitAndRead('Alt monologue', () => editor.press('Alt+Enter'));

		for (const event of [normalByButton, normalByEnter]) {
			expect(event.content).toMatch(/normal|Enter/);
			expect(event.tags.some((tag) => tag[0] === 'l' && tag[1]?.startsWith('speech:'))).toBe(false);
		}
		for (const event of [shoutByControl, shoutByMeta]) {
			expect(event.tags).toContainEqual(['l', 'speech:shout', 'io.github.lokuyow.persona-bubble-field']);
		}
		expect(monologueByAlt.tags).toContainEqual(['l', 'speech:monologue', 'io.github.lokuyow.persona-bubble-field']);
	});

	test('does not publish Ctrl+Meta+Enter as a ctrlOrMeta speech shortcut', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const before = (await publishedMessages(page)).length;

		await editor.fill('both modifiers');
		await editor.press('Control+Meta+Enter');
		await expect.poll(async () => (await publishedMessages(page)).length).toBe(before);
		await expect(editor).toHaveValue('both modifiers');
	});

	test('keeps command-only content, publishes false-positive slash text, and resolves a valid slash command', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const send = page.locator('ehagaki-composer').getByRole('button', { name: 'Send' });
		await editor.fill('/shout');
		await send.click();
		await expect(editor).toHaveValue('/shout');
		await expect.poll(async () => (await publishedMessages(page)).length).toBe(0);

		await editor.fill('/something');
		await send.click();
		await waitForPublishedMessageCount(page, 1);
		const event = (await publishedMessages(page))[0];
		expect(event.content).toBe('/something');
		expect(event.tags.some((tag) => tag[0] === 'l' && tag[1]?.startsWith('speech:'))).toBe(false);

		await editor.fill('/shout valid shout');
		await send.click();
		await waitForPublishedMessageCount(page, 2);
		const validCommandEvent = (await publishedMessages(page))[1];
		expect(validCommandEvent.content).toBe('valid shout');
		expect(validCommandEvent.tags).toContainEqual(['l', 'speech:shout', 'io.github.lokuyow.persona-bubble-field']);
	});

		test('cycles the one-shot speech selector and only resets it after a successful submit', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const send = page.locator('ehagaki-composer').getByRole('button', { name: 'Send' });
		const selector = page.locator('.speech-type-toggle');
		const assertSpeechIcon = async (speechType: 'normal' | 'shout' | 'monologue', accessibleName: RegExp): Promise<void> => {
			await expect(selector).toHaveAttribute('data-speech-type', speechType);
			await expect(selector).toHaveAccessibleName(accessibleName);
			await expect(page.locator(`[data-speech-icon="${speechType}"]`)).toBeVisible();
			const buttonBox = await selector.boundingBox();
			const iconBox = await page.locator(`[data-speech-icon="${speechType}"]`).boundingBox();
			expect(buttonBox && iconBox).toBeTruthy();
			if (buttonBox && iconBox) {
				expect(buttonBox.width).toBeGreaterThanOrEqual(44);
				expect(buttonBox.height).toBeGreaterThanOrEqual(44);
				expect(Math.abs((iconBox.x + iconBox.width / 2) - (buttonBox.x + buttonBox.width / 2))).toBeLessThan(1);
				expect(Math.abs((iconBox.y + iconBox.height / 2) - (buttonBox.y + buttonBox.height / 2))).toBeLessThan(1);
			}
		};

		await assertSpeechIcon('normal', /発言タイプ: 通常.*叫び/);
		await selector.click();
		await assertSpeechIcon('shout', /発言タイプ: 叫び.*モノローグ/);
		await selector.click();
		await assertSpeechIcon('monologue', /発言タイプ: モノローグ.*通常/);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { rejectMessagePublishes(): void } }).__relayStartupTest.rejectMessagePublishes());
		await editor.fill('keep monologue on failure');
		await send.click();
		await expect(editor).toHaveValue('keep monologue on failure');
		await expect(selector).toHaveAttribute('data-speech-type', 'monologue');

		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { allowMessagePublishes(): void } }).__relayStartupTest.allowMessagePublishes());
		await editor.fill('successful monologue');
		await send.click();
		await waitForPublishedMessageCount(page, 2);
		await expect(selector).toHaveAttribute('data-speech-type', 'normal');
	});
});
