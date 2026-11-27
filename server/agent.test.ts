import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { shanghaiDate } from "./agent.ts";
import { ModelError } from "./model.ts";
import type { PlanContext } from "./plan.ts";
import { TaskApiError } from "./task-client.ts";
import { createJsonTaskStore } from "./task-store.ts";
import { testApp } from "./test-helpers.ts";

test("README 六轮对话：模型替身 -> 聊天 HTTP -> 真任务 HTTP -> JSON 持久化", async (t) => {
  const inputs = [
    "帮我记一下买牛奶",
    "再记一条取快递",
    "我有哪些任务？",
    "牛奶买好了",
    "取快递这条删掉吧",
    "再给我看看清单",
  ];
  let turn = 0;
  const { chat, api, filename } = await testApp(t, ({ messages, tasks }) => {
    assert.equal(messages.at(-1)?.content, inputs[turn]);
    assert.equal(messages.length, turn * 2 + 1);
    const action = [
      () => ({ kind: "create", tasks: [{ title: "买牛奶" }] }),
      () => ({ kind: "create", tasks: [{ title: "取快递" }] }),
      () => ({ kind: "list", status: "all" }),
      () => ({
        kind: "update",
        candidateIds: [tasks.find((x) => x.title === "买牛奶")!.id],
        changes: { done: true },
      }),
      () => ({ kind: "delete", candidateIds: [tasks.find((x) => x.title === "取快递")!.id] }),
      () => ({ kind: "list", status: "all" }),
    ][turn++]!();
    return Promise.resolve({ actions: [action] });
  });
  assert.match(await chat(inputs[0]), /已创建待办/);
  assert.match(await chat(inputs[1]), /取快递/);
  const list = await chat(inputs[2]);
  assert.match(list, /买牛奶/);
  assert.match(list, /取快递/);
  assert.match(list, /待办/);
  assert.match(await chat(inputs[3]), /已完成/);
  assert.equal((await api.list()).find((x) => x.title === "取快递")?.done, false);
  assert.match(await chat(inputs[4]), /已删除/);
  const final = await chat(inputs[5]);
  assert.match(final, /已完成.*买牛奶/);
  assert.doesNotMatch(final, /取快递/);
  assert.equal(createJsonTaskStore(filename).list().length, 1);
  assert.equal(JSON.parse(await readFile(filename, "utf8"))[0].done, true);
});

for (const [text, tasks] of [
  ["帮我记一下洗衣服。", [{ title: "洗衣服" }]],
  ["提醒我明天交论文。", [{ title: "交论文", dueDate: "2026-11-28" }]],
  ["我还有一件事没做，就是给老师发邮件。", [{ title: "给老师发邮件" }]],
  [
    "帮我记录买牛奶、买水果和取快递。",
    [{ title: "买牛奶" }, { title: "买水果" }, { title: "取快递" }],
  ],
] as const) {
  test(`中文输入和计划执行（替身，不评估 NLU）：${text}`, async (t) => {
    const { chat, api } = await testApp(t, ({ messages, today }) => {
      assert.equal(messages.at(-1)?.content, text);
      assert.equal(today, "2026-11-27");
      return Promise.resolve({ actions: [{ kind: "create", tasks }] });
    });
    assert.match(await chat(text), /已创建/);
    assert.deepEqual(
      (await api.list()).map(({ id: _id, done: _done, ...input }) => input),
      tasks,
    );
  });
}

test("批量创建、描述、去重；相同标题不同日期仍能创建", async (t) => {
  const { chat, api } = await testApp(t, () =>
    Promise.resolve({
      actions: [
        {
          kind: "create",
          tasks: [
            { title: "买牛奶" },
            { title: "买水果", description: "苹果和梨" },
            { title: "买牛奶" },
            { title: "买牛奶", dueDate: "2026-11-28" },
          ],
        },
      ],
    }),
  );
  assert.match(await chat("批量记录"), /没有重复创建/);
  assert.equal((await api.list()).length, 3);
  await chat("重复记录");
  assert.equal((await api.list()).length, 3);
});

