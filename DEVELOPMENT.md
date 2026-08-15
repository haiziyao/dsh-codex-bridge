# 开发说明

本文面向需要从源码安装、调试或发布 `dsh-vision-mix` 的维护者。普通用户请从 [README.md](README.md) 开始。

## 环境要求

- Node.js `^22.19.0` 或 `>=24.0.0`
- pnpm `>=10`
- DeepSeek Harness 本地仓库

## 本地开发启动

在 DeepSeek Harness 仓库目录执行：

```powershell
pnpm dsh web --patch ../dsh-vision-mix/dsh-patch.yml
```

打开 <http://127.0.0.1:3080>，在模型选择器中选择 `Mix`。

开发 patch 只用于本地调试。通过 npm 安装到 profile 后，应直接运行 `pnpm dsh web`。

如果出现 `EADDRINUSE 127.0.0.1:3080`，说明已经有一份 Web 服务占用该端口。关闭旧进程后重新执行，不要同时启动两份服务。

## 从本地 checkout 安装

在 DeepSeek Harness 仓库目录执行：

```powershell
pnpm dsh plugin --profile web add ../dsh-vision-mix
```

## 从 GitHub 源码安装

```powershell
pnpm dsh plugin --profile web add github:haiziyao/dsh-vision-mix
```

Git 源安装会通过 `prepare` 脚本构建服务端和 Web 客户端。按照 DSH 和 pnpm 10 及以上的安全策略，首次安装可能停止并打印一条完整的 `allowBuilds` 键。把错误中给出的键原样加入 `%USERPROFILE%\.dsh\profiles\web\pnpm-workspace.yaml`，再重新执行安装命令。

```yaml
allowBuilds:
  'dsh-vision-mix@https://codeload.github.com/...': true
```

必须使用 pnpm 输出的完整 URL 和 commit 键，不能直接复制上面的省略示例。

## 检查

```powershell
pnpm run typecheck
pnpm run test
pnpm run build
```

也可以一次执行全部检查：

```powershell
pnpm run check
```

## 发布

仓库使用 npm Trusted Publishing，不保存 `NPM_TOKEN`。推送与 `package.json` 版本一致的 `v*` 标签后，[`.github/workflows/publish.yml`](.github/workflows/publish.yml) 会执行完整检查，通过 GitHub OIDC 获取一次性发布凭据，并将包发布到 npm。npm 会为发布版本生成来源证明。

更新版本并提交：

```powershell
pnpm version patch --no-git-tag-version
$version = (Get-Content package.json | ConvertFrom-Json).version
git add package.json pnpm-lock.yaml
git commit -m "chore: release v$version"
```

确认提交和版本正确后创建并推送标签：

```powershell
git tag "v$version"
git push origin main "v$version"
```

Trusted Publisher 必须绑定以下信息：

- GitHub 仓库：`haiziyao/dsh-vision-mix`
- Workflow：`publish.yml`
- npm 包：`dsh-vision-mix`

标签与 `package.json` 版本不一致时，工作流会拒绝发布。
