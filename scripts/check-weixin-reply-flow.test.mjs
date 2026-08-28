// 所有网络请求都由内存桩拦截；不读取配置、无需依赖、不会给真实微信发消息。
// node --test scripts/check-weixin-reply-flow.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  buildRuntimePromptMessages, mergeAdjacentSameRoleMessages, buildLocalReplyOutbox,
  pollOnce, WEIXIN_CORE_PROTOCOL_VERSION,
} from "../tools/weixin-local-assistant/assistant-core.mjs";

const stamp = n => new Date(Date.parse("2026-08-28T02:00:00Z") + n * 1000).toISOString();
const message = (id, role, n, content = id) => ({
  externalId: id, role, content, receivedAt: stamp(n),
  direction: role === "user" ? "inbound" : "outbound",
});
const template = () => ({
  version: 2, beforeMessages: [], afterMessages: [],
  structuralMessages: [{ role: "system", content: "扮演角色，回答当前输入" }],
  bakedHistoryMessages: [], depthSegments: [],
});
const runtime = () => ({ promptContext: { promptTemplate: template() } });
const conversation = messages => messages.filter(m => m.role !== "system");

test("pending 在旧答案之后、只出现一次，原时间戳不被篡改", () => {
  const a = message("a", "user", 1);
  const b = message("b", "user", 2);
  const reply = message("reply-a", "assistant", 3);
  const before = structuredClone([a, b, reply]);
  const result = buildRuntimePromptMessages(runtime(), [a, b, reply], [b]);
  assert.deepEqual(conversation(result).map(m => m.content), ["a", "reply-a", "b"]);
  assert.deepEqual([a, b, reply], before);
});

test("多条待答消息按原时间组成一轮，历史顺序不变", () => {
  const a = message("a", "user", 1), b = message("b", "user", 2);
  const c = message("c", "user", 3), reply = message("reply", "assistant", 4);
  const result = mergeAdjacentSameRoleMessages(buildRuntimePromptMessages(runtime(), [a, b, c, reply], [c, b, b]));
  assert.deepEqual(conversation(result).map(m => m.content), ["a", "reply", "b\n\nc"]);
});

test("pending 为空时保留原有历史，深度注入相对完整新轮次定位", () => {
  const r = runtime();
  r.promptContext.promptTemplate.depthSegments = [{ depth: 1, messages: [{ role: "system", content: "深度提示" }] }];
  const b = message("b", "user", 2), reply = message("reply", "assistant", 3);
  assert.deepEqual(conversation(buildRuntimePromptMessages(r, [b, reply], [])).map(m => m.content), ["b", "reply"]);
  assert.deepEqual(buildRuntimePromptMessages(r, [b, reply], [b]).slice(-2).map(m => m.content), ["深度提示", "b"]);
});

test("旧 v1 模板也按待答轮次组装，图片附件不会丢失", () => {
  const r = { promptContext: { promptTemplate: { beforeMessages: [], afterMessages: [] } } };
  const b = message("b", "user", 2), reply = message("reply", "assistant", 3);
  const result = buildRuntimePromptMessages(r, [b, reply], [b], new Map([["b", "data:image/png;base64,dGVzdA=="]]));
  assert.equal(result.at(-1).role, "user");
  assert.equal(result.at(-1).content[1].type, "image_url");
});

test("引用标记与下一行回复合并，不发送裸协议", async () => {
  assert.deepEqual(await buildLocalReplyOutbox("[引用:你过来]\n\n来了来了。\n\n下一句话。", {}), [
    { kind: "text", text: "引用「你过来」：来了来了。" },
    { kind: "text", text: "下一句话。" },
  ]);
  assert.deepEqual(await buildLocalReplyOutbox("[引用：你想吃什么]想吃面。", {}), [
    { kind: "text", text: "引用「你想吃什么」：想吃面。" },
  ]);
});

