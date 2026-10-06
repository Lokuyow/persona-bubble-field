import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConversationState, receiveMessage, type SpeechType } from './conversation';
import { createSoundController, createSoundSamples, createSpeechSoundSamples, DEFAULT_SOUND_PREFERENCE, DEATH_SOUND_DURATION, loadSoundPreference, newLiveBubbleEffects, SOUND_ASSET_URLS, SOUND_EFFECT_GAINS, SPEECH_SOUND_DURATIONS, SPEECH_SOUND_PREFERENCE_KEY, UI_SOUND_DURATIONS } from './speechSoundEffects';

const options = { isSpeakerVisible: true, duration: 100, now: 0 };
const message = (id: string, pubkey: string, content: string, speechType: SpeechType = 'normal') => ({ id, pubkey, content, speechType, createdAt: 0 });

function spectralEnergy(samples: Float32Array, sampleRate: number, frequency: number): number {
	let real = 0;
	let imaginary = 0;
	for (let index = 0; index < samples.length; index += 1) {
		const phase = (Math.PI * 2 * frequency * index) / sampleRate;
		const window = 0.5 - 0.5 * Math.cos((Math.PI * 2 * index) / (samples.length - 1));
		real += samples[index] * window * Math.cos(phase);
		imaginary -= samples[index] * window * Math.sin(phase);
	}
	return real * real + imaginary * imaginary;
}

function bandEnergy(samples: Float32Array, sampleRate: number, from: number, to: number): number {
	let total = 0;
	for (let frequency = from; frequency <= to; frequency += 250) total += spectralEnergy(samples, sampleRate, frequency);
	return total;
}

function rms(samples: Float32Array): number {
	return Math.sqrt(samples.reduce((total, sample) => total + sample * sample, 0) / samples.length);
}

type FakeSoundBuffer = AudioBuffer & Readonly<{ assetId?: 'mending-collect' | 'level-up' }>;

