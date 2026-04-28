# `@farhoodlabs/paperclip-plugin-k8s`

Kubernetes sandbox provider plugin for Paperclip.

Implements the `PluginEnvironmentDriver` contract from `@paperclipai/plugin-sdk`,
provisioning a long-lived Kubernetes pod (with optional persistent workspace
volume) per environment lease. Stock agent adapters such as `claude-local` and
`opencode-local` route their command execution through this plugin when the
environment is configured to use the `k8s` driver, so the same plugin works for
any agent runtime without per-runtime forks.

## Status

Scaffolded. Lifecycle hooks are stubs marked with `TODO`.

## Lease model

| Hook | K8s mapping |
|---|---|
| `acquireLease` | Create a `Pod` (and optionally a `PersistentVolumeClaim`); wait for ready |
| `resumeLease` | Look up the pod by name; expire if missing |
| `releaseLease` | If `reuseLease`, leave the pod running; else delete it |
| `destroyLease` | Delete the pod (and PVC if owned) |
| `realizeWorkspace` | Ensure the workspace path exists inside the pod |
| `execute` | Stream a command into the pod via the K8s exec API |

## Local development

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

`@paperclipai/plugin-sdk` is declared as a peer dependency and resolves from
npm. To pin against a local checkout instead, swap the peer dep for
`file:../paperclip/packages/plugins/sdk` (note: that SDK depends on
`@paperclipai/shared` as a workspace package, so a symlink is usually easier
than a file: install).
