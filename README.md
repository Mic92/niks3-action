# niks3-action

GitHub Action for pushing Nix build outputs to a [niks3](https://github.com/Mic92/niks3)
binary cache. Configures the substituter, starts an upload daemon, and drains it
in a post-job step — intermediate derivations get cached even when the build
fails.

## Usage

```yaml
permissions:
  id-token: write
steps:
  - uses: cachix/install-nix-action@v31
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

This is a thin Node wrapper around the `niks3 ci` subcommands. All
orchestration logic (fetching cache config, writing nix.conf, starting the
daemon, draining) lives in the Go binary — this repo only downloads that binary
and provides the main/post lifecycle that composite actions can't have.

The pinned niks3 release version lives in [`NIKS3_VERSION`](NIKS3_VERSION) and
is baked into `dist/index.js` at bundle time.

## Development

```sh
npm ci
npm run build      # regenerates dist/index.js
npm run typecheck
```

`dist/index.js` is committed; CI fails if it is stale.
