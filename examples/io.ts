/**
 * Where the examples print, so a test can run each one and read what it
 * said. Run directly, an example writes to the terminal.
 */

import { pathToFileURL } from "node:url";

export interface Io {
  /** Write as is: a streamed answer arrives in pieces, so nothing is added. */
  write(text: string): void;
  error(line: string): void;
}

export const terminal: Io = {
  write: (text) => void process.stdout.write(text),
  error: (line) => console.error(line),
};

/** True when `moduleUrl` is the script node was started with, rather than an import. */
export function isMain(moduleUrl: string): boolean {
  const script = process.argv[1];
  return script !== undefined && moduleUrl === pathToFileURL(script).href;
}

/** Run `main` and exit with its code; an exception exits 1 after printing it. */
export function start(main: () => Promise<number>): void {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
