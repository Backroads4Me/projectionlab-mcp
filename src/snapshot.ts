import { readdir, readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { ProjectionLabError } from "./errors.js";
import { redactSecrets } from "./redact.js";
import { log } from "./logger.js";
import type { Snapshot } from "./types/projectionlab.js";

const RETENTION_DAYS = 30;

export class SnapshotManager {
  private dir = config.snapshotDir;
  private initialized = false;

  private async ensureDir(): Promise<void> {
    if (!this.initialized) {
      await mkdir(this.dir, { recursive: true });
      this.initialized = true;
    }
  }

  private async prune(): Promise<void> {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const files = await readdir(this.dir);

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(this.dir, file), "utf-8");
        const snap = JSON.parse(raw) as Snapshot;
        if (new Date(snap.timestamp).getTime() < cutoff) {
          await unlink(join(this.dir, file));
          log.info("snapshot", `Pruned expired snapshot ${snap.id}`);
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  async create(
    operation: string,
    sections: string[],
    data: Record<string, unknown>,
  ): Promise<Snapshot> {
    await this.ensureDir();

    const snapshot: Snapshot = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      operation,
      sections,
      // Value-only redaction: scrubs the literal API key if it ever appears in
      // the state without altering any financial data, so rollback stays exact.
      data: redactSecrets(data),
    };

    const filePath = join(this.dir, `${snapshot.id}.json`);
    await writeFile(filePath, JSON.stringify(snapshot, null, 2));
    log.info("snapshot", `Created snapshot ${snapshot.id} for ${operation}`);

    // Prune old snapshots in the background
    this.prune().catch((err) =>
      log.warn("snapshot", `Prune failed: ${err}`),
    );

    return snapshot;
  }

  async list(): Promise<Omit<Snapshot, "data">[]> {
    await this.ensureDir();

    const files = await readdir(this.dir);
    const snapshots: Omit<Snapshot, "data">[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(this.dir, file), "utf-8");
        const snap = JSON.parse(raw) as Snapshot;
        snapshots.push({
          id: snap.id,
          timestamp: snap.timestamp,
          operation: snap.operation,
          sections: snap.sections,
        });
      } catch {
        log.warn("snapshot", `Failed to read snapshot file: ${file}`);
      }
    }

    return snapshots.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
  }

  async get(snapshotId: string): Promise<Snapshot> {
    await this.ensureDir();

    const filePath = join(this.dir, `${snapshotId}.json`);
    try {
      const raw = await readFile(filePath, "utf-8");
      return JSON.parse(raw) as Snapshot;
    } catch {
      throw new ProjectionLabError(
        "SNAPSHOT_NOT_FOUND",
        `Snapshot ${snapshotId} not found`,
        "Use projectionlab_list_snapshots to see available snapshots",
      );
    }
  }
}
