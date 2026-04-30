import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEnvironmentTestHarness } from "@paperclipai/plugin-sdk/testing";

vi.mock("../src/k8s/client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/k8s/client.js")>();
  return {
    ...original,
    buildClient: vi.fn().mockReturnValue({ core: { readNamespace: vi.fn().mockResolvedValue({}) }, kc: {} }),
    loadKubeConfig: vi.fn(),
  };
});

vi.mock("../src/k8s/pod.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/k8s/pod.js")>();
  return {
    ...original,
    createLeasePod: vi.fn().mockResolvedValue({}),
    waitPodReady: vi.fn().mockResolvedValue({}),
    getLeasePod: vi.fn().mockResolvedValue({ metadata: { name: "test-pod" }, status: { phase: "Running" } }),
    deleteLeasePod: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../src/k8s/exec.js", () => ({
  execInPod: vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false, stdout: "ok", stderr: "" }),
}));

import manifest from "../src/manifest.js";
import plugin from "../src/plugin.js";
import { parseDriverConfig } from "../src/config.js";
import { podName, buildPodManifest } from "../src/k8s/pod.js";
import { getLeasePod, deleteLeasePod } from "../src/k8s/pod.js";
import { execInPod } from "../src/k8s/exec.js";

const BASE_CONFIG = { image: "ubuntu:22.04" };

