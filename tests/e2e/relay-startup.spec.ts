import { expect, test, type Page } from '@playwright/test';
import { finalizeEvent } from 'nostr-tools/pure';
import { buildPositionEventTemplate, buildWorldMessageTemplate } from '../../src/lib/nostrProtocol';

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
  constructor() { super(); this.attachShadow({ mode: 'open' }); }
  configureHostOwned(options) { this.options = options; }
  whenReady() { return Promise.resolve(); }
  connectedCallback() {
    if (this.shadowRoot.childElementCount) return;
    window.__ehagakiAbortActiveSubmit = () => this.activeController?.abort();
    const textarea = document.createElement('textarea');
    textarea.setAttribute('aria-label', '投稿エディター');
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Send';
    button.addEventListener('click', async () => {
      const controller = new AbortController();
      if (window.__ehagakiAbortNextSubmit) { window.__ehagakiAbortNextSubmit = false; controller.abort(); }
      this.activeController = controller; window.__ehagakiSubmitStarted = true;
      try { await this.options.submit({ content: textarea.value, tags: [], context: null }, { signal: controller.signal }); textarea.value = ''; }
      catch { /* Host-owned contract: retain the failed content. */ }
      finally { this.activeController = null; }
    });
    this.shadowRoot.append(textarea, button);
  }
}
customElements.define('ehagaki-composer', EhagakiComposer);`
		});
	});
	return { requests: () => requests };
}

async function installDelayedRelay(page: Page): Promise<void> {
	const events = testEvents();
	await page.addInitScript(({ seedRelays, authoritativeRelays, channelEvent, primaryEvents }) => {
		type Listener = (event?: { type: string; data?: string; code?: number; reason?: string }) => void;
		type PendingRequest = { socket: FakeWebSocket; subId: string; filter: Record<string, unknown> };
		const seed = new Set<string>(seedRelays);
		const authoritative = new Set<string>(authoritativeRelays);
		const pendingMetadata: PendingRequest[] = [];
		const pendingPrimary: PendingRequest[] = [];
		const state = {
			requests: [] as Array<{ url: string; subId: string; filter: Record<string, unknown> }>,
			published: [] as Array<Record<string, unknown>>,
			metadataReleased: false,
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
		const respondPrimary = (request: PendingRequest) => {
			const kind = (request.filter.kinds as number[] | undefined)?.[0];
			if (kind === 42) deliver(request.socket, ['EVENT', request.subId, primaryEvents.message]);
			if (kind === 30078) deliver(request.socket, ['EVENT', request.subId, primaryEvents.position]);
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
				const request = { socket: this, subId: packet[1] as string, filter: packet[2] as Record<string, unknown> };
				const relayUrl = new URL(this.url).toString();
				state.requests.push({ url: relayUrl, subId: request.subId, filter: request.filter });
				if (seed.has(relayUrl)) {
					if (state.metadataReleased) respondMetadata(request);
					else pendingMetadata.push(request);
				} else if (authoritative.has(relayUrl)) {
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
				releasePrimary: () => {
					state.primaryReleased = true;
					pendingPrimary.splice(0).forEach((request) => deliver(request.socket, ['EOSE', request.subId]));
				},
				rejectMessagePublishes: () => { state.rejectMessagePublishes = true; },
				rejectPositionPublishes: () => { state.rejectPositionPublishes = true; },
				allowPositionPublishes: () => { state.rejectPositionPublishes = false; }
			}
		});
	}, {
		seedRelays: SEED_RELAYS,
		authoritativeRelays: AUTHORITATIVE_RELAYS,
		channelEvent: CHANNEL_EVENT,
		primaryEvents: events
	});
}

function relayState(page: Page) {
	return page.evaluate(() => (window as typeof window & {
		__relayStartupTest: { state: { requests: Array<{ url: string; filter: Record<string, unknown> }>; published: Array<{ id: string; kind: number }> }; releaseMetadata(): void; releasePrimary(): void; rejectMessagePublishes(): void; rejectPositionPublishes(): void; allowPositionPublishes(): void };
	}).__relayStartupTest);
}

test.describe('Relay startup', () => {
	test('decouples Composer from metadata and participant projection from final primary EOSE', async ({ page }) => {
		const hostOwned = await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await page.goto('/');

		await expect(page.locator('.composer-dock')).toBeVisible();
		await expect.poll(hostOwned.requests).toBeGreaterThan(0);
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await expect(editor).toBeVisible();
		await editor.fill('queued until Relay is ready');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();

		const beforeMetadata = await relayState(page);
		expect(beforeMetadata.state.requests.some((request) => AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) && [42, 30078].includes((request.filter.kinds as number[])[0]))).toBe(false);
		expect(beforeMetadata.state.published.filter((event) => event.kind === 42)).toHaveLength(0);

		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) && [42, 30078].includes((request.filter.kinds as number[])[0]))).toBe(true);
		await expect(page.locator('.participant[data-position="3,2"]')).toHaveCount(1);
		expect(await page.locator('.bubble')).toHaveCount(0);

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
		await expect(editor).toHaveValue('');
		await expect(page.locator('.participant[data-position="3,2"]')).toHaveCount(1);
		await expect(page.locator('.bubble')).toHaveCount(1);

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
		await expect(page.getByText('world live', { exact: true })).toBeVisible();
		expect(new Set((await relayState(page)).state.published.filter((event) => event.kind === 42).map((event) => event.id)).size).toBe(0);
		await expect(editor).toHaveValue('abort while waiting for metadata');
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
