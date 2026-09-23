/** Local production-preview benchmark. Run against `npm run preview -- --port 5180`. */
import { chromium } from '@playwright/test';
import { getPublicKey } from 'nostr-tools/pure';
import { fixtureSecret, installDelayedRelay, seedRelayAccount } from '../tests/e2e/helpers/relayHarness';
import { installHostOwnedStub } from '../tests/e2e/helpers/hostOwnedComposerStub';

type Marks = Record<string, number>;
const baseURL = process.env.BENCHMARK_URL ?? 'http://127.0.0.1:5180';
const repetitions = Number(process.env.BENCHMARK_REPETITIONS ?? 8);
const phase = process.env.BENCHMARK_PHASE ?? 'unspecified';

async function measure(page: import('@playwright/test').Page, metadataDelayMs: number): Promise<Marks> {
	await page.goto(`/?benchmarkMetadataDelay=${metadataDelayMs}`, { waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => Boolean((window as typeof window & { __startupMarks?: Marks }).__startupMarks?.visible), null, { timeout: 20_000 });
	const marks = await page.evaluate(() => (window as typeof window & { __startupMarks: Marks }).__startupMarks);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	return marks;
}

const browser = await chromium.launch();
const rows: Array<{ scenario: string; marks: Marks }> = [];
try {
	for (let iteration = 0; iteration < repetitions; iteration++) {
		const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
		const page = await context.newPage();
		await page.addInitScript({ content: 'window.__name = (fn) => fn;' });
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await page.addInitScript(() => {
			const marks: Marks = { navigation: 0 };
			Object.assign(window, { __startupMarks: marks });
			const mark = (name: string) => { if (!(name in marks)) marks[name] = performance.now(); };
			const relay = (window as typeof window & { __relayStartupTest: { state: { requests: unknown[] }; releaseMetadata(): void } }).__relayStartupTest;
			const requests = relay.state.requests;
			const pushRequest = requests.push;
			requests.push = function (...next) {
				const length = pushRequest.apply(this, next);
				if (length === 8) {
					const delayMs = Number(new URLSearchParams(location.search).get('benchmarkMetadataDelay') ?? 0);
					const release = () => { mark('metadataReleased'); relay.releaseMetadata(); };
					if (delayMs > 0) setTimeout(release, delayMs);
					else queueMicrotask(release);
				}
				return length;
			};
			const socket = (window as typeof window & { WebSocket: typeof WebSocket }).WebSocket;
			const send = socket.prototype.send;
			socket.prototype.send = function (data) {
				try {
					const packet = JSON.parse(String(data));
					if (packet[0] === 'REQ') {
						const kinds = (packet.slice(2) as Array<{ kinds?: number[] }>).flatMap((filter) => filter.kinds ?? []);
						if (kinds.includes(40) || kinds.includes(41)) mark('metadataReq');
						if (kinds.includes(42) || kinds.includes(30079)) mark('primaryReq');
					}
				} catch { /* Ignore non-REQ frames. */ }
				return send.call(this, data);
			};
			const addEventListener = socket.prototype.addEventListener;
			socket.prototype.addEventListener = function (type, listener, options) {
				if (type === 'message' && listener) {
					const wrapped = (event: Event) => {
						try {
							const packet = JSON.parse((event as MessageEvent).data);
							if (packet[0] === 'EVENT' && (packet[2]?.kind === 42 || packet[2]?.kind === 30079)) mark('firstEvidence');
						} catch { /* Ignore non-event frames. */ }
						if (typeof listener === 'function') listener.call(this, event);
						else listener.handleEvent(event);
					};
					return addEventListener.call(this, type, wrapped, options);
				}
				return addEventListener.call(this, type, listener, options);
			};
			const visible = (element: Element) => {
				const rect = element.getBoundingClientRect();
				const style = getComputedStyle(element);
				return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight && style.visibility !== 'hidden' && style.display !== 'none';
			};
			const frame = () => {
				const field = document.querySelector('.field-viewport.initial-field-geometry-ready');
				if (field) mark('geometry');
				const participant = document.querySelector('.participant');
				if (participant) mark('participantDom');
				if (field && participant && visible(participant) && visible(field)) {
					const image = participant.querySelector<HTMLImageElement>('[data-avatar-image]');
					const fallback = participant.querySelector('[data-avatar-fallback]');
					if ((image && image.complete && image.naturalWidth > 0 && visible(image)) || (fallback && visible(fallback))) mark('visible');
				}
				if (!marks.visible) requestAnimationFrame(frame);
			};
			requestAnimationFrame(frame);
		});
		const fresh = await measure(page, 0);
		rows.push({ scenario: 'fresh', marks: fresh });
		await page.getByRole('button', { name: /を選ぶ$/ }).first().waitFor({ state: 'visible' });
		const warm = await measure(page, 0);
		rows.push({ scenario: 'warm', marks: warm });
		await page.getByRole('button', { name: /を選ぶ$/ }).first().waitFor({ state: 'visible' });
		const slowMetadata = await measure(page, 500);
		rows.push({ scenario: 'slowMetadata', marks: slowMetadata });
		await context.close();
	}
} finally {
	await browser.close();
}

const summary = Object.fromEntries(['fresh', 'warm', 'slowMetadata'].map((scenario) => {
	const metrics = ['metadataReq', 'primaryReq', 'firstEvidence', 'geometry', 'participantDom', 'visible'];
	return [scenario, Object.fromEntries(metrics.map((metric) => {
		const values = rows.filter((row) => row.scenario === scenario).map((row) => row.marks[metric]).filter((value): value is number => Number.isFinite(value)).sort((a, b) => a - b);
		const median = (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2;
		return [metric, { median: Math.round(median), min: Math.round(values[0]), max: Math.round(values.at(-1)!) }];
	}))];
}));
console.log(JSON.stringify({ phase, repetitions, summary, rows }, null, 2));
