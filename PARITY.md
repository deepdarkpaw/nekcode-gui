# nekcode-gui：与 nek CLI 的功能对照清单

目标：桌面端（本机与 Remote SSH）能使用 nek CLI 的全部功能。每一项写明来源、负责阶段和验证方式。

- **来源**：nek 侧路径相对 `G:/coding/nekcode/packages/coding-agent/src/`；`/xxx` 为 nek 斜杠命令；`rpc:` 为 RPC 命令或事件（`docs/rpc-commands.md`）。
- **阶段**：对应计划 `.nek/plans/nekcode-gui_facb09.plan.md` §12 的 P0–P8。
- **验证**：`T:<文件>` 单元测试（文件名即仓库内真实存在的测试文件）；`E:<场景>` Playwright 驱动 Electron + faux provider 的 E2E；`R:<场景>` SSH Docker 远程 E2E（`harness/remote`）；`M:<步骤>` 人工验收（Windows 11 本机 / Linux 远程）。
- 状态：`[x]` 已实现并验证；`[~]` 已实现、待接线或待验证；`[ ]` 未实现；`[-]` 不做（写明原因）。

## 0. 当前实现快照（2026-10-29 核查）

- **2026-11-01 打包验收**：Windows 打包应用 + nek 开发版 + 本地 OpenAI 兼容 mock 跑通 `scripts/acceptance/packaged-e2e.mjs` 01–10：引导三步、设置 13 页（含一次写盘）、首发与项目信任、`ls` 工具行、用量指示、ask_question（单选与自填）、switch_mode 审批、plan_review 执行计划并完成待办、重启后恢复历史会话、停止生成。下列 2026-10-29 的缺口中，项目信任询问与交互/状态/引导挂载已被这次验收覆盖；其余各行状态待逐行复核后再改。

- **服务层已切换到 nek**：`packages/services/src/node.ts` 用 `createNekZCodeAgentService` 装配 `IZCodeAgentService`，旧 zcode agent 运行时已删除；`packages/services/test/nekAgentE2E.test.ts` 用真实 nek 产物 + 本地 OpenAI 兼容 mock 跑通"建会话 → prompt → 工具 → 恢复快照"（需 `NEK_RPC_WORKTREE` 与 `NEK_E2E=1`，默认跳过）。
- **设置中心已挂载**：13 个页面由 `NekSettingsSection` 渲染进 `SettingsPage`，后端是真实 `INekConfigApi`（本机执行器 + `~/.nek/agent` 锁），IPC 由 `desktopMainIpcNek*` + preload `nekIpc` 暴露。
- **交互 / 状态 / 远程 / 引导的 headless 层就绪但未挂载**：`packages/ui/src/nek/**`、`packages/ui/src/remote/nek/**`、`packages/ui/src/onboarding/useNek*` 目前只有实现与单测，产品代码里没有引用点，故这些行标 `[~]`。
- 已知接线缺口（影响对应行的验收）：生产装配未注入 `askProjectTrust`（`/trust` 询问会在未记录信任的项目上抛错）、`conversationPlansV4` 仍返回空列表、`nek.stop_subagent` / `get_subagent_transcript` / `list_agent_types` 只有协议没有适配器方法、远程配置执行器为 `() => undefined`、快捷键只有绑定表没有派发。

## 1. 输入

