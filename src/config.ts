import { resolveSelfNamespace } from "./k8s/self-image.js";

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
  env: Record<string, string>;
  runAsUser: number | null;
  runAsGroup: number | null;
  fsGroup: number | null;
  resources: K8sResources | null;
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
    workspaceMountPath: asTrimmedString(raw.workspaceMountPath) ?? "/workspace",
    pvcName: asTrimmedString(raw.pvcName),
    reuseLease: raw.reuseLease === true,
    podReadyTimeoutMs: asPositiveInt(raw.podReadyTimeoutMs, 120_000),
    timeoutMs: asPositiveInt(raw.timeoutMs, 300_000),
    env: asStringMap(raw.env),
    runAsUser: asNonNegativeIntOrNull(raw.runAsUser ?? 1000),
    runAsGroup: asNonNegativeIntOrNull(raw.runAsGroup ?? 1000),
    fsGroup: asNonNegativeIntOrNull(raw.fsGroup ?? 1000),
    resources: asResources(raw.resources),
  };
}
