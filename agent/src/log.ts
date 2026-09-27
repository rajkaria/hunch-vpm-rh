/**
 * Output.
 *
 * The logger is constructed with the secret values the process happens to hold and
 * replaces any occurrence of them with `***` before anything is written. Nothing in this
 * package deliberately logs a key; this is the backstop for the case where a key ends up
 * inside an error message from somewhere else.
 */

export interface Logger {
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

export class ConsoleLogger implements Logger {
  readonly #secrets: readonly string[];

  constructor(secrets: readonly string[] = []) {
    // Short values would match far too much; a real key is never this short.
    this.#secrets = secrets.filter((s) => s.length >= 8);
  }

  info(line: string): void {
    process.stdout.write(`${this.#scrub(line)}\n`);
  }

  warn(line: string): void {
    process.stderr.write(`warn: ${this.#scrub(line)}\n`);
  }

  error(line: string): void {
    process.stderr.write(`error: ${this.#scrub(line)}\n`);
  }

  #scrub(line: string): string {
    let out = line;
    for (const secret of this.#secrets) out = out.split(secret).join("***");
    return out;
  }
}

/** Collects lines instead of printing them. Used by the tests. */
export class MemoryLogger implements Logger {
  readonly lines: string[] = [];
  info(line: string): void {
    this.lines.push(line);
  }
  warn(line: string): void {
    this.lines.push(`warn: ${line}`);
  }
  error(line: string): void {
    this.lines.push(`error: ${line}`);
  }
}

/** Pad a column without pulling in a table library. */
export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}
