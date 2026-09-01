import { expect, test, type Locator, type Page } from '@playwright/test';
import { finalizeEvent } from 'nostr-tools/pure';
import { buildPositionEventTemplate, buildWorldMessageTemplate } from '../../src/lib/nostrProtocol';
import { SPEECH_SHORTCUT_IDS } from '../../src/lib/speechSubmission';

const CHANNEL_ID = '3212de4b75f0c41efa17e41affcfc3a811171ba930e5b657687b5f5148627d5b';
const SEED_RELAYS = [
	'wss://nos.lol/',
	'wss://x.kojira.io/',
	'wss://relay.nostr.wirednet.jp/',
	'wss://yabu.me/'
] as const;
const AUTHORITATIVE_RELAYS = [
	'wss://yabu.me/',
	'wss://relay-jp.nostr.wirednet.jp/',
	'wss://nos.lol/',
	'wss://relay.damus.io/',
	'wss://snowflare.cc/',
	'wss://r.kojira.io/'
] as const;

// A public, verified kind 40 whose immutable id is the configured prototype
// channel. Keeping it in the browser-local fake Relay avoids all network I/O.
const CHANNEL_EVENT = {
	content: '{"name":"name: persona-bubble-field prototype","about":"about:\\nPrototype public chat channel for a spatial character chat client built on Nostr.","picture":"","relays":["wss://yabu.me/","wss://relay-jp.nostr.wirednet.jp/","wss://nos.lol/","wss://relay.damus.io/","wss://snowflare.cc/","wss://r.kojira.io/"]}',
	created_at: 1787801905,
	id: CHANNEL_ID,
	kind: 40,
	pubkey: '89ae5e1f887b68ebc093b1e971164f59ee1e8d3bb02fd1fe168f77d7e4b2c10b',
	sig: '7d86e48506fc1b5796b38b131e39a2ef7654f223b8388e81dd22c2be8102e76ffa6cf1517d09290d3b0477f54cc42fc3d5e1cccf913b462eb1296dbdc12212db',
	tags: [['client', 'lumilumi', '31990:84b0c46ab699ac35eb2ca286470b85e081db2087cdef63932236c397417782f5:1727506446612', 'wss://cagliostr.compile-error.net']]
} as const;

const HOST_OWNED_ENTRY = 'https://lokuyow.github.io/ehagaki/web-component/host-owned/ehagaki-composer.js';

function profileDialog(page: Page) {
	return page.getByRole('dialog');
}

async function openProfile(page: Page): Promise<void> {
	const timeline = page.getByLabel('Recent message timeline');
	if (await timeline.isVisible()) await page.getByRole('button', { name: 'Hide recent messages' }).click();
	await page.locator('.participant[data-self="true"] .participant-profile-trigger').click();
	await expect(profileDialog(page)).toBeVisible();
}

function testEvents() {
	const secret = new Uint8Array(32).fill(19);
	const createdAt = Math.floor(Date.now() / 1000);
	const channel = { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' };
	return {
		message: finalizeEvent(buildWorldMessageTemplate({
			channel,
			content: 'bootstrap message',
			speechType: 'normal',
			position: { x: 3, y: 2 },
			createdAt
		}), secret),
		position: finalizeEvent(buildPositionEventTemplate({
			channel,
			position: { x: 3, y: 2 },
			slot: 0,
			createdAt
		}), secret)
	};
}

async function installHostOwnedStub(page: Page): Promise<{ requests: () => number }> {
	let requests = 0;
	await page.route(HOST_OWNED_ENTRY, async (route) => {
		requests += 1;
		await route.fulfill({
			contentType: 'application/javascript',
			body: `class EhagakiComposer extends HTMLElement {
  editorIsEmpty = null;
  editor = null;
  constructor() { super(); this.attachShadow({ mode: 'open' }); }
  configureHostOwned(options) { this.options = options; window.__ehagakiHostOwnedOptions = options; }
  whenReady() { return Promise.resolve(); }
  focusEditor() { this.editor?.focus(); }
  blurEditor() { this.editor?.blur(); }
  connectedCallback() {
    if (this.shadowRoot.childElementCount) return;
    window.__ehagakiAbortActiveSubmit = () => this.activeController?.abort();
    const textarea = document.createElement('textarea');
    textarea.setAttribute('contenteditable', 'true');
    textarea.setAttribute('aria-label', '投稿エディター');
    const updateEditorEmpty = () => {
      this.editorIsEmpty = textarea.value.length === 0;
      this.dispatchEvent(new CustomEvent('ehagaki-editor-empty-change', { bubbles: true, composed: true, detail: { isEmpty: this.editorIsEmpty } }));
    };
    textarea.addEventListener('input', updateEditorEmpty);
    textarea.addEventListener('keydown', (event) => {
      if (event.key.startsWith('Arrow')) window.__ehagakiEditorArrowPrevented = event.defaultPrevented;

      if ((event.key !== 'Enter' && event.code !== 'NumpadEnter') || event.isComposing || event.shiftKey) return;
      const shortcut = (this.options.submitShortcuts || []).find((candidate) => {
        if (candidate.modifiers.length !== 1) return false;
        if (candidate.modifiers[0] === 'ctrlOrMeta') return (event.ctrlKey !== event.metaKey) && !event.altKey;
        if (candidate.modifiers[0] === 'alt') return event.altKey && !event.ctrlKey && !event.metaKey;
        return false;
      });
      if (event.ctrlKey || event.metaKey || event.altKey) {
        if (!shortcut) return;
      }
      event.preventDefault();
      void submit(shortcut?.id);
    });
    const submit = async (shortcutId) => {
      const controller = new AbortController();
      if (window.__ehagakiAbortNextSubmit) { window.__ehagakiAbortNextSubmit = false; controller.abort(); }
      this.activeController = controller; window.__ehagakiSubmitStarted = true;
      try {
        await this.options.submit({ content: textarea.value, tags: [], context: null }, { signal: controller.signal, shortcutId });
        textarea.value = '';
        updateEditorEmpty();
      } catch { /* Host-owned contract: retain the failed content. */ }
      finally { this.activeController = null; }
    };
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Send';
    button.addEventListener('click', () => void submit());
    this.editor = textarea;
    this.shadowRoot.append(textarea, button);
    window.__ehagakiSetPreferredHeight = (height) => this.dispatchEvent(new CustomEvent('ehagaki-preferred-height-change', { bubbles: true, composed: true, detail: { height } }));
    if (window.__ehagakiDeferComposerEmptyState) {
      window.__ehagakiResolveComposerEmptyState = updateEditorEmpty;
    } else {
      updateEditorEmpty();
    }
  }
}
customElements.define('ehagaki-composer', EhagakiComposer);`
		});
	});
	return { requests: () => requests };
}

async function installVirtualKeyboardStub(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const listeners = new Set<(event: Event) => void>();
		let overlaysContent = false;
		let boundingRect = {
			left: 0,
			top: window.innerHeight,
			right: window.innerWidth,
			bottom: window.innerHeight,
			width: window.innerWidth,
			height: 0
		};
		Object.defineProperty(navigator, 'virtualKeyboard', {
			configurable: true,
			value: {
				get overlaysContent() { return overlaysContent; },
				set overlaysContent(value: boolean) {
					overlaysContent = value;
				},
				get boundingRect() { return boundingRect; },
				addEventListener(type: string, listener: (event: Event) => void) {
					if (type === 'geometrychange') listeners.add(listener);
				},
				removeEventListener(type: string, listener: (event: Event) => void) {
					if (type === 'geometrychange') listeners.delete(listener);
				}
			}
		});
		Object.assign(window, {
			__virtualKeyboardTest: {
				setBottomInset(inset: number) {
					boundingRect = {
						left: 0,
						top: window.innerHeight - inset,
						right: window.innerWidth,
						bottom: window.innerHeight,
						width: window.innerWidth,
						height: inset
					};
					for (const listener of listeners) listener(new Event('geometrychange'));
				},
				state: () => ({ overlaysContent })
			}
		});
	});
}

