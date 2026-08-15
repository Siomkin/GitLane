import { describe, it, expect, beforeEach, vi } from "vitest";
import { create } from "zustand";
import { createAgentsCache, type AgentsCacheApi, type AgentsCacheState } from "./agentsCache";

type Agent = { id: string };
const agent = (id: string): Agent => ({ id });

/** A promise plus its resolver, to control async ordering deterministically. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function mockApi(): AgentsCacheApi<Agent> {
  return {
    get: vi.fn().mockResolvedValue([]),
    set: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn().mockResolvedValue([]),
  };
}

function storeOf(api: AgentsCacheApi<Agent>) {
  return create<AgentsCacheState<Agent>>()(createAgentsCache(api));
}

let api: AgentsCacheApi<Agent>;
let useStore: ReturnType<typeof storeOf>;

beforeEach(() => {
  api = mockApi();
  useStore = storeOf(api);
});

describe("createAgentsCache", () => {
  it("a stale in-flight load cannot overwrite a newer save", async () => {
    const stale = [agent("stale")];
    const saved = [agent("saved")];
    const slowGet = deferred<Agent[]>();
    let getCalls = 0;
    vi.mocked(api.get).mockImplementation(() =>
      getCalls++ === 0 ? slowGet.promise : Promise.resolve(saved),
    );

    const loadP = useStore.getState().loadAgents();
    await useStore.getState().saveAgents(saved);
    expect(useStore.getState().agents).toEqual(saved);

    slowGet.resolve(stale);
    await loadP;
    expect(useStore.getState().agents).toEqual(saved);
  });

  it("treats a null backend list as empty", async () => {
    vi.mocked(api.get).mockResolvedValue(null);
    vi.mocked(api.reset).mockResolvedValue(undefined);

    await useStore.getState().loadAgents();
    expect(useStore.getState().agents).toEqual([]);

    await useStore.getState().resetAgents();
    expect(useStore.getState().agents).toEqual([]);
  });

  it("dedupes overlapping mount-time loads", async () => {
    const slowGet = deferred<Agent[]>();
    vi.mocked(api.get).mockReturnValue(slowGet.promise);

    const first = useStore.getState().loadAgents();
    const second = useStore.getState().loadAgents();
    expect(api.get).toHaveBeenCalledTimes(1);

    slowGet.resolve([agent("x")]);
    await Promise.all([first, second]);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(useStore.getState().agents).toEqual([agent("x")]);
  });
});
