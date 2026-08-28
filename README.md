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
