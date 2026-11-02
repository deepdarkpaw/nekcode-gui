# nekcode

终端编程助手 [nek](https://github.com/deepdarkpaw/nekcode) 的桌面图形界面，支持 Windows 和 macOS；Linux 主机可以通过 Remote SSH 连接使用。

Desktop GUI for the [nek](https://github.com/deepdarkpaw/nekcode) coding agent (Windows and macOS; Linux hosts over Remote SSH).

## 下载安装

到 [Releases](https://github.com/deepdarkpaw/nekcode-gui/releases/latest) 下载最新版本：

| 系统                | 安装包                         |
| ------------------- | ------------------------------ |
| Windows（x64）      | `nekcode-<版本>-win-x64.exe`   |
| Windows（ARM）      | `nekcode-<版本>-win-arm64.exe` |
| macOS（Apple 芯片） | `nekcode-<版本>-mac-arm64.dmg` |
| macOS（Intel）      | `nekcode-<版本>-mac-x64.dmg`   |

安装包暂未签名：Windows 弹出 SmartScreen 时点「更多信息 → 仍要运行」；macOS 首次打开被拦截时，到「系统设置 → 隐私与安全性」点「仍要打开」。

首次启动会检查 nek（需要 0.4.0 或更新版本），没有安装可以在引导里直接安装。之后 nekcode 会自动检查新版本。

## 从源码构建

需要 Node.js 24.14.0（见 `.nvmrc`）和 pnpm 10（`corepack enable` 后按 `packageManager` 自动使用）。

```bash
pnpm bootstrap    # 安装依赖并构建
pnpm dev:desktop  # 开发模式运行
pnpm dist:win     # 打 Windows 安装包，输出到 packages/desktop/dist/
```

## 发布新版本

```bash
pnpm release 0.2.0
```

更新版本号、打 `v0.2.0` tag 并推送；GitHub Actions 构建各平台安装包后自动发布 Release。

## 许可证

[Apache-2.0](LICENSE)。nekcode 基于 [ZCodium](https://github.com/axiom-desu/ZCodium) 修改，修改说明见 [NOTICE.md](NOTICE.md)，第三方组件许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
