import type { ChatMessage } from "../shared/chat.ts";
import type { Task } from "../shared/task.ts";
import { ModelError, planWithModel } from "./model.ts";
import { planSchema, type Planner } from "./plan.ts";
import { TaskApiError, type TaskApi } from "./task-client.ts";
import { taskVersion } from "./task-version.ts";

export type { ChatMessage } from "../shared/chat.ts";

export function shanghaiDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function showTask(task: Task, index: number): string {
  return `${index + 1}. ${task.done ? "[已完成]" : "[待办]"} ${task.title}${task.dueDate ? `（${task.dueDate} 到期）` : ""}${task.description ? `\n   ${task.description}` : ""}\n   ID: ${task.id}`;
}
function clarify(tasks: Task[]): string {
  return `有多条可能的任务，请确认要操作哪一条：\n${tasks.map(showTask).join("\n")}\n请回复“选 完整ID”，确认后我再操作。`;
}
const help =
  "我可以帮你创建、查看、完成、删除和修改待办，也支持一次记录多条、描述和到期日期。例如：帮我记一下洗衣服；看看未完成的任务；衣服洗好了。日期用于查询，不会主动推送提醒。";
const notFound = "没有找到对应任务，本轮没有修改清单。可以先说“看看我的待办”，再指定任务。";

export function createAgent({
  api,
  planner = planWithModel,
  now = () => new Date(),
}: {
  api: TaskApi;
  planner?: Planner;
  now?: () => Date;
}) {
  return async function reply(messages: ChatMessage[]): Promise<string> {
    let snapshot: Task[];
    try {
      snapshot = await api.list();
    } catch {
      console.warn("[tasks] list failed");
      return "暂时无法读取任务清单，本轮没有执行操作。请检查服务或数据文件后重试。";
    }
    let plan;
    try {
      plan = planSchema.parse(
        await planner({ messages, tasks: snapshot, today: shanghaiDate(now()) }),
      );
    } catch (error) {
      if (error instanceof ModelError && error.code === "configuration")
        return "尚未配置模型。请在项目根目录 .env 中设置 DEEPSEEK_API_KEY 并重启服务；本轮没有修改任务。";
      if (error instanceof ModelError && error.code === "unavailable")
        return "模型服务暂时不可用，请检查密钥、网络或额度后重试；本轮没有修改任务。";
      console.warn("[agent] invalid model plan");
      return "模型没有返回有效的操作计划，本轮没有修改任务。请换一种说法重试。";
    }

    // Re-read after model latency: even a no-op reply must use current state.
    let current = snapshot;
    if (plan.actions.some((action) => ["create", "update", "delete"].includes(action.kind))) {
      try {
        current = await api.list();
      } catch {
        return "暂时无法读取最新任务清单，本轮没有执行操作。请稍后重试。";
      }
    }
    // Validate the entire plan before the first write, including every target.
    const touched = new Set<string>();
    for (const action of plan.actions) {
      if (action.kind === "clarify") {
        const matches = snapshot.filter((task) => action.candidateIds.includes(task.id));
        if (matches.length > 1) return clarify(matches);
        if (action.reason === "not_found") return notFound;
        return action.reason === "unsupported"
          ? "目前支持标题、描述、完成状态和到期日期；暂不支持具体时刻、周期提醒、优先级或子任务。你希望按哪一天记录？本轮尚未修改任务。"
          : "请补充要处理的任务及具体内容；本轮尚未修改任务。";
      }
      if (action.kind !== "update" && action.kind !== "delete") continue;
      const ids = [...new Set(action.candidateIds)];
      const original = snapshot.filter((task) => ids.includes(task.id));
      if (original.length !== ids.length || original.length === 0) return notFound;
      const matches = current.filter((task) => ids.includes(task.id));
      if (
        matches.length !== ids.length ||
        original.some(
          (task) => taskVersion(task) !== taskVersion(matches.find((item) => item.id === task.id)!),
        )
      )
        return "任务在对话期间发生了变更，本轮没有执行操作。请先查看最新清单。";
      if (matches.length > 1) return clarify(matches);
      const task = matches[0];
      const duplicates = current.filter((item) => item.title === task.title);
      // Same titles need explicit identity even if the model arbitrarily chooses one.
      if (
        duplicates.length > 1 &&
        messages
          .at(-1)
          ?.content.trim()
          .match(/^选\s+(\S+)$/)?.[1] !== task.id
      )
        return clarify(duplicates);
      if (touched.has(task.id))
        return "同一轮对同一任务有多项操作，请分开说明，以免重复或冲突；本轮尚未修改任务。";
      touched.add(task.id);
    }

    const replies: string[] = [];
    let writes = 0;
    try {
      for (const action of plan.actions) {
        if (action.kind === "help") {
          replies.push(`${action.topic === "greeting" ? "你好，我是小明！" : ""}${help}`);
        } else if (action.kind === "list") {
          const all = await api.list();
          const items = all.filter(
            (task) =>
              (action.status === "all" || task.done === (action.status === "done")) &&
              (!action.dueDate || task.dueDate === action.dueDate),
          );
          replies.push(
            items.length
              ? `任务清单（${items.length} 条）：\n${items.map(showTask).join("\n")}`
              : "没有符合条件的任务。",
          );
        } else if (action.kind === "create") {
          const existing = await api.list();
          for (const input of action.tasks) {
            const duplicate = existing.find(
              (task) =>
                !task.done &&
                task.title === input.title &&
                (task.dueDate ?? null) === (input.dueDate ?? null) &&
                (task.description ?? "") === (input.description ?? ""),
            );
            if (duplicate) {
              replies.push(`已有待办“${duplicate.title}”（ID: ${duplicate.id}），没有重复创建。`);
              continue;
            }
            const created = await api.create(input);
            writes++;
            existing.push(created);
            replies.push(`已创建待办：${showTask(created, 0)}`);
          }
        } else if (action.kind === "update") {
          const task = snapshot.find((item) => item.id === action.candidateIds[0])!;
          if (Object.entries(action.changes).every(([key, value]) => task[key] === value)) {
            // The router checks If-Match and returns without rewriting unchanged data.
            await api.update(task, action.changes);
            replies.push(
              `“${task.title}”${action.changes.done === true ? "已经完成" : "已经是这个状态"}，无需重复操作。`,
            );
            continue;
          }
          const updated = await api.update(task, action.changes);
          writes++;
          replies.push(
            `已${action.changes.done === true ? "完成" : action.changes.done === false ? "恢复为待办" : "修改"}：${showTask(updated, 0)}`,
          );
        } else if (action.kind === "delete") {
          const task = snapshot.find((item) => item.id === action.candidateIds[0])!;
          await api.remove(task);
          writes++;
          replies.push(`已删除“${task.title}”（ID: ${task.id}）。`);
        }
      }
    } catch (error) {
      const status = error instanceof TaskApiError ? error.status : undefined;
      console.warn("[tasks] execution failed", { status, completedWrites: writes });
      replies.push(
        status === 412
          ? "任务在对话期间发生了变更，本次操作未执行。请先查看最新清单。"
          : "任务 API 调用失败，后续操作已停止；失败的操作结果无法确认，请先查看清单，避免重复提交。",
      );
      if (writes) replies.push(`本轮此前已有 ${writes} 项操作成功，未回滚。`);
    }
    return replies.join("\n\n");
  };
}
