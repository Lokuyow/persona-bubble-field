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
	type ProfilePresentationSnapshot = {
		character: NonNullable<typeof character>;
		runLabel: string | null;
		avatarClass: string;
		statusMessage: string | null;
		lifeStats: { expiresAtMs: number; nowMs: number; points: number; abilities: PublicProfileState['abilities'] } | null;
		rootPoints: number | null;
	};
	const livePresentation = $derived.by((): ProfilePresentationSnapshot | null => {
		if (!character) return null;
		return {
			character,
			runLabel: publicState ? `人生 #${publicState.runNumber}` : null,
			avatarClass: `avatar-${avatarTone}`,
			statusMessage: pubkey && readStatus !== 'loading' && readStatus !== 'idle' && readStatus !== 'eose'
				? publicState ? '人生情報の更新を確認できませんでした。表示中の情報は前回確認した内容です。' : '人生情報を確認できませんでした。'
				: null,
			lifeStats: publicState && projectedExpiry !== null
				? { expiresAtMs: projectedExpiry, nowMs: viewerNowMs, points: publicState.points, abilities: publicState.abilities }
				: null,
			rootPoints: publicState && projectedExpiry !== null ? publicState.rootPoints : null
		};
	});
	let closingPresentation = $state<ProfilePresentationSnapshot | null>(null);
	$effect(() => {
		if (open && livePresentation) closingPresentation = livePresentation;
	});
	const presentation = $derived(open ? livePresentation : closingPresentation);
	function handleOpenChangeComplete(isOpen: boolean): void {
		if (!isOpen && !open) closingPresentation = null;
	}

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

	<ProfilePresentation {open} character={presentation?.character ?? null} runLabel={presentation?.runLabel ?? null}
		description="キャラクターのプロフィールと確認できた公開人生情報" avatarClass={presentation?.avatarClass ?? ''} onOpenChange={onOpenChange} {onCloseAutoFocus} onOpenChangeComplete={handleOpenChangeComplete}>
		{#if presentation?.statusMessage}<p class="profile-state-status" aria-live="polite">{presentation.statusMessage}</p>{/if}
		{#if presentation?.lifeStats}
			<div class="profile-section"><ProfileLifeStats {...presentation.lifeStats} /></div>
			{#if presentation.rootPoints !== null}<div class="profile-section"><ProfileRootPoints points={presentation.rootPoints} /></div>{/if}
		{/if}
	</ProfilePresentation>

<style>
	.profile-state-status { margin: 0; color: #75817d; font-size: 13px; line-height: 1.5; }
	.profile-section { display: grid; gap: 10px; }
</style>
