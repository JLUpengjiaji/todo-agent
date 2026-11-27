import {
  taskSchema,
  tasksSchema,
  type Task,
  type TaskChanges,
  type TaskInput,
} from "../shared/task.ts";
import { taskVersion } from "./task-version.ts";

export interface TaskApi {
  list(): Promise<Task[]>;
  create(input: TaskInput): Promise<Task>;
  update(task: Task, changes: TaskChanges): Promise<Task>;
  remove(task: Task): Promise<void>;
}
export class TaskApiError extends Error {
  status: number;
  constructor(status: number) {
    super("Task API request failed");
    this.status = status;
  }
}

// A fixed loopback URL, never a URL supplied by the user or model.
export function createTaskApi(baseURL: string): TaskApi {
  async function request(method: string, path = "", body?: unknown, version?: string) {
    const response = await fetch(`${baseURL}/api/tasks${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(version ? { "If-Match": version } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new TaskApiError(response.status);
    return response.status === 204 ? undefined : response.json();
  }
  return {
    async list() {
      return tasksSchema.parse(await request("GET"));
    },
    async create(input) {
      return taskSchema.parse(await request("POST", "", input));
    },
    async update(task, changes) {
      return taskSchema.parse(
        await request("PATCH", `/${encodeURIComponent(task.id)}`, changes, taskVersion(task)),
      );
    },
    async remove(task) {
      await request("DELETE", `/${encodeURIComponent(task.id)}`, undefined, taskVersion(task));
    },
  };
}
