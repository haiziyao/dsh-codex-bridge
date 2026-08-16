# Vision Mix

[![npm](https://img.shields.io/npm/v/dsh-vision-mix?color=cb3837)](https://www.npmjs.com/package/dsh-vision-mix)
![License](https://img.shields.io/badge/license-MIT-22a06b)
![DeepSeek Harness](https://img.shields.io/badge/DeepSeek_Harness-plugin-6f5cff)

Vision Mix 是 DeepSeek Harness 的视觉增强插件。它把文本模型、视觉模型和可选的图片生成 API 组合成一个 `Mix` 模型，让原本不支持图片的 Agent 能识别上传图片、理解网页截图、持续追问图片内容，并生成或编辑图片。

模型的 Base URL、协议和 API Key 仍由 DSH 的“设置 → 模型”统一管理。Vision Mix 只引用已经配置好的 Provider，不复制凭据。

## 三分钟上手

### 1. 安装

在 DeepSeek Harness 仓库目录执行：

```powershell
pnpm dsh plugin --profile web add dsh-vision-mix
```

启动 Web：

```powershell
pnpm dsh web
```

安装后的正常启动不需要 `--patch`。

### 2. 配置准备使用的模型

打开“设置 → 模型”，配置至少两个模型：

| 用途 | 要求 | 示例 |
|---|---|---|
| 基础模型 | 能处理文本、推理和工具调用 | `deepseek-chat`、`deepseek-v4-pro` |
| 识图模型 | 中转站实际支持 OpenAI/Anthropic 图片消息 | `gpt-5.6-sol`、其他视觉模型 |

识图和基础模型可以来自同一个 Provider，也可以分别使用不同中转站。

如果还要生成或编辑图片，再配置一个支持 OpenAI-compatible `/images/generations` 和 `/images/edits` 的 Provider。它可以使用与识图模型完全不同的 Base URL 和 API Key。

### 3. 检测并启用模型的图片能力

打开“设置 → Vision Mix”，页面最上方是“基础设置”，下方的“模型图片能力”专门用于检测和声明能力：

1. 从“待检测模型”选择刚才配置的视觉模型。
2. 点击“测试并启用 image”。
3. Vision Mix 会临时授予该模型 `image` 能力，发送一张红色测试图。
4. 模型正确识别红色后，Vision Mix 才会保存能力声明；失败会自动回滚。
5. 回到上方“基础设置”，由你自行在“图片模型”中选择该模型。

![Vision Mix 基础路由与模型图片能力设置](docs/settings-routing.png)

测试会产生一次很小的模型调用，但不会出现在聊天会话中。

### 4. 选择基础模型和可选能力

继续在“设置 → Vision Mix”完成：

1. 选择基础模型。
2. 在图片模型列表中选择刚才测试通过的模型。
3. 根据需要选择意图识别模型，用于判断“再详细一点”等模糊的跨轮图片追问。
4. 根据需要开启“自动识别 Agent 工具返回的截图或图片”。
5. 点击“保存路由”。

### 5. 开始使用

新建对话，在模型选择器中选择 `Mix`，然后尝试：

```text
上传一张图片：这张图里是什么？
下一轮追问：右下角还有什么？
让 Agent 截图：检查当前网页有没有布局问题。
```

`Mix` 是 Vision Mix 注册的固定模型入口，不是一个需要单独填写 API Key 的模型服务。

## 中转站模型图片能力说明

很多中转站的 `/models` 只返回模型 id，不会声明模型能否接受图片。DSH 会安全地把这类自定义模型视为纯文本模型；如果直接发送图片，请求会在本地被拒绝，并不会到达中转站。

Vision Mix 提供三种接入方式：

| 操作 | 是否调用 API | 结果 |
|---|---:|---|
| 测试图片能力 | 是 | 临时声明 `image`，发送红色测试图，结束后始终恢复原配置 |
| 强制启用 image | 否 | 直接保存 `input: [text, image]`，适合已经自行验证过的中转站 |
| 测试并启用 image | 是 | 正确识别红色才保存能力声明；失败自动回滚，推荐使用 |

能力操作只修改目标模型的输入能力声明，不会替你更换 Vision Mix 路由。启用成功后，模型会出现在上方“图片模型”列表中。测试和保存会保留模型原有的名称、上下文长度、输出长度及其他高级字段。配置写回原 Provider 的模型 profile，API Key 仍保存在 DSH 凭据系统中。

部署使用只读设置服务时，可以在 `settings.yaml` 中手工配置：

```yaml
- id: your-vision-model
  input:
    - text
    - image
```

DSH Web 模型编辑器会保留这个额外字段。

## 使用独立的图片生成 API

识图模型与图片生成模型不必来自同一个中转站。例如：

| 用途 | Provider | 模型 |
|---|---|---|
| 基础对话 | `chat-relay` | `deepseek-chat` |
| 图片识别 | `vision-relay` | `gpt-5.6-sol` |
| 图片生成与编辑 | `images-relay` | `gpt-image-2` |

配置步骤：

1. 在“设置 → 模型”分别创建识图 Provider 和 Images API Provider。
2. 在“模型图片能力”中测试并启用识图模型的 `image` 能力。
3. 在上方“基础设置”中选择识图模型。
4. 在“图片生成与编辑”选择 Images API Provider。
5. 点击“测试生图 API”。测试固定使用 `low`、`1024×1024`、PNG，会产生一次实际生图费用。
6. 看到测试图预览后点击“保存路由”。

生图测试只在内存中预览并校验结果，不会把测试图片永久写入 attachment 存储。

启用后 Agent 可以调用：

- `vision_mix_image_generate`：根据提示词生成新图片。
- `vision_mix_image_edit`：使用当前会话 attachment 编辑用户图片或上一张生成图。

生成结果会作为 DSH attachment 直接显示在对话中。后续可以继续要求“把刚才生成的图改成夜景”。

## Vision Mix 能做什么

- 用户上传图片后，先显示原始消息，再调用视觉模型分析。
- 文本基础模型读取识图结果后继续推理、回复和调用工具。
- 支持“这张图里还有什么”“再详细一点”等跨轮图片追问。
- 支持分析 Agent 截图、浏览器截图和读图工具返回的图片。
- 普通文本不会重新分析上一轮图片。
- 每一次真实识图调用产生一条独立的会话记录。
- 图片 attachment 保留稳定 id，可以在当前会话中重新读取像素。
- 支持 `gpt-image-2` 图片生成与编辑，并预留其他图片 API 后端接口。
- 识图、基础对话、意图判断和生图可以分别选择不同 Provider。

## 路由方式

| 当前输入 | 处理方式 |
|---|---|
| 普通文本 | 直接交给基础模型，不调用图片模型 |
| 新上传图片 | 图片模型读取像素，基础模型根据分析结果回答 |
| 明确追问最近图片 | 使用当前问题重新读取本会话最近的图片 |
| “再详细一点”等模糊追问 | 配置意图模型后，先判断是否需要重新读取图片 |
| Agent 截图或工具图片 | 分析工具真正返回的图片，再交给下一步 Agent |
| 工具没有返回图片 | 保持原工具结果，不触发识图 |
| 生成或编辑图片 | 调用独立 Images API，返回新的会话 attachment |

插件只处理当前步骤新进入的图片，不会扫描整段历史并重复调用视觉模型。

## 界面预览

### 模型与生图设置

![Vision Mix 生图设置页面](docs/generation-routing.png)

### 会话级识图记录

安装可选的 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 后，每次识图调用默认折叠显示；展开后可以查看完整提示词、图片预览、attachment id 和解析结果。

![会话级识图记录](docs/vision-history.png)

### 会话级生图记录

生图与编辑记录和识图记录分开，包含提示词、源图片、输出参数和生成结果。

![会话级生图记录](docs/generation-history.png)

侧边栏插件不是必需依赖。未安装时，Mix 路由、识图、跨轮追问、生图、对话图片显示和记录持久化仍然正常，只是不显示侧边栏入口。

## 图片 attachment 与隐私

- 插件不包含或持久化硬编码 API Key。
- 每个模型调用都通过所选 Provider 的 credential reference 重新解析凭据。
- 用户图片和生成图由 DSH attachment 服务验证和保存。
- 会话记录保存 attachment id，而不是宿主机器绝对路径或图片 base64。
- `vision_mix_attachment_query` 只能读取当前会话消息、工具结果或识图记录中出现过的附件。
- `vision_mix_image_edit` 只能编辑当前会话消息、工具结果、识图记录或生图记录中出现过的附件。
- 图片预览同时校验会话 id 和调用记录 id，不能跨会话枚举。
- 识图历史默认位于 `$DSH_HOME/vision-mix/v1/calls/`。
- 生图历史默认位于 `$DSH_HOME/vision-mix/v1/generations/`。

更完整的消息生命周期和失败行为见 [DESIGN.md](DESIGN.md)。

## 真实测试：根据设计稿开发网页

我们在 DSH Web 中让 `DeepSeek-V4-Pro` 和 `Mix` 接收相同提示词与同一张 1440×900 设计稿。

| DeepSeek-V4-Pro | Mix（基础模型仍为 DeepSeek-V4-Pro） |
|---|---|
| 提示当前模型不支持图片，Agent 未启动，生成 0 个文件 | 读取设计稿后生成 `index.html`、`styles.css`、`app.js`，并自行截图复查 |

| 参考设计稿 | Mix 单轮生成结果 |
|---|---|
| ![LumaBoard 参考设计稿](docs/benchmark-reference.png) | ![Mix 生成的 LumaBoard 页面](docs/benchmark-mix.png) |

Mix 用时 8分37秒、共 11 个 Agent 步骤。Vision Mix 完成初始识图、针对布局和排版的附件追问，以及成品截图复查。1440×900 下没有页面滚动、控制台错误或页面异常。

这个测试说明，同一个文本基础模型经过 Vision Mix 后，可以读取设计稿、按需重新查看像素并完成视觉自检。完整条件、提示词、资源消耗和生成源码见 [BENCHMARK.md](BENCHMARK.md)。

## 常见问题

### 安装后看不到 Mix

确认 `dsh-vision-mix` 已安装到当前 `web` profile，然后重新启动 `pnpm dsh web`。模型选择器中显示的是 `Mix`。

### 图片模型没有出现在“图片模型”列表

自定义中转模型默认可能只有 `text` 声明。在“模型图片能力”中选择它，点击“测试并启用 image”；测试成功后它会出现在上方图片模型列表，由你自行选择。

### 图片能力测试失败

依次检查：模型 id 是否正确、中转站是否接受图片消息、协议是否与中转站一致、API Key 是否可用。失败测试会恢复原模型配置，不会留下错误的 `image` 声明。

如果已经通过其他客户端确认该模型支持图片，可以使用“强制启用 image”；这个操作不会调用 API。

### 测试生图 API 失败

确认生图 Provider 实现 OpenAI-compatible `/images/generations`，并且当前账号有 `gpt-image-2` 权限。识图聊天接口可用不代表 Images API 一定可用。

### 后续追问会不会再次读取图片

明确引用图片时会。模糊追问需要配置意图识别模型；与图片无关的普通文本不会重新分析历史图片。

### 没有安装 dsh-better-sidebar 能否使用

可以。缺少的只有“识图记录”和“生图记录”入口，核心路由和对话图片显示不受影响。

## 从旧包迁移

如果安装过 0.1.x 的 `dsh-codex-bridge`，请先从当前 `web` profile 移除它，再安装 `dsh-vision-mix`，不要同时启用两个包。新包使用独立的 `vision-mix` 设置和记录目录，需要在“设置 → Vision Mix”重新选择路由。

## 开发

源码安装、本地调试、检查命令和发布流程见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## License

[MIT](LICENSE)
