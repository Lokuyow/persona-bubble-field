import { describe, expect, it } from 'vitest';
import { resolveSpeechSubmission, SPEECH_SHORTCUT_IDS } from './speechSubmission';

function resolve(content: string, selectedSpeechType: 'normal' | 'shout' | 'monologue' = 'normal', shortcutId?: string) {
	return resolveSpeechSubmission({ content, selectedSpeechType, shortcutId });
}

describe('resolveSpeechSubmission', () => {
	it.each([
		['normal', 'normal'],
		['shout', 'shout'],
		['monologue', 'monologue']
	] as const)('uses the selected %s speech type when no command is present', (selectedSpeechType, expectedSpeechType) => {
		expect(resolve('hello', selectedSpeechType)).toEqual({ content: 'hello', speechType: expectedSpeechType });
	});

	it.each([
		['/shout hello', 'hello', 'shout'],
		['/s hello', 'hello', 'shout'],
		['/mono hello', 'hello', 'monologue'],
		['/m hello', 'hello', 'monologue']
	] as const)('resolves %s to the canonical content and speech type', (content, expectedContent, speechType) => {
		expect(resolve(content)).toEqual({ content: expectedContent, speechType });
	});

	it.each([
		['/s  hello', ' hello'],
		['/m  hello', ' hello'],
		['/shout  hello\nnext', ' hello\nnext'],
		['/mono hello  ', 'hello  ']
	] as const)('removes only the command and its first ASCII separator from %s', (content, expectedContent) => {
		expect(resolve(content)).toMatchObject({ content: expectedContent });
	});

	it.each([
		' /shout hello',
		' /s hello',
		' /mono hello',
		' /m hello',
		'/shoutout hello',
		'/something',
		'/monologue hello',
		'/me hello',
		'/SHOUT hello',
		'/S hello',
		'/MONO hello',
		'/M hello',
		'foo /shout hello',
		'foo /s hello',
		'/s\nhello',
		'/m\thello'
	])('does not treat %s as a slash command', (content) => {
		expect(resolve(content, 'monologue')).toEqual({ content, speechType: 'monologue' });
	});

	it.each([
		[SPEECH_SHORTCUT_IDS.shout, '/mono hello', 'hello', 'shout'],
		[SPEECH_SHORTCUT_IDS.shout, '/m hello', 'hello', 'shout'],
		[SPEECH_SHORTCUT_IDS.monologue, '/shout hello', 'hello', 'monologue'],
		[SPEECH_SHORTCUT_IDS.monologue, '/s hello', 'hello', 'monologue']
	] as const)('gives shortcut precedence while removing a recognized command prefix', (shortcutId, content, expectedContent, speechType) => {
		expect(resolve(content, 'normal', shortcutId)).toEqual({ content: expectedContent, speechType });
	});

	it('gives shortcut precedence over a selected speech type without a command', () => {
		expect(resolve('hello', 'monologue', SPEECH_SHORTCUT_IDS.shout)).toEqual({ content: 'hello', speechType: 'shout' });
	});

	it('rejects an unknown eHagaki shortcut ID', () => {
		expect(() => resolve('hello', 'normal', 'unknown-shortcut')).toThrow(/Unknown eHagaki submit shortcut/);
	});

	it.each(['/shout', '/shout ', '/s', '/s ', '/mono', '/mono ', '/m', '/m '])('rejects a command without content: %s', (content) => {
		expect(() => resolve(content)).toThrow('A speech command must be followed by message content.');
	});
});
