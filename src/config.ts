export interface K8sDriverConfig {
  namespace: string;
  // Empty string means "auto-resolve from the worker's own pod at acquire time."
  image: string;
  kubeconfigPath: string | null;
  serviceAccountName: string | null;
  workspaceMountPath: string;
  pvcName: string | null;
  reuseLease: boolean;
  podReadyTimeoutMs: number;
  timeoutMs: number;
  // When set, surfaced to the host as lease.metadata.paperclipApiUrl (which flips
  // the host's environment-execution-target to paperclipTransport: "direct",
  // bypassing the queue-based callback bridge) and injected into the lease pod's
  // container env as PAPERCLIP_API_URL.
  paperclipApiUrl: string | null;
  env: Record<string, string>;
  runAsUser: number | null;
  runAsGroup: number | null;
  fsGroup: number | null;
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

export function parseDriverConfig(raw: Record<string, unknown>): K8sDriverConfig {
  return {
    namespace: asTrimmedString(raw.namespace) ?? "default",
    image: asTrimmedString(raw.image) ?? "",
    kubeconfigPath: asTrimmedString(raw.kubeconfigPath),
    serviceAccountName: asTrimmedString(raw.serviceAccountName),
    workspaceMountPath: asTrimmedString(raw.workspaceMountPath) ?? "/workspace",
    pvcName: asTrimmedString(raw.pvcName),
    reuseLease: raw.reuseLease === true,
    podReadyTimeoutMs: asPositiveInt(raw.podReadyTimeoutMs, 120_000),
    timeoutMs: asPositiveInt(raw.timeoutMs, 300_000),
    paperclipApiUrl: asTrimmedString(raw.paperclipApiUrl),
    env: asStringMap(raw.env),
    runAsUser: asNonNegativeIntOrNull(raw.runAsUser ?? 1000),
    runAsGroup: asNonNegativeIntOrNull(raw.runAsGroup ?? 1000),
    fsGroup: asNonNegativeIntOrNull(raw.fsGroup ?? 1000),
  };
}
