export function fullCommitMessage(summary: string, body: string): string {
  return body.trim() ? `${summary}\n\n${body.trim()}` : summary;
}

export function splitCommitMessage(message: string): { summary: string; description: string } {
  const lines = message.replace(/\r\n/g, "\n").trim().split("\n");
  const summary = lines.shift()?.trim() ?? "";
  const description = lines.join("\n").trim();
  return { summary, description };
}