|     | 项                                                                                                     | 来源                                          | 阶段 | 验证                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [~] | 发送；运行中 Enter 插队（steer）、Alt+Enter 排到最后（follow-up）                                      | `rpc:prompt/steer/follow_up`                  | P4   | `T:nekAgentService.test.ts`；`T:nekAgentServiceAdapter.test.ts`；`E:send-steer-followup`                                               |
| [~] | 队列条：编辑、删除、取回输入框（Alt+↑）、清空                                                          | `rpc:queue_update`、`app.message.dequeue`     | P4   | `T:queueController.test.ts`；`T:queue.test.ts`；`T:nekAgentService.test.ts`；`E:queue-bar`                                             |
| [~] | `!cmd` / `!!cmd` bash 模式（`!!` 不进上下文）：流式输出、退出码、可中止                                | `rpc:bash/abort_bash`                         | P4   | `T:nekAgentService.test.ts`（bash / abort_bash 已通，输入 `!` 前缀未接）；`E:bash-mode`                                                |
| [~] | 图片粘贴与拖放；超过当前模型限制时提示                                                                 | `images.*` 设置、`rpc:prompt.images`          | P4   | `T:nekAgentServiceAdapter.test.ts`（图片附件转换与非图片报错）；`E:image-paste`                                                        |
| [~] | 拖入文件转成 `@路径`；`@` 触发文件补全（只插入路径，不附带内容）                                       | `guide/usage.md#files`                        | P4   | `T:nekMentionLogic.test.ts`；`T:nekMentions.test.ts`；`E:at-file`                                                                      |
| [~] | `@agent:类型` / `@skill:名字` 点名：补全排在文件前，前缀过滤，链接色显示，`@skill` 可点击打开 SKILL.md | `core/mentions.ts`、`rpc:get_mention_targets` | P4   | `T:nekMentions.test.ts`；`T:nekMentionLogic.test.ts`；`T:nekMentionController.test.ts`；nek `T:rpc-gui-mentions.test.ts`；`E:mentions` |
| [x] | 隐藏的 `skill_mention` 消息不出现在对话中                                                              | `core/agent-session.ts`                       | P3   | `T:nekConversationProjector.test.ts`                                                                                                   |
| [ ] | 大段粘贴折叠为可预览粘贴块，发送时展开                                                                 | `tui.editor` 粘贴折叠                         | P4   | `E:paste-block`                                                                                                                        |
| [ ] | Ctrl+G 大编辑器                                                                                        | `app.editor.external`                         | P4   | 绑定已注册（`T:actionRegistry.test.ts`），行为未接；`M:Ctrl+G 打开并回填`                                                              |
| [ ] | 输入历史：首行 ↑ / 末行 ↓                                                                              | `tui.editor.history`                          | P4   | `E:input-history`                                                                                                                      |
| [~] | 输入法组字时 Enter 不发送                                                                              | —                                             | P4   | `T:imeComposition.test.ts`；`T:askQuestion.test.ts`（AQ-K22）                                                                          |
| [ ] | 每会话草稿（含附件）切回恢复                                                                           | —                                             | P4   | `E:draft-restore`                                                                                                                      |

## 2. 模式与计划

|     | 项                                             | 来源                                  | 阶段 | 验证                                                                                                                                                   |
| --- | ---------------------------------------------- | ------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [~] | `/plan`、`/agent`、Alt+M 切换模式              | `extensions/nek`                      | P4   | `T:nekAgentService.test.ts`（`extension_call nek.set_mode`）；`T:actionRegistry.test.ts`；`E:mode-switch`                                              |
| [~] | Plan 审阅：执行 / 新会话执行 / 继续规划 / 退出 | `nek.plan_review`                     | P4   | `T:planReview.test.ts`；`T:planReviewController.test.tsx`；`E:plan-review`                                                                             |
| [~] | `/plans` 列表与预览；计划侧栏                  | `nek.get_state.plans`、`nek.get_plan` | P4   | 预览卡 `T:nekConversationProjector.test.ts`；列表接口仍返回空，待接线；`E:plans-list`                                                                  |
| [~] | switch_mode 审批卡                             | `nek.switch_mode`                     | P4   | `T:switchMode.test.ts`；`T:switchModeController.test.tsx`；`E:switch-mode-approval`                                                                    |
| [~] | ask_question 表单：单选、多选、Other，全键盘   | `nek.ask_question`                    | P4   | `T:askQuestion.test.ts`；`T:askQuestionController.test.tsx`；`T:interactionQueue.test.ts`；nek `T:rpc-gui-extension-channel.test.ts`；`E:ask-question` |
| [~] | todo 面板（`/todos`）                          | `nek.state.todos`                     | P4   | `T:todoController.test.ts`；`T:nekConversationProjector.test.ts`；`E:todo-panel`                                                                       |

## 3. 子代理

|     | 项                                                            | 来源                          | 阶段 | 验证                                                                                                         |
| --- | ------------------------------------------------------------- | ----------------------------- | ---- | ------------------------------------------------------------------------------------------------------------ |
| [~] | 子代理卡：状态、`model · type · ↑in ↓out · elapsed`、当前活动 | `nek.subagent`                | P4   | `T:subagentControllers.test.ts`；`T:format.test.ts`；`T:nekConversationProjector.test.ts`；`E:subagent-card` |
| [~] | 输入框上方运行中子代理条；停止                                | `nek.stop_subagent`           | P4   | `T:subagentControllers.test.ts`（RB-1..6）；`nek.stop_subagent` 尚无适配器方法；`E:subagent-stop`            |
| [~] | 查看子会话记录（侧栏，可返回）                                | `nek.get_subagent_transcript` | P4   | `T:transcriptController.test.ts`（控制器就绪，RPC 未接适配器）；`E:subagent-transcript`                      |
| [~] | 后台完成通知                                                  | `nek.subagent`                | P4   | `T:subagentControllers.test.ts`（RB-6 终态事件只发一次）；`E:subagent-notify`                                |
| [ ] | `/agents`、`/subagents` 视图                                  | `nek.list_agent_types`        | P4   | 只有协议与设置页（`T:pages.test.tsx`），没有视图；`E:agents-view`                                            |

