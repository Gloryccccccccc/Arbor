export class ArborError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ArborError";
  }
}

export function errorInfo(error: unknown): { code: string; message: string } {
  return error instanceof ArborError
    ? { code: error.code, message: error.message }
    : { code: "runtime_error", message: error instanceof Error ? error.message : String(error) };
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Cancelled");
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error("Cancelled"));
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}
