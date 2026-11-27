// Opt-in only: real DeepSeek calls may incur fees. Always use isolated task data.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "../shared/chat.ts";
import { createAgent, shanghaiDate } from "../server/agent.ts";
import { createApp } from "../server/app.ts";
import { createTaskApi } from "../server/task-client.ts";
import { createJsonTaskStore } from "../server/task-store.ts";

if (!process.env.DEEPSEEK_API_KEY?.trim()) {
  console.error("真实模型验收未运行：请先在 .env 配置 DEEPSEEK_API_KEY。没有发起模型请求。");
  process.exit(1);
}
const directory = await mkdtemp(join(tmpdir(), "xiaoming-live-"));
const store = createJsonTaskStore(join(directory, "tasks.json"));
let reply: ReturnType<typeof createAgent>;
const server = createApp({ tasks: store, reply: (messages) => reply(messages) }).listen(
  0,
  "127.0.0.1",
);
try {
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = createTaskApi(url);
  const now = new Date();
  reply = createAgent({ api, now: () => now });
  const messages: ChatMessage[] = [];
  let turns = 0;
  async function chat(content: string) {
    turns++;
    messages.push({ role: "user", content });
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    assert.equal(response.status, 200);
    const { reply: answer } = (await response.json()) as { reply: string };
    console.log(`用户：${content}\n小明：${answer}\n`);
    messages.push({ role: "assistant", content: answer });
    return answer;
  }
  await chat("帮我记一下买牛奶");
  assert.equal(store.list()[0]?.title, "买牛奶");
  await chat("再记一条取快递");
  assert.equal(store.list().length, 2);
  assert.match(await chat("我有哪些任务？"), /买牛奶[\s\S]*取快递/);
  await chat("牛奶买好了");
  assert.deepEqual(
    store.list().map((task) => task.done),
    [true, false],
  );
  await chat("取快递这条删掉吧");
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].title, "买牛奶");
  assert.equal(store.list()[0].done, true);
  assert.match(await chat("再给我看看清单"), /已完成.*买牛奶/);
  await chat("帮我记一下洗衣服");
  await chat("刚才说的那件事已经做完了");
  assert.equal(store.list().find((task) => task.title === "洗衣服")?.done, true);
  await chat("帮我记录买水果和给老师发邮件");
  assert.ok(store.list().some((task) => task.title === "买水果"));
  assert.ok(store.list().some((task) => task.title === "给老师发邮件"));
  await chat("把买水果改成买苹果");
  assert.ok(store.list().some((task) => task.title === "买苹果"));
  const first = store.create("取文件");
  store.create("取文件");
  assert.match(await chat("删除取文件"), /有多条/);
  assert.equal(store.list().filter((task) => task.title === "取文件").length, 2);
  await chat(`选 ${first.id}`);
  assert.equal(store.list().filter((task) => task.title === "取文件").length, 1);
  assert.ok(!store.list().some((task) => task.id === first.id));
  if (process.argv.includes("--extended")) {
    // Fresh conversations isolate intent checks from the previous pending confirmation.
    messages.length = 0;
    let before = store.list();
    assert.match(await chat("衣服已经洗好了。"), /已经完成/);
    assert.deepEqual(store.list(), before);
    assert.match(await chat("体检已经做完了"), /没有找到对应任务/);
    assert.deepEqual(store.list(), before);
    assert.match(await chat("帮我讲个笑话"), /待办/);
    assert.deepEqual(store.list(), before);
    await chat("先不要删除买苹果，它还没买，不用操作");
    assert.deepEqual(store.list(), before);

    messages.length = 0;
    const today = shanghaiDate(now);
    const tomorrow = shanghaiDate(new Date(now.getTime() + 86_400_000));
    await chat("提醒我今天交论文");
    assert.equal(store.list().find((task) => task.title === "交论文")?.dueDate, today);
    await chat("我还有一件事没做，就是明天给老师打电话");
    assert.equal(store.list().find((task) => task.title === "给老师打电话")?.dueDate, tomorrow);
    const dueToday = await chat("今天有哪些任务到期？");
    assert.match(dueToday, /交论文/);
    assert.ok(!dueToday.includes("给老师打电话"));
    await chat("把交论文改到明天");
    assert.equal(store.list().find((task) => task.title === "交论文")?.dueDate, tomorrow);
    const done = await chat("我已经完成了哪些任务？");
    assert.match(done, /买牛奶/);
    assert.match(done, /洗衣服/);
    assert.ok(!done.includes("买苹果"));
    before = store.list();
    assert.match(await chat("帮我再记一下买苹果"), /没有重复创建/);
    assert.deepEqual(store.list(), before);

    messages.length = 0;
    const wang = store.create("给王老师发邮件");
    const li = store.create("给李老师发邮件");
    before = store.list();
    const ambiguity = await chat("老师的邮件已经发完了");
    assert.match(ambiguity, /有多条/);
    for (const task of before.filter((task) => task.title.includes("发邮件")))
      assert.ok(ambiguity.includes(task.id), `遗漏语义候选：${task.title}`);
    assert.deepEqual(store.list(), before);
    await chat(`不要删除 ${wang.id}，我没选它，先不动这些任务`);
    assert.deepEqual(store.list(), before);
    assert.ok(store.list().some((task) => task.id === li.id));

    messages.length = 0;
    await chat("帮我记录整理书架和擦桌子");
    const recent = store.list().filter((task) => ["整理书架", "擦桌子"].includes(task.title));
    assert.equal(recent.length, 2);
    before = store.list();
    const reference = await chat("刚才那件事已经完成了");
    assert.match(reference, /有多条/);
    for (const task of recent) assert.ok(reference.includes(task.id));
    assert.deepEqual(store.list(), before);
  }
  console.log(`真实模型验收通过（${turns} 轮对话，检查真实任务状态）。`);
} finally {
  await server[Symbol.asyncDispose]();
  await rm(directory, { recursive: true, force: true });
}
