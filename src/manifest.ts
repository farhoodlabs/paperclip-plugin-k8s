import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "farhoodlabs.k8s-sandbox-provider";
const PLUGIN_VERSION = "0.1.3";

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
          namespace: {
            type: "string",
            description: "Kubernetes namespace for the pod and any owned resources.",
            default: "default",
          },
          image: {
            type: "string",
            description: "Container image to run inside the lease pod.",
          },
          kubeconfigPath: {
            type: "string",
            description: "Path to a kubeconfig file. Falls back to in-cluster config or ~/.kube/config.",
          },
          serviceAccountName: {
            type: "string",
            description: "ServiceAccount to attach to the pod. Supports {companyId} placeholder, e.g. \"paperclip-{companyId}\".",
          },
          workspaceMountPath: {
            type: "string",
            description: "Path inside the pod where the workspace volume is mounted.",
            default: "/workspace",
          },
          pvcName: {
            type: "string",
            description: "Existing PVC name to mount at the workspace path. If omitted, the workspace is ephemeral.",
          },
          reuseLease: {
            type: "boolean",
            description: "Keep the pod running across runs and resume into it on the next lease.",
            default: false,
          },
          podReadyTimeoutMs: {
            type: "number",
            description: "How long to wait for the pod to reach Ready before failing acquire.",
            default: 120000,
          },
          execTimeoutMs: {
            type: "number",
            description: "Default timeout per execute call.",
            default: 300000,
          },
          env: {
            type: "object",
            description: "Environment variables to set on the pod container.",
            additionalProperties: { type: "string" },
          },
        },
        required: ["image"],
      },
    },
  ],
};

export default manifest;
