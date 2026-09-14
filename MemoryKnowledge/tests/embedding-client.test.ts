import { test, expect } from "vitest";
import { getEmbeddingConfig, WikiEmbeddingClient } from "../src/engines/wiki/embedding-client.js";

test("getEmbeddingConfig returns null when incomplete", () => {
  expect(getEmbeddingConfig({})).toBeNull();
  expect(getEmbeddingConfig({ embedding: { baseUrl: "x" } })).toBeNull();
});

test("getEmbeddingConfig parses valid cfg", () => {
  const c = getEmbeddingConfig({ embedding: { baseUrl: "http://h:1", apiKey: "k", model: "m", dimensions: 4 } });
  expect(c?.dimensions).toBe(4);
});

test("WikiEmbeddingClient normalizes baseUrl trailing slash", () => {
  const c = new WikiEmbeddingClient({ provider: "x", baseUrl: "http://h:1/", apiKey: "k", model: "m", dimensions: 2 });
  expect((c as any).cfg.baseUrl).toBe("http://h:1");
});