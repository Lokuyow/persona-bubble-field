<script lang="ts">
	import { page } from '$app/state';
	import ProfilePresentation from './ProfilePresentation.svelte';
	import ProfileLifeStats from './ProfileLifeStats.svelte';
	import ProfileRootPoints from './ProfileRootPoints.svelte';
	import { projectPublicLifespan } from '$lib/publicProfile';
	import { isNewerPublicProfileEnvelope, type PublicProfileEnvelope, type PublicProfileState } from '$lib/nostrProtocol';
	import type { ProfileReadStatus, ProfileStateUpdate } from '$lib/nostrRelayTransport';
	import { resolveWorldCharacterFromPubkey } from '$lib/worldCharacterAssignment';
	import { getCharacterById } from '$lib/character';
	import type { createWorldReadSession } from '$lib/worldReadSession';

	let { onOpenChange, onCloseAutoFocus, session, currentRunNumber, avatarTone }: {
		onOpenChange: (open: boolean) => void;
		onCloseAutoFocus: (event: Event) => void;
		session: ReturnType<typeof createWorldReadSession> | null;
		currentRunNumber: number | null;
		avatarTone: string;
	} = $props();

	const target = $derived(page.state.profileTarget);
	const pubkey = $derived(target?.kind === 'pubkey' ? target.pubkey : null);
	const character = $derived(target?.kind === 'pubkey' ? resolveWorldCharacterFromPubkey(target.pubkey) ?? null : target?.kind === 'dev-character' ? getCharacterById(target.characterId) ?? null : null);
	const open = $derived(Boolean(target && (target.kind === 'dev-character' || character)));
	let publicState = $state.raw<PublicProfileState | null>(null);
	let readStatus = $state<ProfileReadStatus | 'idle'>('idle');
	let viewerNowMs = $state(Date.now());
	let generation = 0;
	const publicStateCache = new Map<string, Readonly<{ envelope: PublicProfileEnvelope; state: PublicProfileState | null }>>();
	const projectedExpiry = $derived(publicState ? projectPublicLifespan(publicState, viewerNowMs) : null);

	$effect(() => {
		const currentSession = session;
		publicStateCache.clear();
		publicState = null;
		readStatus = 'idle';
		return () => { void currentSession; publicStateCache.clear(); };
	});

	$effect(() => {
		const currentTarget = target;
		const currentPubkey = currentTarget?.kind === 'pubkey' ? currentTarget.pubkey : null;
		const runNumber = currentRunNumber;
		const activeSession = session;
		const currentGeneration = ++generation;
		publicState = null;
		readStatus = 'idle';
		if (!open || !currentPubkey || !runNumber || !activeSession) return;
		const cached = publicStateCache.get(currentPubkey);
		if (cached) {
			publicStateCache.delete(currentPubkey);
			publicStateCache.set(currentPubkey, cached);
			publicState = cached.state?.runNumber === runNumber ? cached.state : null;
			readStatus = 'loading';
		}
		const subscription = activeSession.openProfileState(currentPubkey, (candidate: ProfileStateUpdate) => {
			if (currentGeneration !== generation) return;
			const previous = publicStateCache.get(currentPubkey);
			if (previous && !isNewerPublicProfileEnvelope(candidate.envelope, previous.envelope)) return;
			publicStateCache.delete(currentPubkey);
			publicStateCache.set(currentPubkey, candidate);
			while (publicStateCache.size > 32) publicStateCache.delete(publicStateCache.keys().next().value!);
			publicState = candidate.state?.runNumber === runNumber ? candidate.state : null;
		}, (status) => { if (currentGeneration === generation) readStatus = status; });
		return () => subscription.close();
	});

	$effect(() => {
		if (!open || !publicState) return;
		const timer = window.setInterval(() => { viewerNowMs = Date.now(); }, 1_000);
		return () => window.clearInterval(timer);
	});
</script>

{#if character}
	<ProfilePresentation {open} {character} runLabel={publicState ? `人生 #${publicState.runNumber}` : null}
		description="キャラクターのプロフィールと確認できた公開人生情報" avatarClass={`avatar-${avatarTone}`} onOpenChange={onOpenChange} {onCloseAutoFocus}>
		{#if pubkey && readStatus === 'loading'}<p class="profile-state-status" aria-live="polite">{publicState ? '人生情報を更新中です。' : '人生情報を確認中です。'}</p>
		{:else if pubkey && readStatus !== 'idle' && readStatus !== 'eose'}<p class="profile-state-status" aria-live="polite">{publicState ? '人生情報の更新を確認できませんでした。表示中の情報は前回確認した内容です。' : '人生情報を確認できませんでした。'}</p>{/if}
		{#if publicState && projectedExpiry !== null}
			<section class="profile-section"><h2>人生</h2><ProfileLifeStats expiresAtMs={projectedExpiry} nowMs={viewerNowMs} points={publicState.points} abilities={publicState.abilities} /></section>
			<section class="profile-section"><h2>Root</h2><ProfileRootPoints points={publicState.rootPoints} /></section>
		{/if}
	</ProfilePresentation>
{/if}

<style>
	.profile-state-status { margin: 0; color: #75817d; font-size: 13px; line-height: 1.5; }
	.profile-section { display: grid; gap: 10px; }
	.profile-section h2 { margin: 0; color: #56625e; font-size: 14px; font-weight: 900; letter-spacing: .04em; }
</style>
