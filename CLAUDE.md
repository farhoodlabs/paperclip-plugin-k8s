# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working agreement: verify every action

Do not assume any action you take has succeeded. Verify it with the actual outcome, every single time. This applies to:

- **Every git push.** After `git push`, confirm the commit/tag is on the remote (`git ls-remote --tags origin`, or fetch and diff). Don't claim "pushed" until you've seen it land.
- **Every CI/workflow run.** After a tag triggers a workflow, watch the run (`gh run watch` / `gh run list`) until it completes. Report the actual conclusion, not the assumption that it'll succeed.
- **Every npm publish.** After CI claims publish, verify with `npm view <pkg> version` and `npm view <pkg> dist-tags`. Account for CDN propagation lag — if the user reinstalls and the host pulls an older version, that's on you to flag.
- **Every code change.** Run typecheck and tests after edits. Don't ship an "it should work" diff.
- **Every K8s/runtime change.** When something deploys, tail logs or `kubectl describe` until you see the new behavior in real output. Don't infer success from the absence of an error message.

If a step has a verification command, you run it. If verification fails or is ambiguous, say so explicitly — never paper over it. "I pushed and it should be on npm now" is not acceptable. "v0.1.X is on npm and tagged latest, confirmed via `npm view`" is.

When the user is watching live (e.g. tailing pod logs), match their tempo: small, fully-verified steps over big batches of unverified work.

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
    self-image.ts — resolveSelfImage(): reads the worker's own pod via the
                    in-cluster K8s API and returns spec.containers[0].image,
                    used to default the lease pod image
tests/
  plugin.spec.ts — vitest tests; mocks k8s/* modules, uses createEnvironmentTestHarness
```

### Key design points

**Config parsing is the boundary.** Every hook calls `parseDriverConfig(params.config)` at the top. All fields have defaults; nothing throws. `image` may be empty — when it is, `resolveImage(config, client)` in `plugin.ts` falls back to `resolveSelfImage(client)` (reads the worker's own pod spec). `validateConfig` runs the resolver too, so it returns `{ ok: false }` if the field is empty AND we can't auto-resolve (i.e., not running in-cluster).

**`buildClient` is called per-request**, not cached, so kubeconfig changes take effect immediately. Tests mock `../src/k8s/client.js` at the module level via `vi.mock`.

**Pod naming** is deterministic from `leaseId`: `paperclip-lease-<sanitized-leaseId>`. This lets `getLeasePod`/`deleteLeasePod` look up pods without storing state.

**exec wraps the K8s WebSocket exec API** (`@kubernetes/client-node`'s `Exec` class). It builds a `/bin/sh -c` command that layers `cd`, `export`, then `exec <command>`. Exit code comes from the `V1Status` callback, not from a stream.

**reuseLease flag**: `releaseLease` skips pod deletion when `config.reuseLease === true`; `destroyLease` always deletes.

### Host integration constraints

These are upstream behaviors of `paperclipai/paperclip` that the plugin must work around — easy to forget and hard to debug from inside the plugin alone.

**Plugin worker runs with a stripped env.** The host's `server/src/services/plugin-worker-manager.ts` `spawnProcess()` deliberately does not forward `process.env` to the worker — only `PATH`, `NODE_PATH`, `PAPERCLIP_PLUGIN_ID`, `NODE_ENV`, `TZ`. To read anything else the host pod has (e.g. `PAPERCLIP_API_URL`), query the worker's own pod spec via the in-cluster K8s API. `k8s/self-image.ts` already does this for the image; the same pattern extends to `spec.containers[0].env[]`.

**Lease metadata fields the host reads.** `server/src/services/environment-execution-target.ts` reads `lease.metadata.remoteCwd` (where the agent's commands run) and `lease.metadata.paperclipApiUrl`. If `paperclipApiUrl` is set, the host picks `paperclipTransport: "direct"` (agent calls the host API directly via in-cluster service DNS). If null, it falls back to the queue-based callback bridge in `packages/adapter-utils/src/sandbox-callback-bridge.ts`. Setting `paperclipApiUrl` in lease metadata bypasses the bridge entirely.

**RPC timeout asymmetry.** Upstream PR #4802 added `resolvePluginExecuteRpcTimeoutMs` (`server/src/services/plugin-environment-driver.ts`) which extends the `environmentExecute` RPC budget by reading `config.timeoutMs` from the env's driver config. `environmentAcquireLease` has no equivalent — it's capped at the 30s `DEFAULT_RPC_TIMEOUT_MS`. **Pod creation must fit in 30s**, or the host kills acquire even if the plugin would have succeeded.

**Schema evolution has no migration.** Renaming a field in `configSchema` (e.g. `execTimeoutMs` → `timeoutMs` in v0.1.19) does NOT update existing saved env configs in the host's `environments.config` jsonb column. Old rows keep the old key and silently stop working. Options: accept the legacy name as a fallback in `parseDriverConfig`, or have the user re-save the env in the UI to rewrite under the new schema.

**`buildPodManifest` does not set `imagePullPolicy`.** Kubernetes defaults to `Always` for `:latest` tags (digest check on every pod creation; full re-pull on mismatch). For ~1GB images this alone exceeds the 30s acquire budget. Use a digest tag or a non-`:latest` tag so kubelet defaults to `IfNotPresent`. The image auto-default (host pod inheritance) sidesteps this in practice because the host image is already on every node that runs the host.

### Build system

`esbuild.config.mjs` uses `createPluginBundlerPresets()` from `@paperclipai/plugin-sdk/bundlers`. This produces a fully-bundled `dist/worker.js` (all deps inlined) and an unbundled `dist/manifest.js`. There is no UI bundle — this plugin is worker-only.

### Pinning to a local SDK checkout

The SDK (`@paperclipai/plugin-sdk`) resolves from npm by default. To use a local Paperclip checkout, swap the devDependency to `file:../paperclip/packages/plugins/sdk`. That SDK package depends on `@paperclipai/shared` as a workspace package, so symlinking the Paperclip monorepo's `node_modules` is easier than a file-path install.

### Publishing

CI publishes to npm on `v*` tags. The tag must match `package.json` version exactly. The publish job requires an `NPM_TOKEN` repo secret.
