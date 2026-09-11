# Experimental ChatGPT Web Bridge for Pro — P0.12

独立、私有的 Manifest V3 扩展，只支持 **Chrome/Chromium + `https://chatgpt.com`**。默认通过 Chrome Native Messaging 连接本机 Veyra coordinator；loopback HTTP 保留为开发/诊断 fallback。原生 Codex 使用已有登录；API Provider 为 optional，核心流程无需 `OPENAI_API_KEY`。不使用 Cloudflare、ngrok、公网服务器或 ChatGPT 隐藏后端 API。

保留的 [`apps/chatgpt-bridge`](../chatgpt-bridge/README.md) 是 **preferred future official Full MCP production path**。官方 Pro 权限资料存在差异，证据和当前产品决策见 [ADR 001](../../docs/ADR-001-CHATGPT-BRIDGE.md)。浏览器桥接是可替换的实验路径，DOM 变化可能使其暂停。Project `.veyra/` 是唯一工程共享状态中心；不读取完整 ChatGPT history、其他 conversation 或任何登录凭证。

## Native Messaging 产品流程

**Setup once. Bind once. Then just talk.** 交互事实来源是 [UX-FLOW](../../docs/UX-FLOW.md)。

首次运行 `ve setup`。它自动寻找 PATH 或已安装 Codex/ChatGPT app 中的原生 Codex，通过版本和 login status 检查 readiness，注册本机 host 并验证 coordinator 可启动。不读取凭证文件，也不需要 API Key。尚未发布时，在已构建仓库中使用 `pnpm ve -- setup`。首次安装仍由用户在 `chrome://extensions` 开启 Developer Mode，Load unpacked 加载 setup 输出的目录；未发生 native handshake 时，setup 如实显示等待扩展连接。

扩展随 CLI 打包于 `apps/cli/dist/browser-extension/`；源码构建目录 `apps/chatgpt-extension/dist/` 内容相同。已安装旧开发扩展可继续使用原目录，更新后点击 Reload，再刷新 ChatGPT 页即可，不必每天 Reload。仅 macOS/Linux 的 Chrome/Chromium 受支持；不会修改或使用其他浏览器账号。

每个真实项目只需在项目目录运行 `ve init`。它保留已有 `veyra.yaml` 与 executor 设置，注册 Project，自动绑定 native Codex；新配置只生成 executor 与从 package.json 识别的 test/build/check/lint 验证项。已有项目可直接使用，不需要 `PROOF_DIR`。从源码使用时，在目标项目目录执行 `node /absolute/path/to/veyra/apps/cli/dist/index.js init`。

日常打开**已有的** ChatGPT conversation → Veyra Popup → **Open Veyra** → 在 Side Panel 选择 Project → **Bind conversation**。确保输入框为空、无附件且 GPT 已停止生成；binding 消息确认后，直接提出目标，例如：“请给这个项目增加一个有测试覆盖的小功能，并运行已提供的 test/build 检查；根据返回的真实证据 Review。”不需要输入或复制 handoff JSON。

同一个 conversation 刷新后自动恢复安全的绑定，不再发送 binding 消息。Pause 会保留绑定；Resume 只恢复已确认的安全暂停。Unbind 立即移除会话路由并请求取消 active run。未确认的发送、过期/撤销授权、路径变更和审批都显示 Needs attention，不自动重发或绕过审批。P0.12 仍保留每个绑定最多 1–5 次派发（默认 3）的诊断安全预算；它不是 P0.14 的正式自动 review/fix 策略。

主界面已经是 Chrome Side Panel，详见 [DESIGN](../../docs/DESIGN.md)。它只在 chatgpt.com 启用，适配 320–460px，展示当前 Project、Plan / Execute / Verify / Review、Pause / Unbind 和运行详情。Popup 只保留状态、Open Veyra、Project 和 Diagnostics 快捷入口。机器消息折叠为 Project bound / Plan sent to Codex / Result returned，可展开原始协议；Verification 和执行状态来自真实 Project 证据。运行详情可 Cancel，并在 Native 模式下打开同一 Project 的 Local Control Center。原始状态、UUID、传输、手动刷新和 HTTP fallback 保留在 Diagnostics。

