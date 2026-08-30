import type { Character } from './character';
import {
	markCharacterProfilePublication,
	type AccountSnapshot
} from './nostrAccount';
import {
	buildCharacterProfileTemplate,
	finalizeCharacterProfileEvent
} from './nostrProtocol';
import type { PublishRelayResult } from './nostrRelayTransport';
import type { VerifiedEvent } from 'nostr-tools/pure';

export type PreparedCharacterProfilePublication = Readonly<{
	account: AccountSnapshot;
	event: VerifiedEvent;
}>;

export type CharacterProfilePublicationResult = Readonly<{
	kind: 'recorded' | 'stale' | 'retryable';
}>;

export function prepareCharacterProfilePublication(input: Readonly<{
	account: AccountSnapshot;
	character: Character;
	absolutePictureUrl: string;
	createdAt: number;
}>): PreparedCharacterProfilePublication {
	const template = buildCharacterProfileTemplate({
		character: input.character,
		absolutePictureUrl: input.absolutePictureUrl,
		createdAt: input.createdAt
	});
	return {
		account: input.account,
		event: finalizeCharacterProfileEvent(template, input.account.secretKey)
	};
}

/** NIP-01 duplicate is a success only when it is the exact machine-readable prefix. */
export function reachedAuthoritativeRelay(results: readonly PublishRelayResult[]): boolean {
	return results.some((result) =>
		result.outcome === 'accepted' ||
		(result.outcome === 'rejected' && result.notice?.startsWith('duplicate:'))
	);
}

/** Never throws: publication failures remain retryable and do not affect the world-read lifecycle. */
export async function publishCharacterProfile(
	publication: PreparedCharacterProfilePublication,
	publish: (event: VerifiedEvent) => Promise<readonly PublishRelayResult[]>
): Promise<CharacterProfilePublicationResult> {
	try {
		const results = await publish(publication.event);
		if (!reachedAuthoritativeRelay(results)) return { kind: 'retryable' };
		return await markCharacterProfilePublication(publication.account);
	} catch {
		return { kind: 'retryable' };
	}
}
