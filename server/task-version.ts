import { createHash } from "node:crypto";
import type { Task } from "../shared/task.ts";

export function taskVersion(task: Task): string {
  return '"' + createHash("sha256").update(JSON.stringify(task)).digest("hex") + '"';
}
