import type { ChatMessage } from "../shared/chat.ts";

export async function requestReply(messages: ChatMessage[], requestId?: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, requestId }),
      signal: AbortSignal.timeout(90000),
    });
  } catch (error) {
    throw new Error(
      error instanceof Error && error.name === "TimeoutError"
        ? "请求超时，操作结果尚未确认，请先查询清单。"
        : "网络连接失败，操作结果尚未确认，请先查询清单或使用相同消息重试。",
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("服务返回了无效响应，操作结果尚未确认，请先查询清单。");
  }
  if (typeof body === "object" && body !== null) {
    if (response.ok && "reply" in body && typeof body.reply === "string" && body.reply.trim())
      return body.reply;
    if ("error" in body && typeof body.error === "string") throw new Error(body.error);
  }
  throw new Error("服务暂时不可用。");
}
