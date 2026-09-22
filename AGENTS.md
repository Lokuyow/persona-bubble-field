# Repository instructions

This file defines repository-wide rules for coding agents.

Product specifications and design start at [docs/PROJECT.md](docs/PROJECT.md);
domain specifications are in [docs/specs/](docs/specs/). Before planning or
implementing, read `docs/PROJECT.md` and the specifications relevant to the
task. `docs/research/` is reference material, not the Source of Truth.

Read additional guidance only when its scope applies:

- For Svelte source or component changes, read [Svelte implementation
  guidance](docs/guides/svelte.md).
- For adding or changing tests, especially Playwright, browser, UI, or layout
  tests, read [testing guidance](docs/guides/testing.md).
- For local validation, CI, and Git workflow, use `docs/PROJECT.md`; do not
  duplicate its operational policy here.

## Source of Truth

- Treat `docs/PROJECT.md` and applicable `docs/specs/` documents as the Source
  of Truth for product behavior and design. Normally use the specifications
  merged into `main`; use branch specifications only when they intentionally
  change with the implementation.
- Do not infer or change specifications to fit implementation, invent product,
  protocol, compatibility, or undocumented API behavior, or duplicate product
  decisions here. Report unresolved prerequisites instead of guessing.

## Before editing

- Read the target, its callers, related state/services/utilities, and relevant
  tests. Follow established naming, architecture, and responsibility boundaries.
- Preserve user-visible behavior unless the task or applicable specification
  requires a change; keep work within scope and avoid unrelated cleanup.
- Inspect existing project facilities before adding dependencies or duplicating
  behavior. Verify unfamiliar library or web-platform APIs; for Nostr work,
  verify the applicable NIPs and project specifications.

## Implementation principles

### Root cause before fallback

Reproduce or trace the problem, identify its cause, make the smallest causal
change, and add the lowest sufficient regression coverage. Do not hide a known
cause behind a fallback, delay, duplicate state, broad catch, silent default,
or unrelated invalidation. Use a fallback only when an explicit product or
supported-compatibility requirement, or verified runtime behavior, requires it.

### No speculative compatibility

Do not retain compatibility for hypothetical users, unreleased designs, or
stale callers. Intentional prototype changes are clean breaks: update or remove
affected callers, tests, fixtures, and local data instead of adding aliases,
migrations, adapters, dual support, or compatibility-only fallbacks.

Maintain explicitly supported data, identities, public interfaces, and external
integrations, including required Nostr/NIP, Relay, browser, and Web Platform
interoperability. This does not authorize unrelated behavior changes.

### Avoid premature abstraction

Do not create a shared helper, adapter, service, state machine, generic
extension point, or coordination mechanism for one case. Introduce one only for
a demonstrated repeated problem when it is simpler than a local solution. This
does not delay fixes for security, data loss, protocol, specification, or
reproducible defects.

### Keep responsibilities explicit

- Preserve established separation of rendering, protocol, persistence, and
  domain logic.
- Keep Nostr construction, validation, signing, and Relay behavior within the
  boundaries specified by the project.
- Do not move persona-bubble-field-specific behavior into eHagaki merely
  because it participates in posting; reuse existing ownership boundaries.

## Tests and verification

- Run and add the lowest sufficient deterministic coverage for changed behavior
  or regressions; use browser verification when unit-level checks cannot prove
  browser or layout behavior.
- Do not rely on real relays, external network, real accounts, secrets, or
  timing races unless an explicitly required integration check cannot avoid it.
- Follow `docs/PROJECT.md` and the reviewed Plan for required validation. Claim
  only checks actually observed, and report relevant checks intentionally not
  run and why.
- Remove temporary logs, instrumentation, harnesses, screenshots, traces, and
  discarded experiments unless they are an intentional deliverable.

## Secrets and sensitive material

Never expose Nostr private keys, `nsec` values, authentication material,
tokens, credentials, or other secrets in logs, test fixtures, screenshots,
errors, commits, pull requests, or final reports. Use clearly fake,
deterministic values where tests need secret-like data.

## Git and task scope

Follow the Git workflow in `docs/PROJECT.md` and the current reviewed Plan or
task instruction. Do not commit, push, create or update a pull request, merge,
release, deploy, force-push, or rewrite history unless explicitly authorized.

Do not modify repository instructions, specifications, or unrelated
documentation as an implementation side effect. If implementation exposes a
specification conflict, report it; change the specification only when that is
part of the approved task.

## Final report

For implementation work, report the rationale/root cause, changed files and
responsibilities, specification fit and intentionally preserved behavior,
remaining risks, verification run and omitted (with reasons), and branch,
commit, and pull-request details when Git operations occurred. Keep the report
focused on reviewable evidence.
