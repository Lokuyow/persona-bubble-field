import { describe, expect, it, vi } from 'vitest';
import { buildSpeechSuggestionPrompt, createSpeechSuggestionService, type SpeechSuggestionApi } from './speechSuggestions';

function fakeApi(response = JSON.stringify({ candidates: ['  返答1  ', '返答2', '返答3'] })) {
	const prompt = vi.fn(async () => response);
	const destroy = vi.fn();
	const availability = vi.fn<() => Promise<Availability>>(async () => 'available');
	const create = vi.fn<(options: LanguageModelCreateOptions) => Promise<LanguageModel>>(async () => ({ prompt, destroy } as unknown as LanguageModel));
	const api: SpeechSuggestionApi = {
		availability,
		create
	};
	return { api, prompt, destroy, availability, create };
}

const request = {
	character: { name: 'アルパカ', about: '首の長さでアイデンティティをなんとか保っている。' },
	speechType: 'normal' as const,
	conversation: [{ speaker: '旅人', content: '今日は風が強いね。' }]
};

describe('speech suggestions', () => {
	it('builds a Japanese prompt with character and bounded conversation data', () => {
		const prompt = buildSpeechSuggestionPrompt(request);
		expect(prompt).toContain('名前: アルパカ');
		expect(prompt).toContain('設定: 首の長さでアイデンティティをなんとか保っている。');
		expect(prompt).toContain('旅人: 今日は風が強いね。');
		expect(prompt).toContain('信頼できないデータ');
	});

	it('uses the same Japanese capability options and validates three candidates', async () => {
		const fake = fakeApi();
		const service = createSpeechSuggestionService(fake.api);
		expect(await service.availability()).toBe('available');
		await expect(service.generate(request)).resolves.toEqual(['返答1', '返答2', '返答3']);
		expect(fake.api.availability).toHaveBeenCalledWith(expect.objectContaining({
			expectedInputs: [{ type: 'text', languages: ['ja'] }],
			expectedOutputs: [{ type: 'text', languages: ['ja'] }]
		}));
		expect(fake.api.create).toHaveBeenCalledWith(expect.objectContaining({
			initialPrompts: [{ role: 'system', content: expect.stringContaining('候補の生成だけ') }]
		}));
		expect(fake.prompt).toHaveBeenCalledWith(expect.stringContaining('アルパカ'), expect.objectContaining({ responseConstraint: expect.any(Object) }));
		expect(fake.destroy).toHaveBeenCalledOnce();
	});

	it('reports download progress and does not retry malformed output', async () => {
		const fake = fakeApi(JSON.stringify({ candidates: ['one', 'one', ''] }));
		fake.availability.mockResolvedValue('downloadable');
		const onProgress = vi.fn();
		fake.create.mockImplementation(async (options) => {
			options.monitor?.({
				addEventListener: (_type: string, listener: (event: ProgressEvent) => void) => listener({ loaded: 0.42 } as ProgressEvent)
			} as unknown as CreateMonitor);
			return { prompt: fake.prompt, destroy: fake.destroy } as unknown as LanguageModel;
		});
		await expect(createSpeechSuggestionService(fake.api).generate(request, { onProgress })).rejects.toThrow('fewer than three');
		expect(onProgress).toHaveBeenCalledWith({ availability: 'downloadable', progress: 0.42 });
		expect(fake.prompt).toHaveBeenCalledOnce();
	});

	it('treats unavailable and missing APIs as unsupported feature states', async () => {
		const unavailable: SpeechSuggestionApi = {
			availability: vi.fn<() => Promise<Availability>>(async () => 'unavailable'),
			create: vi.fn()
		};
		expect(await createSpeechSuggestionService(unavailable).availability()).toBe('unavailable');
		expect(await createSpeechSuggestionService(null).availability()).toBe('unsupported');
	});
});
