/**
 * Run `npm run build`, then `npm run preview -- --host 127.0.0.1 --port 5180`.
 * T_visible is the first rAF observing a viewport-visible participant and field,
 * with either a loaded Avatar image or a visible Avatar fallback. This is a
 * repeatable proxy for visibility, not a direct measurement of painted pixels.
 * Percentiles are navigation-relative and are never a CI wall-clock gate.
 */
import { chromium, type Page } from '@playwright/test';
import { getPublicKey } from 'nostr-tools/pure';
import { fixtureSecret, installDelayedRelay, seedRelayAccount } from '../tests/e2e/helpers/relayHarness';
import { installHostOwnedStub } from '../tests/e2e/helpers/hostOwnedComposerStub';

type Marks = Record<string, number>;
type Condition = 'fast' | 'slowPrimary';
type Row = { scenario: string; condition: Condition; marks: Marks };
const baseURL = process.env.BENCHMARK_URL ?? 'http://127.0.0.1:5180';
const repetitions = Number(process.env.BENCHMARK_REPETITIONS ?? 20);
const phase = process.env.BENCHMARK_PHASE ?? 'unspecified';
const conditions: readonly Condition[] = ['fast', 'slowPrimary'];
const scenarios = ['savedActiveCold', 'savedActiveWarmReload'] as const;
const metrics = ['navigation', 'primaryReq', 'firstEvidence', 'geometry', 'participantDom', 'visible', 'selfReady'] as const;
if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error('BENCHMARK_REPETITIONS must be a positive integer.');

async function installMarks(page: Page): Promise<void> {
	await page.addInitScript(() => {
		type RelayTest = { releasePrimaryEvents(): void };
		const marks: Marks = { navigation: performance.now() };
		Object.assign(window, { __startupMarks: marks });
		const mark = (name: string) => { if (!(name in marks)) marks[name] = performance.now(); };
		const relay = (window as typeof window & { __relayStartupTest: RelayTest }).__relayStartupTest;
		const socket = (window as typeof window & { WebSocket: typeof WebSocket }).WebSocket;
		const send = socket.prototype.send;
		let primaryReleaseScheduled = false;
		socket.prototype.send = function (data) {
			let primaryRequest = false;
			try {
				const packet = JSON.parse(String(data));
				if (packet[0] === 'REQ') {
					const kinds = (packet.slice(2) as Array<{ kinds?: number[] }>).flatMap((filter) => filter.kinds ?? []);
					if (kinds.includes(42) || kinds.includes(30079)) {
						mark('primaryReq');
						primaryRequest = true;
					}
					if (kinds.includes(40) || kinds.includes(41)) mark('metadataReq');
				}
			} catch { /* Ignore non-REQ frames. */ }
			const result = send.call(this, data);
			if (primaryRequest && !primaryReleaseScheduled) {
				const delayMs = Number(new URLSearchParams(location.search).get('benchmarkPrimaryDelay') ?? 0);
				if (delayMs > 0) {
					primaryReleaseScheduled = true;
					setTimeout(() => { mark('primaryEventsReleased'); relay.releasePrimaryEvents(); }, delayMs);
				}
			}
			return result;
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
				const fallback = participant.querySelector<HTMLElement>('[data-avatar-fallback]');
				const imageReady = Boolean(image && image.complete && image.naturalWidth > 0 && visible(image));
				if (imageReady || (fallback && visible(fallback))) mark('visible');
			}
			if (!marks.visible) requestAnimationFrame(frame);
		};
		requestAnimationFrame(frame);
	});
}

async function measure(page: Page, condition: Condition, reload: boolean, selfPubkey: string): Promise<Marks> {
	const delayQuery = condition === 'slowPrimary' ? '?benchmarkPrimaryDelay=500' : '';
	if (reload) await page.reload({ waitUntil: 'domcontentloaded' });
	else await page.goto(`/${delayQuery}`, { waitUntil: 'domcontentloaded' });
	try {
		await page.waitForFunction(() => Boolean((window as typeof window & { __startupMarks?: Marks }).__startupMarks?.visible), null, { timeout: 20_000 });
	} catch (error) {
		const state = await page.evaluate(() => ({
			url: location.href,
			marks: (window as typeof window & { __startupMarks?: Marks }).__startupMarks,
			requests: (window as typeof window & { __relayStartupTest?: { state: { requests: unknown[] } } }).__relayStartupTest?.state.requests.length,
			participants: document.querySelectorAll('.participant').length,
			fieldReady: Boolean(document.querySelector('.field-viewport.initial-field-geometry-ready'))
		}));
		throw new Error(`Missing T_visible for ${condition} (${reload ? 'warm reload' : 'cold'}): ${JSON.stringify(state)}`, { cause: error });
	}
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	await page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`).waitFor({ state: 'visible', timeout: 20_000 });
	const marks = await page.evaluate(() => {
		const result = (window as typeof window & { __startupMarks: Marks }).__startupMarks;
		result.selfReady = performance.now();
		return { ...result };
	});
	if (Number.isFinite(marks.metadataReq)) throw new Error('Fixed World startup unexpectedly requested channel metadata.');
	if (condition === 'slowPrimary' && !(marks.primaryEventsReleased > marks.primaryReq)) {
		throw new Error('Primary evidence was not delayed after its REQ.');
	}
	return marks;
}

function percentile(values: number[], fraction: number): number {
	const position = (values.length - 1) * fraction;
	const lower = Math.floor(position);
	return values[lower] + (values[Math.ceil(position)] - values[lower]) * (position - lower);
}

const browser = await chromium.launch();
const rows: Row[] = [];
try {
	for (let iteration = 0; iteration < repetitions; iteration++) {
		for (const condition of conditions) {
			const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
			try {
				const page = await context.newPage();
				await page.addInitScript({ content: 'window.__name = (fn) => fn;' });
				await installHostOwnedStub(page);
				await installDelayedRelay(page, { deferPrimaryEvents: condition === 'slowPrimary' });
				const secret = fixtureSecret(23);
				const selfPubkey = getPublicKey(secret);
				// This creates a selected Identity and active Run in IndexedDB before the app starts.
				await seedRelayAccount(page, secret, selfPubkey);
				await installMarks(page);
				rows.push({ scenario: 'savedActiveCold', condition, marks: await measure(page, condition, false, selfPubkey) });
				rows.push({ scenario: 'savedActiveWarmReload', condition, marks: await measure(page, condition, true, selfPubkey) });
			} finally {
				await context.close();
			}
		}
	}
} finally {
	await browser.close();
}

const summary = Object.fromEntries(conditions.flatMap((condition) => scenarios.map((scenario) => {
	const selected = rows.filter((row) => row.scenario === scenario && row.condition === condition);
	return [`${scenario}/${condition}`, Object.fromEntries(metrics.map((metric) => {
		const values = selected.map((row) => row.marks[metric]);
		if (values.some((value) => !Number.isFinite(value))) throw new Error(`Missing ${metric} in ${scenario}/${condition}.`);
		values.sort((a, b) => a - b);
		return [metric, { n: values.length, p50: Math.round(percentile(values, 0.5)), p90: Math.round(percentile(values, 0.9)), min: Math.round(values[0]), max: Math.round(values.at(-1)!) }];
	}))];
})));
console.log(JSON.stringify({ phase, repetitions, conditions, summary, rows }, null, 2));