function createAudioContextFixture(decodeAudioData: (encoded: ArrayBuffer) => Promise<AudioBuffer> = async () => ({ numberOfChannels: 1 } as AudioBuffer)) {
	const played: FakeSoundBuffer[] = [];
	const gainNodes: Array<{ gain: { value: number; cancelScheduledValues: () => void; setTargetAtTime: (value: number) => void }; connect: () => void }> = [];
	const masterVolumes: number[] = [];
	let proceduralBufferCreations = 0;
	let state: AudioContextState = 'suspended';
	let resumeCalls = 0;
	const context = {
		get state() { return state; }, sampleRate: 10_000, currentTime: 0, destination: {},
		createGain: () => {
			const node = { gain: { value: 1, cancelScheduledValues: () => {}, setTargetAtTime: (value: number) => masterVolumes.push(value) }, connect: () => {} };
			gainNodes.push(node);
			return node;
		},
		createBuffer: (_channels: number, length: number) => {
			proceduralBufferCreations += 1;
			return { getChannelData: () => new Float32Array(length) };
		},
		createBufferSource: () => {
			const source: { buffer: AudioBuffer | null; connect: () => void; start: () => void } = {
				buffer: null,
				connect: () => {},
				start: () => played.push(source.buffer as FakeSoundBuffer)
			};
			return source;
		},
		decodeAudioData,
		close: async () => {}, resume: () => { resumeCalls += 1; state = 'running'; return Promise.resolve(); }
	} as unknown as AudioContext;
	return { context, played, gainNodes, masterVolumes, get proceduralBufferCreations() { return proceduralBufferCreations; }, get resumeCalls() { return resumeCalls; } };
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function encodedAssetResponse(assetId: 'mending-collect' | 'level-up'): Response {
	const byte = assetId === 'mending-collect' ? 1 : 2;
	return { ok: true, arrayBuffer: async () => new Uint8Array([byte]).buffer } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('speech sound effects', () => {
	it('loads each reward asset once and preserves unlock, gain, mute, and hidden-document policies', async () => {
		const decoded: FakeSoundBuffer[] = [];
		const fixture = createAudioContextFixture(async (encoded) => {
			const assetId = new Uint8Array(encoded)[0] === 1 ? 'mending-collect' : 'level-up';
			const buffer = { numberOfChannels: 1, assetId } as FakeSoundBuffer;
			decoded.push(buffer);
			return buffer;
		});
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => encodedAssetResponse(String(input) === SOUND_ASSET_URLS['mending-collect'] ? 'mending-collect' : 'level-up'));
		vi.stubGlobal('fetch', fetchMock);
		let hidden = false;
		const controller = createSoundController({ audioContextFactory: () => fixture.context, document: { get hidden() { return hidden; } } });

		controller.play('mending-collect');
		controller.play('level-up');
		expect(fixture.played).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();

		controller.unlock();
		await flushMicrotasks();
		expect(fixture.resumeCalls).toBe(1);
		expect(new Set(fetchMock.mock.calls.map(([url]) => String(url)))).toEqual(new Set(Object.values(SOUND_ASSET_URLS)));
		expect(decoded.map(({ assetId }) => assetId).sort()).toEqual(['level-up', 'mending-collect']);

		controller.play('mending-collect');
		controller.play('mending-collect');
		controller.play('level-up');
		controller.play('collect');
		controller.play('collect');
		expect(fixture.played.map(({ assetId }) => assetId)).toEqual(['mending-collect', 'mending-collect', 'level-up', undefined, undefined]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fixture.proceduralBufferCreations).toBe(1);
		expect(fixture.gainNodes.slice(1).map(({ gain }) => gain.value)).toEqual([
			SOUND_EFFECT_GAINS['mending-collect'], SOUND_EFFECT_GAINS['mending-collect'], SOUND_EFFECT_GAINS['level-up'], SOUND_EFFECT_GAINS.collect, SOUND_EFFECT_GAINS.collect
		]);

		hidden = true;
		controller.play('mending-collect');
		controller.play('collect');
		controller.setVolume(0);
		hidden = false;
		controller.play('level-up');
		controller.play('collect');
		expect(fixture.played).toHaveLength(5);
		expect(fixture.proceduralBufferCreations).toBe(1);
		expect(fixture.masterVolumes.at(-1)).toBe(0);
		controller.dispose();
	});
	it.each([
		{ failure: 'fetch', effect: 'mending-collect' },
		{ failure: 'fetch', effect: 'level-up' },
		{ failure: 'decode', effect: 'mending-collect' },
		{ failure: 'decode', effect: 'level-up' }
	] as const)('does not fall back to procedural audio when the $effect asset $failure fails', async ({ failure, effect }) => {
		const fixture = createAudioContextFixture(async () => {
			if (failure === 'decode') throw new Error('decode failed');
			return { numberOfChannels: 1 } as AudioBuffer;
		});
		vi.stubGlobal('fetch', failure === 'fetch'
			? vi.fn(async () => { throw new Error('fetch failed'); })
			: vi.fn(async () => encodedAssetResponse('level-up')));
		const controller = createSoundController({ audioContextFactory: () => fixture.context });
		controller.unlock();
		await flushMicrotasks();
		expect(() => controller.play(effect)).not.toThrow();
		await flushMicrotasks();
		expect(fixture.played).toEqual([]);
		expect(fixture.proceduralBufferCreations).toBe(0);
		expect(() => controller.play('collect')).not.toThrow();
		expect(fixture.proceduralBufferCreations).toBe(1);
		controller.dispose();
	});
	it('ignores asset decodes that finish after controller disposal', async () => {
		const pendingDecodes: Array<(buffer: AudioBuffer) => void> = [];
		const fixture = createAudioContextFixture(() => new Promise((resolve) => pendingDecodes.push(resolve)));
		vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => encodedAssetResponse(
			String(input) === SOUND_ASSET_URLS['mending-collect'] ? 'mending-collect' : 'level-up'
		)));
		const controller = createSoundController({ audioContextFactory: () => fixture.context });
		controller.unlock();
		await flushMicrotasks();
		expect(pendingDecodes).toHaveLength(2);
		controller.dispose();
		for (const resolve of pendingDecodes) resolve({ numberOfChannels: 1 } as AudioBuffer);
		await flushMicrotasks();
		controller.play('mending-collect');
		controller.play('level-up');
		expect(fixture.played).toEqual([]);
		expect(fixture.proceduralBufferCreations).toBe(0);
	});
	it('creates deterministic UI chimes with effect-specific gains', () => {
		for (const effect of ['collect', 'startup', 'cooperation-start'] as const) {
			const samples = createSoundSamples(effect, 10_000);
			expect(samples.length).toBe(Math.ceil(UI_SOUND_DURATIONS[effect] * 10_000));
			expect([...samples].every(Number.isFinite)).toBe(true);
			expect(Math.max(...samples.map(Math.abs))).toBeLessThanOrEqual(0.920001);
			expect(samples).toEqual(createSoundSamples(effect, 10_000));
		}
	});
	it('maps Mending and level-up to their dedicated assets instead of procedural generators', () => {
		expect(SOUND_ASSET_URLS['mending-collect']).toContain('mending-collection.ogg');
		expect(SOUND_ASSET_URLS['level-up']).toContain('level-up.ogg');
		expect(createSoundSamples('collect', 10_000)).toEqual(createSoundSamples('collect', 10_000));
	});
	it('creates six distinct, finite, non-clipping tag-game cues at their intended lengths', () => {
		const effects = ['tag-game-benefit', 'tag-game-calamity', 'tag-game-transfer', 'tag-game-switch', 'tag-game-start', 'tag-game-end'] as const;
		const samples = effects.map((effect) => createSoundSamples(effect, 10_000));
		expect(samples.map((buffer, index) => buffer.length)).toEqual(effects.map((effect) => Math.ceil(UI_SOUND_DURATIONS[effect] * 10_000)));
		for (const buffer of samples) {
			expect([...buffer].every(Number.isFinite)).toBe(true);
			expect(Math.max(...buffer.map(Math.abs))).toBeLessThanOrEqual(0.920001);
			expect(buffer.some((sample) => Math.abs(sample) > 0.001)).toBe(true);
		}
		for (let index = 0; index < samples.length; index += 1) {
			expect(samples[index]).toEqual(createSoundSamples(effects[index], 10_000));
			for (let other = index + 1; other < samples.length; other += 1) expect(samples[index]).not.toEqual(samples[other]);
		}
	});
	it('gives the benefit cue a short, bell-like rising major triad', () => {
		const sampleRate = 10_000;
		const benefit = createSoundSamples('tag-game-benefit', sampleRate);
		expect(benefit.length).toBe(Math.ceil(UI_SOUND_DURATIONS['tag-game-benefit'] * sampleRate));
		const firstNote = benefit.slice(40, 500);
		const middleNote = benefit.slice(760, 1_300);
		const finalNote = benefit.slice(1_500, 2_400);
		expect(spectralEnergy(firstNote, sampleRate, 587)).toBeGreaterThan(spectralEnergy(firstNote, sampleRate, 740));
		expect(spectralEnergy(middleNote, sampleRate, 740)).toBeGreaterThan(spectralEnergy(middleNote, sampleRate, 587));
		expect(spectralEnergy(finalNote, sampleRate, 880)).toBeGreaterThan(spectralEnergy(finalNote, sampleRate, 740));
		expect(bandEnergy(benefit, sampleRate, 100, 350)).toBeLessThan(bandEnergy(benefit, sampleRate, 500, 1_000) * 0.02);
		expect(Math.abs(benefit.at(-1) ?? 1)).toBeLessThan(0.001);
	});
	it('keeps speech gain at unity and attenuates only UI success sounds', () => {
		expect(SOUND_EFFECT_GAINS.normal).toBe(1);
		expect(SOUND_EFFECT_GAINS.shout).toBe(1);
		expect(SOUND_EFFECT_GAINS.monologue).toBe(1);
		expect(SOUND_EFFECT_GAINS.collect).toBeCloseTo(0.75);
		expect(SOUND_EFFECT_GAINS['level-up']).toBeCloseTo(0.75);
		expect(SOUND_EFFECT_GAINS['mending-collect']).toBeGreaterThan(SOUND_EFFECT_GAINS['level-up']);
		expect(SOUND_EFFECT_GAINS.startup).toBeCloseTo(0.65);
		expect(SOUND_EFFECT_GAINS['cooperation-start']).toBeCloseTo(0.65);
		expect(SOUND_EFFECT_GAINS.death).toBeCloseTo(0.70);
		expect(SOUND_EFFECT_GAINS['tag-game-benefit']).toBeLessThan(SOUND_EFFECT_GAINS['tag-game-transfer']);
		expect(SOUND_EFFECT_GAINS['tag-game-calamity']).toBeLessThan(SOUND_EFFECT_GAINS['tag-game-start']);
		expect(SOUND_EFFECT_GAINS['tag-game-transfer']).toBeLessThan(SOUND_EFFECT_GAINS['tag-game-start']);
	});
	it('creates a deterministic death soundscape with a decaying tail', () => {
		const sampleRate = 10_000;
		const death = createSoundSamples('death', sampleRate);
		expect(death.length).toBe(Math.ceil(DEATH_SOUND_DURATION * sampleRate));
		expect([...death].every(Number.isFinite)).toBe(true);
		expect(Math.max(...death.map(Math.abs))).toBeLessThanOrEqual(0.920001);
		expect(death.some((sample) => Math.abs(sample) > 0.001)).toBe(true);
		expect(death).toEqual(createSoundSamples('death', sampleRate));
		const firstSecond = death.slice(0, sampleRate);
		const lastSecond = death.slice(-sampleRate);
		expect(rms(lastSecond)).toBeLessThan(rms(firstSecond) * 0.2);
	});
	it('creates deterministic, finite, non-clipping buffers at the specified durations', () => {
		const effects = ['normal', 'shout', 'monologue'] as const;
		const buffers = effects.map((effect) => createSpeechSoundSamples(effect, 10_000));
		expect(buffers.map((buffer) => buffer.length)).toEqual(effects.map((effect) => Math.ceil(SPEECH_SOUND_DURATIONS[effect] * 10_000)));
		for (const buffer of buffers) {
			expect([...buffer].every(Number.isFinite)).toBe(true);
			expect(Math.max(...buffer.map(Math.abs))).toBeLessThanOrEqual(0.920001);
		}
		expect(buffers[0]).toEqual(createSpeechSoundSamples('normal', 10_000));
		expect(buffers[0]).not.toEqual(buffers[1]);
	});
	it('keeps normal noise energy in its selected mid band instead of leaking into ultrasonic highs', () => {
		const sampleRate = 48_000;
		const normal = createSpeechSoundSamples('normal', sampleRate);
		const midEnergy = bandEnergy(normal, sampleRate, 650, 4_300);
		const highEnergy = bandEnergy(normal, sampleRate, 10_250, 23_750);
		const totalEnergy = bandEnergy(normal, sampleRate, 250, 23_750);
		expect(midEnergy / totalEnergy).toBeGreaterThan(0.65);
		expect(highEnergy / totalEnergy).toBeLessThan(0.05);
	});
	it('keeps normal quieter without collapsing its procedural noise level', () => {
		const normal = createSpeechSoundSamples('normal', 48_000);
		expect(rms(normal)).toBeGreaterThan(0.025);
		expect(rms(normal)).toBeLessThan(0.05);
	});
	it('keeps normal centroid in a present but softer midrange', () => {
		const sampleRate = 48_000;
		const normal = createSpeechSoundSamples('normal', sampleRate);
		const totalEnergy = bandEnergy(normal, sampleRate, 250, 23_750);
		let weightedEnergy = 0;
		for (let frequency = 250; frequency <= 23_750; frequency += 250) weightedEnergy += frequency * spectralEnergy(normal, sampleRate, frequency);
		const centroid = weightedEnergy / totalEnergy;
		expect(centroid).toBeGreaterThan(1_800);
		expect(centroid).toBeLessThan(3_000);
	});
	it('keeps shout noise energy and centroid out of the overly-low one-pole range', () => {
		const sampleRate = 48_000;
		const shout = createSpeechSoundSamples('shout', sampleRate);
		const totalEnergy = bandEnergy(shout, sampleRate, 250, 23_750);
		const lowEnergy = bandEnergy(shout, sampleRate, 250, 750);
		const midEnergy = bandEnergy(shout, sampleRate, 750, 5_000);
		let weightedEnergy = 0;
		for (let frequency = 250; frequency <= 23_750; frequency += 250) weightedEnergy += frequency * spectralEnergy(shout, sampleRate, frequency);
		expect(midEnergy / totalEnergy).toBeGreaterThan(0.07);
		expect(lowEnergy / totalEnergy).toBeLessThan(0.94);
		expect(weightedEnergy / totalEnergy).toBeGreaterThan(450);
	});
	it.each(['normal', 'shout', 'monologue'] as const)('maps a new %s bubble to one effect', (speechType) => {
		const previous = createConversationState();
		const next = receiveMessage(previous, message('a', 'alice', 'hello', speechType), options);
		expect(newLiveBubbleEffects(previous, next)).toEqual([speechType]);
	});
	it('does not emit for offscreen or duplicate messages', () => {
		const previous = receiveMessage(createConversationState(), message('a', 'alice', 'hello'), { ...options, isSpeakerVisible: false });
		const next = receiveMessage(previous, message('a', 'alice', 'hello'), options);
		expect(newLiveBubbleEffects(previous, next)).toEqual([]);
	});
	it('emits once when normal bubbles become a newly created merge', () => {
		const previous = receiveMessage(createConversationState(), message('a', 'alice', 'hello'), options);
		const next = receiveMessage(previous, message('b', 'bob', 'hello'), { ...options, now: 1 });
		expect(newLiveBubbleEffects(previous, next)).toEqual(['normal']);
		const joined = receiveMessage(next, message('c', 'charlie', 'hello'), { ...options, now: 2 });
		expect(newLiveBubbleEffects(next, joined)).toEqual([]);
	});
	it('loads safe defaults for invalid persisted values and preserves valid preferences', () => {
		const storage = { getItem: (key: string) => key === SPEECH_SOUND_PREFERENCE_KEY ? '{"volume":4,"muted":"no"}' : null };
		expect(loadSoundPreference(storage)).toEqual(DEFAULT_SOUND_PREFERENCE);
		expect(loadSoundPreference({ getItem: () => '{"volume":0.2,"muted":true}' })).toEqual({ volume: 0.2 });
		expect(loadSoundPreference({ getItem: () => '{"volume":0}' })).toEqual({ volume: 0 });
	});
});
