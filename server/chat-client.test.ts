import assert from "node:assert/strict";
import { test } from "node:test";
import { requestReply } from "../src/chat-client.ts";

const messages = [{ role: "user" as const, content: "帮我记一下买牛奶" }];

test("前端发送完整历史和重试编号，并读取真实回复", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "/api/chat");
    assert.deepEqual(JSON.parse(init.body as string), { messages, requestId: "test-request" });
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json({ reply: "已创建" });
  });
  assert.equal(await requestReply(messages, "test-request"), "已创建");
});

test("前端保留 API 的中文错误", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "请求较多，请稍后重试。" }, { status: 429 }),
  );
  await assert.rejects(requestReply(messages), /请求较多/);
});

for (const [label, response] of [
  ["无效 JSON", () => new Response("<html>proxy error</html>", { status: 502 })],
  ["空回复", () => Response.json({ reply: "  " })],
] as const) {
  test(`前端拒绝 ${label}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => response());
    await assert.rejects(requestReply(messages), /无效响应|服务暂时不可用/);
  });
}
for (const name of ["TimeoutError", "TypeError"]) {
  test(`前端 ${name} 不产生虚假成功，提示结果尚未确认`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      const error = new Error("private transport details");
      error.name = name;
      throw error;
    });
    await assert.rejects(requestReply(messages), /操作结果尚未确认/);
  });
}
