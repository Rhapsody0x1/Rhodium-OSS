export const MAX_LINE_BYTES = 64 * 1024 * 1024;

export class LineTooLongError extends Error {
  readonly lineBytes: number;
  readonly maxBytes: number;

  constructor(lineBytes: number, maxBytes: number = MAX_LINE_BYTES) {
    super(`Line length ${lineBytes} bytes exceeds maximum ${maxBytes} bytes`);
    this.name = "LineTooLongError";
    this.lineBytes = lineBytes;
    this.maxBytes = maxBytes;
  }
}

export class InvalidJsonLineError extends Error {
  readonly line: string;

  constructor(line: string, cause?: unknown) {
    super(`Invalid JSON line: ${cause instanceof Error ? cause.message : String(cause ?? "parse error")}`, { cause });
    this.name = "InvalidJsonLineError";
    this.line = line;
  }
}

export type LineSource = AsyncIterable<Uint8Array | string> | ReadableStream<Uint8Array>;

export type LineSink = {
  write(chunk: string | Uint8Array): unknown;
};

export type ReadJsonLinesOptions<T = unknown> = {
  onMessage: (message: T) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
  maxLineBytes?: number;
  signal?: AbortSignal;
};

const encoder = new TextEncoder();

/** Write a diagnostic message strictly to stderr (never stdout). */
export function logStderr(message: string, sink: LineSink = process.stderr): void {
  const line = message.endsWith("\n") ? message : `${message}\n`;
  sink.write(line);
}

/** Serialize one JSON object as a single newline-delimited UTF-8 line. */
export function writeJsonLine(sink: LineSink, value: unknown): void {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_LINE_BYTES) {
    throw new LineTooLongError(Buffer.byteLength(serialized, "utf8"), MAX_LINE_BYTES);
  }
  sink.write(`${serialized}\n`);
}

function toBytes(chunk: Uint8Array | string): Uint8Array {
  return typeof chunk === "string" ? encoder.encode(chunk) : chunk;
}

function concatBytes(parts: Uint8Array[], totalBytes: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function* iterateChunks(source: LineSource): AsyncGenerator<Uint8Array> {
  if (typeof (source as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (source as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }
  for await (const chunk of source as AsyncIterable<Uint8Array | string>) {
    yield toBytes(chunk);
  }
}

/**
 * Read newline-delimited JSON objects from a byte/string stream.
 * Buffers raw bytes until 0x0a (\n) so multi-byte UTF-8 sequences split across chunks
 * remain intact and exact byte length before \n is enforced. Dispatches onMessage
 * without awaiting handler completion so control messages never block behind long turns.
 */
export async function readJsonLines<T = unknown>(
  source: LineSource,
  opts: ReadJsonLinesOptions<T>,
): Promise<void> {
  const maxLineBytes = opts.maxLineBytes ?? MAX_LINE_BYTES;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const pending = new Set<Promise<void>>();
  let parts: Uint8Array[] = [];
  let lineBytes = 0;
  let droppingUntilNewline = false;
  let firstError: Error | null = null;

  const reportError = (err: Error): void => {
    if (opts.onError) {
      const p = Promise.resolve()
        .then(() => opts.onError!(err))
        .catch((handlerErr) => {
          if (!firstError) firstError = handlerErr instanceof Error ? handlerErr : new Error(String(handlerErr));
        });
      pending.add(p);
      void p.finally(() => pending.delete(p));
      return;
    }
    if (!firstError) firstError = err;
  };

  const dispatchLine = (rawBytes: Uint8Array): void => {
    let text: string;
    try {
      text = decoder.decode(rawBytes);
    } catch (err) {
      reportError(new InvalidJsonLineError("<invalid-utf8>", err));
      return;
    }
    if (text.endsWith("\r")) text = text.slice(0, -1);
    if (text.trim().length === 0) return;

    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch (err) {
      reportError(new InvalidJsonLineError(text, err));
      return;
    }

    try {
      const result = opts.onMessage(parsed);
      if (result && typeof (result as Promise<void>).then === "function") {
        const tracked = Promise.resolve(result).catch((err) => {
          reportError(err instanceof Error ? err : new Error(String(err)));
        });
        pending.add(tracked);
        void tracked.finally(() => pending.delete(tracked));
      }
    } catch (err) {
      reportError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const iterator = iterateChunks(source);
  const abortSignal = opts.signal;

  let onAbortCleanup: (() => void) | undefined;
  const abortPromise = abortSignal
    ? new Promise<{ aborted: true }>((resolvePromise) => {
        if (abortSignal.aborted) {
          resolvePromise({ aborted: true });
          return;
        }
        const onAbort = () => resolvePromise({ aborted: true });
        abortSignal.addEventListener("abort", onAbort, { once: true });
        onAbortCleanup = () => abortSignal.removeEventListener("abort", onAbort);
      })
    : null;

  try {
    while (true) {
      if (abortSignal?.aborted || (firstError && !opts.onError)) break;

      const nextPromise = iterator.next();
      const step = abortPromise
        ? await Promise.race([
            nextPromise.then((res) => ({ aborted: false as const, res })),
            abortPromise,
          ])
        : { aborted: false as const, res: await nextPromise };

      if (step.aborted || step.res.done) {
        if (step.aborted) {
          void nextPromise.catch(() => {});
          void iterator.return?.(undefined).catch(() => {});
        }
        break;
      }

      const chunk = step.res.value;
      let start = 0;

      while (start < chunk.byteLength) {
        const nlIdx = chunk.indexOf(0x0a, start);
        if (nlIdx === -1) {
          const slice = chunk.subarray(start);
          if (!droppingUntilNewline) {
            if (lineBytes + slice.byteLength > maxLineBytes) {
              const total = lineBytes + slice.byteLength;
              parts = [];
              lineBytes = 0;
              droppingUntilNewline = true;
              reportError(new LineTooLongError(total, maxLineBytes));
            } else if (slice.byteLength > 0) {
              parts.push(slice);
              lineBytes += slice.byteLength;
            }
          }
          break;
        }

        const slice = chunk.subarray(start, nlIdx);
        if (droppingUntilNewline) {
          droppingUntilNewline = false;
          parts = [];
          lineBytes = 0;
        } else if (lineBytes + slice.byteLength > maxLineBytes) {
          const total = lineBytes + slice.byteLength;
          parts = [];
          lineBytes = 0;
          reportError(new LineTooLongError(total, maxLineBytes));
        } else {
          if (slice.byteLength > 0) {
            parts.push(slice);
            lineBytes += slice.byteLength;
          }
          const lineData = lineBytes === 0 ? new Uint8Array(0) : concatBytes(parts, lineBytes);
          parts = [];
          lineBytes = 0;
          dispatchLine(lineData);
        }

        start = nlIdx + 1;
        if (firstError && !opts.onError) break;
      }
    }

    if (!abortSignal?.aborted && !droppingUntilNewline && lineBytes > 0 && (!firstError || opts.onError)) {
      const tailData = concatBytes(parts, lineBytes);
      parts = [];
      lineBytes = 0;
      dispatchLine(tailData);
    }

    if (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
  } finally {
    onAbortCleanup?.();
  }

  if (firstError) throw firstError;
}
