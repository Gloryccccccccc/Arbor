import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile, unlink } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";
import { ArborError, throwIfAborted } from "../errors.js";
import { ArtifactStore } from "./artifacts.js";

const MAX_FILE_BYTES = 1024 * 1024;
export function sha256(text: string | Buffer): string { return createHash("sha256").update(text).digest("hex"); }
function within(root: string, target: string): boolean {
  const part = relative(root, target);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep));
}

class OutputBuffer {
  private first = Buffer.alloc(0);
  private last = Buffer.alloc(0);
  total = 0;
  constructor(private readonly limit = 8192) {}
  push(chunk: Buffer): void {
    this.total += chunk.length;
    const half = Math.floor(this.limit / 2);
    if (this.first.length < half) this.first = Buffer.concat([this.first, chunk.subarray(0, half - this.first.length)]);
    this.last = Buffer.concat([this.last, chunk]).subarray(-half);
  }
  text(): string {
    if (this.total <= this.limit / 2) return this.first.toString("utf8");
    if (this.total <= this.limit) return Buffer.concat([this.first, this.last.subarray(Math.max(0, this.first.length + this.last.length - this.total))]).toString("utf8");
    return this.first.toString("utf8") + "\n… output truncated …\n" + this.last.toString("utf8");
  }
}

export class LocalOperations {
  private constructor(readonly cwd: string, private readonly protectedDirectory: string, readonly artifacts: ArtifactStore) {}
  static async create(cwd: string, dataDir: string, artifacts: ArtifactStore): Promise<LocalOperations> {
    const root = await realpath(cwd);
    await mkdir(dataDir, { recursive: true });
    return new LocalOperations(root, await realpath(dataDir), artifacts);
  }

