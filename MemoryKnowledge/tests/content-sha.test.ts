import { test, expect } from "vitest";
import { contentSha256 } from "../src/engines/wiki/content-sha.js";

test("same content same hash", () => {
  expect(contentSha256("abc")).toBe(contentSha256("abc"));
});

test("different content different hash", () => {
  expect(contentSha256("abc")).not.toBe(contentSha256("abd"));
});

test("empty content -> empty string", () => {
  expect(contentSha256("")).toBe("");
});