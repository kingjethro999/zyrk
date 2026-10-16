import { open, readFile } from "node:fs/promises";
import * as path from "node:path";
import { canonicalJson } from "../util/json.ts";
import { ensureDirWithMode, isErrno, mkdirp, rmrfNoFollow } from "../util/fsx.ts";
import { randomId } from "../util/ids.ts";
import { Store } from "./layout.ts";

/**
 * Journaled install transactions (SPEC 17.3).
 *
 * A transaction owns a staging directory under `staging/<txn-id>/` and a
 * journal that records durable state transitions. Markers are written before
 * actions whose recovery depends on them; recovery (a later milestone) reads
 * the journal and the filesystem together and never trusts a stale "done".
 */

export const TXN_STATES = [
  "planned",
  "fetching",
  "sources-committed",
  "realizations-ready",
  "private-builds-ready",
  "projection-ready",
  "committing",
  "committed",
  "aborted",
] as const;

export type TransactionState = (typeof TXN_STATES)[number];

export type JournalEntry = {
  at: string;
  event: "state" | "note";
  state?: TransactionState;
  message?: string;
  data?: Record<string, unknown>;
};

export class Transaction {
  readonly id: string;
  readonly dir: string;
  readonly journalPath: string;
  readonly store: Store;

  private constructor(store: Store, id: string) {
    this.store = store;
    this.id = id;
    this.dir = path.join(store.paths.stagingDir, id);
    this.journalPath = path.join(this.dir, "journal.jsonl");
  }

  static async begin(store: Store, kind: string): Promise<Transaction> {
    const id = `txn1_${randomId("", 16)}`;
    const txn = new Transaction(store, id);
    await ensureDirWithMode(txn.dir, 0o700);
    await txn.appendJournal({ event: "note", message: `begin ${kind}` });
    await txn.setState("planned");
    return txn;
  }

  async appendJournal(entry: Omit<JournalEntry, "at">): Promise<void> {
    const line = canonicalJson({ at: new Date().toISOString(), ...entry });
    await mkdirp(path.dirname(this.journalPath));
    const handle = await open(this.journalPath, "a", 0o600);
    try {
      await handle.write(`${line}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /**
   * Record a state transition. The state is durable before the caller acts on
   * it: writers call setState(state) before performing the action that the
   * state describes.
   */
  async setState(state: TransactionState): Promise<void> {
    await this.appendJournal({ event: "state", state });
  }

  async currentState(): Promise<TransactionState | null> {
    let text: string;
    try {
      text = await readFile(this.journalPath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }
    let last: TransactionState | null = null;
    for (const line of text.split("\n")) {
      if (line === "") continue;
      try {
        const parsed = JSON.parse(line) as Partial<JournalEntry>;
        if (parsed.event === "state" && typeof parsed.state === "string" && (TXN_STATES as readonly string[]).includes(parsed.state)) {
          last = parsed.state as TransactionState;
        }
      } catch {
        // A torn final line after a crash is expected; earlier lines stand.
      }
    }
    return last;
  }

  /** Discard the staging area. Callers decide when cleanup is safe. */
  async finish(): Promise<void> {
    await rmrfNoFollow(this.dir);
  }
}
