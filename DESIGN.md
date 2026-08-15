# Vision Mix 路由设计

## 固定入口

插件只向模型选择器注册一个虚拟路由：provider 为 `vision-mix`，model 为 `mix`，显示名称固定为 `Mix`。它声明支持文本和图片，但不自行持有 API 地址、协议参数或密钥；实际请求全部委托给“设置 → 模型”中已注册的模型。

Vision Mix 设置保存三类对话模型引用和一个独立图片生成引用：

- 基础模型：处理纯文本请求，也接收识图结果并完成最终回复。
- 图片模型：必须在全局模型配置中声明 `image` 输入能力，处理所有图片像素。
- 意图识别模型：可选；工具返回图片后用它生成更有针对性的识图问题，文本追问没有明确写出“图片”时用它判断是否需要重新查看最近图片。
- 图片生成模型：可选；保存“设置 → 模型”中已有 Provider 与 Images API 模型 id，当前 Web 设置固定提供 `gpt-image-2`，不把它注册为聊天模型。

新上传图片和工具图片的存在性始终由结构化 `image` content block 确定，不依赖意图模型。意图模型只处理会话里已经有成功识图记录、当前轮没有新图片的模糊追问；明确提到“这张图片”“previous screenshot”等文本不需要调用意图模型。

## 中转站图片能力接入

`llm-pi-ai` 对手工声明且没有 `input` 的模型默认只授予 `text`，因此 Adapter 会在网络请求前拒绝图片。Vision Mix 的设置页从完整模型目录选择候选路由，并提供三种配置操作。测试操作临时把目标模型的 `input` 改为 `['text', 'image']`，通过正常 `ctx.llm.stream()` 发送一张已知为红色的 attachment，并要求模型识别颜色；测试结束后恢复原设置。强制启用不发送请求，直接持久化能力声明并选择该图片模型。自动配置在测试成功后保留声明并选择模型，测试或选择失败时恢复原设置。

显式 `models` 数组通过替换保留所有现有模型字段；使用 Provider 内置目录的路由则写入 `modelOverrides[model].input`，不会用单个模型替换完整目录。每次设置修改使用 revision fence。回滚前重新读取当前值，只有它仍等于测试写入值时才恢复，避免覆盖测试期间发生的其他配置修改。同一 provider/model 的接入操作串行执行。

图片能力测试是配置操作，不属于聊天会话，不生成用户消息或识图历史。测试图通过 Harness attachment 服务校验和内容寻址；模型必须返回红色语义才算通过，仅接受 HTTP 请求但忽略图片的中转站不会被自动启用。

## 三条输入路径

`agent/pre-step` 只登记事件原始 `messages` payload 中本次真正进入步骤的用户消息，不等待图片模型。下游 listener 返回的 `decision.messages` 可能包含历史消息、压缩上下文或其他插件注入；这些消息不能作为新的视觉调用来源。原始用户消息先由 Agent loop 写入会话，因此聊天界面立即显示。随后 `Mix` 执行一个不调用基础模型的预处理步骤，把分析上下文 steering 到下一步骤；该上下文通过正常的 `user/message` 事件持久化后，基础模型才开始回复。工具返回图片仍由 `tools/post-execute` 独立处理。

### 没有图片

当前用户消息没有图片、会话也没有成功识图记录时，`Mix` 直接把文本安全消息委托给基础模型。会话存在识图记录时，明确引用最近图片的追问会用当前问题重新调用一次图片模型；模糊的“再详细一点”等追问由可选意图模型判断。判断为普通文本时仍直接调用基础模型。`tools/post-execute` 扫描不到工具结果图片时原样接受结果。

### 用户上传图片

原始用户图片消息先进入 proposed step 并写入会话日志。`Mix` 随后读取 attachment，每张新图片只调用一次图片模型，并把来源为 `vision-mix` 的文字分析上下文放入下一步骤。视觉预处理提示词要求图片模型先检查像素，再针对人物或虚构角色比较发型、服装、配饰、画风和可能出处，针对界面截图提取文字、布局、状态和异常区域；提示词和结果都记录在调用历史中。原始消息和分析上下文都由正常的 `user/message` 事件持久化。`Mix` 在下一步骤委托基础模型时删除图片块，基础模型只接收用户文字和可重建的分析上下文。

后续文本追问不会再次扫描历史消息中的图片块。只有追问明确或经意图模型判断指向最近图片时，插件才从本会话的成功识图记录中取回最近 attachment，用新问题产生一条新的调用记录和分析上下文。这既保留跨轮看图能力，也不会让普通下一轮对话重复分析旧图片。

### Agent 截图或工具返回图片

插件使用官方 `tools/post-execute` waterfall。它先调用 `next()` 获取下游最终 decision，再检查最终 model-facing content。只有内容中确实存在图片时才处理：可选意图模型生成问题，图片模型分析 attachment，结果作为 `additionalContexts` 附到这次工具结果之后。Agent loop 先记录工具结果，再记录分析上下文，下一步基础模型因此能看到页面内容。

