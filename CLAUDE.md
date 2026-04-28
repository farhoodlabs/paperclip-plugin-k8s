# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm typecheck          # type-check src + tests (no emit)
pnpm build              # clean + esbuild → dist/worker.js dist/manifest.js
pnpm test               # vitest run (all tests in tests/**/*.spec.ts)
pnpm dev                # esbuild --watch
pnpm build:rollup       # alternative rollup build
```

Run a single test file or filter by name:

```bash
pnpm vitest run tests/plugin.spec.ts
pnpm vitest run --reporter=verbose -t "acquireLease"
```

## Architecture

This is a single-package Paperclip plugin. The host loads `dist/worker.js` as a Node.js worker process and communicates over JSON-RPC via stdin/stdout. `dist/manifest.js` tells the host what capabilities and environment drivers the plugin registers.

### How a Paperclip environment plugin works

The plugin implements the `PluginEnvironmentDriver` contract from `@paperclipai/plugin-sdk`. The host calls lifecycle hooks in this order for each agent run:

```
validateConfig → probe → acquireLease → realizeWorkspace → execute* → releaseLease
                                                                    ↘ destroyLease (force)
```

All hooks are optional methods on the `definePlugin({})` object in `src/plugin.ts`. The `setup(ctx)` hook (required) runs once at worker startup.

### Source layout

```
src/
  manifest.ts   — static plugin manifest (id, capabilities, environmentDrivers schema)
  plugin.ts     — definePlugin() with all onEnvironment* hooks
  worker.ts     — entrypoint: re-exports plugin, calls runWorker()
  config.ts     — parseDriverConfig() parses raw Record<string,unknown> → K8sDriverConfig
  k8s/
    client.ts   — buildClient(): loads KubeConfig → { core: CoreV1Api, kc: KubeConfig }
    pod.ts      — create/get/delete/waitReady pod; buildPodManifest(); podName()
    exec.ts     — execInPod(): streams a command via K8s exec WebSocket API
tests/
  plugin.spec.ts — vitest tests; mocks k8s/* modules, uses createEnvironmentTestHarness
```

### Key design points

**Config parsing is the boundary.** Every hook calls `parseDriverConfig(params.config)` at the top. It throws on missing `image`; the harness catches that in `validateConfig` and returns `{ ok: false }`. All other fields have defaults.

**`buildClient` is called per-request**, not cached, so kubeconfig changes take effect immediately. Tests mock `../src/k8s/client.js` at the module level via `vi.mock`.

**Pod naming** is deterministic from `leaseId`: `paperclip-lease-<sanitized-leaseId>`. This lets `getLeasePod`/`deleteLeasePod` look up pods without storing state.

**exec wraps the K8s WebSocket exec API** (`@kubernetes/client-node`'s `Exec` class). It builds a `/bin/sh -c` command that layers `cd`, `export`, then `exec <command>`. Exit code comes from the `V1Status` callback, not from a stream.

**reuseLease flag**: `releaseLease` skips pod deletion when `config.reuseLease === true`; `destroyLease` always deletes.

### Build system

`esbuild.config.mjs` uses `createPluginBundlerPresets()` from `@paperclipai/plugin-sdk/bundlers`. This produces a fully-bundled `dist/worker.js` (all deps inlined) and an unbundled `dist/manifest.js`. There is no UI bundle — this plugin is worker-only.

### Pinning to a local SDK checkout

The SDK (`@paperclipai/plugin-sdk`) resolves from npm by default. To use a local Paperclip checkout, swap the devDependency to `file:../paperclip/packages/plugins/sdk`. That SDK package depends on `@paperclipai/shared` as a workspace package, so symlinking the Paperclip monorepo's `node_modules` is easier than a file-path install.

### Publishing

CI publishes to npm on `v*` tags. The tag must match `package.json` version exactly. The publish job requires an `NPM_TOKEN` repo secret.