  private async path(input: string, writing = false): Promise<string> {
    if (!input || isAbsolute(input) || /^[A-Za-z]:/.test(input) || input.includes("\0") || input.split(/[\\/]/).includes("..")) throw new ArborError("path_denied", "Use a relative path inside the selected workspace.");
    const candidate = resolve(this.cwd, input);
    if (!within(this.cwd, candidate)) throw new ArborError("path_denied", "The path is outside the workspace.");
    const segments = relative(this.cwd, candidate).split(sep);
    if (segments.some((part) => part === ".git" || part === ".arbor" || (part.startsWith(".env") && part !== ".env.example")) || [".pem", ".key"].includes(extname(candidate).toLowerCase()) || within(this.protectedDirectory, candidate)) {
      throw new ArborError("path_denied", "Credential, Git, and runtime-state paths are protected from file tools.");
    }
    let ancestor = candidate;
    while (true) {
      try {
        const actual = await realpath(ancestor);
        const actualParts = relative(this.cwd, actual).split(sep);
        if (!within(this.cwd, actual) || within(this.protectedDirectory, actual) || actualParts.some((part) => part === ".git" || part === ".arbor" || (part.startsWith(".env") && part !== ".env.example")) || [".pem", ".key"].includes(extname(actual).toLowerCase())) throw new ArborError("path_denied", "The path resolves outside the permitted workspace.");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !writing || ancestor === this.cwd) throw error;
        ancestor = dirname(ancestor);
      }
    }
    return candidate;
  }

  async read(path: string, startLine: number, endLine: number | undefined, signal: AbortSignal, offset = 0, maxChars = 4000): Promise<unknown> {
    throwIfAborted(signal);
    let content: string;
    if (path.startsWith("artifact:")) content = await this.artifacts.read(path.slice(9));
    else {
      const target = await this.path(path);
      const info = await stat(target);
      if (!info.isFile()) throw new ArborError("not_a_file", "The selected path is not a file.");
      if (info.size > MAX_FILE_BYTES) throw new ArborError("file_size", "File tools support files up to 1 MiB in this version.");
      content = await readFile(target, "utf8");
    }
    throwIfAborted(signal);
    if (content.includes("\0")) throw new ArborError("binary_file", "Binary files are not supported by the text tools.");
    const lines = content.split(/\r?\n/);
    const end = Math.min(endLine ?? startLine + 199, lines.length);
    if (startLine > lines.length || end < startLine) throw new ArborError("line_range", "The requested line range is outside the file.");
    const selected = lines.slice(startLine - 1, end).join("\n");
    if (offset > selected.length) throw new ArborError("read_offset", "The offset is outside the selected line range.");
    const page = selected.slice(offset, offset + maxChars);
    return { path, sha256: sha256(content), totalLines: lines.length, startLine, endLine: end, offset,
      content: page, nextOffset: offset + page.length < selected.length ? offset + page.length : null,
    };
  }

  async write(path: string, content: string, expectedHash: string | undefined, signal: AbortSignal): Promise<unknown> {
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new ArborError("file_size", "File tools support writes up to 1 MiB.");
    const target = await this.path(path, true);
    let previous: Buffer | undefined;
    try { previous = await readFile(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if ((previous && (!expectedHash || sha256(previous) !== expectedHash)) || (!previous && expectedHash)) throw new ArborError("file_conflict", "The file changed or already exists. Read it and supply its current sha256 before overwriting.");
    let mode: number | undefined;
    if (previous) {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new ArborError("path_denied", "Writing through a file symlink is not supported. Select the actual workspace file.");
      mode = info.mode & 0o777;
    }
    await mkdir(dirname(target), { recursive: true });
    await this.path(path, true);
    throwIfAborted(signal);
    const temporary = join(dirname(target), `.arbor-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: "wx", mode });
      throwIfAborted(signal);
      // This is an application-level conflict check, not a cross-process filesystem CAS.
      let current: Buffer | undefined;
      try { current = await readFile(target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if ((previous && (!current || sha256(previous) !== sha256(current))) || (!previous && current)) throw new ArborError("file_conflict", "The file changed while preparing the write.");
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(() => undefined); }
    return { path, sha256: sha256(content), bytes: Buffer.byteLength(content), created: previous === undefined };
  }

  async edit(path: string, oldText: string, newText: string, expectedHash: string, signal: AbortSignal): Promise<unknown> {
    const target = await this.path(path);
    const info = await stat(target);
    if (info.size > MAX_FILE_BYTES) throw new ArborError("file_size", "File tools support files up to 1 MiB.");
    const content = await readFile(target, "utf8");
    if (sha256(content) !== expectedHash) throw new ArborError("file_conflict", "The file changed since it was read.");
    const first = content.indexOf(oldText);
    if (first < 0 || content.indexOf(oldText, first + oldText.length) >= 0) throw new ArborError("edit_match", "oldText must match exactly one location. Read a larger unique span.");
    return this.write(path, content.slice(0, first) + newText + content.slice(first + oldText.length), expectedHash, signal);
  }

  async exec(command: string, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    await mkdir(this.artifacts.directory, { recursive: true });
    const artifactId = randomUUID();
    const output = createWriteStream(join(this.artifacts.directory, artifactId + ".txt"), { flags: "wx" });
    const stdout = new OutputBuffer();
    const stderr = new OutputBuffer();
    let storedBytes = 0;
    let artifactTruncated = false;
    const environment: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "LC_ALL", "TERM"]) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    const windows = process.platform === "win32";
    const windowsSystem = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    const shell = windows ? join(windowsSystem, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "/bin/sh";
    const args = windows ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; & { ${command}\n }; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`] : ["-c", command];
    const child = spawn(shell, args, { cwd: this.cwd, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: !windows });
    let closed = false;
    let timedOut = false;
    let cancelled = false;
    let cleanupError = false;
    let stopping: Promise<void> | undefined;
    let outputError: Error | undefined;
    output.on("error", (error) => { outputError = error; void stop(); });
    const copy = (source: NodeJS.ReadableStream, buffer: OutputBuffer, chunk: Buffer) => {
      buffer.push(chunk);
      const remaining = Math.max(0, 8 * 1024 * 1024 - storedBytes);
      if (chunk.length > remaining) artifactTruncated = true;
      const accepted = chunk.subarray(0, remaining);
      storedBytes += accepted.length;
      if (accepted.length && !output.write(accepted)) {
        source.pause();
        output.once("drain", () => source.resume());
      }
    };
    child.stdout.on("data", (chunk: Buffer) => copy(child.stdout, stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => copy(child.stderr, stderr, chunk));
    const stop = (): Promise<void> => {
      if (stopping) return stopping;
      stopping = (async () => {
        if (closed || !child.pid) return;
        if (windows) {
          await new Promise<void>((resolveStop) => {
            const killer = spawn(join(windowsSystem, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
            const killDeadline = setTimeout(() => { cleanupError = true; killer.kill(); child.kill(); resolveStop(); }, 5000);
            killer.once("error", () => { clearTimeout(killDeadline); cleanupError = true; child.kill(); resolveStop(); });
            killer.once("close", (code) => { clearTimeout(killDeadline); if (code && !closed) cleanupError = true; resolveStop(); });
          });
        } else {
          try { process.kill(-child.pid, "SIGTERM"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupError = true; }
          await new Promise((r) => setTimeout(r, 150));
          try { process.kill(-child.pid, "SIGKILL"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupError = true; }
        }
      })();
      return stopping;
    };
    const abort = () => { cancelled = true; void stop(); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; void stop(); }, timeoutMs);
    try {
      const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, exitSignal) => { closed = true; resolveExit({ exitCode, signal: exitSignal }); });
      });
      if (stopping) await stopping;
      if (outputError) throw outputError;
      return { ...result, stdout: stdout.text(), stderr: stderr.text(), timedOut, cancelled, cleanupError, outputTruncated: stdout.total > 8192 || stderr.total > 8192, artifactId, artifactTruncated, totalOutputBytes: stdout.total + stderr.total };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      output.end();
      await finished(output).catch((error: unknown) => { if (!outputError) throw error; });
    }
  }
}
