/**
 * What the client says about its own traffic: a log line per attempt, and
 * a warning the first time a route the API has deprecated is called.
 *
 * `logLevel: "info"` (or `MATTERWAVE_LOG=info` where there is an
 * environment) logs one line per response or failure -- method, path,
 * status, request id, time taken -- and `"debug"` adds each attempt as it
 * goes out and each wait before a retry. Bodies and headers are never
 * logged: a body can hold a person's words and a header the key. The lines
 * go to `logger` (the console unless one is given).
 *
 * The API marks a route it will retire with `Deprecation` (RFC 9745's
 * `@<unix time>`, or the older `true` / HTTP date) and `Sunset` (RFC 8594,
 * the date it stops answering). The first response from such a route is
 * warned about through `logger.warn`, whatever the level, once per route
 * per process.
 */

import { APP_OPERATIONS } from "./conversation-types.js";
import { OPERATIONS } from "./types.js";

export const LOG_ENV = "MATTERWAVE_LOG";
export type LogLevel = "off" | "info" | "debug";

/** Where the lines go: the console's shape, so `console` is one. */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

const RANKS: Record<LogLevel, number> = { off: 0, info: 1, debug: 2 };

/** The level asked for, or `off` for anything that is not one. */
export function logLevelOf(value: string | null | undefined): LogLevel {
  const level = value?.trim().toLowerCase();
  return level === "info" || level === "debug" ? level : "off";
}

function now(): number {
  return globalThis.performance?.now() ?? Date.now();
}

/** @internal The logger the client writes through, at its level. */
export class RequestLog {
  constructor(
    readonly level: LogLevel,
    readonly logger: Logger,
  ) {}

  started(): number {
    return now();
  }

  attempt(method: string, path: string, attempt: number): void {
    if (RANKS[this.level] >= RANKS.debug) this.logger.debug(`${method} ${path} attempt ${attempt + 1}`);
  }

  response(method: string, path: string, response: Response, since: number): void {
    if (RANKS[this.level] < RANKS.info) return;
    const id = response.headers.get("x-request-id") ?? "-";
    this.logger.info(`${method} ${path} -> ${response.status} in ${Math.round(now() - since)}ms request_id=${id}`);
  }

  failure(method: string, path: string, cause: unknown, since: number): void {
    if (RANKS[this.level] < RANKS.info) return;
    const kind = cause instanceof Error ? cause.name : typeof cause;
    this.logger.info(`${method} ${path} failed in ${Math.round(now() - since)}ms: ${kind}`);
  }

  retry(method: string, path: string, delayMs: number, attempt: number): void {
    if (RANKS[this.level] >= RANKS.debug) {
      this.logger.debug(`${method} ${path} retrying in ${(delayMs / 1000).toFixed(2)}s (attempt ${attempt + 2})`);
    }
  }

  deprecated(method: string, path: string, headers: Headers): void {
    const route = routeOf(method, path);
    const message = deprecationMessage(method, route, headers);
    const key = `${method} ${route}`;
    if (message === null || warned.has(key)) return;
    warned.add(key);
    this.logger.warn(message);
  }
}

const warned = new Set<string>();

/** @internal Forget which routes were warned about, for tests. */
export function resetDeprecationWarnings(): void {
  warned.clear();
}

function templatePattern(template: string): RegExp {
  const parts = template.split(/(\{[^}]+\})/);
  const source = parts.map((p) => (p.startsWith("{") ? "[^/]+" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
  return new RegExp(`^${source}$`);
}

const ROUTES: Array<[string, string, RegExp]> = [
  ...Object.values(OPERATIONS).map((op) => [op.method, op.path] as const),
  ...Object.values(APP_OPERATIONS),
].map(([method, path]) => [method, path, templatePattern(path)]);

/**
 * The route a concrete path belongs to (`/v1/models/{model_id}` for
 * `/v1/models/grt-nano`), so one deprecation warns once rather than once
 * per id; the path itself when no known route matches.
 */
export function routeOf(method: string, path: string): string {
  for (const [known, template, pattern] of ROUTES) {
    if (known === method && pattern.test(path)) return template;
  }
  return path;
}

function dateOf(value: string): Date | null {
  const text = value.trim();
  if (text.startsWith("@")) {
    const seconds = Number(text.slice(1));
    return Number.isInteger(seconds) ? new Date(seconds * 1000) : null;
  }
  const when = Date.parse(text);
  return Number.isNaN(when) ? null : new Date(when);
}

function linkOf(header: string | null, rel: string): string | null {
  for (const part of (header ?? "").split(",")) {
    const match = /^\s*<([^>]+)>(.*)$/.exec(part);
    if (match && new RegExp(`rel="?[^";]*\\b${rel}\\b`).test(match[2]!)) return match[1]!;
  }
  return null;
}

/** The warning for a response that carries `Deprecation` or `Sunset`, or null for one that carries neither. */
export function deprecationMessage(method: string, route: string, headers: Headers): string | null {
  const deprecation = headers.get("deprecation");
  const sunset = headers.get("sunset");
  if (deprecation === null && sunset === null) return null;
  if (deprecation !== null && deprecation.trim().toLowerCase() === "false") return null;
  let message = `${method} ${route} is deprecated by the MatterWave API`;
  const since = deprecation ? dateOf(deprecation) : null;
  if (since) message += ` (since ${since.toISOString().slice(0, 10)})`;
  const ends = sunset ? dateOf(sunset) : null;
  if (ends) message += `; it stops answering on ${ends.toISOString().slice(0, 10)}`;
  const link = linkOf(headers.get("link"), "deprecation") ?? linkOf(headers.get("link"), "sunset");
  if (link) message += `. See ${link}`;
  return `${message}.`;
}
