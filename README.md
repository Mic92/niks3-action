# niks3-action

GitHub Action for pushing Nix build outputs to a [niks3](https://github.com/Mic92/niks3)
binary cache. Each derivation is uploaded as soon as it finishes building, so
intermediate results are cached even when the build later fails or the job is
cancelled. Authentication uses GitHub OIDC — no secrets to manage.

## Usage

```yaml
permissions:
  id-token: write
steps:
  - uses: actions/checkout@v5
  - uses: NixOS/nix-installer-action@main
  - uses: Mic92/niks3-action@v1
    with:
      server-url: https://niks3.example.com
  - run: nix build .#foo
```

The action fetches the substituter URL, public keys, and OIDC audience from the
server's `/api/cache-config` endpoint, so these don't need to be hardcoded in
the workflow. See the [GitHub Actions wiki page](https://github.com/Mic92/niks3/wiki/GitHub-Actions)
for server configuration and advanced options.

## How it works

- The action configures a substituter so subsequent steps pull from the
  cache, and registers a `post-build-hook` so each derivation is uploaded
  as soon as it finishes building. **Intermediate derivations are cached
  even when the build later fails or the job is cancelled.**
- A post-job step drains any remaining uploads.
- Authentication uses GitHub's built-in OIDC — no secrets to manage.
  The job needs `permissions: id-token: write`. Fork PRs and jobs without
  that permission still get the substituter configured, just no uploads.
- On self-hosted runners where the user is not in Nix's `trusted-users`,
  the action falls back to scanning `/nix/store` after the job and pushing
  the new paths in one go (no caching of partial builds in that case).

## Inputs

| Input | Required | Description |
|---|---|---|
| `server-url` | yes | niks3 server URL |
| `substituter` | no | override the substituter URL, e.g. a CDN mirror (defaults from server) |
| `skip-push` | no | configure the substituter only, don't upload |
| `cache-config-timeout` | no | seconds before each /api/cache-config request times out (default 15) |
| `cache-config-retries` | no | extra attempts to fetch /api/cache-config after a transient failure (default 3) |
| `drain-timeout` | no | seconds to wait for uploads to finish in the post step (default 600) |
| `niks3-bin` | no | path to a niks3 binary, instead of downloading the release |
| `debug` | no | enable debug logging |

## Development

```sh
npm ci
npm run build      # regenerates dist/index.js
npm run typecheck
```

`dist/index.js` is committed; CI fails if it is stale.

The pinned niks3 release version lives in [`NIKS3_VERSION`](NIKS3_VERSION) and
is baked into `dist/index.js` at bundle time.