async function installDelayedRelay(page: Page, options: { deferPrimaryEvents?: boolean; historyMessages?: readonly object[] } = {}): Promise<void> {
	const events = testEvents();
	await page.addInitScript(({ seedRelays, authoritativeRelays, channelEvent, primaryEvents, historyMessages, deferPrimaryEvents }) => {
		type Listener = (event?: { type: string; data?: string; code?: number; reason?: string }) => void;
		type PendingRequest = { socket: FakeWebSocket; subId: string; filter: Record<string, unknown>; filters: Record<string, unknown>[] };
		const seed = new Set<string>(seedRelays);
		const authoritative = new Set<string>(authoritativeRelays);
		const pendingMetadata: PendingRequest[] = [];
		const pendingPrimary: PendingRequest[] = [];
		const activePrimary: PendingRequest[] = [];
		const timelineHistory = (historyMessages ?? []) as Array<Record<string, unknown>>;
		const state = {
			requests: [] as Array<{ url: string; subId: string; filter: Record<string, unknown>; filters: Record<string, unknown>[] }>,
			published: [] as Array<Record<string, unknown>>,
			metadataReleased: false,
			primaryEventsReleased: !deferPrimaryEvents,
			primaryReleased: false,
			rejectMessagePublishes: false,
			rejectPositionPublishes: false
		};
		const deliver = (socket: FakeWebSocket, packet: unknown[]) => socket.dispatch('message', { type: 'message', data: JSON.stringify(packet) });
		const respondMetadata = (request: PendingRequest) => {
			if ((request.filter.kinds as number[] | undefined)?.includes(40)) {
				deliver(request.socket, ['EVENT', request.subId, channelEvent]);
			}
			deliver(request.socket, ['EOSE', request.subId]);
		};
		const respondPrimaryEvent = (request: PendingRequest) => {
			if (request.filters.some((filter) => (filter.kinds as number[] | undefined)?.includes(42))) {
				deliver(request.socket, ['EVENT', request.subId, primaryEvents.message]);
			}
			if (request.filters.some((filter) => (filter.kinds as number[] | undefined)?.includes(30078))) {
				deliver(request.socket, ['EVENT', request.subId, primaryEvents.position]);
			}
			if (request.filters.some((filter) => filter.limit === 50)) {
				for (const event of timelineHistory) deliver(request.socket, ['EVENT', request.subId, event]);
			}
		};
		const respondPrimary = (request: PendingRequest) => {
			if (state.primaryEventsReleased) respondPrimaryEvent(request);
			if (state.primaryReleased) deliver(request.socket, ['EOSE', request.subId]);
		};

		class FakeWebSocket {
			static CONNECTING = 0;
			static OPEN = 1;
			static CLOSING = 2;
			static CLOSED = 3;
			readyState = FakeWebSocket.CONNECTING;
			listeners = new Map<string, Set<Listener>>();
			constructor(readonly url: string) {
				queueMicrotask(() => {
					this.readyState = FakeWebSocket.OPEN;
					this.dispatch('open', { type: 'open' });
				});
			}
			addEventListener(type: string, listener: Listener) {
				const listeners = this.listeners.get(type) ?? new Set<Listener>();
				listeners.add(listener);
				this.listeners.set(type, listeners);
			}
			removeEventListener(type: string, listener: Listener) { this.listeners.get(type)?.delete(listener); }
			dispatch(type: string, event: { type: string; data?: string; code?: number; reason?: string }) {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
			send(raw: string) {
				const packet = JSON.parse(raw) as unknown[];
				if (packet[0] === 'EVENT') {
					state.published.push(packet[1] as Record<string, unknown>);
					const event = packet[1] as { id: string; kind: number };
					const reject = event.kind === 42 && state.rejectMessagePublishes || event.kind === 30078 && state.rejectPositionPublishes;
					deliver(this, ['OK', event.id, !reject, '']);
					return;
				}
				if (packet[0] !== 'REQ') return;
				const filters = packet.slice(2) as Record<string, unknown>[];
				const request = { socket: this, subId: packet[1] as string, filter: filters[0] ?? {}, filters };
				const relayUrl = new URL(this.url).toString();
				state.requests.push({ url: relayUrl, subId: request.subId, filter: request.filter, filters });
				if (seed.has(relayUrl)) {
					if (state.metadataReleased) respondMetadata(request);
					else pendingMetadata.push(request);
				} else if (authoritative.has(relayUrl)) {
					activePrimary.push(request);
					respondPrimary(request);
					if (!state.primaryReleased) pendingPrimary.push(request);
				}
			}
			close(code = 1000) {
				this.readyState = FakeWebSocket.CLOSED;
				this.dispatch('close', { type: 'close', code, reason: '' });
			}
		}

		Object.defineProperty(window, 'WebSocket', { configurable: true, value: FakeWebSocket });
		window.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/nostr+json' } });
		Object.assign(window, {
			__relayStartupTest: {
				state,
				releaseMetadata: () => {
					state.metadataReleased = true;
					pendingMetadata.splice(0).forEach(respondMetadata);
				},
				releasePrimaryEvents: () => {
					state.primaryEventsReleased = true;
					pendingPrimary.forEach(respondPrimaryEvent);
				},
				releasePrimary: () => {
					state.primaryReleased = true;
					pendingPrimary.splice(0).forEach((request) => deliver(request.socket, ['EOSE', request.subId]));
				},
				rejectMessagePublishes: () => { state.rejectMessagePublishes = true; },
				rejectPositionPublishes: () => { state.rejectPositionPublishes = true; },
				allowPositionPublishes: () => { state.rejectPositionPublishes = false; },
				allowMessagePublishes: () => { state.rejectMessagePublishes = false; },
				injectPosition: (event: object) => {
					for (const request of activePrimary) {
						if (request.filters.some((filter) => (filter.kinds as number[] | undefined)?.includes(30078))) {
							deliver(request.socket, ['EVENT', request.subId, event]);
						}
					}
				},
				injectMessage: (event: object) => {
					for (const request of activePrimary) {
						if (request.filters.some((filter) => (filter.kinds as number[] | undefined)?.includes(42))) {
							deliver(request.socket, ['EVENT', request.subId, event]);
						}
					}
				}
			}
		});
	}, {
		seedRelays: SEED_RELAYS,
		authoritativeRelays: AUTHORITATIVE_RELAYS,
		channelEvent: CHANNEL_EVENT,
		primaryEvents: events,
		historyMessages: options.historyMessages ?? [],
		deferPrimaryEvents: options.deferPrimaryEvents ?? false
	});
}

function relayState(page: Page) {
	return page.evaluate(() => (window as typeof window & {
		__relayStartupTest: { state: { requests: Array<{ url: string; filter: Record<string, unknown>; filters: Record<string, unknown>[] }>; published: Array<{ id: string; kind: number; content: string; tags: string[][] }> }; releaseMetadata(): void; releasePrimaryEvents(): void; releasePrimary(): void; rejectMessagePublishes(): void; allowMessagePublishes(): void; rejectPositionPublishes(): void; allowPositionPublishes(): void; injectPosition(event: object): void; injectMessage(event: object): void };
	}).__relayStartupTest);
}

async function publishedMessages(page: Page) {
	return [...new Map(
		(await relayState(page)).state.published
			.filter((event) => event.kind === 42)
			.map((event) => [event.id, event])
	)].map(([, event]) => event);
}

async function waitForPublishedMessageCount(page: Page, count: number): Promise<void> {
	await expect.poll(async () => (await publishedMessages(page)).length).toBe(count);
}

async function openClockedReadyRelayWorld(page: Page): Promise<Locator> {
	await page.clock.install({ time: Date.now() });
	const editor = await openReadyRelayWorld(page);
	await page.clock.pauseAt(Date.now());
	return editor;
}

async function installVisualAnimationRafMetrics(page: Page): Promise<void> {
	await page.evaluate(() => {
		const clockRequestAnimationFrame = window.requestAnimationFrame.bind(window);
		const clockCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
		const pending = new Set<number>();
		let maxPending = 0;
		window.requestAnimationFrame = (callback) => {
			const id = clockRequestAnimationFrame((timestamp) => {
				pending.delete(id);
				callback(timestamp);
			});
			pending.add(id);
			maxPending = Math.max(maxPending, pending.size);
			return id;
		};
		window.cancelAnimationFrame = (id) => {
			pending.delete(id);
			clockCancelAnimationFrame(id);
		};
		Object.assign(window, {
			__visualAnimationRafMetrics: {
				pending: () => pending.size,
				maxPending: () => maxPending
			}
		});
	});
}

async function openReadyRelayWorld(page: Page): Promise<Locator> {
	await installHostOwnedStub(page);
	await installDelayedRelay(page);
	await page.goto('/');
	await expect(page.locator('.composer-dock')).toBeVisible();
	const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
	await expect(editor).toBeVisible();
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
	await expect.poll(async () => (await relayState(page)).state.requests.some((request) => AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) && [42, 30078].includes((request.filter.kinds as number[])[0]))).toBe(true);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	await expect(page.locator('.participant')).toHaveCount(2);
	return editor;
}