test("未完成、已完成、到期日查询，空清单", async (t) => {
  let status: "all" | "pending" | "done" = "pending";
  let dueDate: string | undefined;
  const { api, chat, store } = await testApp(t, () =>
    Promise.resolve({ actions: [{ kind: "list", status, dueDate }] }),
  );
  assert.match(await chat("看看清单"), /没有符合/);
  const first = await api.create({ title: "交论文", dueDate: "2026-11-27" });
  await api.create({ title: "买水果", dueDate: "2026-11-28" });
  store.update(first.id, { done: true });
  assert.doesNotMatch(await chat("未完成"), /交论文/);
  status = "done";
  assert.doesNotMatch(await chat("已完成"), /买水果/);
  status = "all";
  dueDate = "2026-11-27";
  const answer = await chat("今天到期");
  assert.match(answer, /交论文/);
  assert.doesNotMatch(answer, /买水果/);
});

test("多轮指代传入完整历史，完成、重复完成、重开、改名改期清除日期", async (t) => {
  let turn = 0;
  const { chat, api } = await testApp(t, ({ messages, tasks }) => {
    if (turn++ === 0)
      return Promise.resolve({ actions: [{ kind: "create", tasks: [{ title: "洗衣服" }] }] });
    assert.equal(messages[0].content, "帮我记一下洗衣服");
    assert.match(messages[1].content, /洗衣服/);
    const changes =
      turn <= 3
        ? { done: true }
        : turn === 4
          ? { done: false }
          : turn === 5
            ? { title: "手洗毛衣", dueDate: "2026-11-28" }
            : { dueDate: null };
    return Promise.resolve({ actions: [{ kind: "update", candidateIds: [tasks[0].id], changes }] });
  });
  await chat("帮我记一下洗衣服");
  assert.match(await chat("刚才说的那件事已经做完了"), /已完成/);
  assert.match(await chat("衣服洗好了"), /已经完成/);
  assert.match(await chat("恢复成未完成"), /恢复为待办/);
  await chat("改成手洗毛衣，明天到期");
  assert.equal((await api.list())[0].dueDate, "2026-11-28");
  await chat("取消日期");
  assert.equal((await api.list())[0].dueDate, null);
});

test("语义候选有歧义时不写入，确认后只完成选定一条", async (t) => {
  let chosen: string | undefined;
  const { chat, api } = await testApp(t, ({ tasks }) =>
    Promise.resolve({
      actions: [
        {
          kind: "update",
          candidateIds: chosen ? [chosen] : tasks.map((x) => x.id),
          changes: { done: true },
        },
      ],
    }),
  );
  await api.create({ title: "给李老师发邮件" });
  const second = await api.create({ title: "给王老师发邮件" });
  assert.match(await chat("邮件发好了"), /有多条/);
  assert.ok((await api.list()).every((x) => !x.done));
  chosen = second.id;
  await chat(`选 ${second.id}`);
  assert.deepEqual(
    (await api.list()).map((x) => x.done),
    [false, true],
  );
});

test("同名任务即便模型任意选中一个也必须确认完整 ID", async (t) => {
  const { chat, api } = await testApp(t, ({ tasks }) =>
    Promise.resolve({ actions: [{ kind: "delete", candidateIds: [tasks[0].id] }] }),
  );
  const first = await api.create({ title: "买牛奶" });
  await api.create({ title: "买牛奶" });
  assert.match(await chat("删除买牛奶"), /有多条/);
  assert.equal((await api.list()).length, 2);
  await chat(`选 ${first.id}`);
  assert.equal((await api.list()).length, 1);
});

for (const candidateIds of [[], ["fabricated-id"]]) {
  test(`不存在目标 ${JSON.stringify(candidateIds)}，整批预检阻止其他创建`, async (t) => {
    const { chat, api } = await testApp(t, () =>
      Promise.resolve({
        actions: [
          { kind: "create", tasks: [{ title: "不应创建" }] },
          { kind: "update", candidateIds, changes: { done: true } },
        ],
      }),
    );
    assert.match(await chat("完成不存在任务"), /没有找到/);
    assert.deepEqual(await api.list(), []);
  });
}

