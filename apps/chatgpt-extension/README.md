# Experimental ChatGPT Web Bridge for Pro — P0.12

独立、私有的 Manifest V3 扩展，只支持 **Chrome/Chromium + `https://chatgpt.com`**。直接连接 `http://127.0.0.1:<port>` 的本机 Veyra Daemon。原生 Codex 使用已有登录；API Provider 为 optional，核心流程无需 `OPENAI_API_KEY`。不使用 Cloudflare、ngrok、公网服务器或 ChatGPT 隐藏后端 API。

保留的 [`apps/chatgpt-bridge`](../chatgpt-bridge/README.md) 是 **preferred future official Full MCP production path**。官方 Pro 权限资料存在差异，证据和当前产品决策见 [ADR 001](../../docs/ADR-001-CHATGPT-BRIDGE.md)。浏览器桥接是可替换的实验路径，DOM 变化可能使其暂停。Project `.veyra/` 是唯一工程共享状态中心；不读取完整 ChatGPT history、其他 conversation 或任何登录凭证。

## 阶段 A：开发者可独立运行

从仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @veyraoss/chatgpt-extension test
pnpm --filter @veyraoss/daemon test
pnpm --filter @veyraoss/chatgpt-extension smoke:browser
pnpm lint
pnpm format:check
pnpm check
pnpm test
pnpm build
```

`smoke:browser` 使用已安装的 Playwright Chromium；可通过 `CHROMIUM_EXECUTABLE=/absolute/path/to/chromium` 指定已有兼容可执行文件。需要时可运行 `pnpm --filter @veyraoss/chatgpt-extension exec playwright install chromium` 安装测试浏览器；不需要安装到用户个人 Chrome。

夹具加载真实构建的 MV3 扩展，使用独立临时浏览器 profile，用本地 DOM 模拟 `chatgpt.com`，并阻止公网请求。模拟 executor 修改 disposable Project，真实 daemon/Verifier 先失败再通过，检查两次结构化结果自动回到同一夹具对话、状态展示、配对及撤销；结束时清理其浏览器、daemon、profile。它**不是**真实 ChatGPT Pro / native Codex 账号验收。

## 阶段 B：用户安装与真实 ChatGPT Pro 验收

以下操作只在开发验证完成后由用户进行。不要把模拟页面当成通过；P0.12 在真实安装、授权和自动回传证据齐备前保持未完成。

1. **构建产物与加载目录。** 在仓库根目录运行 `pnpm build`。产物是 `apps/chatgpt-extension/dist/`，包含 `manifest.json`、`background.js`、`content.js`、`popup.js`、`popup.html`、`popup.css`。Chrome 加载 **dist 目录本身**，不是仓库根目录、源码目录或单个文件。用 `pwd` 获得仓库绝对路径后加上 `/apps/chatgpt-extension/dist`。

2. **安装到 Chrome。** 打开 `chrome://extensions`，开启 Developer Mode，选择 Load unpacked，加载上述目录，按 Chrome 提示授权。固定扩展 ID 应为 `meibodpmcjcjdpfaaejdpiclijnpcclh`。public manifest key 只是稳定标识，不是密钥。将 Veyra 固定到工具栏便于观察。更新构建后，在此页点击 Reload，再刷新目标 ChatGPT 页面并重新绑定。

3. **准备专用 disposable Project。** 从仓库根目录执行下面命令。它只新建随机临时目录，不接受已有项目作为目标，不安装依赖，不启动 Codex 模型，不改真实项目。复用已有 greeting fixture，创建本地 Git baseline，注册独立 registry，绑定 native Codex，配置可信的 test/build/diff 检查，并生成启动/停止脚本。把返回的 `directory` 赋给本终端变量 `PROOF_DIR`（例如 `PROOF_DIR='/返回的完整目录'`）；`project.root` 是应该选择的项目目录，名称为 `veyra-pro-proof`。

   ```sh
   pnpm --filter @veyraoss/chatgpt-extension prepare:live /absolute/path/to/codex
   ```

   若 `codex` 已在 PATH，省略最后的路径即可。在本机 macOS 上可使用已安装的 `/Applications/ChatGPT.app/Contents/Resources/codex`，前提是该路径真实存在。不要填写 API Key。每次重新执行都会建立新的独立测试项目，保留之前的证据。

4. **启动 daemon。** 在终端执行 `bash "$PROOF_DIR/start-daemon.sh"` 并保持该终端运行。脚本显式移除 `OPENAI_API_KEY`，仅使用刚生成的 registry/Project，监听 `127.0.0.1:3181`。终端显示 Loopback 地址和 Pairing file 的绝对路径。若端口被占用，先确定占用进程；不要停止无关服务。可以编辑此测试目录的启动脚本，选用另一个空闲的本机端口，并相应替换下方 health 地址。

