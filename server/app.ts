import { resolve } from "node:path";
import express, { type ErrorRequestHandler } from "express";
import { chatRequestSchema, type ChatMessage } from "../shared/chat.ts";
import type { TaskStore } from "./task-store.ts";
import { taskRouter } from "./tasks.ts";

interface AppDependencies {
  reply(messages: ChatMessage[]): Promise<string>;
  tasks: TaskStore;
}

export function createApp({ reply, tasks }: AppDependencies) {
  const app = express();
  const requests = new Map<string, { body: string; expires: number; result: Promise<string> }>();
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;
  app.disable("x-powered-by");
  app.use("/api", (req, res, next) => {
    // Loopback binding alone does not prevent DNS rebinding or cross-site requests.
    const localHost = ["127.0.0.1", "localhost", "[::1]"].includes(req.hostname);
    const origin = req.get("Origin");
    if (
      !localHost ||
      (origin && origin !== `http://${req.get("host")}`) ||
      req.get("Sec-Fetch-Site") === "cross-site"
    ) {
      return res.status(403).json({ error: "任务接口只接受本机同源请求。" });
    }
    next();
  });
  app.use(express.json({ limit: "1mb" }));

  app.post("/api/chat", async (req, res) => {
    const input = chatRequestSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供对话记录，并以用户消息结尾。" });
    }
    const { requestId, messages } = input.data;
    const body = JSON.stringify(messages);
    for (const [id, entry] of requests) if (entry.expires < Date.now()) requests.delete(id);
    const cached = requestId ? requests.get(requestId) : undefined;
    if (cached && cached.body !== body)
      return res.status(409).json({ error: "请求编号已被其他消息使用。" });
    let result = cached?.result;
    if (!result) {
      if (pending >= 2 || (requestId && requests.size >= 500))
        return res.status(429).json({ error: "请求较多，请稍后重试。" });
      pending++;
      let entry: { body: string; expires: number; result: Promise<string> } | undefined;
      result = queue
        .then(() => reply(messages))
        .finally(() => {
          pending--;
          if (entry) entry.expires = Date.now() + 600_000;
        });
      queue = result.catch(() => undefined);
      if (requestId) {
        entry = { body, expires: Infinity, result };
        requests.set(requestId, entry);
      }
    }
    const answer = await result;
    res.json({ reply: answer });
  });

  app.use("/api/tasks", taskRouter(tasks));
  app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在。" }));

  app.use(express.static(resolve("public")));
  app.get("/assets/chat.js", (_req, res) => res.sendFile(resolve("dist/chat.js")));
  app.use(handleApiError);
  return app;
}

const handleApiError: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({ error: "请求需要使用有效的 JSON。" });
  }
  if (error.type === "entity.too.large") {
    return res.status(413).json({ error: "对话太长，请刷新后开始新的对话。" });
  }
  if (error.status === 404)
    return res.status(404).json({ error: "资源不存在，请先运行 npm run build 并检查地址。" });
  console.error("[api] request failed", {
    name: error instanceof Error ? error.name : "UnknownError",
  });
  res.status(500).json({ error: "服务暂时无法处理请求，请稍后重试。" });
};
