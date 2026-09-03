// Runtime schemas for the Files browser reads/writes, file history, blame, and
// the range comparison — mirrors `git/types/files.ts`.

import { z } from "zod";
import type {
  BlameLine,
  CompareResult,
  FileBlame,
  FileHistoryEntry,
  FileHistoryPage,
  RepoFileContent,
  RepoFileWriteResult,
  RepoFiles,
} from "@/lib/api/git/types/files";
import { assertEqual } from "./assertEqual";
import { fileChangeSchema, fileStatusSchema } from "./status";

export const repoFilesSchema = z.object({
  paths: z.array(z.string()),
  truncated: z.boolean(),
});

export const repoFileContentSchema = z.object({
  text: z.string().optional(),
  size: z.number(),
  truncated: z.boolean(),
  binary: z.boolean(),
  expectedState: z.string().optional(),
});

export const repoFileWriteResultSchema = z.object({
  size: z.number(),
  expectedState: z.string(),
});

const fileHistoryEntrySchema = z.object({
  oid: z.string(),
  shortOid: z.string(),
  subject: z.string(),
  body: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  timestamp: z.number(),
  status: fileStatusSchema,
  path: z.string(),
  add: z.number(),
  del: z.number(),
  previousPath: z.string().nullable(),
});

export const fileHistoryPageSchema = z.object({
  entries: z.array(fileHistoryEntrySchema),
  nextOffset: z.number(),
  hasMore: z.boolean(),
  truncated: z.boolean(),
});

const blameLineSchema = z.object({
  lineNo: z.number(),
  content: z.string(),
  oid: z.string(),
  shortOid: z.string(),
  subject: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  timestamp: z.number(),
  originalPath: z.string(),
  originalLine: z.number(),
});

export const fileBlameSchema = z.object({
  path: z.string(),
  revision: z.string().nullable(),
  binary: z.boolean(),
  truncated: z.boolean(),
  lines: z.array(blameLineSchema),
});

export const compareResultSchema = z.object({
  files: z.array(fileChangeSchema),
  add: z.number(),
  del: z.number(),
  ahead: z.number(),
  behind: z.number(),
});

assertEqual<z.infer<typeof repoFilesSchema>, RepoFiles>(true);
assertEqual<z.infer<typeof repoFileContentSchema>, RepoFileContent>(true);
assertEqual<z.infer<typeof repoFileWriteResultSchema>, RepoFileWriteResult>(true);
assertEqual<z.infer<typeof fileHistoryEntrySchema>, FileHistoryEntry>(true);
assertEqual<z.infer<typeof fileHistoryPageSchema>, FileHistoryPage>(true);
assertEqual<z.infer<typeof blameLineSchema>, BlameLine>(true);
assertEqual<z.infer<typeof fileBlameSchema>, FileBlame>(true);
assertEqual<z.infer<typeof compareResultSchema>, CompareResult>(true);