Host 只允许固定扩展 ID `meibodpmcjcjdpfaaejdpiclijnpcclh`，不接受网站对 Native Messaging 的直接调用。安装状态位于 `~/.veyra/browser/installation.json`（自定义 registry 时随 registry）；只保存本机安装身份、Project ID/root 授权与握手时间，不保存账号凭证。显式 Bind 建立最长一年的项目授权；`ve setup --revoke` 撤销所有旧 grant 并轮换身份，旧绑定失效。Unbind 仅删除该会话路由，不撤销其他会话使用的 Project grant。

Native port 空闲 5 秒自动关闭，下次操作重连；独立 coordinator 无 active run/操作 60 秒后退出。运行中关闭 Chrome 不会杀掉 Codex。稳定 idle 无周期性计时器；有事件才产生 debounce，有 active run 才退避查询。日志见 Diagnostics、Project `.veyra/runs/` 和 `~/.veyra/daemon/daemon.jsonl`。Native Host 启动/协议错误可在扩展 Service Worker console 查看；其 stdout 仅用于 framing，不输出私密日志。

后台被 Chrome 回收后，第一次状态请求会自动重新检查本机连接、原绑定身份和 Codex readiness；内存缓存丢失不再直接显示“断开”。握手或只读查询遇到端口中断时，等待 200ms 后最多恢复一次，查询恢复还要核对同一本机安装身份。授权变化、无效回复、超时和已发出的执行/取消请求仍明确报错，不自动重发。没有新事件或运行时，不产生定时重连或保活。

页面复用“停止生成”控件、只修改属性时，也会重新检查新回答是否完成。仍然要求正常完成工具栏、400ms 稳定期、明确协议边界、schema 和绑定身份匹配；不会扫描旧回答或把普通文字派发给 Codex。

真实页面的回答容器同时支持 `data-testid="conversation-turn-…"`（当前为 `section`）和旧 `article`。完成工具栏必须属于该回答；不能借用上一条/相邻回答的按钮，也不能把未知的共同父容器当作回答边界。测试布局只保留观察到的结构，不包含真实聊天记录。

**2026-09-10 独立验证失败分支复验：** 最新真实任务已完成 Codex 执行并回传；问题在于执行器报告失败后，工作流跳过了 Veyra 的全部验证。修复后，普通执行/检查失败仍会继续收集本地配置的其他检查，结果保留真实失败；取消、超时、人工审批和进程清理异常仍会停止。执行器会收到准确的本地检查命令，不能把检查 ID 当成 npm 脚本名。

这次只更新本机组件，无需 Reload、重新绑定或重发旧任务。保留当前绑定，在原对话提出新的只读验收请求。当前 `veyra-pro-proof` 故意包含 `BROKEN`，正确预期是：**测试失败、构建通过、差异检查通过，且三项都有实际证据**。测试失败与桥接故障不同；修复源文件需要用户另发明确任务。不要修改或补写旧失败结果，也不要自动跳过 `HUMAN_DECISION`。两个独立一次性项目的真实 Native Codex 失败/成功证据已验证；真实 ChatGPT 同对话验收仍待用户确认。

**2026-09-10 原生连接与超时修复复验：** 此前真实记录已证明任务下发、Codex 会话创建、失败结果自动回到同一对话，以及 ChatGPT 的人工决策审查。当时失败发生在 Codex 网络连接阶段，三项验证尚未执行。本机 Host 现在会在没有显式代理环境变量时，复用 macOS 已启用的静态 HTTP/HTTPS 代理；保留本机绕过规则，不读取代理密码、不执行 PAC、不修改系统或 Codex 配置。原生执行上限为 15 分钟，验证命令仍有独立时限。真实无工具连接探测已通过。

这次只更新本机组件；旧 coordinator 空闲退出后，下次请求自动使用已构建的新版本。**保留当前对话与 Project 绑定，直接提出一次新的只读验收请求**，由 ChatGPT 生成新的任务单/Run ID。无需 Reload 扩展、重新绑定或 setup。不要重发旧任务单，也不要自动越过已返回的 `HUMAN_DECISION`；失败记录继续保存在 Project `.veyra/`。

