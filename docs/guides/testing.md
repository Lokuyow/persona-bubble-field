# Testing guidance

Read this guide when adding or changing tests, especially Playwright, browser,
UI, or layout tests. It governs test design; `docs/PROJECT.md` remains the
Source of Truth for commands, validation scope, browser installation, local
test doubles, CI, and Git workflow.

## Test assertions

- Protect the behavior and invariants that matter to users. For UI, layout, and
  geometry, prefer non-overlap, required relationships, containment, target
  correspondence, renderability, actionability, responsive constraints, and the
  correct post-animation state.
- Do not assert incidental design-tuning values such as position, dimensions,
  spacing, colors, opacity, or animation duration unless a specification or
  correctness requirement makes the value meaningful.
- Use exact assertions, ranges, relationships, or behavior according to the
  contract being protected. Do not weaken a meaningful contract merely by
  widening tolerances.

## Playwright E2E structure

- Group tests and specs by behavioral responsibility. Do not add a scenario to
  an existing spec solely because its broad category matches when that makes a
  heavy browser path a serial bottleneck or obscures ownership.
- Keep specs and tests independent of execution order and shared mutable state.
  Use local setup and deterministic synchronization rather than timing races.
- Do not over-split into one test per file merely for parallelism, and do not
  unnaturally divide a meaningful state transition only to create parallel work.

## E2E performance decisions

- Do not require a benchmark or full-suite profile for every new E2E test.
  Profile only after a clear full-suite regression, a repeatedly critical-path
  spec, or worker imbalance indicates a real issue.
- Optimize measured critical paths rather than guessed costs. Do not establish
  repository-wide fixed-second thresholds that vary with environment.
