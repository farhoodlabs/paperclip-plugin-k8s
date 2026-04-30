import fs from "node:fs";
import os from "node:os";
import type { K8sClient } from "./client.js";

const SA_NAMESPACE_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";

let cached: string | null | undefined;

// Read the image of the worker's own pod so the lease pod can default to the
// same image. This means the lease image is digest-pinned to whatever shipped
// with the host, and is virtually guaranteed to already be cached on whichever
// node ran the host — eliminating cold image pulls from the acquire path.
export async function resolveSelfImage(client: K8sClient): Promise<string | null> {
  if (cached !== undefined) return cached;
  cached = await readSelfImage(client);
  return cached;
}

async function readSelfImage(client: K8sClient): Promise<string | null> {
  let namespace: string;
  try {
    namespace = fs.readFileSync(SA_NAMESPACE_PATH, "utf8").trim();
  } catch {
    return null;
  }
  if (!namespace) return null;

  const podName = (process.env.HOSTNAME ?? os.hostname()).trim();
  if (!podName) return null;

  try {
    const { body } = await client.core.readNamespacedPod(podName, namespace);
    return body.spec?.containers?.[0]?.image ?? null;
  } catch {
    return null;
  }
}

export function __resetSelfImageCache(): void {
  cached = undefined;
}
