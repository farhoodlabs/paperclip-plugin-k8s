import { Exec } from "@kubernetes/client-node";
import type { V1Status } from "@kubernetes/client-node";
import { PassThrough } from "node:stream";
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
  if (options.stdin != null) {
    // Embed stdin as base64 in the shell command so we never pass a stdin stream to
    // @kubernetes/client-node — that library calls ws.close() on stdin EOF, which
    // kills the WebSocket before the process can write any stdout.
    const encoded = Buffer.from(options.stdin, "utf8").toString("base64");
    parts.push(`printf '%s' ${shellQuote(encoded)} | base64 -d | exec ${execLine}`);
  } else {
    parts.push(`exec ${execLine}`);
  }
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

export async function execInPod(
  client: K8sClient,
  config: K8sDriverConfig,
  leaseId: string,
  options: ExecOptions,
): Promise<ExecResult> {
  const exec = new Exec(client.kc);
  const name = podName(leaseId);
  const command = buildExecCommand(options);

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
    let pendingExitCode: number | null | undefined = undefined;

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
        null, // stdin is embedded in the command; passing a stream would cause early ws.close()
        false,
        (status: V1Status) => {
          pendingExitCode = extractExitCode(status);
        },
      )
      .then((socket) => {
        ws = socket;
        socket.on("error", (err: unknown) => {
          if (!settled) reject(err instanceof Error ? err : new Error(String(err)));
        });
        socket.on("close", (code: unknown) => {
          const { stdout, stderr } = collectOutput();
          if (pendingExitCode !== undefined) {
            settle({ exitCode: pendingExitCode, timedOut: false, stdout, stderr });
          } else {
            const inferredExit = code === 1000 && !stderr.trim() ? 0 : 1;
            settle({ exitCode: inferredExit, timedOut: false, stdout, stderr });
          }
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
