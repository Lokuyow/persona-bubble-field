import { describe, expect, it, vi } from 'vitest';
import { buildSpeechSuggestionPrompt, createSpeechSuggestionService, type SpeechSuggestionApi } from './speechSuggestions';

const request = {
	character: { name: 'アルパカ', about: '首の長さでアイデンティティをなんとか保っている。' },
	speechType: 'normal' as const,
	conversation: [{ speaker: '旅人', content: '今日は風が強いね。' }]
};

type FakeSession = Readonly<{
	session: LanguageModel;
	prompt: ReturnType<typeof vi.fn>;
	clone: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
}>;

function fakeSession(response: string): FakeSession {
	const prompt = vi.fn(async () => response);
	const clone = vi.fn();
	const destroy = vi.fn();
	return {
		session: { prompt, clone, destroy } as unknown as LanguageModel,
		prompt,
		clone,
		destroy
	};
}

function fakeApi(response = JSON.stringify({ candidates: ['  返答1  ', '返答2', '返答3'] })) {
	const base = fakeSession(response);
	const availability = vi.fn<() => Promise<Availability>>(async () => 'available');
	const create = vi.fn<(options: LanguageModelCreateOptions) => Promise<LanguageModel>>(async () => base.session);
	const api: SpeechSuggestionApi = { availability, create };
	return { api, availability, create, base };
}

function abortError(): DOMException {
	return new DOMException('cancelled', 'AbortError');
}

