# Repository instructions

This file defines repository-level working rules for coding agents.

Product specifications and design start at [docs/PROJECT.md](docs/PROJECT.md).
Individual domain specifications are in [docs/specs/](docs/specs/).

Before planning or implementing work, read `docs/PROJECT.md` and the
specifications relevant to the task.

`docs/research/` contains reference material. It may inform technical
decisions, but it is not the Source of Truth for product specifications.

## Source of Truth

- Treat `docs/PROJECT.md` and the applicable documents under `docs/specs/` as
  the Source of Truth for product behavior and design.
- Normally use the specifications merged into `main`.
- When a branch or pull request intentionally changes specifications together
  with implementation, use the specifications in that checkout as part of the
  proposed change.
- Do not infer or change specifications merely to fit the existing
  implementation.
- Do not invent product behavior, protocol behavior, compatibility
  requirements, or undocumented APIs.
- If an important prerequisite is not satisfied and the repository or
  applicable specifications cannot resolve it, report the finding instead of
  guessing.
- Do not duplicate product specifications into this file. Put product
  decisions in the appropriate specification document.

## Before editing

- Read the target files, their callers, related state, services, utilities, and
  relevant tests before deciding how to change them.
- Follow the current code's naming, architecture, and responsibility
  boundaries.
- Preserve existing user-visible behavior unless the requested change or an
  applicable specification requires otherwise.
- Keep changes within the requested scope. Do not mix unrelated refactoring,
  cleanup, or redesign into feature work or bug fixes.
- Check the repository, `package.json`, local types, existing project usage,
  and relevant documentation before adding a dependency or duplicating
  functionality.
- Prefer existing project abstractions and installed-library APIs over new
  bespoke implementations when they already satisfy the requirement.
- When work depends on an external library API or web-platform behavior,
  verify the current API or specification rather than relying on assumptions.
- For Nostr protocol work, verify the applicable NIPs and the project
  specifications. Do not infer protocol semantics from UI behavior or from
  another client's implementation.

## Implementation principles

### Root cause before fallback

When fixing a defect or unexpected behavior:

1. Reproduce or identify the failing behavior.
2. Trace the relevant control flow and state transitions.
3. Determine the root cause.
4. Apply the smallest change that fixes that cause.
5. Add or update regression coverage at the lowest sufficient level.

Do not leave a known root cause in place and hide it behind a fallback,
workaround, arbitrary delay, duplicate state, broad catch, silent default, or
unrelated invalidation.

A fallback is appropriate only when it is required by an explicit product
requirement, a supported compatibility requirement, or verified runtime
behavior.

### No speculative compatibility

Do not add legacy paths, migrations, compatibility branches, adapters, or
fallback behavior for hypothetical future users or unreleased designs.

Preserve compatibility when there is a confirmed requirement such as:

- Published behavior or interfaces that must remain supported
- Existing persisted user data
- Supported external integrations
- An explicit product specification

When no such requirement exists, prefer a clean replacement over maintaining
old and new implementations in parallel.

### Avoid premature abstraction

Do not turn one implementation case, one review finding, or an artificial edge
case into a repository-wide abstraction.

Before introducing a new shared helper, adapter, service layer, state machine,
generic extension point, or coordination mechanism, confirm that it solves a
real repeated problem and is simpler than keeping the behavior local.

For isolated cases, prefer the smallest clear implementation that satisfies the
current requirement.

This does not prevent immediate fixes for security problems, data loss,
protocol violations, specification violations, or reproducible defects.

### Keep responsibilities explicit

- Keep rendering concerns separate from protocol, persistence, and domain
  logic where the existing architecture already makes that distinction.
- Keep Nostr event construction, validation, signing, relay behavior, and
  product-specific semantics in the responsibility boundaries defined by the
  project specifications.
- Do not move persona-bubble-field-specific behavior into eHagaki merely
  because eHagaki is involved in the posting flow.
- Reuse existing responsibility boundaries instead of creating parallel paths
  for the same operation.

## Tests and verification

Use the repository's current scripts and `docs/PROJECT.md` to determine
required verification. `package.json` is the Source of Truth for available npm
commands.

- Run the narrowest relevant tests while implementing.
- Add or update tests when behavior, protocol construction, deterministic
  domain logic, or a regression requires coverage.
- Broaden verification according to the affected area before finishing.
- Run the project-required validation for the task when specified by
  `docs/PROJECT.md` or the reviewed Plan.
- Use real-browser verification when unit-level tests cannot establish the
  relevant browser or layout behavior.
- Keep tests deterministic. Do not depend on real relays, external network
  availability, real accounts, secrets, or timing races unless the task
  explicitly requires an integration check that cannot be performed
  otherwise.
- Do not claim that a test, check, build, browser verification, or CI job
  passed unless it was actually run and observed to pass.
- Report relevant verification that was not run and the reason.

Remove temporary logs, debugging instrumentation, test harnesses, screenshots,
traces, and discarded experimental changes before finishing unless they are
intentionally part of the requested deliverable.

## Secrets and sensitive material

Never expose Nostr private keys, `nsec` values, authentication material,
tokens, credentials, or other secrets in:

- Logs
- Test fixtures
- Screenshots
- Error messages
- Commit messages
- Pull request descriptions
- Final reports

Use clearly fake deterministic values when tests require secret-like data.

## Git and task scope

Follow the Git workflow defined in `docs/PROJECT.md` and the current reviewed
Plan or task instruction.

Do not commit, push, create or update a pull request, merge, release, deploy,
force-push, or rewrite history unless the current task or reviewed Plan
explicitly requires that operation.

Do not modify repository instruction files, specifications, or unrelated
documentation as a side effect of implementation work unless the task requires
those changes.

When implementation reveals that an existing specification must change, do not
silently change product behavior. Treat it as a specification issue and report
the conflict or update the specification only when that change is part of the
approved task.

## Final report

For implementation work, report the information needed to review the result:

- Root cause or implementation rationale
- Files and responsibilities changed
- Why the solution satisfies the applicable specification
- Existing behavior intentionally preserved
- Relevant risks or limitations that remain
- Tests, checks, builds, or browser verification actually run and their results
- Relevant verification not run and why
- Branch, commit, and pull request details when Git operations were part of the
  task

Keep the report focused on evidence needed to review the change.