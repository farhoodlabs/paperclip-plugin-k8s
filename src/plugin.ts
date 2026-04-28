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

import { parseDriverConfig } from "./config.js";
import { buildClient } from "./k8s/client.js";
import {
  createLeasePod,
  deleteLeasePod,
  getLeasePod,
  podName,
  waitPodReady,
} from "./k8s/pod.js";
import { execInPod } from "./k8s/exec.js";

function leaseMetadata(input: {
  leaseId: string;
  namespace: string;
  workspaceMountPath: string;
  reuseLease: boolean;
  resumedLease: boolean;
}) {
  return {
    provider: "k8s",
    leaseId: input.leaseId,
    podName: podName(input.leaseId),
    namespace: input.namespace,
    remoteCwd: input.workspaceMountPath,
    reuseLease: input.reuseLease,
    resumedLease: input.resumedLease,
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
      return { ok: true, normalizedConfig: { ...config } };
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
      // TODO: replace with a real namespace lookup (e.g. core.readNamespace) so the
      // probe actually exercises kubeconfig + RBAC.
      void client;
      return {
        ok: true,
        summary: `Loaded kubeconfig for namespace ${config.namespace}.`,
        metadata: { provider: "k8s", namespace: config.namespace, image: config.image },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        summary: `Kubernetes probe failed for namespace ${config.namespace}.`,
        metadata: { provider: "k8s", namespace: config.namespace, error: message },
      };
    }
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const client = buildClient(config);
    const leaseId = cryptoRandomLeaseId();

    await createLeasePod(client, config, leaseId, params.companyId);
    await waitPodReady(client, config, leaseId, config.podReadyTimeoutMs);

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
    const result = await execInPod(client, config, params.lease.providerLeaseId, {
      command: params.command,
      args: params.args ?? [],
      cwd: params.cwd,
      env: params.env,
      stdin: params.stdin ?? undefined,
      timeoutMs: params.timeoutMs ?? config.execTimeoutMs,
    });
    return result;
  },
});

function cryptoRandomLeaseId(): string {
  return `l${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export default plugin;
