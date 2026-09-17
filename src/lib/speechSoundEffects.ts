import type { ConversationState, SpeechType } from './conversation';

export type SoundPreference = Readonly<{ volume: number; muted: boolean }>;
export type SpeechSoundEffect = SpeechType;

export const DEFAULT_SOUND_PREFERENCE: SoundPreference = { volume: 0.5, muted: false };
export const SPEECH_SOUND_PREFERENCE_KEY = 'persona-bubble-field:speech-sound:v1';

export function loadSoundPreference(storage: Pick<Storage, 'getItem'> | null | undefined): SoundPreference {
	try {
		const raw = storage?.getItem(SPEECH_SOUND_PREFERENCE_KEY);
		if (!raw) return DEFAULT_SOUND_PREFERENCE;
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SOUND_PREFERENCE;
		const value = parsed as Record<string, unknown>;
		if (typeof value.volume !== 'number' || !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 1 || typeof value.muted !== 'boolean') {
			return DEFAULT_SOUND_PREFERENCE;
		}
		return { volume: value.volume, muted: value.muted };
	} catch {
		return DEFAULT_SOUND_PREFERENCE;
	}
}

export function saveSoundPreference(storage: Pick<Storage, 'setItem'> | null | undefined, preference: SoundPreference): void {
	try { storage?.setItem(SPEECH_SOUND_PREFERENCE_KEY, JSON.stringify(preference)); } catch { /* storage is optional */ }
}

export function newLiveBubbleEffects(previous: ConversationState, next: ConversationState): SpeechSoundEffect[] {
	const previousIds = new Set([...previous.normalBubbles, ...previous.mergedBubbles].map((bubble) => bubble.id));
	return [...next.normalBubbles, ...next.mergedBubbles]
		.filter((bubble) => !previousIds.has(bubble.id))
		.map((bubble) => bubble.speechType);
}

type AudioContextLike = AudioContext;
type ControllerOptions = Readonly<{
	storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
	document?: Pick<Document, 'hidden'>;
	audioContextFactory?: () => AudioContextLike;
}>;

export type SpeechSoundController = Readonly<{
	preference: SoundPreference;
	unlock: () => void;
	setVolume: (volume: number) => void;
	setMuted: (muted: boolean) => void;
	play: (effect: SpeechSoundEffect) => void;
	dispose: () => void;
}>;

export function createSpeechSoundController(options: ControllerOptions = {}): SpeechSoundController {
	let preference = loadSoundPreference(options.storage);
	let context: AudioContextLike | null = null;
	let masterGain: GainNode | null = null;
	let disposed = false;

	const applyGain = (at = context?.currentTime ?? 0) => {
		if (!masterGain || !context) return;
		masterGain.gain.cancelScheduledValues(at);
		masterGain.gain.setTargetAtTime(preference.muted ? 0 : preference.volume, at, 0.015);
	};
	const ensureContext = (): AudioContextLike | null => {
		if (disposed || context) return context;
		try {
			context = options.audioContextFactory?.() ?? new AudioContext();
			masterGain = context.createGain();
			masterGain.connect(context.destination);
			applyGain();
			return context;
		} catch {
			context = null;
			masterGain = null;
			return null;
		}
	};
 
	const unlock = () => {
		const audio = ensureContext();
		if (audio?.state === 'suspended') void audio.resume().catch(() => {});
	};
	const setPreference = (next: SoundPreference) => {
		preference = next;
		saveSoundPreference(options.storage, preference);
		applyGain();
	};
	const noise = (audio: AudioContextLike, start: number, duration: number, gain: number, highpass: number, lowpass: number) => {
		if (!masterGain) return;
		const buffer = audio.createBuffer(1, Math.max(1, Math.ceil(audio.sampleRate * duration)), audio.sampleRate);
		const data = buffer.getChannelData(0);
		for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
		const source = audio.createBufferSource();
		const filter = audio.createBiquadFilter();
		const envelope = audio.createGain();
		source.buffer = buffer;
		filter.type = 'bandpass'; filter.frequency.setValueAtTime((highpass + lowpass) / 2, start); filter.Q.setValueAtTime(0.8, start);
		envelope.gain.setValueAtTime(0.0001, start); envelope.gain.exponentialRampToValueAtTime(gain, start + 0.006); envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
		source.connect(filter).connect(envelope).connect(masterGain); source.start(start); source.stop(start + duration + 0.01);
	};
	const tone = (audio: AudioContextLike, start: number, frequency: number, duration: number, gain: number) => {
		if (!masterGain) return;
		const oscillator = audio.createOscillator(); const envelope = audio.createGain();
		oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(frequency, start);
		envelope.gain.setValueAtTime(0.0001, start); envelope.gain.exponentialRampToValueAtTime(gain, start + 0.012); envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
		oscillator.connect(envelope).connect(masterGain); oscillator.start(start); oscillator.stop(start + duration + 0.01);
	};
	return {
		get preference() { return preference; },
		unlock,
		setVolume: (volume) => setPreference({ ...preference, volume: Math.min(1, Math.max(0, volume)) }),
		setMuted: (muted) => setPreference({ ...preference, muted }),
		play: (effect) => {
			const audio = context;
			if (!audio || audio.state !== 'running' || options.document?.hidden || preference.muted || preference.volume <= 0.001) return;
			const start = audio.currentTime + 0.005;
			if (effect === 'normal') noise(audio, start, 0.12, 0.12, 900, 3_200);
			else if (effect === 'shout') { noise(audio, start, 0.16, 0.2, 180, 2_200); tone(audio, start, 105, 0.18, 0.12); }
			else for (const [offset, frequency] of [0, 0.12, 0.24].map((offset) => [offset, 520 + offset * 220] as const)) tone(audio, start + offset, frequency, 0.11, 0.08);
		},
		dispose: () => { disposed = true; if (context) void context.close().catch(() => {}); context = null; masterGain = null; }
	};
}
