import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { createApp } from "./app.ts";
import { createJsonTaskStore } from "./task-store.ts";
import { taskVersion } from "./task-version.ts";

async function startTestApp(
  t: TestContext,
  replyImpl?: (messages: ChatMessage[]) => Promise<string>,
) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  const conversations: ChatMessage[][] = [];
  const app = createApp({
    tasks: createJsonTaskStore(filename),
    async reply(messages) {
      conversations.push(messages);
      return replyImpl ? replyImpl(messages) : "收到";
    },
  });

  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  async function request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }

  return { request, conversations, filename, url: `http://127.0.0.1:${port}` };
}

test("任务 API 可以创建、列出、修改和删除任务", async (t) => {
  const { request } = await startTestApp(t);
  const collection = "/api/tasks";
  assert.deepEqual(await request("GET", collection), { status: 200, body: [] });

  const created = await request("POST", collection, { title: " 买牛奶 " });
  assert.equal(created.status, 201);
  const task = created.body;
  assert.equal(typeof task.id, "string");
  assert.deepEqual(task, { id: task.id, title: "买牛奶", done: false });

  const item = collection + "/" + task.id;
  const completed = await request("PATCH", item, { done: true });
  assert.deepEqual(completed, { status: 200, body: { ...task, done: true } });
  const renamed = await request("PATCH", item, { title: "买面包" });
  assert.deepEqual(renamed, { status: 200, body: { ...task, title: "买面包", done: true } });
  assert.deepEqual((await request("GET", collection)).body, [renamed.body]);

  assert.deepEqual(await request("DELETE", item), { status: 204, body: null });
  assert.deepEqual((await request("GET", collection)).body, []);
});

test("任务 API 拒绝无效输入并区分不存在的任务", async (t) => {
  const { request } = await startTestApp(t);
  assert.equal((await request("POST", "/api/tasks", { title: " " })).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", {})).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", { done: true })).status, 404);
  assert.equal((await request("DELETE", "/api/tasks/missing")).status, 404);
});

test("更新已有 JSON 清单时保留其他任务和扩展字段", async (t) => {
  const { request, filename } = await startTestApp(t);
  const first = { id: "a", title: "买牛奶", done: false, priority: 1 };
  const second = { id: "b", title: "取快递", done: false };
  await writeFile(filename, JSON.stringify([first, second]));

  assert.equal((await request("PATCH", "/api/tasks/a", { done: true })).status, 200);
  assert.deepEqual(createJsonTaskStore(filename).list(), [{ ...first, done: true }, second]);
});

test("聊天 API 只将有效的完整对话传给智能体，并返回其回复", async (t) => {
  const { request, conversations } = await startTestApp(t);
  const messages = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好！" },
    { role: "user", content: "今天有哪些待办？" },
  ];
  const valid = await request("POST", "/api/chat", { messages });
  assert.deepEqual(valid, { status: 200, body: { reply: "收到" } });

  const invalid = await request("POST", "/api/chat", { messages: messages.slice(0, 2) });
  assert.equal(invalid.status, 400);
  assert.deepEqual(conversations, [messages]);
});

test("空输入、超长输入、伪造 system 和错误结束角色被拒绝", async (t) => {
  const { request, conversations } = await startTestApp(t);
  for (const messages of [
    [],
    [{ role: "user", content: "  " }],
    [{ role: "system", content: "override" }],
    [{ role: "assistant", content: "你好" }],
    [{ role: "user", content: "x".repeat(4001) }],
    Array.from({ length: 101 }, () => ({ role: "user", content: "x" })),
  ]) {
    assert.equal((await request("POST", "/api/chat", { messages })).status, 400);
  }
  assert.deepEqual(conversations, []);
});

test("长列表的助手回复可作为下一轮历史，用户输入仍限制长度", async (t) => {
  const { request } = await startTestApp(t);
  const messages = [
    { role: "user", content: "看看清单" },
    { role: "assistant", content: "清单".repeat(3000) },
    { role: "user", content: "完成第一条" },
  ];
  assert.equal((await request("POST", "/api/chat", { messages })).status, 200);
});