## 4. 会话

|     | 项                                                               | 来源                                                    | 阶段 | 验证                                                                                           |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------- |
| [~] | `/new`                                                           | `rpc:new_session`                                       | P3   | `T:nekAgentService.test.ts`；`T:nekAgentE2E.test.ts`；`E:new-session`                          |
| [~] | `/resume`：按时间/名称排序、只看已命名、显示路径、重命名、删除   | `rpc:list_sessions/rename_session/delete_session`       | P3   | `T:nekAgentService.test.ts`；`T:nekSessionIndexSyncer.test.ts`；`E:resume-list`                |
| [~] | `/name`、`/session` 信息                                         | `rpc:set_session_name/get_session_stats`                | P4   | `T:nekAgentService.test.ts`；`E:session-info`                                                  |
| [~] | `/tree`：过滤器、标签、时间戳、折叠；切换分支可生成摘要          | `rpc:get_tree/navigate_tree/set_entry_label`            | P4   | `T:nekAgentService.test.ts`；`E:tree`                                                          |
| [~] | `/fork`：从用户消息分叉并回填输入框                              | `rpc:fork`                                              | P4   | `T:nekAgentService.test.ts`；`E:fork`                                                          |
| [~] | `/clone`、`/import`、`/export`（HTML/JSONL）、`/share`、`/copy`  | `rpc:clone/import_session/export_session/share_session` | P4   | `T:nekAgentService.test.ts`（fork/clone、export、share、import；`/copy` 待接）；`E:session-io` |
| [ ] | 新会话执行计划（`/nek-build --fresh`）                           | `extensions/nek`                                        | P4   | `E:plan-fresh`                                                                                 |
| [ ] | durable 续跑提示（"正在继续上次中断的回合"）                     | `rpc:agent_start` 续跑                                  | P4   | `E:resume-run`                                                                                 |
| [~] | 会话被终端 nek 占用时只读快照打开并提示                          | `rpc:read_session_snapshot`                             | P3   | `T:nekAgentService.test.ts`（只读快照、写入被拒、`lockedBy`；提示层未接）；`E:locked-session`  |
| [ ] | 在终端中继续：释放 GUI 进程，终端面板运行 `nek --session <path>` | —                                                       | P4   | `M:在终端中继续`                                                                               |
| [x] | 会话列表与 nek 对账（GUI 只存置顶/归档/未读/分组）               | `nekSessionIndexSyncer`                                 | P3   | `T:nekSessionIndexSyncer.test.ts`                                                              |

## 5. 模型

|     | 项                                             | 来源                                          | 阶段 | 验证                                                                                                                           |
| --- | ---------------------------------------------- | --------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| [~] | `/model`（搜索）、循环切换、设为默认           | `rpc:set_model/cycle_model`                   | P4   | `T:nekAgentService.test.ts`（set_model / cycle_model）；绑定 `T:actionRegistry.test.ts`；`E:model-picker`                      |
| [~] | `/thinking`、Shift+Tab 循环思考等级            | `rpc:set_thinking_level/cycle_thinking_level` | P4   | `T:nekAgentService.test.ts`；`T:actionRegistry.test.ts`；`E:thinking`                                                          |
| [~] | `/scoped-models`（循环范围）                   | `enabledModels`                               | P5   | `T:lib.test.ts`（`+/-` 增量）；`T:nekConfigApi.test.ts`；`E:scoped-models`                                                     |
| [~] | `/login`、`/logout`（Claude 订阅、Codex 订阅） | `rpc:auth_*`                                  | P5   | 真实后端：`T:nekConfigApiLogin.test.ts`、`T:dataHooks.test.tsx`、`T:pages.test.tsx`；真机 OAuth 待手测（`M:login`）；`E:login` |

## 6. 上下文

