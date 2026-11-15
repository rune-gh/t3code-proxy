# t3code-proxy web panel

The management panel for [t3code-proxy](https://github.com/rune-oai/t3code-proxy): a React 19 +
TypeScript + Vite app that talks to the server's Management API under `/v8/management`. It lets you
manage provider keys, OAuth logins and auth files, quotas, routing, configuration and logs. The panel
ships in English only.

The production build is a single self-contained `dist/index.html` (JS, CSS and assets inlined by
`vite-plugin-singlefile`), which the Go server embeds and serves.

## Development

Requires **Bun 1.4.3** (pinned in `package.json`).

```bash
bun install --frozen-lockfile   # install locked dependencies
bun run dev                     # Vite dev server at http://localhost:5173
bun run test                    # Bun tests under tests/
bun run lint                    # ESLint
bun run type-check              # tsc --noEmit
bun run build                   # type-check + production build to dist/index.html
bun run verify                  # test + lint + build
```

### Fixture session

In dev mode, open `http://localhost:5173/?fixture=quota-history#/quota` to get a logged-in session
backed by sample data, without a running server. The fixture works on other routes too, for
example `#/ai-providers`, `#/oauth`, `#/config` or `#/system`. It is compiled out of production
builds.

## Embedding into the server

The Go server serves the panel from an embedded copy. After changing the panel, rebuild it and copy
the artifact into the backend tree:

```bash
bun run build
cp dist/index.html ../internal/managementasset/embedded/management.html
```

Then rebuild the server binary from the repository root.

## License

MIT, see [LICENSE](LICENSE). The panel is derived from the CLI Proxy API Management Center; the
original copyright notice is kept in `LICENSE`.
