import { HttpError, type V1Pod, type V1PersistentVolumeClaim } from "@kubernetes/client-node";
import { resolveServiceAccountName, type K8sDriverConfig } from "../config.js";
import type { K8sClient } from "./client.js";

const PAPERCLIP_LEASE_LABEL = "paperclip.farhoodlabs.io/lease-id";
const PAPERCLIP_COMPANY_LABEL = "paperclip.farhoodlabs.io/company-id";
const PAPERCLIP_CREATED_BY_LEASE_LABEL = "paperclip.farhoodlabs.io/created-by-lease-id";
export const PAPERCLIP_MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
export const PAPERCLIP_MANAGED_BY_VALUE = "paperclip-plugin-k8s";
const POLL_INTERVAL_MS = 1000;

export function podName(leaseId: string): string {
  return `paperclip-lease-${leaseId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50)}`;
}

export function buildPodManifest(
  config: K8sDriverConfig,
  leaseId: string,
  companyId: string,
): V1Pod {
  const name = podName(leaseId);
  const env = Object.entries(config.env).map(([k, v]) => ({ name: k, value: v }));
  const volumes = config.workspace.pvc.name
    ? [{ name: "workspace", persistentVolumeClaim: { claimName: config.workspace.pvc.name } }]
    : [{ name: "workspace", emptyDir: {} }];
  const volumeMounts = [{ name: "workspace", mountPath: config.workspace.mountPath }];

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace: config.namespace,
      labels: {
        [PAPERCLIP_LEASE_LABEL]: leaseId,
        [PAPERCLIP_COMPANY_LABEL]: companyId,
        [PAPERCLIP_MANAGED_BY_LABEL]: PAPERCLIP_MANAGED_BY_VALUE,
      },
    },
    spec: {
      restartPolicy: "Never",
      serviceAccountName: resolveServiceAccountName(config, companyId) ?? undefined,
      securityContext: {
        ...(config.runAsUser != null ? { runAsUser: config.runAsUser } : {}),
        ...(config.runAsGroup != null ? { runAsGroup: config.runAsGroup } : {}),
        ...(config.fsGroup != null ? { fsGroup: config.fsGroup } : {}),
      },
      // Chown ONLY the mount point so tar -xf can utime/chmod it. Files inside
      // are created by the main container as runAsUser already; recursing here
      // would be O(filesInPVC) and hurt acquireLease latency.
      initContainers:
        config.runAsUser != null
          ? [
              {
                name: "fix-workspace-perms",
                image: config.image,
                command: [
                  "/bin/sh",
                  "-c",
                  `chown ${config.runAsUser}:${config.runAsGroup ?? config.runAsUser} ${config.workspace.mountPath}`,
                ],
                securityContext: { runAsUser: 0, runAsGroup: 0 },
                volumeMounts,
              },
            ]
          : undefined,
      containers: [
        {
          name: "agent",
          image: config.image,
          command: ["/bin/sh", "-c", "trap 'exit 0' TERM; while true; do sleep 3600 & wait $!; done"],
          workingDir: config.workspace.mountPath,
          env,
          volumeMounts,
          ...(config.resources ? { resources: config.resources } : {}),
        },
      ],
      volumes,
    },
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof HttpError && error.statusCode === 404;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPodReady(pod: V1Pod): boolean {
  if (pod.status?.phase !== "Running") return false;
  const containerStatuses = pod.status?.containerStatuses ?? [];
  if (containerStatuses.length === 0) return false;
  return containerStatuses.every((cs) => cs.ready === true);
}

export function buildPvcManifest(
  config: K8sDriverConfig,
  leaseId: string,
  companyId: string,
): V1PersistentVolumeClaim {
  if (!config.workspace.pvc.name) {
    throw new Error("Cannot build PVC manifest without workspace.pvc.name");
  }
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: config.workspace.pvc.name,
      namespace: config.namespace,
      labels: {
        [PAPERCLIP_MANAGED_BY_LABEL]: PAPERCLIP_MANAGED_BY_VALUE,
        [PAPERCLIP_COMPANY_LABEL]: companyId,
        [PAPERCLIP_CREATED_BY_LEASE_LABEL]: leaseId,
      },
    },
    spec: {
      accessModes: [config.workspace.pvc.accessMode],
      ...(config.workspace.pvc.storageClass
        ? { storageClassName: config.workspace.pvc.storageClass }
        : {}),
      resources: { requests: { storage: config.workspace.pvc.size } },
    },
  };
}