|     | 项                                         | 来源                                 | 阶段 | 验证                                                                                                                     |
| --- | ------------------------------------------ | ------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------ |
| [~] | 用量指示：tokens、缓存、上下文百分比、费用 | `rpc:get_session_stats`              | P4   | `T:format.test.ts`（US-1..4）；`T:statusControllers.test.ts`（US-1..6）；`T:nekConversationProjector.test.ts`；`E:usage` |
| [~] | `/compact [说明]`，可取消                  | `rpc:compact/abort`                  | P4   | `T:nekAgentService.test.ts`；`T:retryCompaction.test.ts`（CP-1..3）；`E:compact`                                         |
| [x] | 自动压缩开关                               | `compaction.enabled`                 | P5   | `T:lib.test.ts`（compactionChecks）；`T:nekConfigApi.test.ts`（settings 写入）；Compaction 页已挂载                      |
| [~] | 压缩摘要卡、分支摘要卡                     | `compactionSummary`、`branchSummary` | P3   | 压缩卡 `T:nekConversationProjector.test.ts`；分支摘要已投影但无断言                                                      |
| [ ] | 缓存未命中提示                             | `rpc:cache_miss` 类事件              | P4   | `E:cache-miss`                                                                                                           |
| [~] | 重试横幅：第 n/m 次、倒计时、取消重试      | `rpc:auto_retry_*`                   | P4   | `T:retryCompaction.test.ts`（RT-1..9）；`T:statusControllers.test.ts`（RT-2/5/7/8）；`E:retry-banner`                    |

## 7. 运行时

|     | 项                                                                                     | 来源                                      | 阶段 | 验证                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------- | ----------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [~] | `/reload`；写配置后自动 reload，运行中会话"本轮结束后生效"                             | `rpc:reload`                              | P5   | `T:nekConfigApiWatch.test.ts`（写后自动 reload、deferred 计数、进程级失败上报）；nek 侧 `T:rpc-gui-control-mode.test.ts`（`reload` 属控制命令白名单）；`/reload` 斜杠命令入口未接 |
| [~] | `/mcp`：状态、重连、登录 / 退出                                                        | `mcp.*`                                   | P5   | `T:nekConfigApiWatch.test.ts`；`T:nekConfigApi.test.ts`；`T:pages.test.tsx`；`E:mcp-status`                                                                                       |
| [~] | `/trust`；启动会话前询问并传 `--approve/--no-approve`                                  | `rpc:get_project_trust/set_project_trust` | P3   | `T:nekAgentService.test.ts`；`T:nekConfigApi.test.ts`；生产装配未注入 `askProjectTrust`，询问层待接                                                                               |
| [ ] | `/hotkeys`（快捷键页）、`/changelog`、`/quit`                                          | `rpc:get_changelog`                       | P4   | 快捷键页见 §9；`/changelog`、`/quit` 未做；`E:misc-commands`                                                                                                                      |
| [~] | 扩展命令、prompt 模板、`/skill:` 列进 `/` 菜单并经 `prompt` 执行                       | `rpc:get_commands`                        | P4   | `T:nekAgentService.test.ts`（`get_commands`）；`T:pages.test.tsx`（Agent 预设）；`E:slash-menu`                                                                                   |
| [~] | extension UI：select / confirm / input / editor / notify / status / title / 编辑器文本 | `docs/rpc-extension-ui.md`                | P4   | `T:nekRpcClient.test.ts`；`T:extensionUi.test.ts`；`T:extensionDialog.test.ts`；`T:extensionDialogController.test.tsx`；`E:extension-ui`                                          |
| [ ] | extension_error 显示                                                                   | `rpc:extension_error`                     | P4   | `E:extension-error`                                                                                                                                                               |
| [ ] | 启动诊断：models.json 错误、模型回退、崩溃后续跑                                       | `rpc:get_info`、`validate_config`         | P4   | `E:startup-diagnostics`                                                                                                                                                           |
| [ ] | fd / rg / ast-grep 下载状态                                                            | 工具下载事件                              | P4   | `M:首次运行`                                                                                                                                                                      |

## 8. 显示与导航

|     | 项                                                                                               | 来源                                      | 阶段 | 验证                                                                                               |
| --- | ------------------------------------------------------------------------------------------------ | ----------------------------------------- | ---- | -------------------------------------------------------------------------------------------------- |
| [~] | thinking 显示 / 隐藏（Ctrl+T）、工具输出展开 / 折叠（Ctrl+O），单项覆盖                          | `app.thinking.toggle`、`app.tools.expand` | P4   | `T:foldState.test.ts`；`T:actionRegistry.test.ts`（绑定已注册，派发未接）                          |
| [ ] | 55 个工具渲染器对接 nek 工具（read/edit/write/bash/grep/find/ls/ast_grep/web_search/subagent/…） | `core/tools/`                             | P4   | `E:tool-cards`                                                                                     |
| [ ] | Mermaid、LaTeX、工具结果中的图片                                                                 | —                                         | P4   | `E:rich-render`                                                                                    |
| [ ] | 会话内搜索（Ctrl+F，计数，展开折叠内容）                                                         | `alt-screen-search`                       | P4   | 只有绑定 `tui.altScreen.search`；`E:search`                                                        |
| [ ] | Ctrl+↑/↓ 在提问之间跳转；轮次导航条                                                              | `tui.altScreen.previousPrompt`            | P4   | 只有绑定；`E:prompt-jump`                                                                          |
| [ ] | 跟随底部 / 回到底部；Ctrl+Home / End                                                             | —                                         | P4   | 只有绑定；`E:follow-bottom`                                                                        |
| [ ] | 路径点击在侧栏预览并定位；Ctrl/Cmd+点击外部编辑器；URL 用系统浏览器                              | —                                         | P4   | `E:links`                                                                                          |
| [ ] | 系统通知：回合完成 / 需要输入 / 出错，点击定位                                                   | —                                         | P4   | 桌面通知改为只保留 `elicitation_request`（`T:feedback-boundary.test.mjs`），点击定位未做；`M:通知` |

