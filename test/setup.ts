/** Keep fixture paths canonical on hosts whose temporary directory is an alias.
 * Production deployment deliberately rejects symlinked output parents; tests
 * create their ordinary fixtures beneath the real temporary directory instead.
 */
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";

process.env.TMPDIR = await realpath(tmpdir());