**2026-09-10 页面接收端修复复验：** 针对“找不到消息接收端”的未绑定状态，先在 `chrome://extensions` 重新加载已构建的 Veyra，回到原 ChatGPT 对话，选择原 Project 并点击“绑定当前对话”。该按钮现在会按需修复当前主文档的接收端，旧页面无需先刷新；成功后应只出现一条新绑定消息。保持输入框为空、无附件且 GPT 已停止生成，再提出新的只读验收任务。旧任务单不会被重新扫描或执行。已有安全绑定仍可通过刷新原页面恢复；本次没有新增后台保活或对全部标签页的批量注入。

恢复只允许重试只读的页面准备握手一次。Chrome 的主文档 ID、当前标签页、明确 conversation 和页面内临时目标检查共同防止刷新/导航后误连；权限不足、目标变化或再次失败会直接显示中文/英文处理办法。绑定消息、派发和结果回传都不重试。接收端只初始化一次，失效实例的观察器/计时器会清理；“恢复”失败保留用户暂停状态。站点权限与 human approval gate 保持有效，新增 `scripting` 权限只用于此已授权当前页面的连接恢复。

**2026-09-10 任务识别与模板修复复验：** 这次更新还补齐了发给 ChatGPT 的计划模板和字段说明。重新加载扩展、刷新原对话后，先核对没有进行中的任务，再在原项目上解除绑定并绑定一次，让 ChatGPT 收到新说明；这个步骤只为更新旧对话里的协议说明，不是日常操作。随后发送普通的只读验收请求。不要重发旧 JSON。`requestedVerification` 必须在最外层，`context.currentTask` 必须是计划任务 ID 字符串，`context.decisions` 必须是决策对象数组或空数组。格式错误会暂停并在 Diagnostics 给出中文/英文原因，不会自动修正、执行或重发。

**断线修复的独立复验（不涉及模板更新时）：** 已完成本机设置并保持启用绑定的用户，只需在 `chrome://extensions` 重新加载 Veyra，然后刷新**原来的 ChatGPT 对话**。不需要重跑 setup/init、重新配对或重新绑定。确认项目与对话绑定恢复，闲置超过一分钟，再通过该对话提出验收任务，检查自动唤醒、执行和同会话结果回传。刷新前后均保留 Project 证据；若之前的发送/执行未确认，绑定仍会暂停，需先检查证据，旧任务不会自动重发。当前真实 Pro 验收仍未通过，不能用测试夹具代替。

安全停止：Pause 停止自动派发/回传；Diagnostics → Cancel Run 取消当前运行；Unbind 删除该对话绑定；在 `chrome://extensions` 禁用/移除扩展停止浏览器桥接。需要全机撤销时执行 `ve setup --revoke`。保留 `.veyra/` 证据；高级 `ve daemon stop` 仍可用于显式停止 coordinator。

首次安装的真实 Pro 验收从“加载扩展 → ve setup → 在目标 test Project 内 ve init → 明确选择项目 Bind”开始；已有 HTTP grant 可在 Diagnostics 中切换到 Native Messaging（先暂停旧绑定）。检查 binding 只出现一次、刷新不再重发、目标 handoff 触发原生 Codex、结果自动返回**同一** conversation，以及失败、Cancel、闲置性能。这个人工门槛仍未通过，下面的脚本夹具不能替代它。

## 首次使用或从 HTTP 迁移：完整验收

GUI-1–GUI-6 已实现 Side Panel 和 Local Control Center。遇到接收端错误的已有安装按上面的“页面接收端修复复验”更新即可；以下完整步骤用于首次安装或 HTTP 迁移。**真实 ChatGPT Pro 复验尚未通过**，开发截图不代替它。