## 9. 设置中心（§6）

|     | 项                                                | 来源                                    | 阶段 | 验证                                                                                                                                                        |
| --- | ------------------------------------------------- | --------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [x] | 13 个页面 UI                                      | `packages/ui/src/settings/nek/`         | P5   | 13 页已由 `NekSettingsSection` 挂载；`T:pages.test.tsx`（Providers/Tools/Mcp/Accounts 有组件测试）、`T:dialogs.test.tsx`、`T:lib.test.ts`、`T:i18n.test.ts` |
| [x] | `INekConfigApi` 真实后端（本机）                  | `packages/services/src/nek-config-api/` | P5   | `T:nekConfigApi.test.ts`；`T:nekConfigService.test.ts`；`T:nekConfigApiWatch.test.ts`；`T:nekConfigApiLogin.test.ts`；`T:ipcClient.test.ts`                 |
| [~] | 远程目标读写、复制到远程                          | 同上 + gui-server                       | P6   | 复制语义 `T:nekConfigApiCopy.test.ts`；UI `T:copyToHostDialog.test.tsx`；host 侧远程执行器仍是 `() => undefined`；`R:config-remote`                         |
| [x] | 快捷键页（录制、冲突、导入 nek keybindings.json） | `shortcuts/actionRegistry.ts`           | P5   | `T:actionRegistry.test.ts`（录制、冲突、`imports only GUI actions`）                                                                                        |

## 10. 远程

|     | 项                                               | 来源                          | 阶段 | 验证                                                                                                                                                                                 |
| --- | ------------------------------------------------ | ----------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [~] | 主机密钥首次确认、变化阻断                       | `sshKnownHosts.ts`            | P6   | `T:sshKnownHosts.test.ts`（已接进 `ssh-backend` 的 hostVerifier）；`T:remotePromptBroker.test.ts`；`T:hostKeyController.test.ts`；`T:hostKeyChangedController.test.ts`；`R:host-key` |
| [~] | `~/.ssh/config` + ProxyJump                      | `ssh-config`                  | P6   | `T:sshConfig.test.ts`；`R:proxyjump`                                                                                                                                                 |
| [~] | 远程检测 / 安装 / 更新 nek（install.sh，可取消） | `nek gui-info`                | P6   | `T:nekRemote.test.ts`；`T:onboardingNek.test.ts`（NK-1..12）；`T:mockHostApi.test.ts`；`R:install-nek`                                                                               |
| [~] | 断线重连（1/2/4/8/16 s）与续跑                   | `config/config.yaml remote.*` | P6   | `T:reconnectStateMachine.test.ts`；`T:remoteReconnectAdapter.test.ts`；`T:connectionStatusController.test.ts`（适配器未接连接管理）；`R:reconnect`                                   |
| [~] | 远程 OAuth 回调端口转发（53692 / 1455）          | —                             | P6   | `T:sshPortForward.test.ts`（已接进 `ssh-backend.forwardLocalPortToRemote`，OAuth 流程尚未调用）；`R:oauth-forward`                                                                   |
| [ ] | 凭据用 safeStorage 存储                          | —                             | P6   | 只有 `T:credentialController.test.ts` 的口令提示；`M:Linux 无钥匙串提示`                                                                                                             |

## 11. 用 GUI 原生方式替代、不做

|     | 项                                                                                                           | 说明                                |
| --- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| [-] | tmux / Kitty 键盘协议、OSC 进度、Ctrl+Z 挂起、TUI regular/fullscreen、编辑器 padding、硬件光标、终端图像协议 | 终端特性，GUI 原生实现等价体验      |
| [-] | 彩蛋命令 `/arminsayshi`、`/dementedelves`                                                                    | 不做；`/llama` 作为扩展命令照常可用 |
