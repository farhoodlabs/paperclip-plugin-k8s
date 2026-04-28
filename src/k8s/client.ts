import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import type { K8sDriverConfig } from "../config.js";

export interface K8sClient {
  core: CoreV1Api;
  kc: KubeConfig;
}

export function loadKubeConfig(config: K8sDriverConfig): KubeConfig {
  const kc = new KubeConfig();
  if (config.kubeconfigPath) {
    kc.loadFromFile(config.kubeconfigPath);
    return kc;
  }
  // No kubeconfig path — prefer the in-cluster service account mount.
  // Fall back to loadFromDefault() so local dev (kubectl context) still works.
  try {
    kc.loadFromCluster();
  } catch {
    kc.loadFromDefault();
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
