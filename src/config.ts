export interface K8sDriverConfig {
  namespace: string;
  image: string;
  kubeconfigPath: string | null;
  serviceAccountName: string | null;
  workspaceMountPath: string;
  pvcName: string | null;
  reuseLease: boolean;
  podReadyTimeoutMs: number;
  execTimeoutMs: number;
  env: Record<string, string>;
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

function asStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function parseDriverConfig(raw: Record<string, unknown>): K8sDriverConfig {
  const image = asTrimmedString(raw.image);
  if (!image) {
    throw new Error("K8s sandbox provider requires `image` in config.");
  }
  return {
    namespace: asTrimmedString(raw.namespace) ?? "default",
    image,
    kubeconfigPath: asTrimmedString(raw.kubeconfigPath),
    serviceAccountName: asTrimmedString(raw.serviceAccountName),
    workspaceMountPath: asTrimmedString(raw.workspaceMountPath) ?? "/workspace",
    pvcName: asTrimmedString(raw.pvcName),
    reuseLease: raw.reuseLease === true,
    podReadyTimeoutMs: asPositiveInt(raw.podReadyTimeoutMs, 120_000),
    execTimeoutMs: asPositiveInt(raw.execTimeoutMs, 300_000),
    env: asStringMap(raw.env),
  };
}