5. **确认 Ready。** 在另一个终端执行：

   ```sh
   bash "$PROOF_DIR/daemon-status.sh"
   curl --fail http://127.0.0.1:3181/health
   bash "$PROOF_DIR/native-doctor.sh"
   ```

   daemon status 应显示 `status: running`；health 只返回 `service: veyra-daemon, version: 1`，不表示已经授权。native doctor 的 executor readiness 必须通过。若原生登录缺失，通过 Codex 自己的正常登录流程处理；Veyra 不读取或复制凭证。扩展选择 Project 后还会检查该项目的 native readiness。

6. **明确配对。** 打开扩展，选择终端显示的 JSON 配对文件。在 macOS 文件选择器按 Command–Shift–G 可输入绝对路径。核对弹窗中的本机地址、允许的 Project UUID 和到期时间，再点击“确认所列 Project 范围并配对”。邀请有效期 10 分钟、仅一次使用；成功交换后邀请文件被删除，授权最长 8 小时，仅能访问所列 Projects。**不要把文件内容放进 ChatGPT。** 邀请过期、旧版本配对文件或交换结果不确定时，停止并重启该测试 daemon 获取新文件。

7. **选择 Project 和绑定当前对话。** 在 `chatgpt.com` 新建专用测试对话，先发送“这是 Veyra 本地测试对话，请等我绑定项目后再执行。”，等回答完成且 URL 成为 `/c/<uuid>`。扩展安装前已打开的页面需先刷新。点击扩展“检测 daemon / 刷新项目与 readiness”，**手动选择** `veyra-pro-proof` 并核对 `project.root` 的绝对路径。保持输入框为空、没有附件、GPT 不在生成中。保留执行上限 3，点击“绑定当前会话并启用自动执行”。它会自动把 bounded Project State、检查 ID 和本轮 handoff 模板发到该对话。面板必须显示 `Current — 已明确绑定`、正确的 Project 名称/路径/UUID、`Codex — Ready` 和 daemon connected；不能按标题或聊天文字猜项目。

8. **在同一个对话发送测试提示词。** 这是用户下达任务，不是手工搬运 GPT/Codex 输出。可使用：

   ```text
   请作为这个已绑定 disposable Project 的 Planner / Reviewer 做一次真实桥接验收。
   目标：src/message.js 的 message() 最终返回精确字符串 Hello from the Veyra fixture。
   先用扩展刚提供的 canonical handoff 模板和本轮 Project/runId 提交一次只读检查任务，明确要求 Codex 本轮不修改文件；请求 test、build、diff 三个已有检查（kind 分别 test、build、shell）。当前测试应失败。把计划、任务和验收标准写进 context.plan。
   用独立行 VEYRA_HANDOFF_BEGIN 和 VEYRA_HANDOFF_END 包住唯一的 JSON，不要只输出普通文字或无边界代码块。
   等 Veyra 自动回传结果后，根据实际 Verification Evidence 和 Diff 审查，返回 VEYRA_REVIEW_BEGIN/END 的结构化 verdict。
   首轮确实失败时，再用回传消息里的新身份生成 repair handoff，只允许修改 src/message.js，保留 tests、scripts、配置、AGENTS.md 和 .veyra，重跑同样三个检查。
   只有真实检查通过并且修改符合验收条件才给 PASS。缺失证据不能算成功。需要人工决策时停止，不要发布、提交 Git 或部署，也不要读取凭证或其他聊天历史。
   ```

9. **观察 GPT → Veyra → Codex。** 无需复制 GPT 输出。完成的 assistant 区块通过 JSON/schema、Project/run 身份、连接和 native readiness 检查后派发。扩展显示 Run ID、run 状态和基于保存事件的 Agent 状态；Agent success 与 Verifier/run success 是不同概念。错误保留在弹窗，未知状态不假报通过。实际文件修改在 `PROOF_DIR/project/src/message.js`；handoff、result、run evidence 留在该 Project 的 `.veyra/`。原生执行每次受 daemon 的 120 秒超时约束。

10. **确认同一 conversation 自动回传。** 保持绑定页打开，不切换/刷新该页，输入框保持空闲。应出现明确标注“Veyra Executor 自动回传”的消息，包含 `VEYRA_RESULT_BEGIN/END`、真实 Run ID、结果、Verifier evidence、Git evidence/artifacts，然后 GPT 继续 Review。弹窗 `Last Result` 的回传应为 `confirmed`；仅点击 Send 或看到本地 completed 不算回传通过。记录首次失败/修复通过的 Run ID、浏览器/native 版本、同一 conversation 的回传和 review，勿导出完整对话或凭证。修复后可独立核对保护文件与真实测试/构建：

    ```sh
    pnpm --filter @veyraoss/chatgpt-extension inspect:live "$PROOF_DIR"
    ```

    此命令使用项目外保存的原始内容检查受保护文件，并重跑测试/构建；不会代替真实浏览器的同会话验收。

