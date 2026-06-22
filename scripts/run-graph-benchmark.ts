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
    "git::graph::tests::benchmark_fixture",
    "--",
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
    stdout: "inherit",
    stderr: "inherit",
  },
);

const exitCode = await benchmark.exited;
if (exitCode !== 0) {
  throw new Error(`graph benchmark failed with exit code ${exitCode}`);
}