1. 在原绑定对话中检查是否有 active run。有则先 Cancel 并核对终态；保留 Project 证据。更新后如仍显示旧 HTTP 绑定，先 Unbind 再切换传输，避免把旧运行路由到新的 registry。
2. 在本仓库执行 `pnpm ve -- setup`。它注册本机 Native Host，自动检查 Codex 登录和 coordinator；不需要手动 daemon、localhost、pairing JSON 或 API Key。此步骤是一次性机器接入，不是每天的操作。
3. 在**原 disposable `veyra-pro-proof` 项目根目录**执行 `node /absolute/path/to/veyra/apps/cli/dist/index.js init`，把它注册到默认本机 registry。保留原文件和原验证配置；不要对正在运行的生产项目做 proof。如果原来的临时目录已丢失，先按下文 `prepare:live` 准备新项目，再执行 `ve project add <project.root>` 注册它，避免改变夹具的受保护文件。新项目必须重新明确绑定；不要沿用旧身份、补造旧证据或重放旧任务。
4. Chrome `chrome://extensions` → Veyra → **Reload**，然后刷新原目标 ChatGPT 对话。继续使用已加载的 `apps/chatgpt-extension/dist/` 即可；不必改为另一个目录或重复安装。首次加载可使用 setup 输出的 `apps/cli/dist/browser-extension/`，两者包含同样构建产物。
5. 打开 Veyra → **Open Veyra** 进入 Side Panel。若 Diagnostics 中仍为 HTTP，先 Unbind 旧绑定，再点 **使用 Native Messaging**；项目列表自动刷新。明确选择 `veyra-pro-proof`，核对路径，保持 composer 为空、无附件、GPT 未生成，点击 **Bind**。
6. 先确认 binding 消息仅发送一次、ChatGPT 正常回复，界面仍为 Ready 且当前 Project 正确。刷新该对话，确认绑定恢复、binding 消息未重发，然后自然提出验收任务。可直接使用下面的测试提示词；这是用户任务，不是复制 GPT/Codex 的输出。

   ```text
   请验收当前已绑定的 disposable Project。先让 Codex 只检查不修改，并运行已有 test/build/diff 检查，确认失败结果能自动返回。根据真实 Verification Evidence 和 Diff Review 后，发起 repair，只修改 src/message.js，让 message() 返回精确字符串 Hello from the Veyra fixture。保留 tests、scripts、配置与 .veyra 证据，重跑相同检查。使用 Veyra 刚提供的 canonical handoff 身份和明确 BEGIN/END 边界，不读取凭证、不提交、不发布、不部署。只在证据真实通过时给 PASS。
   ```

7. 应看到 Working → Result returned，自动回传消息出现在**同一个** conversation，并由 ChatGPT 继续 Review。Diagnostics 的 Last Result 应是 `confirmed`；本地 completed 或 Send click 都不能代替它。再验证 Cancel 和闲置性能。若不确定，Pause 并检查当前消息/Project 证据，不重复派发。

日志和停止方式见上面的 Native Messaging 产品流程。可记录两次 Run ID、成功/失败的 verifier 状态及同会话回传确认；无需导出聊天历史、cookie 或 native 凭证。GUI 视觉 Review 与真实 Pro 复验均通过后，再按 TODO 推进 P0.13；本次 GUI 实现结束即停止。

## 阶段 A：开发者可独立运行

从仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @veyraoss/chatgpt-extension test
pnpm --filter @veyraoss/daemon test
pnpm --filter @veyraoss/chatgpt-extension smoke:browser
pnpm --filter @veyraoss/chatgpt-extension smoke:native-browser
pnpm lint
pnpm format:check
pnpm check
pnpm test
pnpm build
```

`smoke:browser` 使用已安装的 Playwright Chromium；可通过 `CHROMIUM_EXECUTABLE=/absolute/path/to/chromium` 指定已有兼容可执行文件。需要时可运行 `pnpm --filter @veyraoss/chatgpt-extension exec playwright install chromium` 安装测试浏览器；不需要安装到用户个人 Chrome。

夹具加载真实构建的 MV3 扩展，使用独立临时浏览器 profile，用本地 DOM 模拟 `chatgpt.com`，并阻止公网请求。模拟 executor 修改 disposable Project，真实 daemon/Verifier 先失败再通过，检查两次结构化结果自动回到同一夹具对话、状态展示、配对及撤销；结束时清理其浏览器、daemon、profile。它**不是**真实 ChatGPT Pro / native Codex 账号验收。

## 发送确认与空闲性能

发送前仍要求当前 tab/conversation/binding 一致、输入框为空、无附件、GPT 未生成。插入后检查本次唯一 marker、完整 BEGIN/END 和归一化正文；允许段落、div、BR、NBSP 和连续空行的合法转换，不忽略正文字符或词间分隔。发送期间的真实键盘、输入、粘贴、剪切、拖放及 IME 输入会中止自动确认。

最终证明是当前 conversation 中**新出现的、携带本次 marker 和完整内容的 user message**。即使 ChatGPT 已清空或替换 composer 并开始回复，也会识别该证明，不再次点击 Send。旧消息、assistant 回声或 click 本身均不算成功；不确定时暂停，不自动重发，Project/run 证据保留。

页面使用 MutationObserver，只追踪绑定后新增的 assistant turn。完成工具栏出现且输出稳定 400ms 后才提取 handoff；不周期性扫描整段 conversation，不读取旧 turn 的正文。Run 执行期间使用 1/2/4/8/15 秒有上限的退避查询，状态变化时加快一次；结束、停止或解除绑定后清除。当前 HTTP `runs.get` 会读取事件，因此 popup 不再另外周期性调用它，也不在后台定时探测 Codex readiness。此 P0 修复复用现有 daemon API，没有新增浏览器业务到 Daemon。

Popup / Side Panel 仅在打开、用户操作和 storage/tab/focus 事件时更新；事件刷新读取本地状态快照，不发 daemon 请求，100ms 合并突发事件。隐藏时停止刷新，关闭后清除监听和待处理刷新。Side Panel 只在绑定或运行证据身份改变时请求一次 bounded evidence；稳定 idle 不重复 render。连接/readiness 是上次检测结果，打开时自动连接；Diagnostics → Refresh diagnostics 可重新检测；派发前仍由 daemon 检查授权和 native readiness。

**稳定 idle 没有周期性 timer。** 仅发生事件时短暂存在 400ms turn debounce 或 100ms popup debounce；实际发送期间有一个 3 秒按钮等待或 10 秒 echo 确认截止 timer；active run 有一个退避 timer。单元测试覆盖大 DOM、60 秒虚拟空闲、mutation burst、active run 和 popup open/closed；`smoke:browser` 另外执行真实 Chromium DOM/可信用户输入测试及 3,000 个旧 turn 的 60 秒墙钟空闲测量。

## 历史 HTTP fallback：send-confirmation 修复复验

1. 若有未结束的 Run，先检查本地证据并 Stop / Cancel；不重派可能已执行的任务。保留当前 conversation 中已有的 binding 消息和原 disposable Project。
2. 构建后在 `chrome://extensions` 对 Veyra 点击 **Reload**，再刷新目标 ChatGPT 页以替换旧 content script。仅 Reload 不会替换已注入页面的旧脚本。
3. 检测 daemon 并核对 `veyra-pro-proof` 的原路径。若 grant 仍有效则复用；若配对丢失、过期或失效，按下面第 4–6 步重启专用测试 daemon，消费新邀请明确配对，不复制旧邀请或登录凭证。
4. 等 GPT 回复结束，确认 composer 为空且无附件，在**当前目标 conversation** 明确选择 Project 并重新绑定。这是用户发起的新绑定，使用新 marker；扩展不会重放旧的不确定发送。
5. 先验证新 binding user message 仅出现一次、ChatGPT 正常回复、popup 显示 Enabled 和正确的 Project。此项通过后从下面第 8 步继续原 P0.12 真实 handoff/result 验收。观察无新输出、无 Run 时是否仍卡顿，以及执行期间、popup 打开/关闭后的表现。

本次测试不会把 P0.12 自动标成完成；修复后的真实 Pro 复验仍是必需项，P0.13 暂不开始。

## HTTP fallback 阶段 B：开发者诊断验收

以下操作只在开发验证完成后由用户进行。不要把模拟页面当成通过；P0.12 在真实安装、授权和自动回传证据齐备前保持未完成。

1. **构建产物与加载目录。** 在仓库根目录运行 `pnpm build`。产物是 `apps/chatgpt-extension/dist/`，包含 `manifest.json`、`background.js`、`content.js`、`popup.js`、`popup.html`、`popup.css`。Chrome 加载 **dist 目录本身**，不是仓库根目录、源码目录或单个文件。用 `pwd` 获得仓库绝对路径后加上 `/apps/chatgpt-extension/dist`。

2. **安装到 Chrome。** 打开 `chrome://extensions`，开启 Developer Mode，选择 Load unpacked，加载上述目录，按 Chrome 提示授权。固定扩展 ID 应为 `meibodpmcjcjdpfaaejdpiclijnpcclh`。public manifest key 只是稳定标识，不是密钥。将 Veyra 固定到工具栏便于观察。更新构建后，在此页点击 Reload，再刷新目标 ChatGPT 页面并重新绑定。

