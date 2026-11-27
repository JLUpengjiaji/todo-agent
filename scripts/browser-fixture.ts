// Development-only scripted model fixture. Never imported by server/index.ts.
// This exercises the UI and real APIs, and does not test language understanding.
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../server/agent.ts";
import { createApp } from "../server/app.ts";
import { createTaskApi } from "../server/task-client.ts";
import { createJsonTaskStore } from "../server/task-store.ts";

const directory = await mkdtemp(join(tmpdir(), "xiaoming-browser-"));
const store = createJsonTaskStore(join(directory, "tasks.json"));
const port = Number(process.env.PORT || 3011);
const reply = createAgent({
  api: createTaskApi(`http://127.0.0.1:${port}`),
  planner: async ({ messages, tasks }) => {
    const text = messages.at(-1)?.content;
    const milk = tasks.find((task) => task.title === "买牛奶");
    const parcel = tasks.find((task) => task.title === "取快递");
    // Exact test fixtures, deliberately not a keyword-based production agent.
    switch (text) {
      case "帮我记一下买牛奶":
        return { actions: [{ kind: "create", tasks: [{ title: "买牛奶" }] }] };
      case "再记一条取快递":
        return { actions: [{ kind: "create", tasks: [{ title: "取快递" }] }] };
      case "我有哪些任务？":
      case "再给我看看清单":
        return { actions: [{ kind: "list", status: "all" }] };
      case "牛奶买好了":
        return {
          actions: [
            { kind: "update", candidateIds: milk ? [milk.id] : [], changes: { done: true } },
          ],
        };
      case "取快递这条删掉吧":
        return { actions: [{ kind: "delete", candidateIds: parcel ? [parcel.id] : [] }] };
      default:
        throw new Error("脚本替身只支持 README 的六句验收输入");
    }
  },
});
const server = createApp({ tasks: store, reply }).listen(port, "127.0.0.1");
await once(server, "listening");
console.log(`浏览器测试替身：http://127.0.0.1:${port}（仅测试 UI/API，不代表真实语义验收）`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await server[Symbol.asyncDispose]();
    await rm(directory, { recursive: true, force: true });
    process.exit(0);
  });
