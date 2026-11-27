import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("生产入口实际启动、静态页面、无密钥提示和进程重启后持久化", { timeout: 20000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "xiaoming-runtime-"));
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  const url = `http://127.0.0.1:${port}`;
  const children: ReturnType<typeof spawn>[] = [];
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    await rm(directory, { recursive: true, force: true });
  });
  async function start() {
    const child = spawn(process.execPath, ["server/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        TASKS_FILE: join(directory, "tasks.json"),
        DEEPSEEK_API_KEY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("服务启动超时")), 5000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("服务提前退出"));
      });
      child.stdout!.on("data", (data: Buffer) => {
        if (data.toString().includes("小明智能体已启动")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    return child;
  }
  const first = await start();
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /assets\/chat.js/);
  const style = await fetch(`${url}/style.css`);
  assert.equal(style.status, 200);
  const created = await fetch(`${url}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"title":"重启后仍存在"}',
  });
  assert.equal(created.status, 201);
  const task = await created.json();
  const exited = once(first, "exit");
  first.kill();
  await exited;
  await start();
  const list = await (await fetch(`${url}/api/tasks`)).json();
  assert.deepEqual(list, [task]);
  const chat = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"messages":[{"role":"user","content":"帮我记一下买牛奶"}]}',
  });
  assert.match((await chat.json()).reply, /尚未配置模型/);
  assert.deepEqual(await (await fetch(`${url}/api/tasks`)).json(), [task]);
});