// Idempotent: if the PVC already exists, returns without error. We deliberately
// don't reconcile spec drift (storageClass, size, etc.) — once a PVC exists,
// changing those fields is non-trivial in Kubernetes and the user owns it.
// Returns "created" | "exists" | "skipped" so callers can attribute ownership.
export async function ensureWorkspacePvc(
  client: K8sClient,
  config: K8sDriverConfig,
  leaseId: string,
  companyId: string,
): Promise<"created" | "exists" | "skipped"> {
  if (!config.workspace.pvc.name || !config.workspace.pvc.create) return "skipped";
  try {
    await client.core.readNamespacedPersistentVolumeClaim(
      config.workspace.pvc.name,
      config.namespace,
    );
    return "exists";
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await client.core.createNamespacedPersistentVolumeClaim(
    config.namespace,
    buildPvcManifest(config, leaseId, companyId),
  );
  return "created";
}

export async function createLeasePod(
  client: K8sClient,
  config: K8sDriverConfig,
  leaseId: string,
  companyId: string,
): Promise<V1Pod> {
  await ensureWorkspacePvc(client, config, leaseId, companyId);
  const manifest = buildPodManifest(config, leaseId, companyId);
  const { body } = await client.core.createNamespacedPod(config.namespace, manifest);
  return body;
}

export interface ManagedPodSummary {
  name: string;
  phase: string | null;
  ready: boolean;
  nodeName: string | null;
  ip: string | null;
  createdAt: string | null;
  leaseId: string | null;
  companyId: string | null;
}

// List lease pods in the namespace that this plugin created. Same purpose as
// listManagedPvcs — awareness in probe metadata, no auto-deletion. We filter
// only on the managed-by label so legacy pods (created before v0.2.0 added the
// company-id label) still appear. Per-company filtering is left to the caller
// since the status page that consumes this is instance-scoped anyway.
export async function listManagedPods(
  client: K8sClient,
  namespace: string,
  companyId?: string,
): Promise<ManagedPodSummary[]> {
  const selector = `${PAPERCLIP_MANAGED_BY_LABEL}=${PAPERCLIP_MANAGED_BY_VALUE}`;
  const { body } = await client.core.listNamespacedPod(
    namespace,
    undefined, // pretty
    undefined, // allowWatchBookmarks
    undefined, // _continue
    undefined, // fieldSelector
    selector, // labelSelector
  );
  return (body.items ?? [])
    .filter((pod) => {
      // If a companyId is provided, include pods matching that company OR pods
      // missing the label entirely (legacy, pre-v0.2.0).
      if (!companyId) return true;
      const podCompany = pod.metadata?.labels?.[PAPERCLIP_COMPANY_LABEL];
      return !podCompany || podCompany === companyId;
    })
    .map((pod) => ({
      name: pod.metadata?.name ?? "",
      phase: pod.status?.phase ?? null,
      ready: (pod.status?.containerStatuses ?? []).every((cs) => cs.ready === true)
        && (pod.status?.containerStatuses?.length ?? 0) > 0,
      nodeName: pod.spec?.nodeName ?? null,
      ip: pod.status?.podIP ?? null,
      createdAt: pod.metadata?.creationTimestamp
        ? new Date(pod.metadata.creationTimestamp).toISOString()
        : null,
      leaseId: pod.metadata?.labels?.[PAPERCLIP_LEASE_LABEL] ?? null,
      companyId: pod.metadata?.labels?.[PAPERCLIP_COMPANY_LABEL] ?? null,
    }));
}

export interface ManagedPvcSummary {
  name: string;
  size: string | null;
  storageClass: string | null;
  phase: string | null;
  createdAt: string | null;
  createdByLeaseId: string | null;
  companyId: string | null;
}

// List PVCs in the namespace that this plugin created. Same filtering policy
// as listManagedPods — filter by managed-by only so legacy resources show up.
export async function listManagedPvcs(
  client: K8sClient,
  namespace: string,
  companyId?: string,
): Promise<ManagedPvcSummary[]> {
  const selector = `${PAPERCLIP_MANAGED_BY_LABEL}=${PAPERCLIP_MANAGED_BY_VALUE}`;
  const { body } = await client.core.listNamespacedPersistentVolumeClaim(
    namespace,
    undefined, // pretty
    undefined, // allowWatchBookmarks
    undefined, // _continue
    undefined, // fieldSelector
    selector, // labelSelector
  );
  return (body.items ?? [])
    .filter((pvc) => {
      if (!companyId) return true;
      const pvcCompany = pvc.metadata?.labels?.[PAPERCLIP_COMPANY_LABEL];
      return !pvcCompany || pvcCompany === companyId;
    })
    .map((pvc) => ({
      name: pvc.metadata?.name ?? "",
      size: pvc.spec?.resources?.requests?.storage ?? null,
      storageClass: pvc.spec?.storageClassName ?? null,
      phase: pvc.status?.phase ?? null,
      createdAt: pvc.metadata?.creationTimestamp
        ? new Date(pvc.metadata.creationTimestamp).toISOString()
        : null,
      createdByLeaseId: pvc.metadata?.labels?.[PAPERCLIP_CREATED_BY_LEASE_LABEL] ?? null,
      companyId: pvc.metadata?.labels?.[PAPERCLIP_COMPANY_LABEL] ?? null,
    }));
}

export async function getLeasePod(
  client: K8sClient,
  config: K8sDriverConfig,
  leaseId: string,
): Promise<V1Pod | null> {
  try {
    const { body } = await client.core.readNamespacedPod(podName(leaseId), config.namespace);
    return body;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function deleteLeasePod(
  client: K8sClient,
  config: K8sDriverConfig,
  leaseId: string,
): Promise<void> {
  try {
    await client.core.deleteNamespacedPod(podName(leaseId), config.namespace);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

export async function waitPodReady(
  client: K8sClient,
  config: K8sDriverConfig,
  leaseId: string,
  timeoutMs: number,
): Promise<V1Pod> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pod = await getLeasePod(client, config, leaseId);
    if (pod && isPodReady(pod)) return pod;
    if (pod?.status?.phase === "Failed") {
      const message = pod.status?.message ?? "unknown failure";
      throw new Error(`Pod ${podName(leaseId)} entered Failed phase: ${message}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Pod ${podName(leaseId)} did not become Ready within ${timeoutMs}ms`);
}
