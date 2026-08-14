import { readSwrCache, writeSwrCache, clearSwrCache } from "../swrCache";

beforeEach(() => {
  localStorage.clear();
});

describe("swrCache", () => {
  it("returns null when nothing has been written for a key", () => {
    expect(readSwrCache("nope")).toBeNull();
  });

  it("round-trips data through write/read", () => {
    writeSwrCache("k", { hello: "world" });
    const entry = readSwrCache("k");
    expect(entry.data).toEqual({ hello: "world" });
    expect(typeof entry.ts).toBe("number");
  });

  it("returns cached data regardless of age — no TTL cutoff", () => {
    localStorage.setItem("k", JSON.stringify({ ts: Date.now() - 999 * 24 * 3600 * 1000, data: { old: true } }));
    expect(readSwrCache("k").data).toEqual({ old: true });
  });

  it("distinguishes an explicitly-cached null from never-cached (both readable, caller decides)", () => {
    writeSwrCache("k", null);
    const entry = readSwrCache("k");
    expect(entry).not.toBeNull();
    expect(entry.data).toBeNull();
  });

  it("clearSwrCache removes the entry", () => {
    writeSwrCache("k", { x: 1 });
    clearSwrCache("k");
    expect(readSwrCache("k")).toBeNull();
  });

  it("never throws on corrupt JSON in storage", () => {
    localStorage.setItem("k", "{not json");
    expect(() => readSwrCache("k")).not.toThrow();
    expect(readSwrCache("k")).toBeNull();
  });
});
