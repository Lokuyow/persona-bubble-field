# Svelte implementation guidance

Read this guide when changing Svelte source or components. It governs
implementation technique, not product behavior; `docs/PROJECT.md` and the
applicable specifications remain the Source of Truth.

## Components and styling

- New or changed ordinary primary actions use the shared `PrimaryButton` and
  semantic accent tokens. Special or destructive actions may use distinct
  semantic treatment when their meaning requires it.
- Keep component-scoped CSS by default, avoid broad `:global(...)`, and do not
  add wrappers that change geometry, positioning, stacking, measurement, or SSR
  DOM contracts.
- For new conditional classes or substantial markup changes, prefer the
  repository's class array/object syntax such as
  `class={['base', { active: condition }]}`. Existing `class:` directives are
  valid and should not be removed as unrelated cleanup.

## Svelte 5 conventions

- Prefer current non-legacy APIs from the installed Svelte version and existing
  repository patterns. Check installed and official documentation before using
  an unfamiliar or version-sensitive API; do not introduce `svelte/legacy` or
  deprecated APIs without an explicit compatibility requirement.
- Use runes mode: `$props()` for props, `$state` for local state, and `$derived`
  for pure derived state. Use `$effect` only for side effects and `$effect.pre`
  only when it must run before a DOM update; do not use an effect merely to
  synchronize a calculation or introduce top-level `$:` in new runes code.
- Use `$state.raw` only for immutable snapshots, identity-sensitive values, or
  a meaningful need to avoid deep proxying. Use `$bindable` only when the child
  genuinely owns a two-way-bound prop.
- Use callback props and event attributes such as `onclick` and `onkeydown`;
  do not introduce `createEventDispatcher` or legacy `on:` directives in new
  code. Prefer snippets and `{@render ...}` for new composition.

## Lifecycle and ownership

- Prefer native `{@attach ...}` for element-local measurement, observers, and
  imperative lifecycle where the attachment naturally owns the resource. Do
  not create a legacy action solely to wrap it with `fromAction`; keep attachment
  dependencies stable enough to avoid needless listener or observer recreation.
- Prefer `<svelte:window>` and `<svelte:document>` for fitting global-event
  ownership and SSR semantics. `onMount` remains appropriate for browser-only
  resources, dynamic custom elements, and external object listeners; do not
  replace it with `$effect` only for modernization.
- Preserve DOM, measurement, lifecycle ordering, and interaction behavior when
  adopting newer syntax. Do not introduce stores, context, or `.svelte.ts`
  owners merely to reduce prop count or file length.
- Do not increase compiler or `svelte-check` warnings in changed Svelte code.
