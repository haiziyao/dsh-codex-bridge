# DSH Codex Bridge

[![npm](https://img.shields.io/npm/v/dsh-codex-bridge?color=cb3837)](https://www.npmjs.com/package/dsh-codex-bridge)
![License](https://img.shields.io/badge/license-MIT-22a06b)
![DeepSeek Harness](https://img.shields.io/badge/DeepSeek_Harness-plugin-6f5cff)

让不支持图片输入的基础模型通过视觉模型看图，并继续完成对话、推理和工具调用。

这个项目中的三个名称分别表示：

- `dsh-codex-bridge`：安装使用的 npm 包名。
- `Bridge GPT`：Web 设置中的插件名称。
- `Mix`：插件注册到模型选择器中的固定模型名称。

模型的 API 地址、协议和密钥仍由 DeepSeek Harness 的“设置 → 模型”统一管理。Bridge GPT 只引用已经配置好的模型，不重复保存凭据。

## 界面预览

在 Bridge GPT 设置中选择基础模型、图片模型和可选的意图识别模型：

![Bridge GPT 设置页面](docs/settings-preview.svg)

搭配可选的 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 后，可以在当前会话中查看每一次识图调用。记录默认折叠，展开后显示完整提示词、图片预览和分析结果：

![会话级识图记录](docs/history-preview.svg)

## 功能

- 用户上传图片时，先显示原始消息，再调用图片模型分析。
- 基础模型读取识图结果后继续回复，不要求基础模型本身支持图片输入。
- 支持“这张图里还有什么”“再详细一点”等跨轮图片追问。
- 支持分析 Agent 截图以及浏览器、读图工具返回的图片。
- 每一次图片模型调用都生成独立的会话级记录。
- 普通文本不会重复分析历史图片。
- 图片附件保留稳定引用，后续需要时可以在当前会话中重新读取像素。
- 图片后端通过统一接口接入，以后可以扩展非 LLM 类型的识图 API。

## 真实对比：根据设计稿开发网页

我们在 DSH Web 中让 `DeepSeek-V4-Pro` 和 `Mix` 接收完全相同的提示词与同一张 1440×900 设计稿。两组都使用“标准模式”和 `Workspace Write`，不追加人工提示。

| DeepSeek-V4-Pro | Mix（基础模型仍为 DeepSeek-V4-Pro） |
|---|---|
| 在提交阶段提示“当前模型不支持图片”，Agent 未启动，生成 0 个文件 | 读取设计稿后生成 `index.html`、`styles.css`、`app.js`，并自行截图复查 |

| 参考设计稿 | Mix 单轮生成结果 |
|---|---|
| ![LumaBoard 参考设计稿](docs/benchmark-reference.png) | ![Mix 生成的 LumaBoard 页面](docs/benchmark-mix.png) |

Mix 用时 8分37秒、共 11 个 Agent 步骤；Bridge GPT 完成 1 次初始分析、3 次针对布局/配色/排版的附件追问，以及 2 次成品截图复查。我们随后独立打开产物验证：1440×900 下没有页面滚动，没有控制台错误或页面异常。

这个结果说明的不是“Mix 的基础模型比 DeepSeek 更强”，而是同一个 DeepSeek 基础模型经过 Bridge GPT 后，获得了读取设计稿、按需重新查看像素并完成视觉自检的能力。完整提示词、原始失败截图、测试条件、资源消耗和生成源码见 [BENCHMARK.md](BENCHMARK.md)。

## 快速开始

### 1. 安装插件

在 DeepSeek Harness 仓库目录执行：

```powershell
pnpm dsh plugin --profile web add dsh-codex-bridge
```

如果需要侧边栏识图记录，再安装：

```powershell
pnpm dsh plugin --profile web add dsh-better-sidebar
```

侧边栏插件不是必需依赖。未安装时，`Mix` 路由、图片分析、跨轮追问和记录持久化仍然正常工作，只是不显示侧边栏入口。

### 2. 启动 Web

```powershell
pnpm dsh web
```

安装后的正常启动不需要 `--patch`。

### 3. 配置模型

先打开“设置 → 模型”，配置准备使用的模型及其 provider、协议、Base URL 和凭据。

然后打开“设置 → Bridge GPT”：

1. 选择负责最终回复和工具调用的基础模型。
2. 选择负责读取图片像素的图片模型。该模型必须声明支持 `image` 输入。
3. 根据需要选择意图识别模型，并决定是否自动分析工具返回的图片。

这里显示的都是“设置 → 模型”中已经配置好的模型，不需要再次填写 API Key。

### 4. 使用 Mix

在新对话的模型选择器中选择 `Mix`，然后发送文本或图片。`Mix` 是固定路由入口，不是一个单独的模型服务。

## Mix 如何处理消息

| 当前输入 | 处理方式 |
|---|---|
| 普通文本 | 直接交给基础模型，不调用图片模型或意图模型 |
| 新上传的图片 | 图片模型读取图片，基础模型根据识图结果回答 |
| 明确追问最近图片 | 使用当前问题重新查看本会话最近的图片 |
| “再详细一点”等模糊追问 | 配置了意图模型时，先判断是否需要重新查看图片 |
| Agent 截图或工具返回图片 | 分析工具真正返回的图片，再把结果交给下一步 Agent |
| 工具没有返回图片 | 保持原有工具结果，不触发识图 |

插件只处理当前步骤中新进入的图片，不会扫描整段历史并重复调用图片模型。同一张图片被用户再次发送，或者用户继续追问图片内容时，会产生一次新的识图调用和一条新的记录。

更完整的路由和生命周期说明见 [DESIGN.md](DESIGN.md)。

## 配置项

| 设置 | 是否必需 | 用途 |
|---|---:|---|
| 基础模型 | 是 | 处理普通文本，读取识图结果并生成最终回复 |
| 图片模型 | 是 | 读取用户图片、Agent 截图和工具图片的实际像素 |
| 意图识别模型 | 否 | 判断模糊的后续追问是否仍在讨论最近图片 |
| 自动分析工具图片 | 否 | 控制是否自动处理截图工具等返回的图片，默认开启 |

如果没有配置意图识别模型，明确写出“图片”“截图”“照片”等指代的追问仍然可以重新识图；模糊追问则直接交给基础模型。

## 识图记录

安装 `dsh-better-sidebar` 后，Bridge GPT 会自动注册桥形图标的“识图记录”标签。侧边栏只显示当前会话的数据，并按日期和时间排列。

每条记录包括：

- 调用来源和时间。
- 图片模型与耗时。
- 发送给图片模型的完整提示词。
- 图片预览、原文件名、格式、尺寸和大小。
- 图片附件的逻辑定位符。
- 完整分析结果或错误信息。

未安装侧边栏，或者侧边栏晚于 Bridge GPT 加载，都不会影响插件的核心功能。

## 图片附件与隐私

- 插件不包含或持久化硬编码 API Key。
- 模型请求统一经过 Harness 的模型注册表和凭据系统。
- 用户图片由 Harness attachment 服务保存；会话记录稳定的 attachment id，而不是宿主机器上的绝对文件路径。
- 图片在模型上下文中带有 `dsh-attachment://` 逻辑定位符，基础模型不会被引导到工作区中搜索上传图片。
- `bridge_gpt_attachment_query` 只能重新读取当前会话识图记录中已经出现过的附件。
- 图片预览同时校验会话和识图记录，其他会话不能直接枚举附件。
- 识图历史默认保存在 `$DSH_HOME/bridge-gpt/v1/calls/`。

附件存储和会话事件的实现细节见 [DESIGN.md](DESIGN.md#附件定位)。

## 常见问题

### 安装后看不到 Mix

确认插件已经安装到正在使用的 `web` profile，并重新启动 `pnpm dsh web`。模型选择器中显示的是 `Mix`，不是 npm 包名或 `Bridge GPT`。

### 图片模型没有出现在 Bridge GPT 的列表中

先在“设置 → 模型”中完成该模型的配置，并确认它声明支持 `image` 输入。纯文本模型不会出现在图片模型列表中。

### 没安装 dsh-better-sidebar 能否使用

可以。缺少的只有“识图记录”侧边栏入口，图片路由和会话数据不受影响。

### 后续追问会不会再次读取图片

明确引用图片时会。模糊追问需要配置意图识别模型。与图片无关的普通文本不会重复读取历史图片。

### 启动时报 `EADDRINUSE 127.0.0.1:3080`

端口 `3080` 已经有一份 Web 服务在运行。关闭旧进程后重新启动，不要同时运行两份 Web 服务。

### npm 镜像没有同步最新版本

可以只在当前 PowerShell 终端临时使用 npm 官方 registry：

```powershell
$env:npm_config_registry = 'https://registry.npmjs.org/'
pnpm dsh plugin --profile web add dsh-codex-bridge
Remove-Item Env:npm_config_registry
```

## 开发

源码安装、本地调试、检查命令和发布流程见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## License

[MIT](LICENSE)
