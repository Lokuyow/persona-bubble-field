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
		let persistedChatterState: boolean | null = null;
		for (const width of [1200, 390, 320]) {
			await page.setViewportSize({ width, height: 844 });
			await openReadyRelayWorld(page, 1);
			const chatterToggle = page.locator('.chatter-toggle');
			const suggestionsToggle = page.locator('.suggestions-toggle');
			for (const control of [page.locator('.profile-trigger'), chatterToggle, page.locator('.speaker-button'), page.locator('.speech-type-toggle'), suggestionsToggle]) {
				const frame = await control.evaluate((element) => {
					const style = getComputedStyle(element);
					return { background: style.backgroundColor, border: style.borderStyle, width: style.borderWidth };
				});
				expect(frame.background).not.toBe('rgba(0, 0, 0, 0)');
				expect(frame.border).toBe('solid');
				expect(frame.width).toBe('1px');
			}
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
			const initiallyOpen: boolean = persistedChatterState ?? (width > 700);
			await expect(chatterToggle).toHaveAttribute('aria-label', initiallyOpen ? 'Chatterを閉じる' : 'Chatterを開く');
			await expect(chatterToggle).toHaveAttribute('aria-pressed', String(initiallyOpen));
			const toggleBox = await chatterToggle.boundingBox();
			expect(toggleBox?.width ?? 0).toBeGreaterThanOrEqual(44);
			expect(toggleBox?.height ?? 0).toBeGreaterThanOrEqual(44);
			await chatterToggle.click();
			await expect(chatterToggle).toHaveAttribute('aria-label', initiallyOpen ? 'Chatterを開く' : 'Chatterを閉じる');
			await expect(chatterToggle).toHaveAttribute('aria-pressed', String(!initiallyOpen));
			persistedChatterState = !initiallyOpen;
			await expect(page.locator('.trace-unread-indicator')).toHaveCount(0);
			await expect(page.locator('.sound-control')).toHaveCount(1);
			await expect(page.getByRole('dialog', { name: 'Sound settings' })).toHaveCount(0);
			expect(await readActionDockControlOrder(page)).toEqual([
				'profile-trigger', 'chatter-toggle', 'sound-control', 'speech-type-toggle', 'suggestions-anchor'
			]);
			if (width <= 700) {
				const editorBox = await page.locator('.composer-editor-slot').boundingBox();
				const leftBox = await page.locator('.composer-controls-left').boundingBox();
				const rightBox = await page.locator('.composer-controls-right').boundingBox();
				expect(editorBox && leftBox && rightBox).toBeTruthy();
				if (editorBox && leftBox && rightBox) {
					expect(editorBox.y + editorBox.height).toBeLessThan(leftBox.y);
					expect(leftBox.x + leftBox.width).toBeLessThanOrEqual(rightBox.x);
					expect(rightBox.x + rightBox.width).toBeLessThanOrEqual(width);
					for (const control of [page.locator('.profile-trigger'), chatterToggle, page.locator('.trace-unread-indicator'), page.locator('.sound-control'), page.locator('.speech-type-toggle'), suggestionsToggle]) {
						if (await control.isVisible()) {
							const box = await control.boundingBox();
							if (!box) throw new Error('Expected a visible mobile ActionDock control to have geometry.');
							expect(box.x).toBeGreaterThanOrEqual(0);
							expect(box.x + box.width).toBeLessThanOrEqual(width);
						}
					}
				}
			} else {
				const leftBox = await page.locator('.composer-controls-left').boundingBox();
				const editorBox = await page.locator('.composer-editor-slot').boundingBox();
				const rightBox = await page.locator('.composer-controls-right').boundingBox();
				expect(leftBox && editorBox && rightBox).toBeTruthy();
				if (leftBox && editorBox && rightBox) {
					expect(leftBox.x + leftBox.width).toBeLessThan(editorBox.x + 1);
					expect(editorBox.x + editorBox.width).toBeLessThanOrEqual(rightBox.x);
				}
			}
			await page.getByRole('button', { name: 'Open sound settings' }).click();
			const soundPanel = page.getByRole('dialog', { name: 'Sound settings' });
			await expect(soundPanel).toBeVisible();
			const soundBox = await soundPanel.boundingBox();
			const soundButtonBox = await page.getByRole('button', { name: 'Open sound settings' }).boundingBox();
			expect(soundBox && soundButtonBox).toBeTruthy();
			if (soundBox && soundButtonBox) expect(soundBox.y + soundBox.height).toBeLessThanOrEqual(soundButtonBox.y + 1);
			await soundPanel.getByRole('slider', { name: 'Sound volume' }).press('Home');
			await page.keyboard.press('Escape');
		}
	});

	test('keeps candidate generation status inside narrow desktop and mobile viewports', async ({ page }) => {
		await installPromptApiStub(page, 'available', 'pending');
		const selfSecret = fixtureSecret(19);
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		const editor = await openReadyRelayWorld(page, 1);
		const candidateButton = page.getByRole('button', { name: 'AI発言候補を生成' });
		await editor.fill('');
		await candidateButton.click();
		for (const viewport of [{ width: 720, height: 844 }, { width: 390, height: 844 }]) {
			await page.setViewportSize(viewport);
			const status = page.getByRole('status');
			await expect(status).toHaveText('候補を生成中…');
			const statusBox = await status.boundingBox();
			expect(statusBox).not.toBeNull();
			if (statusBox) {
				expect(statusBox.x).toBeGreaterThanOrEqual(0);
				expect(statusBox.y).toBeGreaterThanOrEqual(0);
				expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(viewport.width);
				expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(viewport.height);
			}
			await expect(candidateButton).toBeDisabled();
		}
	});

	test('shows a generation error without the candidate panel and allows retry', async ({ page }) => {
		await installPromptApiStub(page, 'available', 'reject-once');
		const selfSecret = fixtureSecret(19);
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		const editor = await openReadyRelayWorld(page, 1);
		await editor.fill('');
		const candidateButton = page.getByRole('button', { name: 'AI発言候補を生成' });
		await candidateButton.click();

		const error = page.locator('.suggestion-error');
		await expect(error).toHaveText('候補を生成できませんでした。もう一度お試しください。');
		await expect(page.locator('.suggestion-panel')).toHaveCount(0);
		for (const viewport of [{ width: 720, height: 844 }, { width: 390, height: 844 }]) {
			await page.setViewportSize(viewport);
			await expect(error).toBeVisible();
			await expect(page.getByRole('status')).toHaveCount(1);
			const errorBox = await error.boundingBox();
			expect(errorBox).not.toBeNull();
			if (errorBox) {
				expect(errorBox.x).toBeGreaterThanOrEqual(0);
				expect(errorBox.y).toBeGreaterThanOrEqual(0);
				expect(errorBox.x + errorBox.width).toBeLessThanOrEqual(viewport.width);
				expect(errorBox.y + errorBox.height).toBeLessThanOrEqual(viewport.height);
			}
		}

		await candidateButton.click();
		await expect(page.locator('.suggestion-panel')).toBeVisible();
		await expect(page.locator('.suggestion-primary').first()).toBeVisible();
		await expect(page.locator('.suggestion-error')).toHaveCount(0);
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
		for (const viewport of [{ width: 720, height: 900 }, { width: 390, height: 844 }]) {
			await page.setViewportSize(viewport);
			await editor.fill('既存のdraft');
			await expect(candidateButton).toBeDisabled();
			await editor.fill('');
			await candidateButton.click();
			const panel = page.locator('.suggestion-panel');
			await expect(panel).toBeVisible();
			const panelBox = await panel.boundingBox();
			expect(panelBox).not.toBeNull();
			expect(panelBox!.x).toBeGreaterThanOrEqual(0);
			expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(viewport.width);
			const primary = panel.locator('.suggestion-primary').first();
			const add = page.getByRole('button', { name: '候補1をコンポーザーに追加' });
			await expect(primary).toBeVisible();
			const addStyle = await add.evaluate((element) => {
				const style = getComputedStyle(element);
				const box = element.getBoundingClientRect();
				return { minWidth: style.minWidth, padding: style.padding, fontSize: style.fontSize, box: { x: box.x, y: box.y, width: box.width, height: box.height } };
			});
			const primaryBox = await primary.boundingBox();
			expect(addStyle.minWidth).toBe('48px');
			expect(addStyle.padding).toBe('6px 8px');
			expect(addStyle.fontSize).toBe('11px');
			expect(primaryBox).not.toBeNull();
			expect(addStyle.box.x).toBeGreaterThanOrEqual(primaryBox!.x + primaryBox!.width);
			expect(addStyle.box.x - (primaryBox!.x + primaryBox!.width)).toBeLessThanOrEqual(8);
			expect(addStyle.box.height).toBeGreaterThanOrEqual(38);
			const publishedBefore = (await publishedMessages(page)).length;
			await add.click();
			await expect(editor).toHaveValue('まずは自然な返答です。');
			expect((await publishedMessages(page)).length).toBe(publishedBefore);
			await expect(panel).toHaveCount(0);
		}
	});

	test('closes the candidate panel from its explicit close button without side effects', async ({ page }) => {
		await installPromptApiStub(page);
		const selfSecret = fixtureSecret(19);
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		const editor = await openReadyRelayWorld(page, 1);
		const candidateButton = page.getByRole('button', { name: 'AI発言候補を生成' });
		for (const viewport of [{ width: 720, height: 900 }, { width: 390, height: 844 }]) {
			await page.setViewportSize(viewport);
			await candidateButton.click();
			const panel = page.locator('.suggestion-panel');
			await expect(panel).toBeVisible();
			const publishedBefore = (await publishedMessages(page)).length;
			const close = page.getByRole('button', { name: '発言候補を閉じる' });
			const panelBox = await panel.boundingBox();
			expect(panelBox).not.toBeNull();
			expect(panelBox!.x).toBeGreaterThanOrEqual(0);
			expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(viewport.width);
			const closeStyle = await close.evaluate((element) => {
				const style = getComputedStyle(element);
				const box = element.getBoundingClientRect();
				const icon = element.querySelector('svg')!.getBoundingClientRect();
				return {
					width: box.width, height: box.height,
					iconWidth: icon.width, iconHeight: icon.height,
					iconCenterX: icon.x + icon.width / 2, iconCenterY: icon.y + icon.height / 2,
					centerX: box.x + box.width / 2, centerY: box.y + box.height / 2,
					background: style.backgroundColor, border: style.borderStyle
				};
			});
			expect(closeStyle.width).toBe(44);
			expect(closeStyle.height).toBe(44);
			expect(closeStyle.iconWidth).toBe(24);
			expect(closeStyle.iconHeight).toBe(24);
			expect(Math.abs(closeStyle.iconCenterX - closeStyle.centerX)).toBeLessThan(1);
			expect(Math.abs(closeStyle.iconCenterY - closeStyle.centerY)).toBeLessThan(1);
			expect(closeStyle.background).not.toBe('rgba(0, 0, 0, 0)');
			expect(closeStyle.border).toBe('solid');
			await expect(close.locator('svg')).toBeVisible();
			await close.click();
			await expect(panel).toHaveCount(0);
			expect((await publishedMessages(page)).length).toBe(publishedBefore);
			await expect(editor).toHaveValue('');
		}
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
		await expect(page.getByRole('status')).toHaveCount(1);
		await expect(page.locator('.suggestion-panel')).toBeVisible();
		for (const viewport of [{ width: 720, height: 844 }, { width: 390, height: 844 }]) {
			await page.setViewportSize(viewport);
			const status = page.locator('.suggestion-error');
			await expect(status).toBeVisible();
			const statusBox = await status.boundingBox();
			const panelBox = await page.locator('.suggestion-panel').boundingBox();
			const firstCandidateBox = await page.locator('.suggestion-primary').first().boundingBox();
			expect(statusBox && panelBox && firstCandidateBox).toBeTruthy();
			if (statusBox && panelBox && firstCandidateBox) {
				expect(statusBox.x).toBeGreaterThanOrEqual(panelBox.x);
				expect(statusBox.y).toBeGreaterThanOrEqual(panelBox.y);
				expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);
				expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(firstCandidateBox.y);
				for (const box of [statusBox, panelBox]) {
					expect(box.x).toBeGreaterThanOrEqual(0);
					expect(box.y).toBeGreaterThanOrEqual(0);
					expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
					expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
				}
			}
		}
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
			const sendBox = await send.boundingBox();
			const viewport = page.viewportSize();
			if (!sendBox || !viewport) throw new Error('Expected the Composer send control to have viewport geometry.');
			expect(sendBox.x).toBeGreaterThanOrEqual(0);
			expect(sendBox.y).toBeGreaterThanOrEqual(0);
			expect(sendBox.x + sendBox.width).toBeLessThanOrEqual(viewport.width);
			expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(viewport.height);
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
