import { resolve } from "node:path";

const repo = Bun.argv[2];
if (!repo) {
  throw new Error(
    "Usage: bun run bench:graph /path/to/fixture [limit] [iterations]",
  );
}

const limit = Bun.argv[3] ?? "10000";
const iterations = Bun.argv[4] ?? "5";
const benchmark = Bun.spawn(
  [
    "cargo",
    "test",
    "--release",
    "--lib",
    "git::graph::tests::support::benchmark_fixture",
    "--",
    "--exact",
    "--ignored",
    "--nocapture",
  ],
  {
    cwd: resolve(import.meta.dir, "../src-tauri"),
    env: {
      ...Bun.env,
      GITLANE_BENCH_REPO: resolve(repo),
      GITLANE_BENCH_LIMIT: limit,
      GITLANE_BENCH_ITERATIONS: iterations,
    },
    // Piped (and echoed) so a filter that matches nothing is caught below.
    stdout: "pipe",
    stderr: "inherit",
  },
);

let output = "";
const decoder = new TextDecoder();
for await (const chunk of benchmark.stdout) {
  const text = decoder.decode(chunk, { stream: true });
  output += text;
  process.stdout.write(text);
}

const exitCode = await benchmark.exited;
if (exitCode !== 0) {
  throw new Error(`graph benchmark failed with exit code ${exitCode}`);
}
// libtest exits 0 when the filter matches nothing — a moved test module would
// otherwise make the benchmark silently measure nothing.
if (!/\b1 passed\b/.test(output)) {
  throw new Error("graph benchmark ran no test (did benchmark_fixture move?)");
}
