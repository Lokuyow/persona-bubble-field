# persona-bubble-field

Bootstrap repository for a SvelteKit static web application. The public
service name and product UI are not decided yet; this repository name is only
a temporary development identifier.

## Product specifications and design

See [docs/PROJECT.md](docs/PROJECT.md) for the repository's product
specifications and design documentation.

## Development

Use Node.js 24. The minimum supported version is 24.19.0, and the current
recommended version is 24.19.0. On Windows, do not use Node.js 24.13.0; its
toolchain caused a native crash during investigation.

When using nvm on Windows, select the recommended version explicitly:

```sh
nvm use 24.19.0
```

```sh
npm install
npm run dev
```

For manual verification of the real expiry and death lifecycle, use the
isolated death DEV server:

```text
npm run dev:death
http://localhost:5174/
```

This development-only mode gives newly started Runs an initial lifespan of
3 seconds. It uses a separate origin and browser storage from normal DEV, so
the normal `http://localhost:5173/` Identity and Run are unaffected. The
production initial lifespan remains 7 days.

### Manual Rift operator CLI

The local operator CLI runs on Node.js 24.19 or newer. The default command is
a signed dry-run and never publishes:

```sh
npm run operator:rift:start
```

The explicit publish command requires a hidden local interactive TTY
confirmation and then publishes to the authoritative Relays:

```sh
npm run operator:rift:publish
```

This explicit npm command is the supported publish entrypoint; after an exact
`PUBLISH` confirmation and creator `nsec` verification it can publish a real
EVENT. The CLI's direct `--publish` mode is an implementation entrypoint, not
the recommended invocation. Automated tests and the Windows acceptance
procedure never publish a real EVENT; the acceptance procedure uses only an
invalid marker or Ctrl+C.

The CLI accepts the creator `nsec` only through its hidden interactive TTY
prompt. Never put an `nsec` in argv, an environment variable, a file, or a
pipe. The CLI does not echo unknown argv values, but it cannot guarantee that
an argv secret is hidden from shell history, process listings, npm, or another
layer that runs before the CLI. An `nsec` must only ever be entered at the
hidden TTY prompt. Secret input is not saved to disk or echoed; mutable bytes
are best-effort zeroized, but complete memory erasure cannot be guaranteed.

The creator key, active-manual preflight, and scheduled conflict checks are
validated before publication. Publish results are reported per Relay; one
accepted Relay is an overall success, while all failures are non-zero. Relay
reasons and CLOSED/network messages that are displayed are bounded and safely
sanitized. Unsolicited Relay NOTICE messages are suppressed by the operator
CLI and are never written raw to the terminal. The `PUBLISH` confirmation input
is hidden and is also never echoed.

### DEV World Sandbox

For local field, movement, camera, viewport, and fixture checks without
connecting to a Relay:

```text
http://localhost:5173/?devWorld=1
```

This starts a DEV-only, local-only sandbox with one `Dev Wanderer` participant.
Use the Scenario picker to choose a named fixture. Automation and direct
debugging can select one with `?devWorld=1&devScenario=<id>`. The controls also
keep `devCharacter=<id>` as an independent character option. `Rift Playground`
is a fully local manual Rift simulation: it does not connect to a Relay and
does not modify production persona or Run state.

The DEV World query is ignored in a production build, which continues to start
the normal Relay world.

When checking Relay isolation in browser DevTools, confirm there are no
connections or frames for Relay hosts or Nostr traffic. Vite's development HMR
WebSocket is unrelated to the application and is excluded from that check.

## Verification

```sh
npm run check
npm run build
npm run validate
```

For a GitHub Pages project site, use `npm run build:pages`; it builds with the
repository base path `/persona-bubble-field` on Windows and Linux.

### Character image conversion

Run `npm run characters:images` to convert high-resolution character originals
from the gitignored `.character-sources/` directory into
`static/characters/*.webp`. An alternate input directory can be supplied, for
example `npm run characters:images -- "D:\character originals"`. The source
basename becomes the delivery image filename. Do not use an existing delivery
WebP as input; regenerate from the high-resolution original instead.

Normal runs use SHA-256 fingerprints for the source and output plus the current
pipeline signature. They convert missing, changed, or invalid images and skip
only valid unchanged outputs recorded in the gitignored
`.character-image-cache.json`. Use `npm run characters:images -- --force` to
regenerate every source.

## Licensing

- Source code is available under the [MIT License](LICENSE).
- Character materials, when added and explicitly identified as such, are
  available under [CC0 1.0 Universal](LICENSE-CC0). This covers character
  images, `name`, `about`, and other character-specific content.
- Service names, logos, and other brand assets are not covered by CC0 unless
  explicitly identified as character materials.

See [CHARACTER-MATERIALS.md](CHARACTER-MATERIALS.md) for the scope notice.
