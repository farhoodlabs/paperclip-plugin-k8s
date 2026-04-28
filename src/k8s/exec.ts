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

// Below this stdin size, embed the bytes inside the shell command so the WebSocket
// stays open after stdin EOF and stdout can flow back. Above it, embedding would
// blow ARG_MAX (typically 128KB), so we fall back to streaming stdin through the
// WebSocket and accept that @kubernetes/client-node closes the socket on stdin
// EOF — fine for commands like `base64 -d > file` that don't need stdout.
const STDIN_EMBED_MAX = 32 * 1024;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildExecCommand(options: ExecOptions, embedStdin: boolean): string[] {
  const parts: string[] = [];
  if (options.cwd) parts.push(`cd ${shellQuote(options.cwd)}`);
  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) {
      parts.push(`export ${k}=${shellQuote(v)}`);
    }
  }
  const execLine = [options.command, ...options.args].map(shellQuote).join(" ");
  if (embedStdin && options.stdin != null) {
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
  const embedStdin = options.stdin != null && options.stdin.length <= STDIN_EMBED_MAX;
  const command = buildExecCommand(options, embedStdin);
  const wsStdin = !embedStdin && options.stdin != null ? stdinReadable(options.stdin) : null;

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

  // After Status arrives we want a short drain so any in-flight stdout/stderr lands
  // before we resolve. But we also want to settle promptly on close. Either signal
  // can trigger settlement — but if Status has fired, its exit code is authoritative
  // (the close handler must NOT race in with an inferred exit code).
  const STATUS_DRAIN_MS = 50;

  const statusPromise = new Promise<ExecResult>((resolve, reject) => {
    let settled = false;
    // undefined = Status frame not yet received; null/number = exit code from Status.
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
        wsStdin,
        false,
        (status: V1Status) => {
          pendingExitCode = extractExitCode(status);
          setTimeout(() => {
            const { stdout, stderr } = collectOutput();
            settle({ exitCode: pendingExitCode!, timedOut: false, stdout, stderr });
          }, STATUS_DRAIN_MS);
        },
      )
      .then((socket) => {
        ws = socket;
        socket.on("error", (err: unknown) => {
          if (!settled) reject(err instanceof Error ? err : new Error(String(err)));
        });
        socket.on("close", (code: unknown) => {
          if (settled) return;
          const { stdout, stderr } = collectOutput();
          if (pendingExitCode !== undefined) {
            // Status arrived; use its exit code instead of waiting on the drain timer.
            settle({ exitCode: pendingExitCode, timedOut: false, stdout, stderr });
          } else {
            // No Status — typically the stdin-EOF path where @kubernetes/client-node
            // closes the socket before K8s sends a Status frame.
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

  const result = await Promise.race([statusPromise, timeoutPromise]);
  return normalizeBenignTarWarning(result);
}

// GNU tar exits 1 on the "archive cannot contain itself" warning when the
// output file lives inside the directory being archived. The host-side runtime
// produces exactly this layout for workspace-download.tar, expects exit 0
// (which is what BusyBox tar / the e2b sandbox returns), and treats anything
// else as a failure. Map this benign warning to exit 0 so we match.
function normalizeBenignTarWarning(result: ExecResult): ExecResult {
  if (result.exitCode === 1 && /archive cannot contain itself/i.test(result.stderr)) {
    return { ...result, exitCode: 0 };
  }
  return result;
}
