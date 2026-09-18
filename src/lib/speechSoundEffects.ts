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

export const SPEECH_SOUND_DURATIONS = { normal: 0.225, shout: 0.420, monologue: 0.715 } as const;
const TAU = Math.PI * 2;

function clamp01(value: number): number { return Math.min(1, Math.max(0, value)); }

function seededNoise(length: number, seed: number, sampleRate: number, low: number, high: number): Float32Array {
	const output = new Float32Array(length);
	let state = seed >>> 0;
	let lowPass = 0;
	let highPass = 0;
	const lowAlpha = 1 - Math.exp(-TAU * high / sampleRate);
	const highAlpha = 1 - Math.exp(-TAU * low / sampleRate);
	for (let index = 0; index < length; index += 1) {
		state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
		const white = ((state >>> 0) / 0xffffffff) * 2 - 1;
		lowPass += lowAlpha * (white - lowPass);
		highPass = white - lowPass;
		output[index] = highPass;
		lowPass += highAlpha * (highPass - lowPass);
	}
	return output;
}

function normalize(samples: Float32Array): Float32Array {
	let peak = 0;
	for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
	if (peak <= 0.92) return samples;
	const scale = 0.92 / peak;
	for (let index = 0; index < samples.length; index += 1) samples[index] *= scale;
	return samples;
}

function createNormalSamples(sampleRate: number): Float32Array {
	const length = Math.ceil(sampleRate * SPEECH_SOUND_DURATIONS.normal);
	const layerA = seededNoise(length, 0x13579bdf, sampleRate, 750, 5000);
	const layerB = seededNoise(length, 0x2468ace0, sampleRate, 2300, 7800);
	const output = new Float32Array(length);
	for (let index = 0; index < length; index += 1) {
		const t = index / sampleRate;
		const attack = Math.pow(clamp01(t / 0.022), 1.2);
		const release = Math.pow(clamp01((0.225 - t) / 0.045), 1.25);
		const envelope = attack * Math.exp(-t / 0.09) * release;
		const modulation = 0.97 + 0.03 * Math.sin(TAU * 9 * t + 0.3);
		output[index] = 0.45 * (0.88 * layerA[index] + 0.20 * layerB[index]) * envelope * modulation;
	}
	return normalize(output);
}

function createShoutSamples(sampleRate: number): Float32Array {
	const length = Math.ceil(sampleRate * SPEECH_SOUND_DURATIONS.shout);
	const output = new Float32Array(length);
	const layers = [
		{ offset: 0, gain: 1, brightness: 1, shift: 0, seed: 0x31415926 },
		{ offset: 0.034, gain: 0.54, brightness: 1.08, shift: 28, seed: 0x27182818 },
		{ offset: 0.071, gain: 0.36, brightness: 0.96, shift: -12, seed: 0x16180339 },
		{ offset: 0.125, gain: 0.20, brightness: 0.92, shift: 18, seed: 0x9e3779b9 }
	] as const;
	for (const layer of layers) {
		const noise = seededNoise(length, layer.seed, sampleRate, 380, Math.min(7600, 5200 * layer.brightness));
		const crack = seededNoise(length, layer.seed ^ 0xabcdef01, sampleRate, 1400, 7800);
		let phase = 0;
		for (let index = 0; index < length; index += 1) {
			const t = index / sampleRate - layer.offset;
			if (t < 0) continue;
			const noiseEnvelope = (1 - Math.exp(-t / 0.0013)) * Math.exp(-t / 0.04);
			const bodyEnvelope = (1 - Math.exp(-t / 0.0015)) * Math.exp(-t / 0.09);
			const crackEnvelope = (1 - Math.exp(-t / 0.0007)) * Math.exp(-t / 0.016);
			const frequency = 175 + layer.shift + 135 * Math.exp(-t / 0.03);
			phase += TAU * frequency / sampleRate;
			const resonance = 0.06 * Math.exp(-t / 0.11) * Math.sin(TAU * (360 + layer.shift) * t + 0.3)
				+ 0.045 * Math.exp(-t / 0.09) * Math.sin(TAU * (520 + layer.shift * 0.7) * t + 1);
			output[index] += layer.gain * (0.35 * noise[index] * noiseEnvelope + 0.23 * Math.sin(phase) * bodyEnvelope + 0.22 * crack[index] * crackEnvelope + resonance);
		}
	}
	const diffuse = seededNoise(length, 0xdeadbeef, sampleRate, 650, 4200);
	for (let index = 0; index < length; index += 1) {
		const t = index / sampleRate;
		output[index] += 0.075 * diffuse[index] * Math.exp(-t / 0.145) * clamp01(t / 0.003) * clamp01((0.420 - t) / 0.070);
	}
	return normalize(output);
}

