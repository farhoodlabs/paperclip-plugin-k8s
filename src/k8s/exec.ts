import { Exec } from "@kubernetes/client-node";
import type { V1Status } from "@kubernetes/client-node";
import { PassThrough, Readable } from "node:stream";
import type { K8sDriverConfig } from "../config.js";
import type { K8sClient } from "./client.js";
import { podName } from "./pod.js";

export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildExecCommand(options: ExecOptions): string[] {
  const parts: string[] = [];
  if (options.cwd) parts.push(`cd ${shellQuote(options.cwd)}`);
  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) {
      parts.push(`export ${k}=${shellQuote(v)}`);
    }
  }
  const execLine = [options.command, ...options.args].map(shellQuote).join(" ");
  parts.push(`exec ${execLine}`);
  return ["/bin/sh", "-c", parts.join("; ")];
}

function extractExitCode(status: V1Status): number | null {
  if (status.status === "Success") return 0;
  const cause = status.details?.causes?.find((c) => c.reason === "ExitCode");
  if (cause?.message) {
    const code = parseInt(cause.message, 10);
    if (Number.isFinite(code)) return code;
  }
  return 1;
}

function stdinReadable(input: string): Readable {
  const r = new Readable({ read() {} });
  r.push(input);
  r.push(null);
  return r;
}

export async function execInPod(
  client: K8sClient,
  config: K8sDriverConfig,
  leaseId: string,
  options: ExecOptions,
): Promise<ExecResult> {
  const exec = new Exec(client.kc);
  const name = podName(leaseId);
  const command = buildExecCommand(options);
  const stdin = options.stdin != null ? stdinReadable(options.stdin) : null;

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();
  stdoutStream.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  stderrStream.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  let ws: { close(): void; on(event: string, handler: (...args: unknown[]) => void): void } | undefined;

  const collectOutput = (): Pick<ExecResult, "stdout" | "stderr"> => ({
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  });

  const statusPromise = new Promise<ExecResult>((resolve, reject) => {
    let settled = false;
    const settle = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      stdoutStream.end();
      stderrStream.end();
      resolve(result);
    };

    exec
      .exec(
        config.namespace,
        name,
        "agent",
        command,
        stdoutStream,
        stderrStream,
        stdin,
        false,
        (status: V1Status) => {
          settle({ exitCode: extractExitCode(status), timedOut: false, ...collectOutput() });
        },
      )
      .then((socket) => {
        ws = socket;
        socket.on("error", (err: unknown) => {
          if (!settled) reject(err instanceof Error ? err : new Error(String(err)));
        });
        // @kubernetes/client-node closes the WebSocket when stdin ends (web-socket-handler.js),
        // preventing K8s from sending a Status frame. Infer success from close code + stderr.
        socket.on("close", (code: unknown) => {
          const { stdout, stderr } = collectOutput();
          const inferredExit = code === 1000 && !stderr.trim() ? 0 : 1;
          settle({ exitCode: inferredExit, timedOut: false, stdout, stderr });
        });
      })
      .catch(reject);
  });

  const timeoutPromise = new Promise<ExecResult>((resolve) =>
    setTimeout(() => {
      ws?.close();
      stdoutStream.end();
      stderrStream.end();
      resolve({ exitCode: null, timedOut: true, ...collectOutput() });
    }, options.timeoutMs),
  );

  return Promise.race([statusPromise, timeoutPromise]);
}
