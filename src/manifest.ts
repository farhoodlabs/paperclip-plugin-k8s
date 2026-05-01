import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "farhoodlabs.k8s-sandbox-provider";
const PLUGIN_VERSION = "0.1.29";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Kubernetes Sandbox Provider",
  description:
    "Provisions a long-lived Kubernetes pod per environment lease and routes adapter command execution through the K8s exec API.",
  author: "farhoodlabs",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "k8s",
      kind: "sandbox_provider",
      displayName: "Kubernetes Pod",
      description:
        "Runs each environment lease as a long-lived pod, with optional PVC-backed workspace and lease reuse across runs.",
      configSchema: {
        type: "object",
        properties: {
          // --- Cluster connection ---
          kubeconfigPath: {
            type: "string",
            description: "Path to a kubeconfig file. Falls back to in-cluster config or ~/.kube/config.",
          },

          // --- Pod identity ---
          namespace: {
            type: "string",
            description: "Kubernetes namespace for the lease pod and any owned resources. When the plugin worker runs in-cluster and this is left blank, defaults to the worker's own namespace (read from the in-cluster service account). Falls back to \"default\" otherwise.",
          },
          image: {
            type: "string",
            description: "Container image to run inside the lease pod. When the plugin worker runs in-cluster and this is left blank, defaults to the worker's host pod image, which is digest-pinned and already cached on the node.",
          },
          serviceAccountName: {
            type: "string",
            description: "ServiceAccount to attach to the pod. Supports {companyId} placeholder, e.g. \"paperclip-{companyId}\".",
          },

          // --- Workspace ---
          workspaceMountPath: {
            type: "string",
            description: "Path inside the pod where the workspace volume is mounted.",
            default: "/workspace",
          },
          pvcName: {
            type: "string",
            title: "Workspace PVC Name",
            description: "Existing PVC name to mount at the workspace path. If omitted, the workspace is ephemeral.",
          },

          // --- Security context (UID/GID/fsGroup) ---
          runAsUser: {
            type: "number",
            description: "UID for the pod's containers. Defaults to 1000 (the `node` user in the Paperclip image).",
            default: 1000,
          },
          runAsGroup: {
            type: "number",
            description: "GID for the pod's containers. Defaults to 1000.",
            default: 1000,
          },
          fsGroup: {
            type: "number",
            description: "fsGroup applied to mounted volumes so the runAsUser can write. Defaults to 1000.",
            default: 1000,
          },

          // --- Resource requests/limits ---
          resources: {
            type: "object",
            title: "Resources",
            description: "CPU and memory requests/limits for the lease pod's agent container. Standard Kubernetes quantity strings (e.g. \"500m\", \"2\", \"512Mi\", \"4Gi\"). Leave blank for no limits.",
            properties: {
              requests: {
                type: "object",
                title: "Requests",
                description: "Minimum resources reserved for the pod (used by the scheduler).",
                properties: {
                  cpu: { type: "string", title: "CPU", description: "e.g. 500m, 1, 2" },
                  memory: { type: "string", title: "Memory", description: "e.g. 256Mi, 1Gi" },
                },
              },
              limits: {
                type: "object",
                title: "Limits",
                description: "Maximum resources the pod can consume (kubelet enforces; CPU throttles, memory triggers OOM).",
                properties: {
                  cpu: { type: "string", title: "CPU", description: "e.g. 1, 2, 4" },
                  memory: { type: "string", title: "Memory", description: "e.g. 1Gi, 4Gi, 8Gi" },
                },
              },
            },
          },

          // --- Lease behavior ---
          reuseLease: {
            type: "boolean",
            description: "Keep the pod running across runs and resume into it on the next lease.",
            default: false,
          },

          // --- Timeouts ---
          podReadyTimeoutMs: {
            type: "number",
            title: "Pod Ready Timeout (ms)",
            description: "How long to wait for the pod to reach Ready before failing acquire.",
            default: 120000,
          },
          timeoutMs: {
            type: "number",
            title: "Timeout (ms)",
            description: "Default timeout per execute call. The host extends its environmentExecute RPC budget to match this value.",
            default: 300000,
          },

          // --- Environment variables ---
          env: {
            type: "object",
            description: "Environment variables to set on the pod container.",
            properties: {
              PAPERCLIP_API_URL: {
                type: "string",
                title: "PAPERCLIP_API_URL",
                description: "URL the agent inside the lease pod uses to reach the host Paperclip API (e.g. https://your-host or http://paperclip.<ns>.svc.cluster.local:3100). Setting this enables direct mode: the host routes the agent's API calls straight to this URL via a single HTTP hop instead of through the queue-based in-pod callback bridge. Leave blank to use bridge mode.",
              },
            },
            additionalProperties: { type: "string" },
          },
        },
      },
    },
  ],
};

export default manifest;
