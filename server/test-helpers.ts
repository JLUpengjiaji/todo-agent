import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { createAgent } from "./agent.ts";
import { createApp } from "./app.ts";
import type { Planner } from "./plan.ts";
import { createTaskApi, type TaskApi } from "./task-client.ts";
import { createJsonTaskStore } from "./task-store.ts";

export async function testApp(
  t: TestContext,
  planner: Planner,
  decorate: (api: TaskApi) => TaskApi = (api) => api,
) {
  const directory = await mkdtemp(join(tmpdir(), "xiaoming-test-"));
  const filename = join(directory, "tasks.json");
  const store = createJsonTaskStore(filename);
  let reply: ReturnType<typeof createAgent>;
  const app = createApp({ tasks: store, reply: (messages) => reply(messages) });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = createTaskApi(url);
  reply = createAgent({
    api: decorate(api),
    planner,
    now: () => new Date("2026-11-27T12:00:00+08:00"),
  });
  t.after(async () => {
    await server[Symbol.asyncDispose]();
    await rm(directory, { recursive: true, force: true });
  });
  const messages: ChatMessage[] = [];
  async function chat(content: string) {
    messages.push({ role: "user", content });
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    const body = (await response.json()) as { reply: string };
    messages.push({ role: "assistant", content: body.reply });
    return body.reply;
  }
  return { api, store, filename, url, chat, messages };
}