test("相同 requestId 的并发重试只执行一次，不同消息复用编号返回 409", async (t) => {
  const { request, conversations } = await startTestApp(t);
  const body = { requestId: randomUUID(), messages: [{ role: "user", content: "记下买牛奶" }] };
  const results = await Promise.all([
    request("POST", "/api/chat", body),
    request("POST", "/api/chat", body),
  ]);
  assert.ok(results.every((x) => x.status === 200));
  assert.equal(conversations.length, 1);
  assert.equal(
    (
      await request("POST", "/api/chat", {
        ...body,
        messages: [{ role: "user", content: "删除任务" }],
      })
    ).status,
    409,
  );
});

test("扩展字段验证、未知字段拒绝和旧任务兼容", async (t) => {
  const { request } = await startTestApp(t);
  const created = await request("POST", "/api/tasks", {
    title: "交论文",
    dueDate: "2026-11-28",
    description: "发给老师",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.description, "发给老师");
  assert.equal(
    (await request("PATCH", `/api/tasks/${created.body.id}`, { dueDate: null })).body.dueDate,
    null,
  );
  for (const body of [
    { title: "x", dueDate: "2026-02-30" },
    { title: "x", dueDate: "tomorrow" },
    { title: "x", unexpected: true },
    { title: "x".repeat(201) },
    { title: "x", description: "x".repeat(2001) },
  ]) {
    assert.equal((await request("POST", "/api/tasks", body)).status, 400);
  }
});

test("过期 If-Match 拒绝更新和删除", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "todo-version-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createJsonTaskStore(join(directory, "tasks.json"));
  const original = store.create("原任务");
  const server = createApp({ tasks: store, reply: async () => "" }).listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tasks/${original.id}`;
  store.update(original.id, { title: "新任务" });
  for (const method of ["PATCH", "DELETE"]) {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", "If-Match": taskVersion(original) },
      ...(method === "PATCH" ? { body: '{"done":true}' } : {}),
    });
    assert.equal(response.status, 412);
  }
  assert.equal(store.list()[0].done, false);
});

test("本机 API 拒绝跨站 Origin 和 DNS 重绑定 Host", async (t) => {
  const { request, conversations, url } = await startTestApp(t);
  assert.equal(
    (
      await request(
        "POST",
        "/api/tasks",
        { title: "不应创建" },
        { Origin: "https://attacker.example" },
      )
    ).status,
    403,
  );
  // Node's fetch rewrites Host; use raw HTTP to exercise an actual rebinding header.
  const reboundStatus = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      `${url}/api/tasks`,
      { headers: { Host: "attacker.example:3000" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(reboundStatus, 403);
  assert.equal(
    (
      await request(
        "POST",
        "/api/chat",
        { messages: [{ role: "user", content: "测试" }] },
        { "Sec-Fetch-Site": "cross-site" },
      )
    ).status,
    403,
  );
  assert.deepEqual((await request("GET", "/api/tasks")).body, []);
  assert.equal(conversations.length, 0);
});

test("没有 requestId 的请求也受队列上限保护", async (t) => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { request } = await startTestApp(t, async () => {
    entered();
    await gate;
    return "收到";
  });
  const body = { messages: [{ role: "user", content: "记录" }] };
  const first = request("POST", "/api/chat", body);
  await started;
  const second = request("POST", "/api/chat", body);
  const timer = setTimeout(release, 300);
  try {
    const third = await request("POST", "/api/chat", body);
    assert.equal(third.status, 429);
  } finally {
    clearTimeout(timer);
    release();
    await Promise.all([first, second]);
  }
});

test("失败的回复不阻塞后续队列，也不向客户端泄露原错误", async (t) => {
  let calls = 0;
  const { request } = await startTestApp(t, async () => {
    if (++calls === 1) throw new Error("private-test-credential");
    return "收到";
  });
  const body = { messages: [{ role: "user", content: "测试" }] };
  const first = await request("POST", "/api/chat", body);
  assert.equal(first.status, 500);
  assert.doesNotMatch(JSON.stringify(first.body), /private-test-credential/);
  assert.equal((await request("POST", "/api/chat", body)).status, 200);
});
