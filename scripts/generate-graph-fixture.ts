import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Shape = "linear" | "merge-heavy";

interface Options {
  output: string;
  commits: number;
  shape: Shape;
  refs: number;
  messageBytes: number;
}

function parseOptions(args: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Expected --name value arguments, received: ${args.join(" ")}`);
    }
    values.set(key.slice(2), value);
  }
  const commits = Number(values.get("commits") ?? 2_000);
  const shape = (values.get("shape") ?? "linear") as Shape;
  const refs = Number(values.get("refs") ?? 200);
  const messageBytes = Number(values.get("message-bytes") ?? 80);
  const output = resolve(
    values.get("output") ?? join(tmpdir(), `gitlane-bench-${shape}-${commits}`),
  );
  if (!Number.isInteger(commits) || commits < 1) throw new Error("--commits must be >= 1");
  if (!Number.isInteger(refs) || refs < 0) throw new Error("--refs must be >= 0");
  if (!Number.isInteger(messageBytes) || messageBytes < 16) {
    throw new Error("--message-bytes must be >= 16");
  }
  if (shape !== "linear" && shape !== "merge-heavy") {
    throw new Error("--shape must be linear or merge-heavy");
  }
  return { output, commits, shape, refs, messageBytes };
}

const options = parseOptions(Bun.argv.slice(2));
rmSync(options.output, { recursive: true, force: true });
mkdirSync(options.output, { recursive: true });

const init = Bun.spawnSync(["git", "init", "--quiet", "--initial-branch=main"], {
  cwd: options.output,
  stderr: "inherit",
});
if (init.exitCode !== 0) throw new Error("git init failed");

const stream: string[] = ["feature done\n"];
const marks: number[] = [];
let mark = 0;
let timestamp = 1_700_000_000;
let mainMark = 0;

function data(value: string) {
  return `data ${Buffer.byteLength(value)}\n${value}\n`;
}

function message(index: number, kind: string) {
  const prefix = `benchmark ${kind} commit ${index.toString().padStart(6, "0")} `;
  return (prefix + "x".repeat(options.messageBytes)).slice(0, options.messageBytes);
}

function addCommit(ref: string, kind: string, parents: number[] = []) {
  mark += 1;
  timestamp += 1;
  const commitMessage = message(mark, kind);
  stream.push(`commit ${ref}\n`);
  stream.push(`mark :${mark}\n`);
  stream.push(`author Benchmark Author ${mark % 97} <author${mark % 97}@example.test> ${timestamp} +0000\n`);
  stream.push(`committer Benchmark <benchmark@example.test> ${timestamp} +0000\n`);
  stream.push(data(commitMessage));
  if (parents[0]) stream.push(`from :${parents[0]}\n`);
  for (const parent of parents.slice(1)) stream.push(`merge :${parent}\n`);
  if (mark === 1) {
    stream.push("M 100644 inline benchmark.txt\n");
    stream.push(data("deterministic graph fixture\n"));
  }
  stream.push("\n");
  marks.push(mark);
  return mark;
}

mainMark = addCommit("refs/heads/main", "root");

if (options.shape === "linear") {
  while (mark < options.commits) {
    mainMark = addCommit("refs/heads/main", "linear", [mainMark]);
  }
} else {
  let group = 0;
  while (mark < options.commits) {
    group += 1;
    const base = mainMark;
    const topics: Array<{ mark: number; ref: string }> = [];
    for (let topic = 0; topic < 8 && mark < options.commits; topic += 1) {
      const ref = `refs/heads/topics/topic-${group}-${topic}`;
      topics.push({ mark: addCommit(ref, "topic", [base]), ref });
    }
    for (let advance = 0; advance < 8 && mark < options.commits; advance += 1) {
      mainMark = addCommit("refs/heads/main", "main", [mainMark]);
    }
    for (const topic of topics) {
      if (mark >= options.commits) break;
      mainMark = addCommit("refs/heads/main", "merge", [mainMark, topic.mark]);
      stream.push(`reset ${topic.ref}\n\n`);
    }
  }
}

for (let index = 0; index < options.refs; index += 1) {
  const target = marks[Math.floor((index * marks.length) / Math.max(options.refs, 1))] ?? mainMark;
  const namespace = index % 2 === 0 ? "tags" : "remotes/origin";
  stream.push(`reset refs/${namespace}/benchmark-${index}\nfrom :${target}\n\n`);
}
stream.push("done\n");

const importer = Bun.spawn(["git", "fast-import", "--quiet"], {
  cwd: options.output,
  stdin: "pipe",
  stdout: "inherit",
  stderr: "inherit",
});
importer.stdin.write(stream.join(""));
importer.stdin.end();
const exitCode = await importer.exited;
if (exitCode !== 0) throw new Error(`git fast-import failed with exit code ${exitCode}`);

const checkout = Bun.spawnSync(["git", "reset", "--hard", "--quiet", "main"], {
  cwd: options.output,
  stderr: "inherit",
});
if (checkout.exitCode !== 0) throw new Error("git reset failed");

console.log(
  JSON.stringify(
    {
      output: options.output,
      commits: options.commits,
      shape: options.shape,
      refs: options.refs,
      messageBytes: options.messageBytes,
    },
    null,
    2,
  ),
);
