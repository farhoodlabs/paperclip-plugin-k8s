import { resolveSelfNamespace } from "./k8s/self-image.js";

export interface K8sDriverConfig {
  namespace: string;
  // Empty string means "auto-resolve from the worker's own pod at acquire time."
  image: string;
  kubeconfigPath: string | null;
  serviceAccountName: string | null;
  workspace: K8sWorkspaceConfig;
  reuseLease: boolean;
  podReadyTimeoutMs: number;
  timeoutMs: number;
  env: Record<string, string>;
  runAsUser: number | null;
  runAsGroup: number | null;
  fsGroup: number | null;
  resources: K8sResources | null;
  // When true, the plugin emits verbose logs from each lifecycle hook
  // (validateConfig/probe/acquireLease/resumeLease/execute/etc) prefixed with
  // [debug]. Useful for diagnosing timeouts and config-passthrough issues.
  // Per-env, defaults to false. Toggle without restart by re-saving the env.
  debug: boolean;
}

export interface K8sWorkspaceConfig {
  mountPath: string;
  pvc: K8sWorkspacePvcConfig;
}

export interface K8sWorkspacePvcConfig {
  // Blank/null → ephemeral emptyDir (no persistence).
  name: string | null;
  // When true, the plugin creates the PVC during acquireLease if it doesn't
  // exist. When false, the PVC must already exist or acquire fails.
  create: boolean;
  // Used only when creating a PVC. Blank → cluster's default StorageClass.
  storageClass: string | null;
  // Volume size for newly-created PVCs (k8s quantity string).
  size: string;
  accessMode: string;
}

export interface K8sResources {
  requests: { cpu?: string; memory?: string };
  limits: { cpu?: string; memory?: string };
}

// Resolves {companyId} placeholder in serviceAccountName.
export function resolveServiceAccountName(
  config: K8sDriverConfig,
  companyId: string,
): string | null {
  return config.serviceAccountName?.replace("{companyId}", companyId) ?? null;
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asPositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function asNonNegativeIntOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

function asStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function parseWorkspaceConfig(raw: Record<string, unknown>): K8sWorkspaceConfig {
  const workspace = (raw.workspace && typeof raw.workspace === "object" ? raw.workspace : {}) as Record<string, unknown>;
  const pvc = (workspace.pvc && typeof workspace.pvc === "object" ? workspace.pvc : {}) as Record<string, unknown>;

  // Backward compat: accept legacy top-level workspaceMountPath / pvcName.
  const mountPath =
    asTrimmedString(workspace.mountPath) ??
    asTrimmedString(raw.workspaceMountPath) ??
    "/workspace";
  const name = asTrimmedString(pvc.name) ?? asTrimmedString(raw.pvcName);

  return {
    mountPath,
    pvc: {
      name,
      create: pvc.create === true,
      storageClass: asTrimmedString(pvc.storageClass),
      size: asTrimmedString(pvc.size) ?? "10Gi",
      accessMode: asTrimmedString(pvc.accessMode) ?? "ReadWriteOnce",
    },
  };
}

function asResources(value: unknown): K8sResources | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const pickQuantities = (input: unknown): { cpu?: string; memory?: string } => {
    if (!input || typeof input !== "object") return {};
    const r = input as Record<string, unknown>;
    const out: { cpu?: string; memory?: string } = {};
    if (typeof r.cpu === "string" && r.cpu.trim()) out.cpu = r.cpu.trim();
    if (typeof r.memory === "string" && r.memory.trim()) out.memory = r.memory.trim();
    return out;
  };
  const requests = pickQuantities(raw.requests);
  const limits = pickQuantities(raw.limits);
  if (Object.keys(requests).length === 0 && Object.keys(limits).length === 0) return null;
  return { requests, limits };
}

export function parseDriverConfig(raw: Record<string, unknown>): K8sDriverConfig {
  return {
    namespace: asTrimmedString(raw.namespace) ?? resolveSelfNamespace() ?? "default",
    image: asTrimmedString(raw.image) ?? "",
    kubeconfigPath: asTrimmedString(raw.kubeconfigPath),
    serviceAccountName: asTrimmedString(raw.serviceAccountName),
    workspace: parseWorkspaceConfig(raw),
    reuseLease: raw.reuseLease === true,
    podReadyTimeoutMs: asPositiveInt(raw.podReadyTimeoutMs, 120_000),
    timeoutMs: asPositiveInt(raw.timeoutMs, 300_000),
    env: asStringMap(raw.env),
    runAsUser: asNonNegativeIntOrNull(raw.runAsUser ?? 1000),
    runAsGroup: asNonNegativeIntOrNull(raw.runAsGroup ?? 1000),
    fsGroup: asNonNegativeIntOrNull(raw.fsGroup ?? 1000),
    resources: asResources(raw.resources),
    debug: raw.debug === true,
  };
}