let fixtureId = 0;
async function withWorker(options, run) {
  const id = `test-${++fixtureId}`;
  const env = { SUPABASE_URL: `https://${id}.invalid`, SUPABASE_SERVICE_ROLE_KEY: "test-only", WEIXIN_AUTO_REPLY: "true" };
  const r = {
    ...runtime(), createdAt: "2026-08-01T00:00:00Z", bot: { id, botToken: "test-only" },
    character: { id: "character-test" }, session: { id: "session-test" },
    apiConfig: { provider: "Custom", baseUrl: "https://model.invalid/v1", apiKey: "test-only", defaultModel: "mock" },
  };
  const objects = new Map();
  const messagePrefix = `weixin-cloud/messages/${id}/`;
  const flagPath = `weixin-cloud/pending/${id}.json`;
  const old = { ...message("a", "user", 1), format: "ai-phone-weixin-cloud-message", needsReply: true,
    raw: { from_user_id: "test-user", context_token: "test-context" } };
  objects.set(`${messagePrefix}a.json`, old);
  objects.set(flagPath, { pending: true, lastInboundExternalId: "a" });
  objects.set("weixin-cloud/index.json", { packages: [{ botId: id, path: "runtime.json", updatedAt: stamp(0) }] });
  objects.set("runtime.json", r);
  const sent = [], requests = [];
  const ctx = {
    objects, sent, requests, old, flagPath,
    addInput(name = "b", extra = {}) {
      const m = { ...message(name, "user", 2), format: "ai-phone-weixin-cloud-message", needsReply: true, raw: old.raw, ...extra };
      objects.set(`${messagePrefix}${name}.json`, m);
      objects.set(flagPath, { pending: true, lastInboundExternalId: name });
      return m;
    },
    outbound: () => [...objects.values()].filter(o => o.direction === "outbound"),
  };
  let sendAttempts = 0, generations = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    requests.push({ host: url.host, path: url.pathname, action: url.searchParams.get("action"), body });
    if (url.origin === env.SUPABASE_URL) {
      const objectPrefix = "/storage/v1/object/ai-phone-backup/";
      if (url.pathname.startsWith(objectPrefix)) {
        const key = decodeURIComponent(url.pathname.slice(objectPrefix.length));
        if (init.method === "POST") { objects.set(key, structuredClone(body)); return json({}); }
        return objects.has(key) ? json(objects.get(key)) : json({ error: "not found" }, 404);
      }
      if (url.pathname.startsWith("/storage/v1/object/list/")) {
        return json([...objects.keys()].filter(key => key.startsWith(body.prefix)).map(key => ({ name: key.slice(body.prefix.length) })));
      }
      if (url.pathname === "/rest/v1/push_bridge_config") return json([{ shortcut_actions: options.actions || [] }]);
      if (url.pathname === "/rest/v1/push_server_config") return json([{ site_origin: "https://site.invalid" }]);
      if (url.pathname === "/functions/v1/ai-phone-push") {
        return url.searchParams.get("action") === "shortcut-create"
          ? json({ ok: true, command: { id: "mock-command" }, resultUrl: "https://result.invalid" })
          : json({ ok: true, delivered: true });
      }
    }
    if (url.host === "model.invalid") {
      generations += 1;
      await options.onGenerate?.(ctx, generations);
      return json({ choices: [{ message: { content: options.reply || "第一句。\n\n第二句。\n\n第三句。" } }] });
    }
    if (url.host === "ilinkai.weixin.qq.com") {
      if (url.pathname.endsWith("/getupdates")) return json({ msgs: [], get_updates_buf: "test-cursor" });
      if (url.pathname.endsWith("/getconfig")) return json({});
      if (url.pathname.endsWith("/sendmessage")) {
        sendAttempts += 1;
        if (options.failSend?.(sendAttempts)) return json({ error: "mock send failure" }, 503);
        if (options.rejectSend) return json({ ret: 0, error_code: -14 });
        sent.push(body.msg.item_list[0].text_item.text);
        await options.onSend?.(ctx, sent.length);
        return json({ ret: 0 });
      }
    }
    throw new Error(`Unexpected network request blocked: ${url.host}${url.pathname}`);
  };
  try {
    const poll = async () => (await pollOnce(env)).results[0].autoReply;
    await run(ctx, poll);
    const lock = objects.get(`weixin-cloud/locks/${id}.json`);
    assert.equal(lock.expiresAt, new Date(0).toISOString(), "每条退出路径都释放回复锁");
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("正常多段发送只记一轮，下一次轮询不重复发送", async () => {
  await withWorker({}, async (ctx, poll) => {
    assert.equal((await poll()).status, "sent");
    assert.equal(ctx.sent.length, 3);
    assert.equal(ctx.outbound().length, 1);
    assert.deepEqual(ctx.outbound()[0].raw.replyToExternalIds, ["a"]);
    assert.ok(ctx.objects.get([...ctx.objects.keys()].find(k => k.endsWith("/a.json"))).repliedAt);
    assert.equal((await poll()).status, "idle");
    assert.equal(ctx.sent.length, 3);
  });
});

test("生成期间新输入入库：草稿不发送，旧输入与新输入下一轮一起回答", async () => {
  await withWorker({ onGenerate: (ctx, n) => { if (n === 1) ctx.addInput(); } }, async (ctx, poll) => {
    assert.equal((await poll()).status, "superseded");
    assert.equal(ctx.sent.length, 0);
    assert.equal(ctx.outbound().length, 0);
    assert.equal(ctx.old.repliedAt, undefined);
    assert.equal(ctx.objects.get(ctx.flagPath).pending, true);
    assert.equal((await poll()).status, "sent");
    const messages = ctx.requests.filter(q => q.host === "model.invalid").at(-1).body.messages;
    assert.equal(conversation(messages).at(-1).content, "a\n\nb");
    assert.deepEqual(ctx.outbound()[0].raw.replyToExternalIds, ["a", "b"]);
  });
});

test("分段发送中收到新输入：停止后续，只把实际发送的文字记入历史", async () => {
  await withWorker({ onSend: (ctx, n) => { if (n === 1) ctx.addInput(); } }, async (ctx, poll) => {
    assert.equal((await poll()).status, "interrupted");
    assert.deepEqual(ctx.sent, ["第一句。"]);
    assert.equal(ctx.outbound()[0].content, "第一句。");
    assert.equal(ctx.objects.get(ctx.flagPath).lastInboundExternalId, "b");
    assert.equal(ctx.objects.get([...ctx.objects.keys()].find(k => k.endsWith("/b.json"))).repliedAt, undefined);
    assert.equal((await poll()).status, "sent");
    const messages = ctx.requests.filter(q => q.host === "model.invalid").at(-1).body.messages;
    assert.equal(conversation(messages).at(-1).content, "b");
    assert.equal(conversation(messages).at(-2).content, "第一句。");
  });
});

test("已回复的旧标志不能永久阻塞新回复", async () => {
  await withWorker({ onGenerate: ctx => ctx.addInput("old", { repliedAt: stamp(3) }) }, async (ctx, poll) => {
    assert.equal((await poll()).status, "sent");
    assert.equal(ctx.sent.length, 3);
  });
});

test("部分发送失败时不把失败片段当作已经说过", async () => {
  await withWorker({ failSend: n => n === 2 }, async (ctx, poll) => {
    assert.equal((await poll()).status, "partial_sent");
    assert.deepEqual(ctx.sent, ["第一句。", "第三句。"]);
    assert.equal(ctx.outbound()[0].content, "第一句。\n\n第三句。");
  });
});

test("全部发送失败时仍待回复，不留下假历史", async () => {
  await withWorker({ failSend: () => true, reply: "一句话。" }, async (ctx, poll) => {
    assert.equal((await poll()).status, "failed");
    assert.equal(ctx.outbound().length, 0);
    assert.equal(ctx.old.repliedAt, undefined);
    assert.equal(ctx.objects.get(ctx.flagPath).pending, true);
  });
});

test("HTTP 200 但 iLink 拒绝发送不能算成功", async () => {
  await withWorker({ rejectSend: true, reply: "一句话。" }, async (ctx, poll) => {
    assert.equal((await poll()).status, "failed");
    assert.equal(ctx.outbound().length, 0);
    assert.equal(ctx.old.repliedAt, undefined);
  });
});

const actions = [{ actionId: "mock-action", name: "测试动作", shortcutName: "mock-shortcut", resultMode: "none" }];
const actionReply = '第一句。\n\n第二句。\n\n【快捷动作：测试动作({"value":"test"})】';

test("正常快捷动作保留参数：文字发送、历史落盘后才通知执行", async () => {
  await withWorker({ actions, reply: actionReply }, async (ctx, poll) => {
    assert.equal((await poll()).status, "sent");
    const create = ctx.requests.findIndex(q => q.action === "shortcut-create");
    const deliver = ctx.requests.findIndex(q => q.action === "shortcut-deliver");
    const lastSend = ctx.requests.findLastIndex(q => q.path.endsWith("/sendmessage"));
    const stored = ctx.requests.findIndex(q => q.body?.direction === "outbound");
    assert.ok(create > lastSend);
    assert.ok(deliver > stored && stored > create);
    assert.deepEqual(ctx.requests[create].body.arguments, { value: "test" });
    assert.equal(ctx.outbound()[0].shortcutMarker.name, "测试动作");
  });
});

test("新输入使整个草稿过时：不创建隐藏的快捷动作", async () => {
  await withWorker({ actions, reply: actionReply, onGenerate: ctx => ctx.addInput() }, async (ctx, poll) => {
    assert.equal((await poll()).status, "superseded");
    assert.equal(ctx.requests.filter(q => q.path.startsWith("/functions/")).length, 0);
  });
});

test("快捷动作草稿发送中被打断：不执行剩余动作、不把动作写入历史", async () => {
  await withWorker({ actions, reply: actionReply, onSend: (ctx, n) => { if (n === 1) ctx.addInput(); } }, async (ctx, poll) => {
    assert.equal((await poll()).status, "interrupted");
    assert.equal(ctx.requests.filter(q => q.path.startsWith("/functions/")).length, 0);
    assert.equal(ctx.outbound()[0].shortcutMarker, undefined);
    assert.equal(ctx.outbound()[0].content, "第一句。");
  });
});

test("分发文件一致，v4 加载器不加载旧 v3 核心", () => {
  const read = p => readFileSync(new URL(p, import.meta.url), "utf8");
  const source = read("../tools/weixin-local-assistant/assistant-core.mjs");
  const wrapper = read("../tools/weixin-local-assistant/cloud-function-wrapper.mjs");
  const bundled = read("../public/weixin-local-assistant/cloud-function.mjs");
  assert.equal(WEIXIN_CORE_PROTOCOL_VERSION, 4);
  assert.match(wrapper, /REQUIRED_BUCKET_CORE_PROTOCOL_VERSION = 4/);
  assert.equal(read("../public/weixin-local-assistant/assistant-core.mjs"), source);
  assert.ok(bundled.endsWith(source + "\n" + wrapper));
  assert.equal(read("../supabase/functions/weixin-assistant/index.ts"), bundled);
});
