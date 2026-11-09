import { readdir, readFile, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { ProjectionLabError } from "./errors.js";
import { redactSecrets } from "./redact.js";
import { secureMkdir, secureWriteFile } from "./secureFs.js";
import { log } from "./logger.js";
import type { Snapshot } from "./types/projectionlab.js";

const RETENTION_DAYS = 30;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The three mutually exclusive ways a caller can name one snapshot. */
export interface SnapshotSelectorArgs {
  snapshotId?: string | null;
  nBack?: number | null;
  beforeTime?: string | null;
}

type SnapshotSelector =
  | { kind: "snapshotId"; value: string }
  | { kind: "nBack"; value: number }
  | { kind: "beforeTime"; value: string };

const SELECTOR_KEYS = ["snapshotId", "nBack", "beforeTime"] as const;

const SELECTOR_HELP =
  "Supply exactly one of snapshotId (an exact ID from projectionlab_list_snapshots), " +
  "nBack (how many snapshots back, 1 being the most recent) or " +
  "beforeTime (an ISO 8601 time with an explicit Z or ±HH:MM offset)";

// Snapshot timestamps are UTC instants. Date.parse reads an offset-less
// date-time in the host's zone and accepts loose text such as "12345" or
// "November 8 2026", so beforeTime has to carry its own offset to name one
// unambiguous instant. A bare date is refused for the same reason: it states
// no time of day.
const ISO_TIME_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/i;

/** The instant a beforeTime names, or NaN when it is not a usable one. */
function parseBeforeTime(value: string): number {
  const parts = ISO_TIME_WITH_OFFSET.exec(value);
  if (!parts) return NaN;

  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return NaN;

  const offset = parts[8].toUpperCase();
  const offsetMinutes =
    offset === "Z"
      ? 0
      : (offset[0] === "-" ? -1 : 1) *
        (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));

  // Date.parse rolls 31 February over instead of rejecting it, so the wall
  // clock the caller wrote has to survive the round trip.
  const wall = new Date(ms + offsetMinutes * 60_000);
  const matches =
    wall.getUTCFullYear() === Number(parts[1]) &&
    wall.getUTCMonth() === Number(parts[2]) - 1 &&
    wall.getUTCDate() === Number(parts[3]) &&
    wall.getUTCHours() === Number(parts[4]) &&
    wall.getUTCMinutes() === Number(parts[5]);

  return matches ? ms : NaN;
}

function pickSelector(
  args: SnapshotSelectorArgs,
  subject: string,
): SnapshotSelector {
  const supplied = SELECTOR_KEYS.filter(
    (key) => args[key] !== undefined && args[key] !== null,
  );

  if (supplied.length !== 1) {
    throw new ProjectionLabError(
      "INVALID_INPUT",
      supplied.length === 0
        ? `No ${subject} selector supplied`
        : `Supply exactly one ${subject} selector, received ${supplied.join(" and ")}`,
      SELECTOR_HELP,
    );
  }

  // Exactly one key is present and is neither undefined nor null.
  return { kind: supplied[0], value: args[supplied[0]] } as SnapshotSelector;
}

export class SnapshotManager {
  private dir = config.snapshotDir;
  private initialized = false;

  private async ensureDir(): Promise<void> {
    if (!this.initialized) {
      await secureMkdir(this.dir);
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
    await secureWriteFile(filePath, JSON.stringify(snapshot, null, 2));
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

    // Newest first, with equal millisecond timestamps ordered by id so a
    // recency-based rollback selector picks the same snapshot every time.
    return snapshots.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  async get(snapshotId: string): Promise<Snapshot> {
    await this.ensureDir();

    // Snapshot IDs are UUIDs we generate; reject anything else so a
    // caller-supplied value can't traverse out of the snapshot directory.
    if (!UUID_RE.test(snapshotId)) {
      throw new ProjectionLabError(
        "SNAPSHOT_NOT_FOUND",
        `Snapshot ${snapshotId} not found`,
        "Use projectionlab_list_snapshots to see available snapshots",
      );
    }

    const filePath = join(this.dir, `${snapshotId}.json`);
    // Defense in depth: ensure the resolved path stays inside the snapshot dir.
    const dirPrefix = resolve(this.dir) + sep;
    if (!resolve(filePath).startsWith(dirPrefix)) {
      throw new ProjectionLabError(
        "SNAPSHOT_NOT_FOUND",
        `Snapshot ${snapshotId} not found`,
        "Use projectionlab_list_snapshots to see available snapshots",
      );
    }
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

/**
 * Resolve a snapshot selector to one snapshot. Shared by
 * projectionlab_rollback and projectionlab_diff so both pick the same
 * snapshot for the same selector.
 *
 * nBack and beforeTime rank snapshots newest first, the order
 * projectionlab_list_snapshots shows, and count every saved snapshot including
 * the rollback_pre_* snapshot a confirmed rollback itself writes. nBack: 1 is
 * therefore always the top of that list, which is the state saved just before
 * a confirmed rollback, so a rollback is undone by rolling back once more.
 *
 * `subject` names the selector in the errors, for example "rollback snapshot"
 * or "from snapshot".
 */
export async function resolveSnapshot(
  snapshots: SnapshotManager,
  args: SnapshotSelectorArgs,
  subject = "rollback snapshot",
): Promise<Snapshot> {
  const selector = pickSelector(args, subject);

  switch (selector.kind) {
    case "snapshotId":
      return snapshots.get(selector.value);

    case "nBack": {
      const nBack = selector.value;
      if (!Number.isInteger(nBack) || nBack < 1) {
        throw new ProjectionLabError(
          "INVALID_INPUT",
          `nBack must be a positive integer with 1 as the most recent snapshot, received ${String(nBack)}`,
          SELECTOR_HELP,
        );
      }

      const list = await snapshots.list();
      if (nBack > list.length) {
        const existence =
          list.length === 0
            ? "no snapshots exist"
            : `only ${list.length} snapshot${list.length === 1 ? "" : "s"} exist${list.length === 1 ? "s" : ""}`;
        throw new ProjectionLabError(
          "SNAPSHOT_NOT_FOUND",
          `nBack ${nBack} is out of range; ${existence}`,
          "Use projectionlab_list_snapshots to see them, or a smaller nBack. " +
            "Snapshots are saved automatically before confirmed writes",
        );
      }

      return snapshots.get(list[nBack - 1].id);
    }

    case "beforeTime": {
      const cutoff = parseBeforeTime(selector.value);
      if (Number.isNaN(cutoff)) {
        throw new ProjectionLabError(
          "INVALID_INPUT",
          `beforeTime "${selector.value}" is not an ISO 8601 time with an explicit Z or ±HH:MM offset`,
          "Use a time such as 2026-11-08T15:30:00Z or 2026-11-08T15:30:00+02:00. " +
            "projectionlab_list_snapshots shows snapshot times in that form",
        );
      }

      const list = await snapshots.list();
      const match = list.find(
        (entry) => Date.parse(entry.timestamp) < cutoff,
      );
      if (!match) {
        throw new ProjectionLabError(
          "SNAPSHOT_NOT_FOUND",
          list.length === 0
            ? "No snapshots exist, so nothing predates that beforeTime"
            : `No snapshot predates ${selector.value}; the oldest is ${list[list.length - 1].timestamp}`,
          "Use projectionlab_list_snapshots to see the saved snapshot times, or a later beforeTime",
        );
      }

      return snapshots.get(match.id);
    }
  }
}
