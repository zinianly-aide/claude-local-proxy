import test from "node:test";
import assert from "node:assert/strict";
import { anthropicToOpenAI, pickModel } from "../proxy.mjs";

test("anthropicToOpenAI converts system and message text", () => {
  const input = {
    system: "sys",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "world" }] }
    ]
  };

  assert.deepEqual(anthropicToOpenAI(input), [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "world" }
  ]);
});

test("pickModel selects smaller model for short non-code prompts", () => {
  assert.equal(pickModel("你好"), "qwen3:0.6b");
});

test("pickModel selects coder model for code prompts", () => {
  assert.equal(pickModel("帮我修复这个 js bug"), "qwen2.5-coder");
});
