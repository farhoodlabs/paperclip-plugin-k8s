import { HttpError, type V1Pod } from "@kubernetes/client-node";
import { resolveServiceAccountName, type K8sDriverConfig } from "../config.js";
import type { K8sClient } from "./client.js";

const PAPERCLIP_LEASE_LABEL = "paperclip.farhoodlabs.io/lease-id";
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
  // Inject PAPERCLIP_API_URL into the lease pod env when configured, so processes
  // inside the pod can reach the host API directly. config.env still overrides.
  const baseEnv: Record<string, string> = {};
  if (config.paperclipApiUrl) baseEnv.PAPERCLIP_API_URL = config.paperclipApiUrl;
  const mergedEnv = { ...baseEnv, ...config.env };
  const env = Object.entries(mergedEnv).map(([k, v]) => ({ name: k, value: v }));
  const volumes = config.pvcName
    ? [{ name: "workspace", persistentVolumeClaim: { claimName: config.pvcName } }]
    : [{ name: "workspace", emptyDir: {} }];
  const volumeMounts = [{ name: "workspace", mountPath: config.workspaceMountPath }];

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace: config.namespace,
      labels: {
        [PAPERCLIP_LEASE_LABEL]: leaseId,
        "app.kubernetes.io/managed-by": "paperclip-plugin-k8s",
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
                  `chown ${config.runAsUser}:${config.runAsGroup ?? config.runAsUser} ${config.workspaceMountPath}`,
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
          workingDir: config.workspaceMountPath,
          env,
          volumeMounts,
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

export async function createLeasePod(
  client: K8sClient,
  config: K8sDriverConfig,
  leaseId: string,
  companyId: string,
): Promise<V1Pod> {
  const manifest = buildPodManifest(config, leaseId, companyId);
  const { body } = await client.core.createNamespacedPod(config.namespace, manifest);
  return body;
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
