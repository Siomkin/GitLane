// Runtime schemas for the terminal-agent / commit-agent / ACP settings
// catalogues and the PTY spawn response — mirrors the interfaces in
// `terminal.ts`.

import { z } from "zod";
import type {
  AcpAdapter,
  AcpAgent,
  AcpConfigOption,
  AcpModel,
  AcpProbe,
  AiActionCommand,
  CommitAgentMessages,
  PtySpawnResponse,
  TerminalAgent,
} from "@/lib/api/terminal";
import { assertEqual } from "./assertEqual";

export const terminalAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  available: z.boolean(),
});

const aiActionCommandSchema = z.object({
  id: z.string(),
  title: z.string(),
  instruction: z.string(),
  enabled: z.boolean(),
});

export const commitAgentMessagesSchema = z.object({
  draftInstruction: z.string(),
  commitInstruction: z.string(),
  descriptionInstruction: z.string(),
  aiActions: z.array(aiActionCommandSchema),
});

export const acpAdapterSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  install: z.string(),
  docs: z.string(),
  requires: z.string(),
  available: z.boolean(),
});

const acpModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
});

const acpConfigOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  currentValue: z.string(),
  options: z.array(acpModelSchema),
});

export const acpProbeSchema = z.object({
  agentName: z.string(),
  agentVersion: z.string(),
  models: z.array(acpModelSchema),
  currentModelId: z.string(),
  configOptions: z.array(acpConfigOptionSchema),
});

export const acpAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  model: z.string(),
  config: z.record(z.string(), z.string()),
  description: z.string(),
  enabled: z.boolean(),
  available: z.boolean(),
});

export const ptySpawnResponseSchema = z.object({
  sessionId: z.number(),
});

assertEqual<z.infer<typeof terminalAgentSchema>, TerminalAgent>(true);
assertEqual<z.infer<typeof aiActionCommandSchema>, AiActionCommand>(true);
assertEqual<z.infer<typeof commitAgentMessagesSchema>, CommitAgentMessages>(true);
assertEqual<z.infer<typeof acpAdapterSchema>, AcpAdapter>(true);
assertEqual<z.infer<typeof acpModelSchema>, AcpModel>(true);
assertEqual<z.infer<typeof acpConfigOptionSchema>, AcpConfigOption>(true);
assertEqual<z.infer<typeof acpProbeSchema>, AcpProbe>(true);
assertEqual<z.infer<typeof acpAgentSchema>, AcpAgent>(true);
assertEqual<z.infer<typeof ptySpawnResponseSchema>, PtySpawnResponse>(true);
