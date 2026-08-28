// Runs the actual storage module against an isolated in-memory DB. No real user data or network.
// node --test scripts/check-chat-unread.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

const root = new URL("../", import.meta.url);
function compile(file) {
    return ts.transpileModule(readFileSync(new URL(file, root), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
}
const storageCode = compile("lib/chat-storage.ts");

async function fixture(seed = { messages: [], sessions: [], contacts: [] }) {
    const db = structuredClone(seed);
    const put = (key, rows) => {
        for (const row of rows) {
            const index = db[key].findIndex(item => item.id === row.id);
            if (index < 0) db[key].push(structuredClone(row));
            else db[key][index] = structuredClone(row);
        }
    };
    const dbApi = {
        initChatDb: async () => structuredClone(db),
        dbPutMessage: row => put("messages", [row]),
        dbPutMessages: rows => put("messages", rows),
        dbPutSessions: rows => put("sessions", rows),
        dbPutContacts: rows => put("contacts", rows),
        dbReplaceSessions: rows => { db.sessions = structuredClone(rows); },
        dbReplaceContacts: rows => { db.contacts = structuredClone(rows); },
        dbDeleteMessage: id => { db.messages = db.messages.filter(m => m.id !== id); },
        dbDeleteMessagesByIds: ids => { db.messages = db.messages.filter(m => !ids.includes(m.id)); },
        dbDeleteMessagesBySession: id => { db.messages = db.messages.filter(m => m.sessionId !== id); },
        dbDeleteSession: id => { db.sessions = db.sessions.filter(s => s.id !== id); },
    };
    const window = new EventTarget();
    const document = { visibilityState: "visible" };
    const module = { exports: {} };
    const modules = {
        "./chat-db": dbApi,
        "./settings-storage": { resolveUserIdentity: () => ({ name: "我" }) },
        "./character-storage": { loadCharacters: () => [] },
        "./kv-db": { kvGet: () => null, kvSet: () => {}, registerKvMigration: () => {} },
        "./chat-plugin-hooks": { emitChatPluginEvent: () => {}, runChatPluginTransformSync: (_name, value) => value },
        "./rich-message-parser": { parseAIResponse: () => ({ parts: [] }) },
        "./text-tool-protocol": { extractTextToolDirectiveText: () => "" },
    };
    vm.runInNewContext(storageCode, {
        exports: module.exports, module, require: name => {
            assert.ok(name in modules, `Unexpected storage import: ${name}`);
            return modules[name];
        }, window, document, CustomEvent, console,
    });
    const api = module.exports;
    await api.hydrateChatStorage();
    const session = api.createOrGetSession("character-a");
    const push = (patch = {}) => api.pushChatMessage({ sessionId: session.id, role: "assistant", content: "你好", ...patch });
    const count = (id = session.id) => api.loadChatSessions().find(s => s.id === id)?.unreadCount;
    return { api, db, window, document, session, push, count };
}

test("four character bubbles produce 4; user/system/tool/empty records do not count", async () => {
    const f = await fixture();
    for (let i = 0; i < 4; i++) f.push();
    assert.equal(f.count(), 4);
    for (const role of ["user", "system", "tool"]) f.push({ role });
    for (const mediaType of ["tool_call", "tool_result", "tool_notice", "system_instruction", "memory_write_request", "reading_discuss", "poke", "group_admin_notice"]) f.push({ mediaType });
    f.push({ content: "" });
    f.push({ content: "", nativeToolCalls: [{ id: "tool", name: "noop", args: {} }] });
    f.push({ content: "[我挂断了语音通话]" });
    f.push({ isRetracted: true });
    assert.equal(f.count(), 4);
    for (const mediaType of ["image", "audio", "sticker", "red_packet"]) f.push({ content: "", mediaType });
    assert.equal(f.count(), 8);
});

test("reading one room clears it; hidden cached rooms and other conversations still count", async () => {
    const f = await fixture();
    f.push();
    const activity = f.api.loadChatSessions()[0].updatedAt;
    const unregister = f.api.registerChatSessionReader(f.session.id);
    assert.equal(f.count(), 0);
    assert.equal(f.api.loadChatSessions()[0].updatedAt, activity);
    assert.equal(f.push().unread, false);
    const other = f.api.createOrGetSession("character-b");
    f.push({ sessionId: other.id });
    assert.equal(f.count(other.id), 1);
    unregister();
    f.push();
    assert.equal(f.count(), 1);
});

test("background browser tab accumulates unread until visible again; readers have independent cleanup", async () => {
    const f = await fixture();
    const closeMain = f.api.registerChatSessionReader(f.session.id);
    const closeMini = f.api.registerChatSessionReader(f.session.id);
    closeMain();
    f.push();
    assert.equal(f.count(), 0);
    f.document.visibilityState = "hidden";
    f.push();
    assert.equal(f.count(), 1);
    f.document.visibilityState = "visible";
    f.api.markChatSessionRead(f.session.id);
    assert.equal(f.count(), 0);
    closeMini();
    f.push();
    assert.equal(f.count(), 1);
});

test("cloud import counts late arrivals once and never marks a duplicate unread again", async () => {
    const f = await fixture();
    let updates = 0;
    f.window.addEventListener(f.api.CHAT_UNREAD_UPDATED_EVENT, () => updates++);
    f.push();
    const imported = { id: "cloud-old-timestamp", sessionId: f.session.id, role: "assistant", content: "来自微信", createdAt: "2020-01-01T00:00:00Z", status: "sent", unread: false };
    assert.equal(f.api.upsertImportedChatMessage(imported).inserted, true);
    assert.equal(f.count(), 2);
    assert.equal(updates, 2);
    assert.equal(f.api.upsertImportedChatMessage(imported).inserted, false);
    assert.equal(f.count(), 2);
    f.api.markChatSessionRead(f.session.id);
    f.api.upsertImportedChatMessage(imported);
    assert.equal(f.count(), 0);
});

test("unread survives reload, clearing persists, and legacy history does not all become unread", async () => {
    const f = await fixture();
    f.push(); f.push();
    const reloaded = await fixture(f.db);
    assert.equal(reloaded.count(), 2);
    reloaded.api.markChatSessionRead(reloaded.session.id);
    assert.equal((await fixture(reloaded.db)).count(), 0);
    const legacy = structuredClone(f.db);
    legacy.messages.forEach(m => { delete m.unread; });
    assert.equal((await fixture(legacy)).count(), 0);
});

test("deleting, retracting and clearing messages remove their unread counts", async () => {
    const f = await fixture();
    const a = f.push(), b = f.push(); f.push();
    f.api.deleteChatMessage(a.id);
    assert.equal(f.count(), 2);
    f.api.retractChatMessage(b.id);
    assert.equal(f.count(), 1);
    f.api.clearChatSessionMessages(f.session.id);
    assert.equal(f.count(), 0);
});

test("reprocessing bubbles preserves unread/read state, excludes tools, and recounts parts", async () => {
    const f = await fixture();
    const a = f.push({ responseBatchId: "batch" });
    f.api.replaceMessageWithParts(a.id, [{ content: "一" }, { content: "二" }]);
    assert.equal(f.count(), 2);
    f.api.replaceResponseBatchWithParts(f.session.id, "batch", "三", [{ content: "三" }], { toolCallContent: "internal" });
    assert.equal(f.count(), 1);
    f.api.markChatSessionRead(f.session.id);
    f.api.replaceResponseBatchWithParts(f.session.id, "batch", "编辑", [{ content: "一" }, { content: "二" }]);
    assert.equal(f.count(), 0);
});

test("group chats count character bubbles and preserve the count when a round is rebuilt", async () => {
    const f = await fixture();
    const group = f.api.createGroupSession("群聊", ["character-a", "character-b"]);
    f.push({ sessionId: group.id, senderCharacterId: "character-a", responseRoundId: "round" });
    f.push({ sessionId: group.id, senderCharacterId: "character-b", responseRoundId: "round" });
    assert.equal(f.count(group.id), 2);
    f.api.replaceGroupResponseRound(group.id, "round", "edited", [{ content: "一" }, { content: "二" }, { content: "三" }]);
    assert.equal(f.count(group.id), 3);
    f.api.registerChatSessionReader(group.id)();
    assert.equal(f.count(group.id), 0);
});

test("moving messages between sessions carries unread state without duplicating it", async () => {
    const f = await fixture();
    f.push(); f.push();
    const other = f.api.createOrGetSession("character-b");
    f.api.reassignChatSessionMessages(f.session.id, other.id);
    assert.equal(f.count(), 0);
    assert.equal(f.count(other.id), 2);
});

// Render the real list item, stubbing only its data providers (not its JSX).
export function renderSessionPreview(unreadCount, isGroup = false) {
    const module = { exports: {} };
    const modules = {
        react: React,
        "react/jsx-runtime": jsxRuntime,
        "@/lib/character-storage": { loadCharacters: () => [] },
        "@/lib/settings-storage": { resolveUserIdentity: () => ({ name: "我" }) },
        "@/lib/chat-storage": { getLastVisibleSessionMessage: () => ({ content: "他嗓音沙哑低沉，带着……", createdAt: "2026-08-28T12:00:00Z" }), getChatMessagePreview: m => m.content },
        "@/lib/chat-offline-storage": { getLastChatOfflineTurn: () => null },
        "@/lib/chat-time": { formatChatUiTime: () => "刚刚" },
        "./chat-fallback-avatar": { ChatFallbackAvatar: ({ className }) => React.createElement("img", { src: "/images/default-moment-avatar.png", className: `w-full h-full object-cover ${className}` }) },
    };
    // The normal module keeps SessionItem private; expose it only inside this isolated test VM.
    vm.runInNewContext(compile("components/chat/chat-message-list.tsx") + "\nexports.TestSessionItem = SessionItem;", {
        exports: module.exports, module, require: name => modules[name] || {},
    });
    return renderToStaticMarkup(React.createElement(module.exports.TestSessionItem, {
        session: { id: "preview", contactId: "preview", alias: "殷忱", groupName: "好友群聊", isGroup, unreadCount, updatedAt: "2026-08-28T12:00:00Z" },
        onSelect: () => {},
    }));
}

test("real list-item JSX renders exact Arabic counts, hides zero, and places group badges outside clipping", () => {
    assert.doesNotMatch(renderSessionPreview(0), /chat-avatar-unread-badge/);
    for (const count of [1, 4, 12, 128]) {
        const html = renderSessionPreview(count);
        assert.match(html, new RegExp(`aria-label="${count} 条未读消息"`));
        assert.match(html, new RegExp(`>${count}</span>`));
    }
    assert.match(renderSessionPreview(4, true), /<\/div><span class="chat-avatar-unread-badge"/);
});
