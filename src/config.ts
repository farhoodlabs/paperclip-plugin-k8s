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
  // When set, surfaced to the host as lease.metadata.paperclipApiUrl. The host
  // builds AdapterSandboxExecutionTarget.paperclipApiUrl from this and the claude
  // adapter overrides the agent's PAPERCLIP_API_URL env to point at it.
  paperclipApiUrl: string | null;
  // Forces the host's transport selection. Surfaced as lease.metadata.paperclipTransport.
  // - "direct": skip the in-pod callback bridge; agent calls paperclipApiUrl directly
  // - "bridge": always start the queue-based callback bridge
  // - null: host's auto-logic applies (direct if paperclipApiUrl set, else bridge)
  paperclipTransport: "direct" | "bridge" | null;
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
    paperclipTransport:
      raw.paperclipTransport === "direct" || raw.paperclipTransport === "bridge"
        ? raw.paperclipTransport
        : null,
    env: asStringMap(raw.env),
    runAsUser: asNonNegativeIntOrNull(raw.runAsUser ?? 1000),
    runAsGroup: asNonNegativeIntOrNull(raw.runAsGroup ?? 1000),
    fsGroup: asNonNegativeIntOrNull(raw.fsGroup ?? 1000),
  };
}
