import { KNOWN_COMMIT_AGENTS, type KnownCommitAgent } from "./commitAgents";

type ImageStatus = "loading" | "ready" | "failed";
interface CachedAgentImage {
  image: HTMLImageElement;
  status: ImageStatus;
}

// A fixed, app-lifetime cache: it can contain at most one image for each entry
// in KNOWN_COMMIT_AGENTS. There is no author/avatar cache and no network lookup,
// so history size cannot grow retained image memory.
const cache = new Map<string, CachedAgentImage>();
const listeners = new Set<() => void>();

export function preloadCommitAgentImages() {
  if (typeof Image === "undefined") return;
  for (const agent of KNOWN_COMMIT_AGENTS) {
    if (cache.has(agent.iconUrl)) continue;
    const image = new Image();
    image.decoding = "async";
    const entry: CachedAgentImage = { image, status: "loading" };
    cache.set(agent.iconUrl, entry);
    image.onload = () => {
      entry.status = "ready";
      notify();
    };
    image.onerror = () => {
      entry.status = "failed";
      notify();
    };
    image.src = agent.iconUrl;
  }
}

export function readyCommitAgentImage(agent: KnownCommitAgent): HTMLImageElement | null {
  const entry = cache.get(agent.iconUrl);
  return entry?.status === "ready" ? entry.image : null;
}

export function subscribeCommitAgentImages(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  for (const listener of listeners) listener();
}
