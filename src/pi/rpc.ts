/**
 * Zero-dependency Node `child_process.spawn` JSON-Lines RPC driver for
 * `pi --mode rpc`. Injects `MATTERWAVE_API_KEY` and `MATTERWAVE_BASE_URL`
 * into the child process environment, correlates request IDs to promises,
 * streams typed `PiRpcEvent` frames, and cleanly terminates the subprocess
 * on `close()` or `AbortSignal`.
 */

import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { API_KEY_ENV, BASE_URL_ENV, envValue, type MatterWave } from "../client.js";
import type {
  PiRpcCommand,
  PiRpcEvent,
  PiRpcResponseEvent,
  PiRpcSessionState,
} from "./types.js";

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

function getSpawn(): SpawnFn {
  const proc = (
    globalThis as {
      process?: { getBuiltinModule?: (id: string) => { spawn?: SpawnFn } | undefined };
    }
  ).process;
  const builtin = proc?.getBuiltinModule?.("node:child_process");
  if (builtin?.spawn) return builtin.spawn;
  throw new Error("PiRpcClient requires a Node-compatible runtime with node:child_process.");
}

/** Configuration options for `PiRpcClient`. */
export interface PiRpcClientOptions {
  /** Optional `MatterWave` client used to populate `MATTERWAVE_API_KEY` and `MATTERWAVE_BASE_URL`. */
  client?: MatterWave;
  /** Explicit MatterWave API key injected as `MATTERWAVE_API_KEY`. */
  apiKey?: string;
  /** Explicit MatterWave base URL injected as `MATTERWAVE_BASE_URL`. */
  baseUrl?: string;
  /** Executable to spawn (defaults to `"pi"`). */
  command?: string;
  /** Arguments passed to `command` (defaults to `["--mode", "rpc"]`). */
  args?: readonly string[];
  /** Working directory for the child process. */
  cwd?: string;
  /** Additional environment variables merged over `process.env`. */
  env?: Record<string, string | undefined>;
  /** Optional `AbortSignal` that automatically closes the subprocess when aborted. */
  signal?: AbortSignal;
  /** Per-command response timeout in milliseconds (default: 60_000). */
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (response: PiRpcResponseEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function extractClientApiKey(client?: MatterWave): string | undefined {
  if (!client) return undefined;
  const internal = client as unknown as {
    apiKey?: string | null;
    accessToken?: string | (() => string | Promise<string>) | null;
  };
  if (typeof internal.apiKey === "string" && internal.apiKey.trim() !== "") {
    return internal.apiKey.trim();
  }
  if (typeof internal.accessToken === "string" && internal.accessToken.trim() !== "") {
    return internal.accessToken.trim();
  }
  return undefined;
}

/**
 * JSON-Lines RPC client for `pi --mode rpc`.
 */
export class PiRpcClient {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  private readonly cwd?: string;
  private readonly timeoutMs: number;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private nextRequestId = 0;
  private closed = false;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: PiRpcEvent) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly removeSignalListener?: () => void;

  constructor(options: PiRpcClientOptions = {}) {
    this.command = options.command ?? "pi";
    this.args = options.args ? [...options.args] : ["--mode", "rpc"];
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs ?? 60_000;

    const apiKey = options.apiKey ?? extractClientApiKey(options.client) ?? envValue(API_KEY_ENV) ?? undefined;
    const baseUrl = options.baseUrl ?? options.client?.baseUrl ?? envValue(BASE_URL_ENV) ?? undefined;

    this.env = {
      ...process.env,
      ...(apiKey !== undefined ? { [API_KEY_ENV]: apiKey } : {}),
      ...(baseUrl !== undefined ? { [BASE_URL_ENV]: baseUrl } : {}),
      ...(options.env ?? {}),
    };

    this.ensureStarted();

    if (options.signal) {
      if (options.signal.aborted) {
        void this.close();
      } else {
        const onAbort = () => {
          void this.close();
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        this.removeSignalListener = () => options.signal?.removeEventListener("abort", onAbort);
      }
    }
  }

  /** Subprocess PID if currently running. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Collected stderr output from the child process. */
  getStderr(): string {
    return this.stderrBuffer;
  }

  /** Ensure the RPC subprocess is started (idempotent). */
  async start(): Promise<void> {
    this.ensureStarted();
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.closed) {
      throw new Error("PiRpcClient is closed.");
    }
    if (this.child) return this.child;

    const proc = getSpawn()(this.command, [...this.args], {
      cwd: this.cwd,
      env: this.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = proc;

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      this.stdoutBuffer += chunk;
      let newlineIdx = this.stdoutBuffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const rawLine = this.stdoutBuffer.slice(0, newlineIdx).replace(/\r$/, "");
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
        if (rawLine.trim() !== "") {
          this.handleLine(rawLine);
        }
        newlineIdx = this.stdoutBuffer.indexOf("\n");
      }
    });

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
    });

    const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.stdoutBuffer.trim() !== "") {
        const remaining = this.stdoutBuffer.replace(/\r$/, "");
        this.stdoutBuffer = "";
        this.handleLine(remaining);
      }
      const err = new Error(
        `Pi RPC process exited (${code !== null ? `code ${code}` : `signal ${signal ?? "unknown"}`})${
          this.stderrBuffer.trim() ? `: ${this.stderrBuffer.trim()}` : ""
        }`,
      );
      this.rejectAllPending(err);
      for (const listener of this.closeListeners) {
        listener();
      }
    };

    proc.once("exit", handleExit);
    proc.once("error", (err: Error) => {
      this.rejectAllPending(err);
      for (const listener of this.closeListeners) {
        listener();
      }
    });

    return proc;
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const event = parsed as PiRpcEvent;
    if (typeof event.type !== "string") return;

    if (event.type === "response" && typeof event.id === "string") {
      const pending = this.pending.get(event.id);
      if (pending) {
        this.pending.delete(event.id);
        clearTimeout(pending.timer);
        if (event.success === false) {
          pending.reject(new Error(event.error ?? `Pi RPC command "${event.command}" failed`));
        } else {
          pending.resolve(event);
        }
      }
    }

    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  /** Subscribe to all JSONL events emitted by `pi --mode rpc`. Returns an unsubscribe function. */
  onEvent(listener: (event: PiRpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Async iterator yielding `PiRpcEvent` frames until the client closes or `signal` aborts. */
  async *events(options: { signal?: AbortSignal } = {}): AsyncGenerator<PiRpcEvent, void, undefined> {
    if (this.closed) return;
    const queue: PiRpcEvent[] = [];
    let wake: (() => void) | null = null;
    let done = false;

    const notify = () => {
      if (wake) {
        const fn = wake;
        wake = null;
        fn();
      }
    };

    const unsubEvent = this.onEvent((ev) => {
      queue.push(ev);
      notify();
    });
    const onClose = () => {
      done = true;
      notify();
    };
    this.closeListeners.add(onClose);

    const onAbort = () => {
      done = true;
      notify();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        if (done || this.closed || options.signal?.aborted) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      unsubEvent();
      this.closeListeners.delete(onClose);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Send a typed `PiRpcCommand` over `stdin` and wait for its correlated
   * `response` frame on `stdout`.
   */
  sendCommand<T = Record<string, unknown>>(
    command: PiRpcCommand,
    options: { timeoutMs?: number } = {},
  ): Promise<PiRpcResponseEvent<T> & T> {
    const proc = this.ensureStarted();
    const id = command.id ?? `req_${++this.nextRequestId}`;
    const payload = { ...command, id };
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    return new Promise<PiRpcResponseEvent<T> & T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC command "${command.type}" (id=${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (response) => {
          const dataObj =
            typeof response.data === "object" && response.data !== null
              ? (response.data as Record<string, unknown>)
              : {};
          resolve({ ...response, ...dataObj } as PiRpcResponseEvent<T> & T);
        },
        reject,
        timer,
      });

      proc.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
        if (err) {
          const pending = this.pending.get(id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(id);
            pending.reject(err);
          }
        }
      });
    });
  }

  /** Send a `prompt` command to the Pi agent. */
  prompt(
    message: string,
    options: { images?: unknown[]; streamingBehavior?: "steer" | "followUp"; timeoutMs?: number } = {},
  ): Promise<PiRpcResponseEvent<{ disposition?: string }> & { disposition?: string }> {
    return this.sendCommand(
      {
        type: "prompt",
        message,
        ...(options.images ? { images: options.images } : {}),
        ...(options.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
      },
      { timeoutMs: options.timeoutMs },
    );
  }

  /** Send a `steer` command to interrupt the agent mid-run. */
  steer(
    message: string,
    options: { images?: unknown[]; timeoutMs?: number } = {},
  ): Promise<PiRpcResponseEvent<{ disposition?: string }> & { disposition?: string }> {
    return this.sendCommand(
      {
        type: "steer",
        message,
        ...(options.images ? { images: options.images } : {}),
      },
      { timeoutMs: options.timeoutMs },
    );
  }

  /** Queue a `follow_up` message after the current run finishes. */
  followUp(
    message: string,
    options: { images?: unknown[]; timeoutMs?: number } = {},
  ): Promise<PiRpcResponseEvent<{ disposition?: string }> & { disposition?: string }> {
    return this.sendCommand(
      {
        type: "follow_up",
        message,
        ...(options.images ? { images: options.images } : {}),
      },
      { timeoutMs: options.timeoutMs },
    );
  }

  /** Abort the currently running agent turn. */
  abort(options: { timeoutMs?: number } = {}): Promise<PiRpcResponseEvent> {
    return this.sendCommand({ type: "abort" }, options);
  }

  /** Start a new session. */
  newSession(
    parentSession?: string,
    options: { timeoutMs?: number } = {},
  ): Promise<PiRpcResponseEvent<{ cancelled?: boolean }> & { cancelled?: boolean }> {
    return this.sendCommand(
      {
        type: "new_session",
        ...(parentSession !== undefined ? { parentSession } : {}),
      },
      options,
    );
  }

  /** Query the current session state (`get_state`). */
  getState(options: { timeoutMs?: number } = {}): Promise<PiRpcResponseEvent<PiRpcSessionState> & PiRpcSessionState> {
    return this.sendCommand<PiRpcSessionState>({ type: "get_state" }, options);
  }

  /** Switch the active provider and model (`set_model`). */
  setModel(
    provider: string,
    modelId: string,
    options: { timeoutMs?: number } = {},
  ): Promise<PiRpcResponseEvent<{ provider?: string; id?: string }> & { provider?: string; id?: string }> {
    return this.sendCommand({ type: "set_model", provider, modelId }, options);
  }

  /** Retrieve all messages in the current session (`get_messages`). */
  getMessages(
    options: { timeoutMs?: number } = {},
  ): Promise<PiRpcResponseEvent<{ messages?: unknown[] }> & { messages?: unknown[] }> {
    return this.sendCommand({ type: "get_messages" }, options);
  }

  /** Compact the session context (`compact`). */
  compact(
    customInstructions?: string,
    options: { timeoutMs?: number } = {},
  ): Promise<PiRpcResponseEvent<Record<string, unknown>>> {
    return this.sendCommand(
      {
        type: "compact",
        ...(customInstructions !== undefined ? { customInstructions } : {}),
      },
      options,
    );
  }

  /** Cleanly terminate the `pi --mode rpc` subprocess and settle pending requests. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.removeSignalListener?.();
    this.rejectAllPending(new Error("PiRpcClient closed"));
    for (const listener of this.closeListeners) {
      listener();
    }

    const proc = this.child;
    this.child = null;
    if (!proc) return;

    try {
      proc.stdin.end();
    } catch {
      // Ignore stdin close errors if process already exited.
    }

    if (proc.exitCode !== null || proc.signalCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      const forceTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Process already gone.
        }
        resolve();
      }, 500);

      proc.once("exit", () => {
        clearTimeout(forceTimer);
        resolve();
      });

      try {
        proc.kill("SIGTERM");
      } catch {
        clearTimeout(forceTimer);
        resolve();
      }
    });
  }
}