这覆盖截图工具、浏览器工具以及 `read` 图片文件等返回 `image` block 的工具。`Mix` 还会递归清除 `tool-result.content` 中的图片，避免 DeepSeek 文本适配器收到嵌套图片并报 `UNSUPPORTED_CONTENT`。

## 图片生成与编辑

`ctx.llm` 只承载聊天流，OpenAI Images API 不是聊天模型，因此图片生成不通过 `LlmAdapter`。插件提供独立的 `ImageGenerationBackend` 接口，当前 `OpenAiImageBackend` 实现 `POST /images/generations` 和 multipart `POST /images/edits`。设置变更后只重建后端路由；每次操作都会重新读取所选 Provider 的 settings profile，并通过该 profile 的 credential reference 重新解析凭据，因此 Base URL、headers 或密钥变更可以在下一次调用生效。

`vision_mix_image_generate` 接收提示词和可选尺寸、质量、格式。`vision_mix_image_edit` 还接收一个 attachment id，并只允许当前会话识图历史中的附件或当前会话成功生图记录的输出附件。后端返回 base64 后立即解码为 bytes，并交给 Harness attachment 服务校验媒体类型、尺寸和持久化。工具的结构化结果只保存 attachment metadata，`render()` 返回相邻的文字块和 `image` block，因此生成图会进入正常的 `tool/result` 会话事件并由官方 UI 渲染。

生成工具的图片结果不会再次进入 `tools/post-execute` 自动识图，避免同一操作同时产生生图记录和非必要识图记录。Mix 文本基础模型看到的是生成结果的 attachment 引用；后续编辑可复用该引用，不需要把 base64 放入模型上下文。

## 会话级记录

每一次真实图片模型调用产生一条记录，来源为 `message`、`tool` 或 `tool-result`；针对最近图片的后续追问也会产生一条使用新提示词的 `message` 记录。记录包含会话 id、时间、完整输入提示词、attachment、图片模型、耗时、结果或错误。侧边栏只查询当前 `sessionId`，按日期分组并以时间倒序显示；记录卡片默认折叠为摘要，展开后才显示提示词、预览和完整结果，卡片列表在侧边栏内容区域内独立滚动。

生图与编辑使用独立的 `$DSH_HOME/vision-mix/v1/generations/` JSONL 记录，不修改识图记录格式。每条记录包含操作类型、后端、模型、提示词、源附件、输出参数、耗时以及输出 attachment 或错误。Web 路由使用 `sessionId + generationId` 查找预览，不能仅凭 attachment id 跨会话读取。

## 附件定位

用户上传图片以 `ImageAttachmentRef` 进入会话：`attachmentId` 是内容寻址的 `sha256:` opaque id，旁边带经过验证的媒体类型、字节数、宽高和可选原文件名。原始 `user/message` 持久化这个结构化引用。`Mix` 向文本基础模型映射图片块时不会再静默删除，而是替换为 `<image-attachment>` 文本，包含 attachment id、`dsh-attachment://` 逻辑定位符及元数据；识图后的 `<img-caption>` 也重复同一身份并明确说明视觉后端已经读取真实附件字节。

物理路径不属于引用协议。默认 local provider 位于 `<DSH_HOME>/attachments/v1/objects/`，但会话不持久化该路径，避免泄露宿主布局或在 home 迁移、远程 provider 下留下失效地址。侧边栏从调用记录解析 attachment metadata，并额外显示会话和 call 双重授权的预览 URL。`vision_mix_attachment_query` 只在当前会话的调用记录中按 attachment id 查找引用，因此模型可以再次读取像素而不能越权枚举其他会话附件。

## 扩展其他识图 API

编排层只依赖 `VisionBackend`。当前 `LlmVisionBackend` 通过 Harness 的 `ctx.llm.stream()` 调用全局模型注册表，所以新增识图服务的常规方式是在“设置 → 模型”增加 provider/model，并声明图片能力，而不是修改本插件。如果将来需要非 LLM 协议，可实现新的 `VisionBackend`，其余消息处理、工具 hook、会话记录和 Web UI 不变。

图片生成编排层只依赖 `ImageGenerationBackend`。其他服务可以实现同一 `generate()` / `edit()` 接口并复用 attachment 持久化、工具输出和会话记录；Provider 密钥解析属于具体后端，不进入通用请求对象。

设置页的生图 API 测试独立接收 `generationModel` 路由，固定发送 low / 1024×1024 / PNG 请求，并通过 attachment 服务验证返回图片。识图接入不读取或修改该路由；生图测试也不读取或修改 `imageModel`，所以两者可以使用完全不同的 Provider、Base URL、headers 和 credential reference。

## 失败行为

用户图片识别失败会记录错误，并把明确的分析失败上下文放入下一步骤，防止基础模型假装看到了图片。工具截图识别失败不会把原本成功的工具调用改成失败；插件同样记录错误并追加失败上下文。取消信号始终向 attachment、意图模型和图片模型传播。

生图或编辑失败会记录错误并让对应工具调用失败，不会创建伪造的 attachment。HTTP 非成功状态、无数据、非法 JSON、无效 base64、缺失 Provider、缺失 credential reference 和缺失 credential 都会明确报错；取消信号传递到 Images API fetch。
