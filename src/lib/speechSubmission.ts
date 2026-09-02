import type { SpeechType } from './conversation';

export const SPEECH_SHORTCUT_IDS = {
	shout: 'persona-speech-shout',
	monologue: 'persona-speech-monologue'
} as const;

export type SpeechShortcutId = (typeof SPEECH_SHORTCUT_IDS)[keyof typeof SPEECH_SHORTCUT_IDS];

export type SpeechSubmissionInput = Readonly<{
	content: string;
	shortcutId?: string;
	selectedSpeechType: SpeechType;
}>;

export type SpeechSubmission = Readonly<{
	content: string;
	speechType: SpeechType;
}>;

type SlashCommand = Readonly<{ token: string; speechType: SpeechType }>;

const SLASH_COMMANDS: readonly SlashCommand[] = [
	{ token: '/shout', speechType: 'shout' },
	{ token: '/s', speechType: 'shout' },
	{ token: '/mono', speechType: 'monologue' },
	{ token: '/m', speechType: 'monologue' }
];

function speechTypeForShortcut(shortcutId: string | undefined): SpeechType | undefined {
	if (shortcutId === undefined) return undefined;
	if (shortcutId === SPEECH_SHORTCUT_IDS.shout) return 'shout';
	if (shortcutId === SPEECH_SHORTCUT_IDS.monologue) return 'monologue';
	throw new Error(`Unknown eHagaki submit shortcut: ${shortcutId}`);
}

function parseSlashCommand(content: string): Readonly<{ content: string; speechType?: SpeechType }> {
	for (const command of SLASH_COMMANDS) {
		if (content === command.token) {
			return { content: '', speechType: command.speechType };
		}
		const prefix = `${command.token} `;
		if (content.startsWith(prefix)) {
			return { content: content.slice(prefix.length), speechType: command.speechType };
		}
	}
	return { content };
}

export function resolveSpeechSubmission(input: SpeechSubmissionInput): SpeechSubmission {
	const shortcutSpeechType = speechTypeForShortcut(input.shortcutId);
	const parsed = parseSlashCommand(input.content);
	if (parsed.speechType && parsed.content.length === 0) {
		throw new Error('A speech command must be followed by message content.');
	}

	return {
		content: parsed.content,
		speechType: shortcutSpeechType ?? parsed.speechType ?? input.selectedSpeechType ?? 'normal'
	};
}