function makeHarness(config: Record<string, unknown> = BASE_CONFIG) {
  return createEnvironmentTestHarness({
    manifest,
    config,
    environmentDriver: {
      driverKey: "k8s",
      onValidateConfig: (p) => plugin.definition.onEnvironmentValidateConfig!(p),
      onProbe: (p) => plugin.definition.onEnvironmentProbe!(p),
      onAcquireLease: (p) => plugin.definition.onEnvironmentAcquireLease!(p),
      onResumeLease: (p) => plugin.definition.onEnvironmentResumeLease!(p),
      onReleaseLease: (p) => plugin.definition.onEnvironmentReleaseLease!(p),
      onDestroyLease: (p) => plugin.definition.onEnvironmentDestroyLease!(p),
      onRealizeWorkspace: (p) => plugin.definition.onEnvironmentRealizeWorkspace!(p),
      onExecute: (p) => plugin.definition.onEnvironmentExecute!(p),
    },
  });
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

describe("parseDriverConfig", () => {
  it("parses required image", () => {
    const cfg = parseDriverConfig({ image: "node:20" });
    expect(cfg.image).toBe("node:20");
    expect(cfg.namespace).toBe("default");
    expect(cfg.workspaceMountPath).toBe("/workspace");
    expect(cfg.reuseLease).toBe(false);
    expect(cfg.podReadyTimeoutMs).toBe(120_000);
    expect(cfg.timeoutMs).toBe(300_000);
  });

  it("allows missing image (resolution is deferred to acquire-time)", () => {
    const cfg = parseDriverConfig({});
    expect(cfg.image).toBe("");
  });

  it("respects all optional fields", () => {
    const cfg = parseDriverConfig({
      image: "alpine",
      namespace: "prod",
      kubeconfigPath: "/etc/k8s/config",
      serviceAccountName: "sa-{companyId}",
      workspaceMountPath: "/work",
      pvcName: "my-pvc",
      reuseLease: true,
      podReadyTimeoutMs: 60_000,
      timeoutMs: 90_000,
      env: { FOO: "bar" },
    });
    expect(cfg.namespace).toBe("prod");
    expect(cfg.kubeconfigPath).toBe("/etc/k8s/config");
    expect(cfg.serviceAccountName).toBe("sa-{companyId}");
    expect(cfg.workspaceMountPath).toBe("/work");
    expect(cfg.pvcName).toBe("my-pvc");
    expect(cfg.reuseLease).toBe(true);
    expect(cfg.podReadyTimeoutMs).toBe(60_000);
    expect(cfg.timeoutMs).toBe(90_000);
    expect(cfg.env).toEqual({ FOO: "bar" });
  });

  it("ignores non-string env values", () => {
    const cfg = parseDriverConfig({ image: "alpine", env: { A: "ok", B: 42, C: null } });
    expect(cfg.env).toEqual({ A: "ok" });
  });
});

// ---------------------------------------------------------------------------
// Pod utilities
// ---------------------------------------------------------------------------

describe("podName", () => {
  it("produces a valid DNS label", () => {
    const name = podName("l1a2b3c4");
    expect(name).toMatch(/^paperclip-lease-[a-z0-9-]+$/);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it("lowercases and strips invalid characters", () => {
    const name = podName("L_UPPER_123");
    expect(name).not.toMatch(/[A-Z_]/);
  });
});

describe("buildPodManifest", () => {
  it("sets required fields", () => {
    const cfg = parseDriverConfig({ image: "alpine:3.18" });
    const pod = buildPodManifest(cfg, "lease123", "company-1");
    expect(pod.metadata?.namespace).toBe("default");
    expect(pod.spec?.containers?.[0]?.image).toBe("alpine:3.18");
    expect(pod.spec?.restartPolicy).toBe("Never");
  });

  it("mounts PVC when pvcName is set", () => {
    const cfg = parseDriverConfig({ image: "alpine", pvcName: "ws-pvc" });
    const pod = buildPodManifest(cfg, "l1", "c1");
    const vol = pod.spec?.volumes?.find((v) => v.name === "workspace");
    expect(vol?.persistentVolumeClaim?.claimName).toBe("ws-pvc");
  });

  it("uses emptyDir when no pvcName", () => {
    const cfg = parseDriverConfig({ image: "alpine" });
    const pod = buildPodManifest(cfg, "l1", "c1");
    const vol = pod.spec?.volumes?.find((v) => v.name === "workspace");
    expect(vol?.emptyDir).toBeDefined();
  });

  it("resolves {companyId} placeholder in serviceAccountName", () => {
    const cfg = parseDriverConfig({ image: "alpine", serviceAccountName: "sa-{companyId}" });
    const pod = buildPodManifest(cfg, "l1", "acme");
    expect(pod.spec?.serviceAccountName).toBe("sa-acme");
  });

  it("sets env vars on the container", () => {
    const cfg = parseDriverConfig({ image: "alpine", env: { MY_VAR: "hello" } });
    const pod = buildPodManifest(cfg, "l1", "c1");
    const env = pod.spec?.containers?.[0]?.env ?? [];
    expect(env).toContainEqual({ name: "MY_VAR", value: "hello" });
  });
});

// ---------------------------------------------------------------------------
// Environment harness — validateConfig
// ---------------------------------------------------------------------------

describe("onEnvironmentValidateConfig", () => {
  it("accepts a valid config", async () => {
    const harness = makeHarness();
    const result = await harness.validateConfig({ driverKey: "k8s", config: BASE_CONFIG });
    expect(result.ok).toBe(true);
  });

  it("rejects missing image", async () => {
    const harness = makeHarness();
    const result = await harness.validateConfig({ driverKey: "k8s", config: {} });
    expect(result.ok).toBe(false);
    expect(result.errors?.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Environment harness — probe
// ---------------------------------------------------------------------------

describe("onEnvironmentProbe", () => {
  it("returns a result with ok and metadata", async () => {
    const harness = makeHarness();
    const result = await harness.probe({
      driverKey: "k8s",
      companyId: "c1",
      environmentId: "env-1",
      config: BASE_CONFIG,
    });
    expect(typeof result.ok).toBe("boolean");
    expect(result.metadata?.provider).toBe("k8s");
  });
});

// ---------------------------------------------------------------------------
// Environment harness — realizeWorkspace
// ---------------------------------------------------------------------------

describe("onEnvironmentRealizeWorkspace", () => {
  it("returns cwd from lease metadata", async () => {
    const harness = makeHarness();
    const result = await harness.realizeWorkspace({
      driverKey: "k8s",
      companyId: "c1",
      environmentId: "env-1",
      config: BASE_CONFIG,
      lease: { providerLeaseId: "l123", metadata: { remoteCwd: "/workspace" } },
      workspace: {},
    });
    expect(result.cwd).toBe("/workspace");
  });

  it("falls back to workspaceMountPath from config", async () => {
    const harness = makeHarness({ image: "alpine", workspaceMountPath: "/custom" });
    const result = await harness.realizeWorkspace({
      driverKey: "k8s",
      companyId: "c1",
      environmentId: "env-1",
      config: { image: "alpine", workspaceMountPath: "/custom" },
      lease: { providerLeaseId: "l123" },
      workspace: {},
    });
    expect(result.cwd).toBe("/custom");
  });
});

// ---------------------------------------------------------------------------
// Environment harness — acquireLease / releaseLease / destroyLease
// ---------------------------------------------------------------------------

describe("onEnvironmentAcquireLease", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a lease with providerLeaseId and metadata", async () => {
    const harness = makeHarness();
    const lease = await harness.acquireLease({
      driverKey: "k8s",
      companyId: "c1",
      environmentId: "env-1",
      config: BASE_CONFIG,
      runId: "run-1",
    });
    expect(lease.providerLeaseId).toBeTruthy();
    expect(lease.metadata?.provider).toBe("k8s");
    expect(lease.metadata?.namespace).toBe("default");
  });
});

describe("onEnvironmentResumeLease", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the lease when pod exists", async () => {
    vi.mocked(getLeasePod).mockResolvedValueOnce({ metadata: { name: "test-pod" } } as never);
    const harness = makeHarness();
    const lease = await harness.resumeLease({
      driverKey: "k8s",
      companyId: "c1",
      environmentId: "env-1",
      config: BASE_CONFIG,
      providerLeaseId: "l-existing",
    });
    expect(lease.providerLeaseId).toBe("l-existing");
    expect(lease.metadata?.resumedLease).toBe(true);
  });

  it("returns expired when pod is gone", async () => {
    vi.mocked(getLeasePod).mockResolvedValueOnce(null);
    const harness = makeHarness();
    const lease = await harness.resumeLease({
      driverKey: "k8s",
      companyId: "c1",
      environmentId: "env-1",
      config: BASE_CONFIG,
      providerLeaseId: "l-gone",
    });
    expect(lease.providerLeaseId).toBeNull();
    expect(lease.metadata?.expired).toBe(true);
  });
});

describe("onEnvironmentReleaseLease", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes the pod when reuseLease is false", async () => {
    const harness = makeHarness();
    await harness.releaseLease({
      driverKey: "k8s",
      companyId: "c1",
      environmentId: "env-1",
      config: { ...BASE_CONFIG, reuseLease: false },
      providerLeaseId: "l-123",
    });
    expect(vi.mocked(deleteLeasePod)).toHaveBeenCalledOnce();
  });

  it("skips deletion when reuseLease is true", async () => {
    const harness = makeHarness();
    await harness.releaseLease({
      driverKey: "k8s",
      companyId: "c1",
      environmentId: "env-1",
      config: { ...BASE_CONFIG, reuseLease: true },
      providerLeaseId: "l-123",
    });
    expect(vi.mocked(deleteLeasePod)).not.toHaveBeenCalled();
  });
});

