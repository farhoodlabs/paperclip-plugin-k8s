import fs from "node:fs";
import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import type { K8sDriverConfig } from "../config.js";

export interface K8sClient {
  core: CoreV1Api;
  kc: KubeConfig;
}

const SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const SA_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

function isInCluster(): boolean {
  try {
    fs.accessSync(SA_TOKEN_PATH);
    return true;
  } catch {
    return false;
  }
}

// loadFromCluster() relies on KUBERNETES_SERVICE_HOST being present in the
// worker process environment, which isn't guaranteed when the plugin worker is
// spawned as a subprocess. Read the env var ourselves and fall back to the
// well-known in-cluster DNS name so this works regardless.
function loadInCluster(kc: KubeConfig): void {
  const host = process.env.KUBERNETES_SERVICE_HOST ?? "kubernetes.default.svc";
  const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
  const server = host.includes(":")
    ? `https://[${host}]:${port}` // IPv6
    : `https://${host}:${port}`;
  const token = fs.readFileSync(SA_TOKEN_PATH, "utf8").trim();
  kc.loadFromOptions({
    clusters: [{ name: "in-cluster", server, caFile: SA_CA_PATH }],
    users: [{ name: "in-cluster", token }],
    contexts: [{ name: "in-cluster", cluster: "in-cluster", user: "in-cluster" }],
    currentContext: "in-cluster",
  });
}

export function loadKubeConfig(config: K8sDriverConfig): KubeConfig {
  const kc = new KubeConfig();
  if (config.kubeconfigPath) {
    kc.loadFromFile(config.kubeconfigPath);
  } else if (isInCluster()) {
    loadInCluster(kc);
  } else {
    kc.loadFromDefault();
  }
  const cluster = kc.getCurrentCluster();
  if (!cluster?.server || cluster.server.includes("undefined")) {
    throw new Error(
      "No valid Kubernetes cluster URL found. " +
      "Set kubeconfigPath in the environment driver config, " +
      "or ensure a current context is set in ~/.kube/config.",
    );
  }
  return kc;
}

export function buildClient(config: K8sDriverConfig): K8sClient {
  const kc = loadKubeConfig(config);
  return {
    kc,
    core: kc.makeApiClient(CoreV1Api),
  };
}
