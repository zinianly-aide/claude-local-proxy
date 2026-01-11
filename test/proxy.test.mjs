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

test("anthropicToOpenAI handles array system prompt", () => {
  const input = {
    system: [{ type: "text", text: "system1" }, { type: "text", text: "system2" }],
    messages: [
      { role: "user", content: "hello" }
    ]
  };

  assert.deepEqual(anthropicToOpenAI(input), [
    { role: "system", content: "system1\nsystem2" },
    { role: "user", content: "hello" }
  ]);
});

test("anthropicToOpenAI handles array content with multiple types", () => {
  const input = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "text content" },
          { type: "image", url: "image.jpg" },
          { type: "text", text: "more text" }
        ]
      }
    ]
  };

  assert.deepEqual(anthropicToOpenAI(input), [
    { role: "user", content: "text content\nmore text" }
  ]);
});

test("pickModel selects smaller model for short non-code prompts", () => {
  assert.equal(pickModel("你好"), "qwen3:0.6b");
});

test("pickModel selects coder model for code prompts", () => {
  assert.equal(pickModel("帮我修复这个 js bug"), "qwen2.5-coder");
});

test("pickModel selects reasoning model for reasoning prompts", () => {
  assert.equal(pickModel("请证明勾股定理"), "deepseek-r1:7b");
  assert.equal(pickModel("为什么天空是蓝色的？"), "deepseek-r1:7b");
  assert.equal(pickModel("一步一步教我如何做蛋糕"), "deepseek-r1:7b");
});

test("pickModel selects default model for long non-code prompts", () => {
  const longText = "这是一段很长的文本，" + "重复多次来达到长度要求。".repeat(20);
  assert.equal(pickModel(longText), "qwen3:8b");
});

test("pickModel selects coder model for code-related keywords", () => {
  assert.equal(pickModel("帮我写一个 python 脚本"), "qwen2.5-coder");
  assert.equal(pickModel("修复这个 java 编译错误"), "qwen2.5-coder");
  assert.equal(pickModel("docker 配置文件怎么写？"), "qwen2.5-coder");
  assert.equal(pickModel("这个 sql 查询有问题吗？"), "qwen2.5-coder");
});