async function chooseHorizontalMove(page: Page): Promise<{ key: 'ArrowLeft' | 'ArrowRight'; expected: string }> {
	const position = await page.locator('.participant[data-self="true"]').getAttribute('data-position');
	if (!position) throw new Error('Expected the Relay self participant position.');
	const [x, y] = position.split(',').map(Number);
	if (await page.getByRole('button', { name: 'Move right' }).count() > 0) {
		return { key: 'ArrowRight', expected: `${x + 1},${y}` };
	}
	if (await page.getByRole('button', { name: 'Move left' }).count() > 0) {
		return { key: 'ArrowLeft', expected: `${x - 1},${y}` };
	}
	throw new Error('Expected an available horizontal move for the Relay self participant.');
}

type AvailableMove = {
	key: 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'ArrowUp';
	expected: string;
};

async function chooseMoveToward(page: Page, target: { x: number; y: number }): Promise<AvailableMove> {
	const position = await page.locator('.participant[data-self="true"]').getAttribute('data-position');
	if (!position) throw new Error('Expected the Relay self participant position.');
	const [x, y] = position.split(',').map(Number);
	const candidates: Array<AvailableMove & { name: string }> = [];
	if (x < target.x) candidates.push({ key: 'ArrowRight', expected: `${x + 1},${y}`, name: 'Move right' });
	if (x > target.x) candidates.push({ key: 'ArrowLeft', expected: `${x - 1},${y}`, name: 'Move left' });
	if (y < target.y) candidates.push({ key: 'ArrowDown', expected: `${x},${y + 1}`, name: 'Move down' });
	if (y > target.y) candidates.push({ key: 'ArrowUp', expected: `${x},${y - 1}`, name: 'Move up' });
	for (const candidate of candidates) {
		if (await page.getByRole('button', { name: candidate.name }).count() > 0) {
			return candidate;
		}
	}
	throw new Error('Expected an available move toward the Relay camera boundary.');
}

