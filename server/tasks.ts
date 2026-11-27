import { Router } from "express";
import { taskInputSchema, taskChangesSchema } from "../shared/task.ts";
import type { TaskStore } from "./task-store.ts";
import { taskVersion } from "./task-version.ts";

const taskNotFound = { error: "找不到这条任务。" };

export function taskRouter(tasks: TaskStore) {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(tasks.list());
  });

  router.post("/", (req, res) => {
    const input = taskInputSchema.safeParse(req.body);
    if (!input.success) {
      return res
        .status(400)
        .json({ error: "请提供 1 至 200 个字符的标题、有效日期（YYYY-MM-DD）及可选描述。" });
    }
    const { title, ...details } = input.data;
    res.status(201).json(tasks.create(title, details));
  });

  router.patch("/:id", (req, res) => {
    const input = taskChangesSchema.safeParse(req.body);
    if (!input.success) {
      return res
        .status(400)
        .json({ error: "请提供有效的 title、done、description 或 dueDate 字段。" });
    }

    const current = tasks.list().find((task) => task.id === req.params.id);
    if (!current) return res.status(404).json(taskNotFound);
    if (req.headers["if-match"] && req.headers["if-match"] !== taskVersion(current)) {
      return res.status(412).json({ error: "任务已变更，请查看最新清单后重试。" });
    }
    if (Object.entries(input.data).every(([key, value]) => current[key] === value))
      return res.json(current);
    const updated = tasks.update(req.params.id, input.data);
    if (!updated) return res.status(404).json(taskNotFound);
    res.json(updated);
  });

  router.delete("/:id", (req, res) => {
    const current = tasks.list().find((task) => task.id === req.params.id);
    if (!current) return res.status(404).json(taskNotFound);
    if (req.headers["if-match"] && req.headers["if-match"] !== taskVersion(current)) {
      return res.status(412).json({ error: "任务已变更，请查看最新清单后重试。" });
    }
    if (!tasks.remove(req.params.id)) return res.status(404).json(taskNotFound);
    res.sendStatus(204);
  });

  return router;
}