describe("onEnvironmentDestroyLease", () => {
  beforeEach(() => vi.clearAllMocks());

  it("always deletes the pod", async () => {
    const harness = makeHarness();
    await harness.destroyLease({
      driverKey: "k8s",
      companyId: "c1",
      environmentId: "env-1",
      config: { ...BASE_CONFIG, reuseLease: true },
      providerLeaseId: "l-123",
    });
    expect(vi.mocked(deleteLeasePod)).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Environment harness — execute
// ---------------------------------------------------------------------------

describe("onEnvironmentExecute", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns exec result from the pod", async () => {
    vi.mocked(execInPod).mockResolvedValueOnce({ exitCode: 0, timedOut: false, stdout: "hello\n", stderr: "" });
    const harness = makeHarness();
    const result = await harness.execute({
      driverKey: "k8s",
      companyId: "c1",
      environmentId: "env-1",
      config: BASE_CONFIG,
      lease: { providerLeaseId: "l-123" },
      command: "echo",
      args: ["hello"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
  });

  it("returns error when providerLeaseId is null", async () => {
    const harness = makeHarness();
    const result = await harness.execute({
      driverKey: "k8s",
      companyId: "c1",
      environmentId: "env-1",
      config: BASE_CONFIG,
      lease: { providerLeaseId: null },
      command: "echo",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/No provider lease ID/);
  });
});