describe('speech suggestions', () => {
	it('builds a Japanese prompt with character and bounded conversation data', () => {
		const prompt = buildSpeechSuggestionPrompt(request);
		expect(prompt).toContain('名前: アルパカ');
		expect(prompt).toContain('設定: 首の長さでアイデンティティをなんとか保っている。');
		expect(prompt).toContain('旅人: 今日は風が強いね。');
		expect(prompt).toContain('信頼できないデータ');
	});

	it('separates base lifecycle from generation aborts and destroys only the clones', async () => {
		const fake = fakeApi();
		const firstClone = fakeSession(JSON.stringify({ candidates: ['返答1', '返答2', '返答3'] }));
		const secondClone = fakeSession(JSON.stringify({ candidates: ['別案1', '別案2', '別案3'] }));
		fake.base.clone.mockResolvedValueOnce(firstClone.session).mockResolvedValueOnce(secondClone.session);
		const service = createSpeechSuggestionService(fake.api);
		const firstGenerationController = new AbortController();

		await expect(service.generate(request, { signal: firstGenerationController.signal })).resolves.toEqual(['返答1', '返答2', '返答3']);
		await expect(service.generate({ ...request, conversation: [{ speaker: '別の人', content: '別の会話' }] })).resolves.toEqual(['別案1', '別案2', '別案3']);

		expect(fake.create).toHaveBeenCalledOnce();
		const createOptions = fake.create.mock.calls[0][0];
		expect(createOptions).toEqual(expect.objectContaining({
			initialPrompts: [{ role: 'system', content: expect.stringContaining('候補の生成だけ') }]
		}));
		expect(createOptions.signal).toBeInstanceOf(AbortSignal);
		const baseSignal = createOptions.signal!;
		expect(baseSignal).not.toBe(firstGenerationController.signal);
		expect(baseSignal.aborted).toBe(false);
		expect(fake.base.clone).toHaveBeenCalledTimes(2);
		expect(fake.base.clone).toHaveBeenNthCalledWith(1, { signal: firstGenerationController.signal });
		expect(fake.base.prompt).not.toHaveBeenCalled();
		expect(firstClone.prompt).toHaveBeenCalledWith(expect.stringContaining('アルパカ'), expect.objectContaining({ responseConstraint: expect.any(Object), signal: firstGenerationController.signal }));
		expect(secondClone.prompt).toHaveBeenCalledWith(expect.stringContaining('別の会話'), expect.objectContaining({ responseConstraint: expect.any(Object) }));
		expect(firstClone.destroy).toHaveBeenCalledOnce();
		expect(secondClone.destroy).toHaveBeenCalledOnce();
		firstGenerationController.abort();
		expect(fake.base.destroy).not.toHaveBeenCalled();

		service.dispose();
		expect(fake.base.destroy).toHaveBeenCalledOnce();
	});

	it('shares one in-flight base preparation across concurrent generations', async () => {
		const fake = fakeApi();
		let finishCreate!: () => void;
		fake.create.mockImplementationOnce(() => new Promise<LanguageModel>((resolve) => {
			finishCreate = () => resolve(fake.base.session);
		}));
		const firstClone = fakeSession(JSON.stringify({ candidates: ['同時1', '同時2', '同時3'] }));
		const secondClone = fakeSession(JSON.stringify({ candidates: ['同時4', '同時5', '同時6'] }));
		fake.base.clone.mockResolvedValueOnce(firstClone.session).mockResolvedValueOnce(secondClone.session);
		const service = createSpeechSuggestionService(fake.api);
		const first = service.generate(request);
		const second = service.generate(request);
		await Promise.resolve();
		expect(fake.create).toHaveBeenCalledOnce();
		finishCreate();
		await expect(first).resolves.toEqual(['同時1', '同時2', '同時3']);
		await expect(second).resolves.toEqual(['同時4', '同時5', '同時6']);
		expect(fake.create).toHaveBeenCalledOnce();
		expect(fake.base.clone).toHaveBeenCalledTimes(2);
		service.dispose();
	});

	it('does not let an aborted generation cancel shared base preparation', async () => {
		const fake = fakeApi();
		let finishCreate!: () => void;
		fake.create.mockImplementationOnce(() => new Promise<LanguageModel>((resolve) => {
			finishCreate = () => resolve(fake.base.session);
		}));
		const clone = fakeSession(JSON.stringify({ candidates: ['共有1', '共有2', '共有3'] }));
		fake.base.clone.mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
			if (signal?.aborted) throw abortError();
			return clone.session;
		});
		const service = createSpeechSuggestionService(fake.api);
		const abortedController = new AbortController();
		const first = service.generate(request, { signal: abortedController.signal });
		const second = service.generate(request);
		await Promise.resolve();
		const createOptions = fake.create.mock.calls[0][0];
		abortedController.abort();
		finishCreate();

		await expect(first).rejects.toMatchObject({ name: 'AbortError' });
		await expect(second).resolves.toEqual(['共有1', '共有2', '共有3']);
		expect(createOptions.signal).not.toBe(abortedController.signal);
		expect(fake.create).toHaveBeenCalledOnce();
		expect(fake.base.destroy).not.toHaveBeenCalled();
		expect(clone.destroy).toHaveBeenCalledOnce();
		service.dispose();
	});

	it('aborts an in-flight base preparation and destroys the completed base on dispose', async () => {
		const fake = fakeApi();
		let rejectCreate!: (error: unknown) => void;
		fake.create.mockImplementationOnce((options) => new Promise<LanguageModel>((_resolve, reject) => {
			rejectCreate = reject;
			options.signal?.addEventListener('abort', () => rejectCreate(abortError()), { once: true });
		}));
		const service = createSpeechSuggestionService(fake.api);
		const generation = service.generate(request);
		await Promise.resolve();
		const createOptions = fake.create.mock.calls[0][0];
		service.dispose();

		await expect(generation).rejects.toMatchObject({ name: 'AbortError' });
		expect(createOptions.signal).toBeDefined();
		expect(createOptions.signal!.aborted).toBe(true);
		expect(fake.base.destroy).not.toHaveBeenCalled();
	});

	it('reports download progress and validates malformed output without retrying', async () => {
		const fake = fakeApi();
		const clone = fakeSession(JSON.stringify({ candidates: ['one', 'one', ''] }));
		fake.base.clone.mockResolvedValue(clone.session);
		fake.availability.mockResolvedValue('downloadable');
		const onProgress = vi.fn();
		fake.create.mockImplementationOnce(async (options) => {
			options.monitor?.({
				addEventListener: (_type: string, listener: (event: ProgressEvent) => void) => listener({ loaded: 0.42 } as ProgressEvent)
			} as unknown as CreateMonitor);
			return fake.base.session;
		});

		await expect(createSpeechSuggestionService(fake.api).generate(request, { onProgress })).rejects.toThrow('fewer than three');
		expect(onProgress).toHaveBeenCalledWith({ availability: 'downloadable', progress: 0.42 });
		expect(fake.create).toHaveBeenCalledOnce();
		expect(clone.destroy).toHaveBeenCalledOnce();
	});

	it.each([
		new Error('create failed'),
		new DOMException('create aborted', 'AbortError')
	])('does not cache a failed base creation and retries on the next explicit generation', async (failure) => {
		const fake = fakeApi();
		const clone = fakeSession(JSON.stringify({ candidates: ['返答1', '返答2', '返答3'] }));
		fake.base.clone.mockResolvedValue(clone.session);
		fake.create.mockRejectedValueOnce(failure).mockResolvedValueOnce(fake.base.session);
		const service = createSpeechSuggestionService(fake.api);

		await expect(service.generate(request)).rejects.toBe(failure);
		await expect(service.generate(request)).resolves.toEqual(['返答1', '返答2', '返答3']);
		expect(fake.create).toHaveBeenCalledTimes(2);
		expect(fake.base.clone).toHaveBeenCalledOnce();
	});

	it('clears a broken base after clone failure and preserves it for clone/prompt aborts', async () => {
		const fake = fakeApi();
		const replacement = fakeSession(JSON.stringify({ candidates: ['返答1', '返答2', '返答3'] }));
		fake.base.clone.mockRejectedValueOnce(new Error('clone failed'));
		fake.create.mockResolvedValueOnce(fake.base.session).mockResolvedValueOnce(replacement.session);
		const service = createSpeechSuggestionService(fake.api);

		await expect(service.generate(request)).rejects.toThrow('clone failed');
		expect(fake.base.destroy).toHaveBeenCalledOnce();
		const replacementClone = fakeSession(JSON.stringify({ candidates: ['復旧1', '復旧2', '復旧3'] }));
		replacement.clone.mockResolvedValue(replacementClone.session);
		await expect(service.generate(request)).resolves.toEqual(['復旧1', '復旧2', '復旧3']);

		const abortClone = fakeSession('');
		replacement.clone.mockResolvedValue(abortClone.session);
		abortClone.prompt.mockRejectedValue(abortError());
		await expect(service.generate(request)).rejects.toMatchObject({ name: 'AbortError' });
		expect(replacement.destroy).not.toHaveBeenCalled();
		expect(abortClone.destroy).toHaveBeenCalledOnce();
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