function reverseMoveKey(key: AvailableMove['key']): AvailableMove['key'] {
	switch (key) {
		case 'ArrowDown': return 'ArrowUp';
		case 'ArrowLeft': return 'ArrowRight';
		case 'ArrowRight': return 'ArrowLeft';
		case 'ArrowUp': return 'ArrowDown';
	}
}

test.describe('Relay startup', () => {
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

	test('resolves long and short slash commands before publishing', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const send = page.locator('ehagaki-composer').getByRole('button', { name: 'Send' });
		for (const [command, content, label] of [
			['/shout hello', 'hello', 'speech:shout'],
			['/s short hello', 'short hello', 'speech:shout'],
			['/mono monologue hello', 'monologue hello', 'speech:monologue'],
			['/m short monologue', 'short monologue', 'speech:monologue']
		] as const) {
			const before = (await publishedMessages(page)).length;
			await editor.fill(command);
			await send.click();
			await waitForPublishedMessageCount(page, before + 1);
			const event = (await publishedMessages(page))[before];
			expect(event.content).toBe(content);
			expect(event.tags).toContainEqual(['l', label, 'io.github.lokuyow.persona-bubble-field']);
		}
	});

	test('gives keyboard shortcuts precedence while still removing recognized slash prefixes', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const before = (await publishedMessages(page)).length;

		await editor.fill('/m hello');
		await editor.press('Control+Enter');
		await waitForPublishedMessageCount(page, before + 1);
		let event = (await publishedMessages(page))[before];
		expect(event.content).toBe('hello');
		expect(event.tags).toContainEqual(['l', 'speech:shout', 'io.github.lokuyow.persona-bubble-field']);

		await editor.fill('/s hello');
		await editor.press('Alt+Enter');
		await waitForPublishedMessageCount(page, before + 2);
		event = (await publishedMessages(page))[before + 1];
		expect(event.content).toBe('hello');
		expect(event.tags).toContainEqual(['l', 'speech:monologue', 'io.github.lokuyow.persona-bubble-field']);
	});

	test('does not publish Ctrl+Meta+Enter as a ctrlOrMeta speech shortcut', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const before = (await publishedMessages(page)).length;

		await editor.fill('both modifiers');
		await editor.press('Control+Meta+Enter');
		await expect.poll(async () => (await publishedMessages(page)).length).toBe(before);
		await expect(editor).toHaveValue('both modifiers');
	});

	test('keeps command-only content and false-positive slash text instead of publishing an empty command', async ({ page }) => {
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
	});

	test('cycles the one-shot speech selector and only resets it after a successful submit', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const send = page.locator('ehagaki-composer').getByRole('button', { name: 'Send' });
		const selector = page.locator('.speech-type-toggle');

		await expect(selector).toHaveAttribute('data-speech-type', 'normal');
		await selector.click();
		await expect(selector).toHaveAttribute('data-speech-type', 'shout');
		await selector.click();
		await expect(selector).toHaveAttribute('data-speech-type', 'monologue');
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

	test('renders DEV sandbox without Composer in the initial response or after hydration', async ({ page }) => {
		const hostOwned = await installHostOwnedStub(page);
		const consoleIssues: string[] = [];
		page.on('console', (message) => {
			if (message.type() === 'warning' || message.type() === 'error') consoleIssues.push(message.text());
		});
		page.on('pageerror', (error) => consoleIssues.push(error.message));

		const response = await page.goto('/?devWorld=1');
		expect(response).not.toBeNull();
		expect(await response!.text()).not.toContain('<div class="composer-dock');

		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await expect(page.locator('.participant')).toHaveCount(1);
		await expect(page.locator('.composer-dock')).toHaveCount(0);
		await expect(page.locator('ehagaki-composer')).toHaveCount(0);
		expect(hostOwned.requests()).toBe(0);
		expect(consoleIssues).toEqual([]);
	});

	test('keeps history-only messages in the timeline without restoring their presence or bubbles', async ({ page }) => {
		const historySecret = new Uint8Array(32).fill(20);
		const createdAt = Math.floor(Date.now() / 1000) - 3_600;
		const historyMessage = finalizeEvent(buildWorldMessageTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' },
			content: 'history-only message',
			speechType: 'monologue',
			position: { x: 1, y: 1 },
			createdAt
		}), historySecret);
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { historyMessages: [historyMessage] });
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === 42 &&
			request.filters.length === 2 &&
			request.filters.some((filter) => typeof filter.since === 'number') &&
			request.filters.some((filter) => filter.limit === 50 && filter.since === undefined)
		)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());

		await expect(page.locator(`[data-timeline-event-id="${historyMessage.id}"]`)).toHaveCount(1);
		await expect(page.locator(`[data-participant-id="${historyMessage.pubkey}"]`)).toHaveCount(0);
		await expect(page.locator(`[data-bubble-id="${historyMessage.id}"]`)).toHaveCount(0);
	});

	test('continues timeline ingestion while its overlay is hidden', async ({ page }) => {
		await page.setViewportSize({ width: 1200, height: 500 });
		const liveSecret = new Uint8Array(32).fill(21);
		const liveMessage = finalizeEvent(buildWorldMessageTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' },
			content: 'arrived while hidden',
			speechType: 'normal',
			position: { x: 3, y: 3 },
			createdAt: Math.floor(Date.now() / 1000)
		}), liveSecret);
		const historyMessages = Array.from({ length: 9 }, (_, index) => finalizeEvent(buildWorldMessageTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' },
			content: `history ${index + 1}`,
			speechType: 'normal',
			position: { x: 3, y: 3 },
			createdAt: Math.floor(Date.now() / 1000) - 3_600 - index
		}), new Uint8Array(32).fill(30 + index)));
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { historyMessages });
		await page.goto('/');
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === 42
		)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('.participant')).toHaveCount(2);
		await expect(page.getByLabel('Recent message timeline')).toBeVisible();
		const visibleTimeline = page.locator('.timeline-visible-entries .timeline-entry');
		const beforeHiddenIds = await visibleTimeline.evaluateAll((entries) => entries.map((entry) => entry.getAttribute('data-timeline-event-id')));
		await page.getByRole('button', { name: 'Hide recent messages' }).click();
		await expect(page.getByLabel('Recent message timeline')).toBeHidden();
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectMessage(event: object): void } }).__relayStartupTest.injectMessage(event), liveMessage);
		await page.getByRole('button', { name: 'Show recent messages' }).click();
		await expect(page.locator(`[data-timeline-event-id="${liveMessage.id}"]`)).toHaveCount(1);
		const afterShownIds = await visibleTimeline.evaluateAll((entries) => entries.map((entry) => entry.getAttribute('data-timeline-event-id')));
		expect(afterShownIds.some((id) => !beforeHiddenIds.includes(id))).toBe(true);
	});

	for (const viewport of [
		{ name: 'desktop', width: 1200, height: 900 },
		{ name: 'mobile', width: 390, height: 844 }
	]) {
		test(`reserves the one-line Composer from the initial render on ${viewport.name}`, async ({ page }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height });
			await installHostOwnedStub(page);
			await installDelayedRelay(page);

			const response = await page.goto('/', { waitUntil: 'commit' });
			expect(response).not.toBeNull();
			expect(await response!.text()).toContain('composer-dock');

			await expect(page.locator('.composer-dock')).toBeVisible();
			await expect(page.locator('ehagaki-composer')).toBeVisible();
			const beforePreferredHeight = await page.evaluate(() => {
				const shell = document.querySelector<HTMLElement>('.app-shell')!;
				const dock = document.querySelector<HTMLElement>('.composer-dock')!;
				const field = document.querySelector<HTMLElement>('.field-viewport')!;
				return {
					dockHeight: dock.getBoundingClientRect().height,
					fieldHeight: field.getBoundingClientRect().height,
					viewportHeight: window.innerHeight,
					initialPreferredHeight: getComputedStyle(shell)
						.getPropertyValue('--composer-initial-preferred-height').trim(),
					preferredHeight: getComputedStyle(shell).getPropertyValue('--composer-preferred-height').trim()
				};
			});
			expect(beforePreferredHeight.initialPreferredHeight).toBe('50px');
			expect(beforePreferredHeight.preferredHeight).toBe('50px');
			expect(beforePreferredHeight.dockHeight).toBeCloseTo(67, 1);
			expect(beforePreferredHeight.fieldHeight + beforePreferredHeight.dockHeight)
				.toBeCloseTo(beforePreferredHeight.viewportHeight, 1);

			await page.evaluate(() => (window as typeof window & {
				__ehagakiSetPreferredHeight(height: number): void;
			}).__ehagakiSetPreferredHeight(50));
			await expect.poll(() => page.evaluate(() => document.querySelector<HTMLElement>('.composer-dock')!.getBoundingClientRect().height))
				.toBeCloseTo(beforePreferredHeight.dockHeight, 1);

			const afterPreferredHeight = await page.evaluate(() => ({
				dockHeight: document.querySelector<HTMLElement>('.composer-dock')!.getBoundingClientRect().height,
				fieldHeight: document.querySelector<HTMLElement>('.field-viewport')!.getBoundingClientRect().height
			}));
			expect(Math.abs(afterPreferredHeight.dockHeight - beforePreferredHeight.dockHeight)).toBeLessThan(0.5);
			expect(Math.abs(afterPreferredHeight.fieldHeight - beforePreferredHeight.fieldHeight)).toBeLessThan(0.5);
		});
	}

	test('keeps Field geometry reserved while only the fixed Composer follows VirtualKeyboard geometry', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await installVirtualKeyboardStub(page);
		await openReadyRelayWorld(page);
		await expect.poll(() => page.evaluate(() => (window as typeof window & {
			__virtualKeyboardTest: { state(): { overlaysContent: boolean } };
		}).__virtualKeyboardTest.state().overlaysContent)).toBe(true);

		const before = await page.evaluate(() => {
			const dock = document.querySelector<HTMLElement>('.composer-dock')!;
			const field = document.querySelector<HTMLElement>('.field-viewport')!;
			const self = document.querySelector<HTMLElement>('.participant[data-self="true"]')!;
			return {
				dock: dock.getBoundingClientRect().toJSON(),
				field: field.getBoundingClientRect().toJSON(),
				participant: self.getBoundingClientRect().toJSON(),
				cameraTransform: getComputedStyle(document.querySelector<HTMLElement>('.field-scene')!).transform,
				position: getComputedStyle(dock).position,
				viewportHeight: window.innerHeight
			};
		});
		expect(before.position).toBe('fixed');
		expect(before.dock.bottom).toBeCloseTo(before.viewportHeight, 1);
		expect(before.field.height + before.dock.height).toBeCloseTo(before.viewportHeight, 1);

		await page.evaluate(() => (window as typeof window & {
			__virtualKeyboardTest: { setBottomInset(inset: number): void };
		}).__virtualKeyboardTest.setBottomInset(300));
		await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.app-shell')!)
			.getPropertyValue('--composer-keyboard-inset').trim())).toBe('300px');

		const keyboardOpen = await page.evaluate(() => {
			const dock = document.querySelector<HTMLElement>('.composer-dock')!;
			const field = document.querySelector<HTMLElement>('.field-viewport')!;
			const self = document.querySelector<HTMLElement>('.participant[data-self="true"]')!;
			return {
				dock: dock.getBoundingClientRect().toJSON(),
				field: field.getBoundingClientRect().toJSON(),
				participant: self.getBoundingClientRect().toJSON(),
				cameraTransform: getComputedStyle(document.querySelector<HTMLElement>('.field-scene')!).transform
			};
		});
		expect(keyboardOpen.dock.bottom).toBeCloseTo(544, 1);
		expect(keyboardOpen.field.height).toBeCloseTo(before.field.height, 1);
		expect(keyboardOpen.participant).toEqual(before.participant);
		expect(keyboardOpen.cameraTransform).toBe(before.cameraTransform);

		await page.evaluate(() => (window as typeof window & {
			__virtualKeyboardTest: { setBottomInset(inset: number): void };
		}).__virtualKeyboardTest.setBottomInset(0));
		await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.app-shell')!)
			.getPropertyValue('--composer-keyboard-inset').trim())).toBe('0px');
		await expect(page.locator('.composer-dock')).toHaveCSS('bottom', '0px');

	});

	test('keeps the Field reservation synchronized with Host-owned preferred height', async ({ page }) => {
		await openReadyRelayWorld(page);
		const before = await page.evaluate(() => ({
			dock: document.querySelector('.composer-dock')!.getBoundingClientRect().toJSON(),
			field: document.querySelector('.field-viewport')!.getBoundingClientRect().toJSON(),
			viewportHeight: window.innerHeight
		}));
		await page.evaluate(() => (window as typeof window & {
			__ehagakiSetPreferredHeight(height: number): void;
		}).__ehagakiSetPreferredHeight(200));
		await expect.poll(() => page.evaluate(() => document.querySelector('.composer-dock')!.getBoundingClientRect().height)).toBeGreaterThan(before.dock.height);
		const after = await page.evaluate(() => ({
			dock: document.querySelector('.composer-dock')!.getBoundingClientRect().toJSON(),
			field: document.querySelector('.field-viewport')!.getBoundingClientRect().toJSON(),
			viewportHeight: window.innerHeight
		}));
		expect(after.field.height).toBeLessThan(before.field.height);
		expect(after.field.height + after.dock.height).toBeCloseTo(after.viewportHeight, 1);
	});

	test('decouples Composer from metadata and participant projection from final primary EOSE', async ({ page }) => {
		const hostOwned = await installHostOwnedStub(page);
		await installDelayedRelay(page, { deferPrimaryEvents: true });
		await page.goto('/');

		await expect(page.locator('.composer-dock')).toBeVisible();
		await expect.poll(hostOwned.requests).toBeGreaterThan(0);
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await expect(editor).toBeVisible();
		await editor.fill('queued until Relay is ready');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect(page.locator('.speech-type-toggle')).toBeDisabled();

		const beforeMetadata = await relayState(page);
		expect(beforeMetadata.state.requests.some((request) => AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) && [42, 30078].includes((request.filter.kinds as number[])[0]))).toBe(false);
		expect(beforeMetadata.state.published.filter((event) => event.kind === 42)).toHaveLength(0);

		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => {
			const requests = (await relayState(page)).state.requests;
			return [42, 30078].every((kind) => requests.some((request) =>
				AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
				(request.filter.kinds as number[])[0] === kind
			));
		}).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimaryEvents(): void } }).__relayStartupTest.releasePrimaryEvents());
		await expect(page.locator('.participant[data-position="3,2"]')).toHaveCount(1);
		await expect(page.locator('.bubble')).toHaveCount(0);

		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { rejectPositionPublishes(): void } }).__relayStartupTest.rejectPositionPublishes());
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.getByRole('button', { name: 'Enter field again' })).toBeVisible();
		await expect(editor).toHaveValue('queued until Relay is ready');
		await editor.fill('reject while entry is retryable');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect(editor).toHaveValue('reject while entry is retryable');
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { allowPositionPublishes(): void } }).__relayStartupTest.allowPositionPublishes());
		await page.getByRole('button', { name: 'Enter field again' }).click();
		await editor.fill('publish after entry recovery');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect.poll(async () => new Set((await relayState(page)).state.published
			.filter((event) => event.kind === 42)
			.map((event) => event.id)).size).toBe(1);
		const [publishedMessageId] = new Set((await relayState(page)).state.published
			.filter((event) => event.kind === 42)
			.map((event) => event.id));
		await expect(editor).toHaveValue('');
		await expect(page.locator('.participant[data-position="3,2"]')).toHaveCount(1);
		await expect(page.locator(`.bubble[data-bubble-id="${publishedMessageId}"]`)).toHaveCount(1);

		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { rejectMessagePublishes(): void } }).__relayStartupTest.rejectMessagePublishes());
		await editor.fill('retain after Relay rejection');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect(editor).toHaveValue('retain after Relay rejection');
		await page.evaluate(() => { (window as typeof window & { __ehagakiAbortNextSubmit?: boolean }).__ehagakiAbortNextSubmit = true; });
		await editor.fill('retain after abort');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect(editor).toHaveValue('retain after abort');
	});

	test('aborting a metadata-waiting submit releases it without publishing later', async ({ page }) => {
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await editor.fill('abort while waiting for metadata');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __ehagakiSubmitStarted?: boolean }).__ehagakiSubmitStarted))).toBe(true);
		await page.evaluate(() => (window as typeof window & { __ehagakiAbortActiveSubmit(): void }).__ehagakiAbortActiveSubmit());
		await expect(editor).toHaveValue('abort while waiting for metadata');

		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) && [42, 30078].includes((request.filter.kinds as number[])[0]))).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	await expect(page.locator('.participant')).toHaveCount(2);
		expect(new Set((await relayState(page)).state.published.filter((event) => event.kind === 42).map((event) => event.id)).size).toBe(0);
		await expect(editor).toHaveValue('abort while waiting for metadata');
	});

	test('uses an empty Host-owned Composer editor Arrow for one movement and prevents its default', async ({ page }) => {
		const editor = await openClockedReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const move = await chooseHorizontalMove(page);
		await page.evaluate(() => {
			(window as typeof window & { __keyboardDefaulted?: boolean }).__keyboardDefaulted = false;
			window.addEventListener('keydown', (event) => {
				if (event.key.startsWith('Arrow')) (window as typeof window & { __keyboardDefaulted?: boolean }).__keyboardDefaulted = event.defaultPrevented;
			});
		});
		await editor.focus();
		await page.keyboard.press(move.key);
		await expect(self).toHaveAttribute('data-position', move.expected);
		await expect(self).toHaveAttribute('data-movement-animation', 'active');
		await page.clock.runFor(16);
		await expect(self).toHaveAttribute('data-movement-animation', 'active');
		await page.clock.runFor(1_000);
		await expect(self).not.toHaveAttribute('data-movement-animation', 'active');
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __keyboardDefaulted?: boolean }).__keyboardDefaulted)).toBe(true);
	});

	test('does not move or prevent Arrow default from another Composer control', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const before = await self.getAttribute('data-position');
		await page.evaluate(() => {
			(window as typeof window & { __keyboardDefaulted?: boolean }).__keyboardDefaulted = false;
			window.addEventListener('keydown', (event) => {
				if (event.key.startsWith('Arrow')) (window as typeof window & { __keyboardDefaulted?: boolean }).__keyboardDefaulted = event.defaultPrevented;
			});
		});
		const send = page.locator('ehagaki-composer').getByRole('button', { name: 'Send' });
		await send.focus();
		await page.keyboard.press('ArrowRight');
		await expect(self).toHaveAttribute('data-position', before ?? '');
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __keyboardDefaulted?: boolean }).__keyboardDefaulted)).toBe(false);
	});

	test('preserves Composer editing Arrow behavior while non-empty and re-enables movement after deletion', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const before = await self.getAttribute('data-position');
		await editor.fill('x');
		await editor.focus();
		await page.keyboard.press('ArrowLeft');
		await expect(self).toHaveAttribute('data-position', before ?? '');
		await expect.poll(() => editor.evaluate((element) => ({
			value: (element as HTMLTextAreaElement).value,
			selectionStart: (element as HTMLTextAreaElement).selectionStart
		}))).toEqual({ value: 'x', selectionStart: 0 });

		await editor.fill('');
		const move = await chooseHorizontalMove(page);
		await editor.focus();
		await page.keyboard.press(move.key);
		await expect(self).toHaveAttribute('data-position', move.expected);
	});

	test('fails closed for Composer empty-state null and preserves modifier Arrow behavior', async ({ page }) => {
		await page.addInitScript(() => {
			(window as typeof window & { __ehagakiDeferComposerEmptyState?: boolean }).__ehagakiDeferComposerEmptyState = true;
		});
		const editor = await openReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const before = await self.getAttribute('data-position');
		const move = await chooseHorizontalMove(page);
		await editor.focus();
		await page.keyboard.press(move.key);
		await expect(self).toHaveAttribute('data-position', before ?? '');

		await page.evaluate(() => (window as typeof window & { __ehagakiResolveComposerEmptyState?: () => void }).__ehagakiResolveComposerEmptyState?.());
		await page.keyboard.press('Shift+' + move.key);
		await page.keyboard.press('Control+' + move.key);
		await page.keyboard.press('Alt+' + move.key);
		await page.keyboard.press('Meta+' + move.key);
		await expect(self).toHaveAttribute('data-position', before ?? '');

		await editor.fill('');
		await page.keyboard.press(move.key);
		await expect(self).toHaveAttribute('data-position', move.expected);
	});

	test('continues Composer-empty movement on a hold at the Relay movement cadence', async ({ page }) => {
		const editor = await openClockedReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const position = await self.getAttribute('data-position');
		if (!position) throw new Error('Expected the Relay self participant position.');
		const [x] = position.split(',').map(Number);
		const move = await chooseHorizontalMove(page);
		const key = move.key;
		await editor.focus();
		await page.keyboard.down(key);
		await expect(self).not.toHaveAttribute('data-position', position);
		await page.clock.runFor(750);
		await page.clock.runFor(750);
		await page.keyboard.up(key);
		const finalPosition = await self.getAttribute('data-position');
		const [finalX] = (finalPosition ?? '').split(',').map(Number);
		expect(Math.abs(finalX - x)).toBeGreaterThanOrEqual(1);
		await page.clock.runFor(1_000);
		await expect(self).toHaveAttribute('data-position', finalPosition ?? '');
	});

	test('focuses the Composer with N and blurs it with Escape before WASD movement', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const move = await chooseHorizontalMove(page);

		await page.locator('.participant').first().focus();
		await page.keyboard.press('n');
		await expect(editor).toBeFocused();

		await editor.fill('keep this content');
		await page.keyboard.press('Escape');
		await expect(editor).not.toBeFocused();
		await expect(editor).toHaveValue('keep this content');
		await page.keyboard.press(move.key === 'ArrowRight' ? 'd' : 'a');
		await expect(self).toHaveAttribute('data-position', move.expected);
	});

	test('keeps WASD and N as normal Composer input while the editor is focused', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const before = await self.getAttribute('data-position');

		await editor.fill('');
		await editor.focus();
		for (const key of ['w', 'a', 's', 'd', 'n']) await page.keyboard.press(key);
		await expect(self).toHaveAttribute('data-position', before ?? '');
		await expect(editor).toHaveValue('wasdn');
	});

	test('does not intercept Composer shortcuts while a profile dialog is open', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const before = await self.getAttribute('data-position');

		await openProfile(page);
		await page.keyboard.press('d');
		await page.keyboard.press('n');
		await expect(self).toHaveAttribute('data-position', before ?? '');
		await expect(editor).not.toBeFocused();
		await expect(profileDialog(page)).toBeVisible();
	});

	test('does not intercept WASD or N during composition or with modifiers in the Composer', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const before = await self.getAttribute('data-position');

		await page.locator('.participant').first().focus();
		await page.keyboard.press('Shift+d');
		await page.keyboard.press('Control+n');
		await page.keyboard.press('Alt+w');
		await page.keyboard.press('Meta+a');
		await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'd', code: 'KeyD', isComposing: true, bubbles: true
		})));
		await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'n', code: 'KeyN', isComposing: true, bubbles: true
		})));
		await expect(self).toHaveAttribute('data-position', before ?? '');
		await expect(editor).not.toBeFocused();

		await editor.fill('composition content');
		await editor.focus();
		await editor.evaluate((element) => element.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'Escape', code: 'Escape', isComposing: true, bubbles: true, composed: true
		})));
		await expect(editor).toBeFocused();
		await expect(editor).toHaveValue('composition content');
	});

	test('retargets active participant and camera animation when another participant updates', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.clock.install({ time: Date.now() });
		const editor = await openReadyRelayWorld(page);
		await page.clock.pauseAt(Date.now());
		await installVisualAnimationRafMetrics(page);
		const self = page.locator('.participant[data-self="true"]');
		const scene = page.locator('.field-scene');
		const remotePosition = finalizeEvent(buildPositionEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' },
			position: { x: 4, y: 2 },
			slot: 0,
			createdAt: Math.floor(Date.now() / 1000) + 1
		}), new Uint8Array(32).fill(19));

		const initialPosition = await self.getAttribute('data-position');
		if (!initialPosition) throw new Error('Expected the Relay self participant position.');
		const [initialX, initialY] = initialPosition.split(',').map(Number);
		const cameraBoundary = { x: initialX < 8 ? 15 : 0, y: initialY < 4 ? 7 : 0 };
		let move = await chooseMoveToward(page, cameraBoundary);
		let retargetMove: AvailableMove | null = null;
		for (let attempt = 0; attempt < 16; attempt += 1) {
			const transformBeforeMove = await scene.evaluate((element) => getComputedStyle(element).transform);
			const positionBeforeMove = await self.getAttribute('data-position');
			if (!positionBeforeMove) throw new Error('Expected the Relay self participant position.');
			await editor.focus();
			await page.keyboard.press(move.key);
			await expect(self).toHaveAttribute('data-position', move.expected);
			await expect(self).toHaveAttribute('data-movement-animation', 'active');
			await page.clock.runFor(2_000);
			const transformAfterMove = await scene.evaluate((element) => getComputedStyle(element).transform);
			if (transformAfterMove !== transformBeforeMove) {
				retargetMove = {
					key: reverseMoveKey(move.key),
					expected: positionBeforeMove
				};
				break;
			}
			await expect(self).not.toHaveAttribute('data-movement-animation', 'active');
			move = await chooseMoveToward(page, cameraBoundary);
		}
		expect(retargetMove).not.toBeNull();

		const transformBeforeRetarget = await scene.evaluate((element) => getComputedStyle(element).transform);
		await editor.focus();
		await page.keyboard.press(retargetMove!.key);
		await expect(self).toHaveAttribute('data-position', retargetMove!.expected);
		await expect(self).toHaveAttribute('data-movement-animation', 'active');
		await page.evaluate((event) => {
			(window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event);
		}, remotePosition);
		await page.clock.runFor(100);
		await expect(self).toHaveAttribute('data-movement-animation', 'active');
		await expect(scene).toHaveAttribute('data-camera-animation', 'active');
		expect(await page.evaluate(() => (window as typeof window & { __visualAnimationRafMetrics: { maxPending(): number } }).__visualAnimationRafMetrics.maxPending())).toBeLessThanOrEqual(1);
		const transformDuringRetarget = await scene.evaluate((element) => getComputedStyle(element).transform);

		await page.clock.runFor(1_000);
		await expect(self).not.toHaveAttribute('data-movement-animation', 'active');
		await expect(scene).not.toHaveAttribute('data-camera-animation', 'active');
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __visualAnimationRafMetrics: { pending(): number } }).__visualAnimationRafMetrics.pending())).toBe(0);
		const transformAtRest = await scene.evaluate((element) => getComputedStyle(element).transform);
		expect(transformBeforeRetarget).not.toBe(transformAtRest);
		expect(transformDuringRetarget).not.toBe(transformAtRest);
		await expect(self).toHaveAttribute('data-position', retargetMove!.expected);
		await expect(page.locator(`.participant[data-participant-id="${remotePosition.pubkey}"]`)).toHaveAttribute('data-position', '4,2');
	});

	test('never mounts or loads the Host-owned Composer in DEV World', async ({ page }) => {
		const hostOwned = await installHostOwnedStub(page);
		await page.goto('/?devWorld=1');

		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await expect(page.locator('.composer-dock')).toHaveCount(0);
		await expect(page.locator('ehagaki-composer')).toHaveCount(0);
		expect(hostOwned.requests()).toBe(0);
	});
});
