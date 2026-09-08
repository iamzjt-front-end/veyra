import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  currentProcessOwner,
  inspectProcessOwner,
  isProcessOwner,
  type ProcessOwner,
} from "./owner.js";

export class LocalLockError extends Error {
  override readonly name = "LocalLockError";
  constructor(
    readonly code: "lock_busy" | "invalid_lock" | "lock_timeout" | "lock_lost",
    message: string,
  ) {
    super(message);
  }
}

export interface LocalLockOptions {
  directory: string;
  /** Scope-local logical owner, such as a run UUID or the shared store identifier. */
  holder: string;
  waitMs?: number;
  /** Only dead local entries for this same holder may be retired. Never uses age/mtime. */
  recoverStale?: boolean;
}

export interface LocalLock {
  release(): Promise<void>;
}

interface Ticket {
  version: 1;
  id: string;
  directory: string;
  holder: string;
  owner: ProcessOwner;
  /** Zero means choosing; a positive number is ordered with the unique entry ID. */
  number: number;
}

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_ENTRIES = 1024;

/** Local-filesystem bakery lock: each participant writes/deletes only its unique entry.
 * Avoids deleting a replacement owner's reusable lock name during stale recovery.
 * See https://lamport.azurewebsites.net/pubs/bakery.pdf and docs/LOCKING.md.
 */
export async function acquireLocalLock(options: LocalLockOptions): Promise<LocalLock> {
  const waitMs = options?.waitMs ?? 0;
  if (
    !options ||
    typeof options.directory !== "string" ||
    !options.directory ||
    options.directory.includes("\0") ||
    typeof options.holder !== "string" ||
    !/^[A-Za-z0-9:_-]{1,128}$/.test(options.holder) ||
    !Number.isSafeInteger(waitMs) ||
    waitMs < 0 ||
    waitMs > 60_000 ||
    (options.recoverStale !== undefined && typeof options.recoverStale !== "boolean")
  )
    throw new LocalLockError(
      "invalid_lock",
      "Expected a local lock directory, holder and wait of 0–60000 ms.",
    );
  const requested = resolve(options.directory);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const stat = await lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new LocalLockError(
      "invalid_lock",
      `Refusing a linked or non-directory lock scope: ${requested}.`,
    );
  const directory = await realpath(requested);
  const ticket: Ticket = {
    version: 1,
    id: randomUUID(),
    directory,
    holder: options.holder,
    owner: currentProcessOwner(),
    number: 0,
  };
  const file = join(directory, `${ticket.id}.json`);
  let published = false;
  const start = performance.now();
  const entries = async () => {
    const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    if (names.length > MAX_ENTRIES)
      throw new LocalLockError(
        "invalid_lock",
        `Too many lock entries at ${directory}; preserve and inspect coordination metadata.`,
      );
    const result: Ticket[] = [];
    for (const name of names) {
      const other = await readTicket(join(directory, name), directory);
      if (!other || other.id === ticket.id) continue;
      const liveness = inspectProcessOwner(other.owner);
      if (liveness === "dead") {
        if (!options.recoverStale || other.holder !== ticket.holder)
          throw new LocalLockError(
            "lock_busy",
            `Lock at ${directory} belongs to a stopped owner; explicit recovery for that holder is required.`,
          );
        // Names are never reused. Two recoverers may unlink the same dead entry,
        // but neither can remove a new live owner's different entry.
        await remove(join(directory, name));
      } else if (liveness === "unknown")
        throw new LocalLockError(
          "lock_busy",
          `Owner liveness is unknown at ${directory}; preserve the lock for inspection.`,
        );
      else result.push(other);
    }
    return result;
  };
  try {
    await publish(file, ticket, true);
    published = true;
    ticket.number = 1 + Math.max(0, ...(await entries()).map((entry) => entry.number));
    if (!Number.isSafeInteger(ticket.number))
      throw new LocalLockError("invalid_lock", `Lock ticket counter overflow at ${directory}.`);
    await publish(file, ticket, false);
    for (;;) {
      const pending = (await entries()).some(
        (entry) =>
          entry.number === 0 ||
          entry.number < ticket.number ||
          (entry.number === ticket.number && entry.id < ticket.id),
      );
      if (!pending) break;
      if (performance.now() - start >= waitMs)
        throw new LocalLockError(
          waitMs ? "lock_timeout" : "lock_busy",
          `Lock is busy at ${directory}; wait for its owner to finish and retry.`,
        );
      await delay(Math.min(10, Math.max(1, waitMs - (performance.now() - start))));
    }
    let releasing: Promise<void> | undefined;
    return {
      release: () =>
        (releasing ??= (async () => {
          const current = await readTicket(file, directory);
          if (
            !current ||
            current.owner.pid !== ticket.owner.pid ||
            current.owner.host !== ticket.owner.host ||
            current.number !== ticket.number
          )
            throw new LocalLockError(
              "lock_lost",
              `Lock ownership changed at ${directory}; preserve coordination metadata.`,
            );
          await unlink(file);
        })()),
    };
  } catch (error) {
    if (published) await remove(file);
    throw error;
  }
}

async function publish(path: string, ticket: Ticket, initial: boolean) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let created = false;
  try {
    await writeFile(temporary, JSON.stringify(ticket), { flag: "wx", mode: 0o600 });
    created = true;
    // Publish a complete choosing record atomically; no empty-owner window.
    if (initial) await link(temporary, path);
    else await rename(temporary, path);
  } finally {
    if (created) await remove(temporary);
  }
}

async function readTicket(path: string, directory: string): Promise<Ticket | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192)
      throw new Error("Invalid lock file");
    const entry = JSON.parse(await readFile(path, "utf8")) as Ticket;
    if (
      !entry ||
      typeof entry !== "object" ||
      Object.keys(entry).length !== 6 ||
      entry.version !== 1 ||
      typeof entry.id !== "string" ||
      !ID.test(entry.id) ||
      path !== join(directory, `${entry.id}.json`) ||
      entry.directory !== directory ||
      typeof entry.holder !== "string" ||
      !/^[A-Za-z0-9:_-]{1,128}$/.test(entry.holder) ||
      !isProcessOwner(entry.owner) ||
      !Number.isSafeInteger(entry.number) ||
      entry.number < 0
    )
      throw new Error("Invalid lock record");
    return entry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new LocalLockError(
      "invalid_lock",
      `Invalid lock entry at ${path}; preserve it for inspection.`,
    );
  }
}

async function remove(path: string) {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
