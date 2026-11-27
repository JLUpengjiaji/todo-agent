import { z } from "zod";

export const dateSchema = z.iso.date();
export const taskInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  dueDate: dateSchema.nullable().optional(),
});
export const taskChangesSchema = taskInputSchema
  .partial()
  .extend({ done: z.boolean().optional() })
  .refine((changes) => Object.keys(changes).length > 0);
// Preserve unknown fields from existing files, as in the original store.
export const taskSchema = z.looseObject({
  ...taskInputSchema.shape,
  id: z.string().min(1),
  done: z.boolean(),
});
export const tasksSchema = z
  .array(taskSchema)
  .refine(
    (tasks) => new Set(tasks.map((task) => task.id)).size === tasks.length,
    "任务 ID 必须唯一。",
  );
export type Task = z.infer<typeof taskSchema>;
export type TaskInput = z.infer<typeof taskInputSchema>;
export type TaskChanges = z.infer<typeof taskChangesSchema>;