function createMonologueSamples(sampleRate: number): Float32Array {
	const pulseDuration = 0.205;
	const length = Math.ceil(sampleRate * SPEECH_SOUND_DURATIONS.monologue);
	const output = new Float32Array(length);
	const breath = seededNoise(Math.ceil(sampleRate * pulseDuration), 0xabcdef12, sampleRate, 500, 3000);
	for (let index = 0; index < length; index += 1) {
		const t = index / sampleRate;
		const pulse = Math.floor(t / 0.255);
		const local = t - pulse * 0.255;
		if (pulse > 2 || local >= pulseDuration) continue;
		const u = clamp01(local / pulseDuration);
		const bloomFrequency = 470 + 450 * Math.pow(u, 0.62);
		const envelope = Math.pow(Math.min(clamp01(local / 0.026), clamp01((pulseDuration - local) / 0.060)), 0.72) * (0.84 + 0.16 * Math.sin(Math.PI * u));
		const phase = TAU * (235 * local + 170 * Math.pow(u, 1.78) * pulseDuration / 1.78 + 8 * pulse * local);
		const bloom = 0.22 * Math.exp(-Math.pow((u - 0.62) / 0.28, 2)) * Math.sin(TAU * bloomFrequency * local + 0.55);
		output[index] = 0.34 * (0.72 * Math.sin(phase) + 0.20 * Math.sin(2 * phase + 0.25) + 0.07 * Math.sin(3 * phase + 0.8) + bloom) * envelope + 0.018 * breath[Math.min(breath.length - 1, Math.floor(local * sampleRate))] * Math.exp(-local / 0.028) * clamp01(local / 0.004);
	}
	return normalize(output);
}

export function createSpeechSoundSamples(effect: SpeechSoundEffect, sampleRate: number): Float32Array {
	if (!Number.isFinite(sampleRate) || sampleRate <= 0) return new Float32Array();
	if (effect === 'normal') return createNormalSamples(sampleRate);
	if (effect === 'shout') return createShoutSamples(sampleRate);
	return createMonologueSamples(sampleRate);
}

type AudioContextLike = AudioContext;
type ControllerOptions = Readonly<{ storage?: Pick<Storage, 'getItem' | 'setItem'> | null; document?: Pick<Document, 'hidden'>; audioContextFactory?: () => AudioContextLike }>;
export type SpeechSoundController = Readonly<{ preference: SoundPreference; unlock: () => void; setVolume: (volume: number) => void; setMuted: (muted: boolean) => void; play: (effect: SpeechSoundEffect) => void; dispose: () => void }>;

export function createSpeechSoundController(options: ControllerOptions = {}): SpeechSoundController {
	let preference = loadSoundPreference(options.storage);
	let context: AudioContextLike | null = null;
	let masterGain: GainNode | null = null;
	let disposed = false;
	const buffers = new Map<SpeechSoundEffect, AudioBuffer>();
	const applyGain = (at = context?.currentTime ?? 0) => {
		if (!masterGain || !context) return;
		masterGain.gain.cancelScheduledValues(at); masterGain.gain.setTargetAtTime(preference.muted ? 0 : preference.volume, at, 0.015);
	};
	const ensureContext = (): AudioContextLike | null => {
		if (disposed || context) return context;
		try { context = options.audioContextFactory?.() ?? new AudioContext(); masterGain = context.createGain(); masterGain.connect(context.destination); applyGain(); return context; }
		catch { context = null; masterGain = null; return null; }
	};
	const unlock = () => { const audio = ensureContext(); if (audio?.state === 'suspended') void audio.resume().catch(() => {}); };
	const setPreference = (next: SoundPreference) => { preference = next; saveSoundPreference(options.storage, preference); applyGain(); };
	return {
		get preference() { return preference; }, unlock,
		setVolume: (volume) => setPreference({ ...preference, volume: Math.min(1, Math.max(0, volume)) }),
		setMuted: (muted) => setPreference({ ...preference, muted }),
		play: (effect) => {
			const audio = context;
			if (!audio || !masterGain || audio.state !== 'running' || options.document?.hidden || preference.muted || preference.volume <= 0.001) return;
			let buffer = buffers.get(effect);
			if (!buffer) { const samples = createSpeechSoundSamples(effect, audio.sampleRate); buffer = audio.createBuffer(1, samples.length, audio.sampleRate); buffer.getChannelData(0).set(samples); buffers.set(effect, buffer); }
			const source = audio.createBufferSource(); source.buffer = buffer; source.connect(masterGain); source.start(audio.currentTime + 0.005);
		},
		dispose: () => { disposed = true; buffers.clear(); if (context) void context.close().catch(() => {}); context = null; masterGain = null; }
	};
}
