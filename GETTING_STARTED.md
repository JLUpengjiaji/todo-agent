# 本地开发指南

## 启动

安装 Node.js 24.12 或更高版本（含 npm）。在终端执行以下命令。

```sh
git clone https://github.com/JLUpengjiaji/todo-agent.git
cd todo-agent
npm ci
npm run dev
```

浏览器打开 <http://127.0.0.1:3000>。前后端共用这个地址，修改服务端代码后服务会自动重启。修改聊天界面的 TSX 后，在另一个终端运行 `npm run build` 并刷新页面。若 3000 端口已占用，可以用 `PORT=3001 npm run dev` 指定其他端口（macOS / Linux）。

交付仓库为 [JLUpengjiaji/todo-agent](https://github.com/JLUpengjiaji/todo-agent)。原始 `TokeNow/todo-agent` 是招聘模板；若收到项目压缩包，解压后直接进入项目根目录运行安装命令。

## 接入 DeepSeek

1. 在项目根目录将 `.env.example` 复制为 `.env`。
2. 在 `.env` 中填写 [DeepSeek 开放平台](https://platform.deepseek.com/) 的 API Key。可通过 `DEEPSEEK_MODEL` 更换模型。使用兼容中转时，把 `DEEPSEEK_BASE_URL` 改为该服务商提供的完整 API 根地址（通常含 `/v1`，不含 `/chat/completions`），并填写该渠道的密钥及可用模型 ID。渠道必须支持结构化工具调用及项目请求参数；不支持时会报错，不会伪造任务执行结果。
3. 重启开发服务。在服务端使用 [server/model.ts](server/model.ts) 导出的 `getModelClient()` 获取客户端，使用 `model` 读取配置的模型名称。只有发起模型请求才会产生调用费用。

## 代码入口

| 文件                                         | 用途                                       |
| -------------------------------------------- | ------------------------------------------ |
| [src/App.tsx](src/App.tsx)                   | 聊天界面，发送当前页面的对话历史并显示回复 |
| [server/index.ts](server/index.ts)           | 接入智能体与任务存储，启动服务             |
| [server/agent.ts](server/agent.ts)           | 候选人实现入口，接收消息数组，返回回复文本 |
| [server/model.ts](server/model.ts)           | 服务端 DeepSeek 客户端与模型配置           |
| [server/tasks.ts](server/tasks.ts)           | 任务 API 的输入校验和 HTTP 响应            |
| [server/app.ts](server/app.ts)               | 接收对话历史，调用智能体并挂载任务 API     |
| [server/task-store.ts](server/task-store.ts) | 读写本地 JSON 任务清单                     |
| [server/openapi.yaml](server/openapi.yaml)   | 任务请求和响应的完整定义                   |

## 手动验证接口

启动服务后，在另一个终端发送聊天消息。

```sh
curl -sS http://127.0.0.1:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"你好"}]}'
```

配置密钥后会回复能力介绍；未配置密钥时会明确提示设置 `DEEPSEEK_API_KEY`，并且不修改任务。后续请求可在 `messages` 中按顺序传入之前的用户消息和小明的回复，再追加最新的用户消息。可传入可选的 UUID `requestId`；网络重试使用相同编号和消息，可在 10 分钟内避免重复执行。相同编号携带不同消息返回 `409`。

创建一条任务，然后检查列表。

```sh
curl -sS http://127.0.0.1:3000/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"买牛奶"}'
curl -sS http://127.0.0.1:3000/api/tasks
```

首次创建任务时，服务会在项目根目录创建 `data/tasks.json`。这些任务会保留到下次启动，浏览器中的聊天记录则会在刷新后清空。

Windows PowerShell 可用以下方式避免原生 curl 的引号和中文编码差异：

```powershell
$payload = @{ messages = @(@{ role = "user"; content = "帮我记一下买牛奶" }) } | ConvertTo-Json -Depth 5
Invoke-RestMethod http://127.0.0.1:3000/api/chat -Method Post -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($payload))
Invoke-RestMethod http://127.0.0.1:3000/api/tasks
```

## 本地检查

```sh
npm test
npm run typecheck
npm run lint
npm run fmt:check
npm run build
```

测试使用独立的临时目录。要预览构建产物，先停止开发服务，再运行 `npm start` 并打开同一地址。

## Windows 配置

PowerShell 中用 `Copy-Item .env.example .env` 创建配置文件（已有文件时不要覆盖）。可在 `.env` 设置 `PORT=3001`，或运行 `$env:PORT=3001; npm run dev` 指定端口。环境要求 Node.js 24.12 或以上；若提示无法直接运行 `.ts`，请先检查 `node --version`。

## 额外验收入口

- `npm run test:browser-fixture`：在 3011 端口启动仅支持 README 六句固定输入的脚本模型替身，数据隔离，用于浏览器 UI/API 验证。
- `npm run test:live`：读取本地 `.env`，在临时目录执行 12 轮真实模型验收，会产生配置渠道的调用费用。缺少密钥时明确失败退出。
- `npm run test:live -- --extended`：执行 26 轮，补充否定句、日期、相近任务和多目标指代等语义边界；同样检查实际任务状态并隔离数据。

完整功能、架构、测试结果及限制见 [README 的实现与运行说明](README.md#实现与运行说明)。替身测试不代表真实模型语义验收通过。
