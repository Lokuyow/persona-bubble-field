import { describe, expect, it } from 'vitest';
import { createConversationState, receiveMessage, type SpeechType } from './conversation';
import { createSpeechSoundSamples, DEFAULT_SOUND_PREFERENCE, loadSoundPreference, newLiveBubbleEffects, SPEECH_SOUND_DURATIONS, SPEECH_SOUND_PREFERENCE_KEY } from './speechSoundEffects';

const options = { isSpeakerVisible: true, duration: 100, now: 0 };
const message = (id: string, pubkey: string, content: string, speechType: SpeechType = 'normal') => ({ id, pubkey, content, speechType, createdAt: 0 });

describe('speech sound effects', () => {
	it('creates deterministic, finite, non-clipping buffers at the specified durations', () => {
		const effects = ['normal', 'shout', 'monologue'] as const;
		const buffers = effects.map((effect) => createSpeechSoundSamples(effect, 10_000));
		expect(buffers.map((buffer) => buffer.length)).toEqual(effects.map((effect) => Math.ceil(SPEECH_SOUND_DURATIONS[effect] * 10_000)));
		for (const buffer of buffers) {
			expect([...buffer].every(Number.isFinite)).toBe(true);
			expect(Math.max(...buffer.map(Math.abs))).toBeLessThanOrEqual(0.92);
		}
		expect(buffers[0]).toEqual(createSpeechSoundSamples('normal', 10_000));
		expect(buffers[0]).not.toEqual(buffers[1]);
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
