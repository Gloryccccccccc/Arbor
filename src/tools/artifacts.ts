import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ArborError } from "../errors.js";

export class ArtifactStore {
  readonly directory: string;
  constructor(dataDir: string, sessionId: string) { this.directory = join(dataDir, "artifacts", sessionId); }
  async put(text: string): Promise<string> {
    const id = randomUUID();
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, id + ".txt"), text, { flag: "wx" });
    return id;
  }
  async read(id: string): Promise<string> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new ArborError("artifact_id", "Invalid artifact ID.");
    return readFile(join(this.directory, id + ".txt"), "utf8");
  }
}

export function clipText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  const half = Math.max(1, Math.floor((maxBytes - 100) / 2));
  return { text: bytes.subarray(0, half).toString("utf8") + "\n… output truncated; read the artifact for details …\n" + bytes.subarray(-half).toString("utf8"), truncated: true };
}
