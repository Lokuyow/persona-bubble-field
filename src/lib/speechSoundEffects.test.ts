import { describe, expect, it } from 'vitest';
import { createConversationState, receiveMessage, type SpeechType } from './conversation';
import { createSpeechSoundSamples, DEFAULT_SOUND_PREFERENCE, loadSoundPreference, newLiveBubbleEffects, SPEECH_SOUND_DURATIONS, SPEECH_SOUND_PREFERENCE_KEY } from './speechSoundEffects';

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

describe('speech sound effects', () => {
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
	it('keeps normal noise energy in its specified mid band instead of leaking into ultrasonic highs', () => {
		const sampleRate = 48_000;
		const normal = createSpeechSoundSamples('normal', sampleRate);
		const midEnergy = bandEnergy(normal, sampleRate, 750, 5_000);
		const highEnergy = bandEnergy(normal, sampleRate, 10_250, 23_750);
		const totalEnergy = bandEnergy(normal, sampleRate, 250, 23_750);
		expect(midEnergy / totalEnergy).toBeGreaterThan(0.70);
		expect(highEnergy / totalEnergy).toBeLessThan(0.05);
	});
	it('keeps normal noise at a unit-variance-derived level', () => {
		const normal = createSpeechSoundSamples('normal', 48_000);
		expect(rms(normal)).toBeGreaterThan(0.05);
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
		expect(loadSoundPreference({ getItem: () => '{"volume":0.2,"muted":true}' })).toEqual({ volume: 0.2, muted: true });
	});
});