for (const plan of [
  null,
  { actions: [] },
  { actions: [{ kind: "create", tasks: [{ title: " " }] }] },
  { actions: [{ kind: "create", tasks: [{ title: "x", dueDate: "2026-02-30" }] }] },
  { actions: [{ kind: "shell", command: "oops" }] },
  { actions: [{ kind: "update", candidateIds: [], changes: {} }] },
]) {
  test(`无效模型计划不执行：${JSON.stringify(plan)}`, async (t) => {
    const { chat, api } = await testApp(t, () => Promise.resolve(plan));
    assert.match(await chat("处理一下"), /没有返回有效/);
    assert.deepEqual(await api.list(), []);
  });
}

for (const code of ["configuration", "unavailable", "invalid_output"] as const) {
  test(`模型错误 ${code} 有明确反馈且无写入`, async (t) => {
    const { chat, api } = await testApp(t, () => {
      throw new ModelError(code);
    });
    assert.match(await chat("记下任务"), /没有修改任务/);
    assert.deepEqual(await api.list(), []);
  });
}

test("无关输入及问候仅展示帮助，不修改任务", async (t) => {
  const { chat, api } = await testApp(t, () =>
    Promise.resolve({ actions: [{ kind: "help", topic: "unrelated" }] }),
  );
  assert.match(await chat("讲个笑话"), /我可以帮你/);
  assert.deepEqual(await api.list(), []);
});

test("明确的不存在任务计划给出找不到提示，阻止同批其他写入", async (t) => {
  const { chat, api } = await testApp(t, () =>
    Promise.resolve({
      actions: [
        { kind: "create", tasks: [{ title: "不能静默创建" }] },
        { kind: "clarify", reason: "not_found", candidateIds: [] },
      ],
    }),
  );
  await api.create({ title: "洗衣服" });
  const before = await api.list();
  assert.match(await chat("体检已经做完了"), /没有找到对应任务/);
  assert.deepEqual(await api.list(), before);
});

test("不支持的时间精度和缺少信息先澄清，阻止同批其他写入", async (t) => {
  const { chat, api } = await testApp(t, () =>
    Promise.resolve({
      actions: [
        { kind: "create", tasks: [{ title: "不能静默创建" }] },
        { kind: "clarify", reason: "unsupported", candidateIds: [] },
      ],
    }),
  );
  assert.match(await chat("明天下午三点提醒我"), /暂不支持具体时刻/);
  assert.deepEqual(await api.list(), []);
});

test("API 首次写入失败不报告成功", async (t) => {
  const { chat, api } = await testApp(
    t,
    () => Promise.resolve({ actions: [{ kind: "create", tasks: [{ title: "买牛奶" }] }] }),
    (api) => ({
      ...api,
      create: () => {
        throw new TaskApiError(500);
      },
    }),
  );
  const answer = await chat("买牛奶");
  assert.match(answer, /API 调用失败/);
  assert.doesNotMatch(answer, /已创建/);
  assert.deepEqual(await api.list(), []);
});

test("批量部分失败如实报告已成功项并停止剩余操作", async (t) => {
  let count = 0;
  const { chat, api } = await testApp(
    t,
    () =>
      Promise.resolve({
        actions: [
          {
            kind: "create",
            tasks: [{ title: "第一条" }, { title: "第二条" }, { title: "第三条" }],
          },
        ],
      }),
    (api) => ({
      ...api,
      create: (input) => {
        if (++count === 2) throw new TaskApiError(500);
        return api.create(input);
      },
    }),
  );
  const answer = await chat("批量创建");
  assert.match(answer, /已有 1 项操作成功/);
  assert.equal((await api.list()).length, 1);
});

test("读取损坏的数据文件失败时保留原文件，不调用模型", async (t) => {
  let calls = 0;
  const { chat, filename } = await testApp(t, () => {
    calls++;
    throw new Error("should not run");
  });
  await writeFile(filename, "{broken");
  assert.match(await chat("看看清单"), /无法读取/);
  assert.equal(calls, 0);
  assert.equal(await readFile(filename, "utf8"), "{broken");
});

