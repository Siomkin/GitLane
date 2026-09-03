// Runtime schemas for `commit_graph`, `search_history`, and `range_commits` —
// mirrors `git/types/graph.ts`.

import { z } from "zod";
import type {
  CommitNode,
  GraphEdge,
  HistorySearchPage,
  HistorySearchResult,
  RefLabel,
  RepoGraph,
  StashRef,
} from "@/lib/api/git/types/graph";
import { assertEqual } from "./assertEqual";

const refLabelSchema = z.object({
  name: z.string(),
  kind: z.enum(["branch", "remote", "tag", "head"]),
  targetOid: z.string().nullish(),
});

const stashRefSchema = z.object({
  index: z.number(),
  message: z.string(),
});

const commitNodeSchema = z.object({
  id: z.string(),
  shortId: z.string(),
  summary: z.string(),
  body: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  timestamp: z.number(),
  parents: z.array(z.string()),
  lane: z.number(),
  row: z.number(),
  refs: z.array(refLabelSchema),
  stash: stashRefSchema.nullish(),
});

const graphEdgeSchema = z.object({
  fromRow: z.number(),
  fromLane: z.number(),
  toRow: z.number(),
  toLane: z.number(),
  parentIndex: z.number(),
  color: z.number(),
});

export const repoGraphSchema = z.object({
  commits: z.array(commitNodeSchema),
  edges: z.array(graphEdgeSchema),
  laneCount: z.number(),
  wipLane: z.number().nullable(),
  head: z.string().nullable(),
  truncated: z.boolean(),
});

export const historySearchResultSchema = z.object({
  id: z.string(),
  shortId: z.string(),
  summary: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  timestamp: z.number(),
});

export const historySearchPageSchema = z.object({
  results: z.array(historySearchResultSchema),
  truncated: z.boolean(),
  workTruncated: z.boolean(),
});

assertEqual<z.infer<typeof refLabelSchema>, RefLabel>(true);
assertEqual<z.infer<typeof stashRefSchema>, StashRef>(true);
assertEqual<z.infer<typeof commitNodeSchema>, CommitNode>(true);
assertEqual<z.infer<typeof graphEdgeSchema>, GraphEdge>(true);
assertEqual<z.infer<typeof repoGraphSchema>, RepoGraph>(true);
assertEqual<z.infer<typeof historySearchResultSchema>, HistorySearchResult>(true);
assertEqual<z.infer<typeof historySearchPageSchema>, HistorySearchPage>(true);