11. **排错和日志位置。** 弹窗错误与连接/native 状态用于第一步排查。运行日志在 `PROOF_DIR/registry/daemon/daemon.jsonl`；项目证据在 `PROOF_DIR/project/.veyra/handoffs/` 和 `.veyra/runs/<runId>/`（包括 events.jsonl 与 state.json），共享状态在 `.veyra/state.json`。扩展 service worker 可从 `chrome://extensions` 的 Inspect views 打开；只检查本扩展，不采集其他对话。输入框有草稿或附件时会等待；缺边界、schema/身份不符、未知 DOM、跨页、审批暂停或不确定发送时不会猜测重试。先查看本地证据和当前对话，再决定重新绑定。取消未确认时在本机停止测试 daemon；不要重派一个可能已执行的任务。

12. **安全停止/卸载。** `Disable` 停止派发与回传，已经派发的 run 继续运行。`Stop / Cancel Run` 先停止桥接再请求取消，等待 Run 进入 terminal 状态；`Unpair` 还会撤销授权并清除本地 grant。最终执行 `bash "$PROOF_DIR/stop-daemon.sh"`，检查原终端退出、health 不再连接。在 `chrome://extensions` Disable 或 Remove 本扩展。浏览器关闭会清除 session storage，daemon 重启会使旧 grant 失效；单独卸载扩展不等于取消原生任务，所以先停止 daemon。保留 disposable 目录用于验收；确认不再需要后只删除该次明确的 `PROOF_DIR`，不要删除真实项目。

## 协议与隔离边界

- UI 默认 Disabled，绑定必须由用户明确选择 Project；一次只允许一个当前对话。切换/刷新/关闭目标页会暂停，不自动寻找其他对话。其他页面只看到“未绑定”，不会自动接收结果。
- 只有 **新完成 assistant 输出**中的一个完整 BEGIN/END handoff 区块参与处理。绑定时只记住已存在消息的 ID，既不扫描旧文本，也不采集其他 conversation。围栏语言标签不能代替明确边界；schema/来源/Project/新鲜 run UUID 不匹配均不能执行。只提取结构化 JSON，不把整条 GPT 回答发给 Codex。
- JSON 复用 [canonical handoff schema](../../docs/HANDOFF.md)：`version/kind/id/projectId/runId/provenance/context`，其中计划位于 `context.plan`，任务为 `{id,description}`，Project ID 是真实 UUID。扁平化产品示例不能替代该 schema。扩展会自动提供可直接填写的完整身份模板。
- Result 使用 canonical 执行结果，附加真实事件中的 bounded `verificationEvidence`、`workspaceDiff`，明确提示 GPT 作为 Reviewer 审查。Git diff 标注为读取时的工作区快照（可能含先前修改）；命名 diff Verifier 的输出才是持久化的运行检查证据。不读取 untracked 文件内容、父目录仓库或 `.veyra` / `.env*` diff。
- `VEYRA_REVIEW_BEGIN/END` 为 P0.14 保留结构化 verdict/findings/nextAction 边界。当前 review 本身不会派发；GPT 可另发有效 repair handoff，在本次 1–5 次总执行限额内自动处理，默认 3。P0.14 后续负责正式 review 持久化、最多三次默认 repair、no-progress detection、human decision 和完整循环 provenance。
- Pairing、grant、临时绑定和短期 Last Result 摘要仅在可信扩展 `chrome.storage.session` 中；DOM 不是长期状态。页面脚本拿不到 grant，不读取 ChatGPT cookie/token 或 Codex 凭证。只有 service worker 可访问固定本机 HTTP 地址；网页不能传入任意 URL、命令或 Project 根路径。
- Daemon 检查 Host、extension Origin/CORS、配对/撤销/到期、Project allowlist 和请求 schema；带 ChatGPT/恶意网页 Origin 的请求会被拒绝。无 Origin 也仍需本地授权。localhost 不是信任凭据，权限不能越过 Veyra/native 的 human approval gate。
- Canonical handoff 上限 64 KiB，网络响应 256 KiB，自动结果 JSON 128 KiB。超限或不确定传输时暂停，不能把截断当成功。没有任意文件读取、shell、审批、聊天历史或凭证接口。

阶段 B 真正通过后，按 TODO 顺序继续 P0.13 → P0.14 → P0.15；不要仅凭此开发夹具勾选产品闭环。
