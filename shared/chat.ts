import { z } from "zod";

const messageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(200_000),
  })
  .refine((message) => message.role !== "user" || message.content.length <= 4000);

export type ChatMessage = z.infer<typeof messageSchema>;

export const chatRequestSchema = z.object({
  requestId: z.uuid().optional(),
  messages: z
    .array(messageSchema)
    .min(1)
    .max(100)
    .refine((messages) => messages.at(-1)?.role === "user"),
});
