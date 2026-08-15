# Bridge GPT 路由设计

## 固定入口

插件只向模型选择器注册一个虚拟路由：provider 为 `bridge-gpt`，model 为 `mix`，显示名称固定为 `Mix`。它声明支持文本和图片，但不自行持有 API 地址、协议参数或密钥；实际请求全部委托给“设置 → 模型”中已注册的模型。

Bridge GPT 设置只保存三个模型引用：

- 基础模型：处理纯文本请求，也接收识图结果并完成最终回复。
- 图片模型：必须在全局模型配置中声明 `image` 输入能力，处理所有图片像素。
- 意图识别模型：可选，只在工具已经返回图片后，根据工具名和参数生成更有针对性的识图问题。

意图模型不判断有没有图片。图片存在性由结构化 `image` content block 确定，因此不会出现“先调用意图模型，意图模型没识别出来，整条路由停止”的情况。

## 三条输入路径

`agent/pre-step` 只分析事件原始 `messages` payload 中的新图片。下游 listener 返回的 `decision.messages` 可能包含历史消息、压缩上下文或其他插件注入；这些消息只用于最终模型请求，不能作为新的视觉调用来源。图片分析上下文追加到下游 decision，工具返回图片则由 `tools/post-execute` 独立处理。

### 没有图片

`agent/pre-step` 扫描不到顶层图片时原样返回消息；`tools/post-execute` 扫描不到工具结果图片时原样接受结果。图片模型和意图模型都不会被调用，`Mix` 直接把文本安全消息委托给基础模型。

### 用户上传图片

`agent/pre-step` 在 proposed step 写入会话日志前读取 attachment，每张图片调用一次图片模型，并保留原始用户图片消息，随后追加一条来源为 `bridge-gpt` 的文字分析上下文。视觉预处理提示词要求图片模型先检查像素，再针对人物或虚构角色比较发型、服装、配饰、画风和可能出处，针对界面截图提取文字、布局、状态和异常区域；提示词和结果都记录在调用历史中。两条消息都由正常的 `user/message` 事件持久化。`Mix` 在委托基础模型时删除图片块，基础模型只接收用户文字和可重建的分析上下文。

### Agent 截图或工具返回图片

插件使用官方 `tools/post-execute` waterfall。它先调用 `next()` 获取下游最终 decision，再检查最终 model-facing content。只有内容中确实存在图片时才处理：可选意图模型生成问题，图片模型分析 attachment，结果作为 `additionalContexts` 附到这次工具结果之后。Agent loop 先记录工具结果，再记录分析上下文，下一步基础模型因此能看到页面内容。

这覆盖截图工具、浏览器工具以及 `read` 图片文件等返回 `image` block 的工具。`Mix` 还会递归清除 `tool-result.content` 中的图片，避免 DeepSeek 文本适配器收到嵌套图片并报 `UNSUPPORTED_CONTENT`。

## 会话级记录

每一次真实图片模型调用产生一条记录，来源为 `message`、`tool` 或 `tool-result`。记录包含会话 id、时间、完整输入提示词、attachment、图片模型、耗时、结果或错误。侧边栏只查询当前 `sessionId`，按日期分组并以时间倒序显示；记录卡片默认折叠为摘要，展开后才显示提示词、预览和完整结果，卡片列表在侧边栏内容区域内独立滚动。

## 扩展其他识图 API

编排层只依赖 `VisionBackend`。当前 `LlmVisionBackend` 通过 Harness 的 `ctx.llm.stream()` 调用全局模型注册表，所以新增识图服务的常规方式是在“设置 → 模型”增加 provider/model，并声明图片能力，而不是修改本插件。如果将来需要非 LLM 协议，可实现新的 `VisionBackend`，其余消息处理、工具 hook、会话记录和 Web UI 不变。

## 失败行为

用户图片识别失败会记录错误并拒绝该 proposed step，防止基础模型在没有图像信息时猜测。工具截图识别失败不会把原本成功的工具调用改成失败；插件记录错误并追加明确的分析失败上下文。取消信号始终向 attachment、意图模型和图片模型传播。
