import { afterEach, describe, expect, it, vi } from "vitest";
import { KNOWN_COMMIT_AGENTS } from "./commitAgents";
import {
  preloadCommitAgentImages,
  readyCommitAgentImage,
  subscribeCommitAgentImages,
} from "./commitAgentImages";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("commit agent image cache", () => {
  it("creates at most one local image per registry entry and notifies on decode", () => {
    const images: FakeImage[] = [];
    class FakeImage {
      decoding = "auto";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      src = "";

      constructor() {
        images.push(this);
      }
    }
    vi.stubGlobal("Image", FakeImage);
    const listener = vi.fn();
    const unsubscribe = subscribeCommitAgentImages(listener);

    preloadCommitAgentImages();
    preloadCommitAgentImages();

    expect(images).toHaveLength(KNOWN_COMMIT_AGENTS.length);
    expect(readyCommitAgentImage(KNOWN_COMMIT_AGENTS[0])).toBeNull();
    images[0].onload?.();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readyCommitAgentImage(KNOWN_COMMIT_AGENTS[0])).toBe(
      images[0] as unknown as HTMLImageElement,
    );
    unsubscribe();
  });
});
