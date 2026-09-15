import type { Character } from './character';
import {
	markCharacterProfilePublication,
	type ActiveSignerSnapshot
	} from './rootIdentity';
import {
	buildCharacterProfileTemplate,
	finalizeCharacterProfileEvent
} from './nostrProtocol';
import type { PublishRelayResult } from './nostrRelayTransport';
import type { VerifiedEvent } from 'nostr-tools/pure';

export type PreparedCharacterProfilePublication = Readonly<{
	signer: ActiveSignerSnapshot;
	event: VerifiedEvent;
}>;

export type CharacterProfilePublicationResult = Readonly<{
	kind: 'recorded' | 'stale' | 'retryable';
}>;

export function prepareCharacterProfilePublication(input: Readonly<{
	signer: ActiveSignerSnapshot;
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
		signer: input.signer,
		event: finalizeCharacterProfileEvent(template, input.signer.secretKey)
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
		return await markCharacterProfilePublication(publication.signer);
	} catch {
		return { kind: 'retryable' };
	}
}
