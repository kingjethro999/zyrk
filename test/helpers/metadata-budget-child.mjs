import { RegistryClient } from "../../src/fetch/registry.ts";

const registry = process.argv[2];
if (!registry) process.exit(2);

try {
  await new RegistryClient({
    registry,
    userAgent: "zyrk-test",
    retries: 0,
    maxMetadataBytes: 16 * 1024 * 1024,
    maxTotalMetadataBytes: 1024,
    requestDeadlineMs: 5_000,
  }).packument("fixture");
  process.stdout.write("unexpected success\n");
  process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${error.code ?? "UNKNOWN"}\n`);
}

// Keep the process alive long enough to surface late writes into a closed
// decompressor. The parent test checks that this stays an ordinary rejection.
await new Promise((resolve) => setTimeout(resolve, 100));
