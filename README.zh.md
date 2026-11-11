# dsh-session-delete（会话删除）

> 真正删除 DeepSeek Harness 的会话 —— **包括你此刻正在看的那个**。

侧边栏右键任意会话 → **删除会话**。不再提示"该会话正在使用中"，不整页刷新，
也不会在列表里留下删不掉的行。

[English](./README.md)

---

## 为什么需要它

DSH 把每个会话存成独立目录（`<DSH_HOME>/sessions/<session-id>/`）。侧边栏自带的是
**归档**（从列表里隐藏），并没有真正的删除：

- 手工删目录：Windows 上 DSH 还握着该目录的写句柄，`fs.rename` 直接 `EPERM`；
  即使删掉，列表也要整页刷新才会少一行。
- 只是"打开过一次"的会话仍驻留在 DSH 进程里，所以"先切到别的会话再删"并不解决问题
  —— 切换只改变 UI 焦点，进程里的会话对象还在。

本插件按正确顺序做收尾，然后再把目录挪走。

## 功能

- **正在使用的会话也能删**：先停手（`cancel` + 等空闲），再从进程内的会话/agent 注册表
  中摘除 —— 正是这一步让持久层 flush 并真正关闭文件句柄 —— 然后才动磁盘。
- **不刷新页面**：Host 半侧触发官方的 `api-session/removed` 事件，侧边栏行即时消失。
- **清空主视图**：如果删的正是当前打开的会话，工作区退回"没有会话"的空状态，
  而不是停留在一个已被删除的会话上。
- **可恢复**：目录被移动到 `<DSH_HOME>/sessions-trash/<时间戳>__<会话id>`，不是彻底清除。
  手工搬回去即可恢复。
- **移动带重试**：Windows 上杀毒/索引服务可能短暂占用目录，插件会重试约 6 秒，
  仍然失败则报出具体的错误码。

## 安装

在 DSH 的**插件**页面添加 `@tuweizhi/dsh-session-delete`，或使用命令行：

```bash
dsh plugin --profile <profile名> add @tuweizhi/dsh-session-delete
```

安装不会热生效：**Host 半侧需要重启 DSH**（或在插件页面停用再启用），因为它在进程内
注册了 HTTP 路由和事件监听；**浏览器半侧**在下次页面加载时生效。

## 使用

1. 在侧边栏右键任意会话 —— 正在运行的、打开着的、闲置的都行。
2. 选择 **删除会话**。
3. 确认。行立刻消失，目录被移入 `sessions-trash`。

界面上没有撤销。要找回某个会话：先退出 DSH，再把它的目录从 `sessions-trash`
搬回 `sessions/`：

```bash
# 示例（路径以你的实际为准）
mv "<DSH_HOME>/sessions-trash/2026-11-11T12-00-00-000Z__session-abc" "<DSH_HOME>/sessions/session-abc"
```

## 实现方式

Host 半侧（[`lib/index.js`](./lib/index.js)）在 `/dsh-session-delete` 下注册一组很小的
HTTP 接口（`list`、`diag`、`delete`），删除流程在工作区注册表的操作队列中串行执行：

1. 若该会话有存活的 agent：`agent.cancel({ kind: "disposed" })` 并等待 `whenIdle()`（有上限）。
2. `sessions.detachEntered(entry)` —— 从会话存储中摘除并派发 `session/disposed`。
   这一个事件同时完成三件事：DSH 的 JSONL 持久层 flush、释放写租约并关闭句柄；
   官方 session controller 向所有已连接前端广播 `api-session/removed`。
3. `agents.detachEntered(entry)` 以及有上限的 `scope.dispose()`，释放 agent 自己的上下文。
4. 从工作区记账里移除（archived/pinned 列表）。
5. `fs.rename` 把目录移入 `sessions-trash`，遇到 `EPERM`/`EBUSY`/`EACCES`/`ENOTEMPTY` 重试。
6. 清理该会话的投影缓存行（best effort）。

只有在第 2 步没能执行时，才补发一次 `ctx.emit("api-session/removed", id)`，
因此前端不会收到重复的移除事件。

浏览器半侧（[`lib/client.js`](./lib/client.js)）负责菜单项、确认框，以及删除成功后
—— 若删的是当前聚焦的会话 —— 调用 `uiWorkspace.clearMain()`。

`GET /dsh-session-delete/diag` 会返回当前加载的修订号，以及本次运行的 DSH 究竟暴露了哪些
内部钩子（sessions/agents 上的 `detachEntered` 等）。将来 DSH 改动内部结构时，
`/diag` 是第一排查点。

## 环境要求

- DSH `>= 0.2.1-alpha.1`（开发与验证基于 `0.2.2-rc.1`），Node.js `>= 22.19.0`。
- 插件会触达一些内部服务（`sessions`、`agents`、`workspaceRegistry`、`sessionPersistence`）。
  所有调用都做了特性探测，但如果某个 DSH 版本改动了这些内部结构，插件能力可能降级
  —— 升级 DSH 后请先看 `/diag`。

## 开发

```bash
npm run check   # 清单/文件自检 + 宿主模拟测试
```

- `scripts/verify.mjs` —— 校验清单、bundle patch、图标体积、locale JSON、绝对路径与
  `node --check` 语法。
- `tests/*.test.mjs` —— 起一个假的 DSH 宿主（注册表、持久层、web server），断言删除序列：
  存活 vs 闲置会话、`api-session/removed` 只发一次、目录落到 `sessions-trash`、错误分支。

## 许可证

MIT © 2026 TuWeiZhi
