import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";

import { parseDriverConfig, type K8sDriverConfig } from "./config.js";
import { buildClient, k8sErrorMessage, type K8sClient } from "./k8s/client.js";
import {
  createLeasePod,
  deleteLeasePod,
  getLeasePod,
  podName,
  waitPodReady,
} from "./k8s/pod.js";
import { resolveSelfImage } from "./k8s/self-image.js";
import { execInPod } from "./k8s/exec.js";

async function resolveImage(config: K8sDriverConfig, client: K8sClient): Promise<string> {
  if (config.image) return config.image;
  const fromHost = await resolveSelfImage(client);
  if (fromHost) return fromHost;
  throw new Error(
    "K8s sandbox provider requires `image` in config (and could not auto-detect from the host pod).",
  );
}

function leaseMetadata(input: {
  leaseId: string;
  namespace: string;
  workspaceMountPath: string;
  reuseLease: boolean;
  resumedLease: boolean;
}) {
  // Surface the worker's PAPERCLIP_API_URL so the host's environment-execution-target
  // selects "direct" transport (agent calls the host API directly via in-cluster service
  // DNS) instead of the queue-based callback bridge. Bridge mode is fragile and depends
  // on per-request filesystem sync into the pod; direct mode is a single HTTP hop.
  const paperclipApiUrl = process.env.PAPERCLIP_API_URL?.trim();
  return {
    provider: "k8s",
    leaseId: input.leaseId,
    podName: podName(input.leaseId),
    namespace: input.namespace,
    remoteCwd: input.workspaceMountPath,
    reuseLease: input.reuseLease,
    resumedLease: input.resumedLease,
    ...(paperclipApiUrl ? { paperclipApiUrl } : {}),
  };
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Kubernetes sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Kubernetes sandbox provider plugin healthy" };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    try {
      const config = parseDriverConfig(params.config);
      const image = await resolveImage(config, buildClient(config));
      return { ok: true, normalizedConfig: { ...config, image } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, errors: [message] };
    }
  },

  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const config = parseDriverConfig(params.config);
    try {
      const client = buildClient(config);
      await client.core.readNamespace(config.namespace);
      const image = config.image || (await resolveSelfImage(client)) || null;
      return {
        ok: true,
        summary: `Connected to namespace ${config.namespace}.`,
        metadata: { provider: "k8s", namespace: config.namespace, image },
      };
    } catch (error) {
      return {
        ok: false,
        summary: `Kubernetes probe failed: ${k8sErrorMessage(error)}`,
        metadata: { provider: "k8s", namespace: config.namespace, error: k8sErrorMessage(error) },
      };
    }
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const parsed = parseDriverConfig(params.config);
    const client = buildClient(parsed);
    const config: K8sDriverConfig = { ...parsed, image: await resolveImage(parsed, client) };
    const leaseId = cryptoRandomLeaseId();

    try {
      await createLeasePod(client, config, leaseId, params.companyId);
      await waitPodReady(client, config, leaseId, config.podReadyTimeoutMs);
    } catch (error) {
      throw new Error(`Failed to acquire K8s lease pod: ${k8sErrorMessage(error)}`);
    }

    return {
      providerLeaseId: leaseId,
      metadata: leaseMetadata({
        leaseId,
        namespace: config.namespace,
        workspaceMountPath: config.workspaceMountPath,
        reuseLease: config.reuseLease,
        resumedLease: false,
      }),
    };
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const client = buildClient(config);
    const pod = await getLeasePod(client, config, params.providerLeaseId);
    if (!pod) {
      return { providerLeaseId: null, metadata: { expired: true } };
    }
    return {
      providerLeaseId: params.providerLeaseId,
      metadata: leaseMetadata({
        leaseId: params.providerLeaseId,
        namespace: config.namespace,
        workspaceMountPath: config.workspaceMountPath,
        reuseLease: config.reuseLease,
        resumedLease: true,
      }),
    };
  },

  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    if (config.reuseLease) return;
    const client = buildClient(config);
    await deleteLeasePod(client, config, params.providerLeaseId);
  },

  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    const client = buildClient(config);
    await deleteLeasePod(client, config, params.providerLeaseId);
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const config = parseDriverConfig(params.config);
    const cwd =
      typeof params.lease.metadata?.remoteCwd === "string"
        ? params.lease.metadata.remoteCwd
        : config.workspaceMountPath;
    // TODO: optionally rsync params.workspace into the pod (kubectl cp / tar over exec).
    // For PVC-backed leases this is typically a no-op since the volume persists.
    return {
      cwd,
      metadata: { provider: "k8s", remoteCwd: cwd },
    };
  },

  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    if (!params.lease.providerLeaseId) {
      return {
        exitCode: 1,
        timedOut: false,
        stdout: "",
        stderr: "No provider lease ID available for execution.",
      };
    }
    const config = parseDriverConfig(params.config);
    const client = buildClient(config);
    try {
      return await execInPod(client, config, params.lease.providerLeaseId, {
        command: params.command,
        args: params.args ?? [],
        cwd: params.cwd,
        env: params.env,
        stdin: params.stdin ?? undefined,
        timeoutMs: params.timeoutMs ?? config.timeoutMs,
      });
    } catch (error) {
      throw new Error(`K8s exec failed: ${k8sErrorMessage(error)}`);
    }
  },
});

function cryptoRandomLeaseId(): string {
  return `l${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export default plugin;