test("模型思考期间任务被改名时，预检阻止误完成", async (t) => {
  let mutate: (context: PlanContext) => void = () => {};
  const { chat, api, store } = await testApp(t, (context) => {
    mutate(context);
    return Promise.resolve({
      actions: [{ kind: "update", candidateIds: [context.tasks[0].id], changes: { done: true } }],
    });
  });
  const task = await api.create({ title: "买牛奶" });
  mutate = () => {
    store.update(task.id, { title: "交论文" });
  };
  assert.match(await chat("牛奶买好了"), /发生了变更/);
  assert.equal((await api.list())[0].done, false);
});

test("重复目标或互相冲突的更新计划不会写入", async (t) => {
  const { chat, api } = await testApp(t, ({ tasks }) =>
    Promise.resolve({
      actions: [
        { kind: "update", candidateIds: [tasks[0].id], changes: { done: true } },
        { kind: "delete", candidateIds: [tasks[0].id] },
      ],
    }),
  );
  await api.create({ title: "买牛奶" });
  assert.match(await chat("处理牛奶"), /重复或冲突/);
  assert.equal((await api.list())[0].done, false);
});

test("创建已完成同名任务会生成新的待办", async (t) => {
  const { chat, api, store } = await testApp(t, () =>
    Promise.resolve({ actions: [{ kind: "create", tasks: [{ title: "买牛奶" }] }] }),
  );
  const task = await api.create({ title: "买牛奶" });
  store.update(task.id, { done: true });
  assert.match(await chat("再买一次牛奶"), /已创建/);
  assert.deepEqual(
    (await api.list()).map((x) => x.done),
    [true, false],
  );
});

test("上海日期跨 UTC 零点正确", () => {
  assert.equal(shanghaiDate(new Date("2026-11-26T17:00:00Z")), "2026-11-27");
});

test("重复完成不能依据已过期快照声称任务已经完成", async (t) => {
  let mutate = () => {};
  const { chat, api, store } = await testApp(t, ({ tasks }) => {
    mutate();
    return Promise.resolve({
      actions: [{ kind: "update", candidateIds: [tasks[0].id], changes: { done: true } }],
    });
  });
  const task = await api.create({ title: "买牛奶" });
  store.update(task.id, { done: true });
  mutate = () => {
    store.update(task.id, { done: false });
  };
  const answer = await chat("牛奶买好了");
  assert.match(answer, /发生了变更/);
  assert.doesNotMatch(answer, /已经完成/);
  assert.equal(store.list()[0].done, false);
});

test("消息中否定某个 ID 不算同名任务确认", async (t) => {
  const { chat, api } = await testApp(t, ({ tasks }) =>
    Promise.resolve({ actions: [{ kind: "delete", candidateIds: [tasks[0].id] }] }),
  );
  const task = await api.create({ title: "买牛奶" });
  await api.create({ title: "买牛奶" });
  assert.match(await chat(`不要删除 ${task.id}，我还没确定`), /有多条/);
  assert.equal((await api.list()).length, 2);
});

test("模型请求期间新增同名任务后，不能仍按原唯一目标删除", async (t) => {
  let mutate = () => {};
  const { chat, api, store } = await testApp(t, ({ tasks }) => {
    mutate();
    return Promise.resolve({ actions: [{ kind: "delete", candidateIds: [tasks[0].id] }] });
  });
  await api.create({ title: "取快递" });
  mutate = () => {
    store.create("取快递");
  };
  assert.match(await chat("把取快递删掉"), /有多条/);
  assert.equal(store.list().length, 2);
});

test("重复任务 ID 的损坏文件必须拒绝读取，不能一次误删两条", async (t) => {
  const { chat, filename } = await testApp(t, ({ tasks }) =>
    Promise.resolve({ actions: [{ kind: "delete", candidateIds: [tasks[0].id] }] }),
  );
  const data = JSON.stringify([
    { id: "same", title: "一", done: false },
    { id: "same", title: "二", done: false },
  ]);
  await writeFile(filename, data);
  assert.match(await chat("删掉第一条"), /无法读取/);
  assert.equal(await readFile(filename, "utf8"), data);
});