3. **准备专用 disposable Project。** 从仓库根目录执行下面命令。它只在 `~/Projects/veyra-proofs/` 下新建独立目录，供跨天实机验收保留证据；不再存放于系统临时目录。它不接受已有项目作为覆盖目标，不安装依赖，不启动 Codex 模型，不改真实项目。复用已有 greeting fixture，创建本地 Git baseline，注册独立 registry，绑定 native Codex，配置可信的 test/build/diff 检查，并生成启动/停止脚本。把返回的 `directory` 赋给本终端变量 `PROOF_DIR`（例如 `PROOF_DIR='/返回的完整目录'`）；`project.root` 是应该选择的项目目录，名称为 `veyra-pro-proof`。这里只是开发者的 HTTP fallback 诊断；普通 Native Messaging 使用流程不需要这些脚本或变量。

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

- 未绑定页面默认禁用自动执行，Project 必须由用户明确选择。一次仅一个 tab 拥有 live binding；切换/关闭会解除页面附着，不自动寻找其他对话。Native 模式仅为完全相同的 conversation 恢复已确认安全的持久绑定；HTTP fallback 保留临时会话行为。不确定的派发/回传和用户 Pause 不自动重放。
- 只有 **新完成 assistant 输出**中的一个完整 BEGIN/END handoff 区块参与处理。绑定时只记住已存在消息的 ID，既不扫描旧文本，也不采集其他 conversation。围栏语言标签不能代替明确边界；schema/来源/Project/新鲜 run UUID 不匹配均不能执行。只提取结构化 JSON，不把整条 GPT 回答发给 Codex。
- JSON 复用 [canonical handoff schema](../../docs/HANDOFF.md)：`version/kind/id/projectId/runId/provenance/context`，其中计划位于 `context.plan`，任务为 `{id,description}`，Project ID 是真实 UUID。扁平化产品示例不能替代该 schema。扩展会自动提供可直接填写的完整身份模板。
- Result 使用 canonical 执行结果，附加真实事件中的 bounded `verificationEvidence`、`workspaceDiff`，明确提示 GPT 作为 Reviewer 审查。Git diff 标注为读取时的工作区快照（可能含先前修改）；命名 diff Verifier 的输出才是持久化的运行检查证据。不读取 untracked 文件内容、父目录仓库或 `.veyra` / `.env*` diff。
- `VEYRA_REVIEW_BEGIN/END` 为 P0.14 保留结构化 verdict/findings/nextAction 边界。当前 review 本身不会派发；GPT 可另发有效 repair handoff，在本次 1–5 次总执行限额内自动处理，默认 3。P0.14 后续负责正式 review 持久化、最多三次默认 repair、no-progress detection、human decision 和完整循环 provenance。
- HTTP pairing/grant、临时绑定和短期 Result body 仅在可信扩展 `chrome.storage.session` 中；Native 持久绑定只在可信 `chrome.storage.local` 保存路由/一次性意图元数据，工程证据仍在 Project。DOM 不是长期状态。页面脚本拿不到 grant，不读取 ChatGPT cookie/token 或 Codex 凭证。只有 service worker 可访问固定本机 HTTP 地址；网页不能传入任意 URL、命令或 Project 根路径。
- Daemon 检查 Host、extension Origin/CORS、配对/撤销/到期、Project allowlist 和请求 schema；带 ChatGPT/恶意网页 Origin 的请求会被拒绝。无 Origin 也仍需本地授权。localhost 不是信任凭据，权限不能越过 Veyra/native 的 human approval gate。
- Canonical handoff 上限 64 KiB，网络响应 256 KiB，自动结果 JSON 128 KiB。超限或不确定传输时暂停，不能把截断当成功。没有任意文件读取、shell、审批、聊天历史或凭证接口。

本次 GUI phases 完成后停止，等待用户第一次视觉 Review。P0.12 阶段 B 的真实 Pro 证据仍是后续 P0.13 → P0.14 → P0.15 的前提，不凭开发夹具勾选产品闭环。截图、启动方式和 GUI 验证见 [GUI acceptance](../../docs/GUI-ACCEPTANCE.md)。
