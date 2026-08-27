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

## Licensing

- Source code is available under the [MIT License](LICENSE).
- Character materials, when added and explicitly identified as such, are
  available under [CC0 1.0 Universal](LICENSE-CC0). This covers character
  images, `name`, `about`, and other character-specific content.
- Service names, logos, and other brand assets are not covered by CC0 unless
  explicitly identified as character materials.

See [CHARACTER-MATERIALS.md](CHARACTER-MATERIALS.md) for the scope notice.
