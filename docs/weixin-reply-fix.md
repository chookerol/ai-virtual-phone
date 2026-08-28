# 微信连续消息错轮次修复（2026-08-28）

适用仓库：`chookerol/ai-virtual-phone`。核对时 main 为
`1b650263402ca964c8190a15ad856025b942406e`；修改前的相关已有文件与该版本一致。
这份补丁不包含角色数据、聊天记录或 API 密钥，不修改数据库结构。

## 改了什么

- 待回复消息从历史中去重后移到本轮末尾，按原顺序合并，不修改消息时间戳。
  解决“生成旧回复期间收到新输入，新输入却排在旧回复前面”的上下文错轮次。
- 每个发送分段之前检查轻量 pending 标志。发现已入库的新输入时停止旧草稿；
  一条也没发出的草稿不记历史、不标记已回复，下一轮合并新旧输入再回答。
- 中途停止或部分发送失败时，历史只保存实际成功发送的部分。
  HTTP 200 但 iLink 返回非零 `ret` / `error_code` 也按发送失败处理。
- 内部 `[引用:内容]` 转为 `引用「内容」：回答`，并将跨行引用与回答合为一条。
  这是纯文字降级，不是微信原生的引用气泡。
- 被打断/未完整发送的草稿不会创建或执行其中的快捷动作。
- 核心与加载器协议升级到 **4**，避免更新云函数后仍优先执行桶内旧 v3 核心。
  心跳增加 `coreProtocolVersion`，便于核对是否已生效。

## GitHub 里需要提交的文件

按原路径覆盖已有文件，新文件按同一路径添加。不要只改 `supabase/`，否则下次
网站构建或同步运行包时会再次分发旧代码。

| 文件 | 用途 |
| --- | --- |
| `tools/weixin-local-assistant/assistant-core.mjs` | 核心修复源文件 |
| `tools/weixin-local-assistant/cloud-function-wrapper.mjs` | v4 加载器与版本心跳 |
| `public/weixin-local-assistant/assistant-core.mjs` | 供小手机同步的核心，自动生成 |
| `public/weixin-local-assistant/cloud-function.mjs` | 单文件部署包，自动生成 |
| `supabase/functions/weixin-assistant/index.ts` | Supabase 部署文件，自动生成 |
| `scripts/check-weixin-reply-flow.test.mjs` | 新增：不联网的回复流程回归测试 |
| `scripts/check-weixin-prompt-equivalence.mjs` | 修正 Windows 路径，运行既有等价性测试 |
| `package.json` | 增加 `check:weixin-replies` 测试命令 |
| `docs/weixin-reply-fix.md` | 本说明 |

若 main 后续已有其他修改，请合并补丁，不要用旧整文件覆盖新的改动。

## 怎样让线上生效

1. 在小手机微信设置中暂时关闭“云端轮询”，避免更新期间继续回旧消息。
2. 将上述文件提交到自己的 GitHub 仓库。确保 Netlify/Vercel 关联的是这个 fork，
   并等待新版本构建部署成功。仅在 GitHub 改文件，不会自动更新未关联的站点。
3. 在 Supabase 项目中打开现有 **`weixin-assistant`** 函数的代码编辑器，
   用新 `supabase/functions/weixin-assistant/index.ts` 的**全部内容**替换入口代码，
   再部署更新。不要另建名字不同的函数，也不要只粘贴核心文件。
   保持该项目现有的定时密钥和环境变量；本函数使用自定义定时密钥鉴权，
   现有的 `verify_jwt=false` 配置保持不变。无需新建 SQL 表。
4. 打开**自己更新后的站点**，在微信设置里重新同步运行包，再开启云端轮询。
   这会同步当前角色/历史和新核心。避免同时打开旧版站点反复上传旧运行包。
   如果换了网站域名，先备份并迁移本地数据，不要清空浏览器数据。
5. 刷新云端心跳；在备份桶 `weixin-cloud/state/cloud-assistant.json` 中应能看到
   `coreProtocolVersion: 4`。`codeSource` 为 `bucket` 或 `bundled` 均可，关键是协议为 4。
6. 用普通测试消息验证：连续发两三条，检查是否围绕最后的输入回答；在回复分段期间
   再发一句新要求，确认新输入被轮询收到后，不再把旧草稿剩余部分全部发出。

**本次需要重新部署云函数，不是只同步运行包。** 老 v3 加载器会拒绝 v4 桶代码，
并回退到其旧内置版本；新的 v4 加载器则会拒绝旧桶代码，使用修复后的内置版本。

官方部署参考：<https://supabase.com/docs/guides/functions/deploy>

## 本地验证

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run weixin:build-dist
npm run check:weixin-replies
npm run check:weixin
```

回复回归测试的全部 HTTP 请求都由内存桩拦截，不读取真实密钥，不联系微信或模型。
分发文件由 `weixin:build-dist` 生成，不要在生成文件中单独修改业务逻辑。

本次本地验证结果：16 项回复流程测试、385 项提示词等价性场景通过，
`npm run build` 完成（71 个静态页面）。项目构建配置会跳过类型检查和 lint，
因此构建成功不代表这两项额外检查通过。尚未部署或进行真实微信收发验收。

## 边界

- 只能停止尚未发送的分段，不能撤回已发送消息。
- 检查的是**已经轮询收到并入库**的新消息，不是实时读取微信输入框。
  在下一次轮询尚未收到新消息、或者只运行串行本地助手时，不能保证立即打断。
- 不删除旧回复，也不重写已有历史；修复生效后仍可能受到旧错答或过重提示词影响。
- 不改变世界书关键词仅在同步时激活的现有限制，也不保证模型永不答非所问。
