import { join } from "node:path";
import { createAgent } from "./agent.ts";
import { createApp } from "./app.ts";
import { createJsonTaskStore } from "./task-store.ts";
import { createTaskApi } from "./task-client.ts";

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT 必须为 1 至 65535 的整数。");
const tasks = createJsonTaskStore(process.env.TASKS_FILE || join("data", "tasks.json"));
const reply = createAgent({ api: createTaskApi(`http://127.0.0.1:${port}`) });
const app = createApp({ reply, tasks });
app.listen(port, "127.0.0.1", () => console.log(`小明智能体已启动：http://127.0.0.1:${port}`));
