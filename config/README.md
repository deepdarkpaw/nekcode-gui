# 内置配置

- `config.yaml`：nekcode-gui 自身的运行参数（进程、超时、缓冲、重连、交互阈值），不是 nek 的配置；nek 的配置在 `~/.nek/agent/`，由设置中心管理。
- `default.json`：随客户端打包的帮助入口（反馈与社群链接），桌面端由 `packages/desktop/src/main/desktopHelpConfig.ts` 从安装包内读取，不再请求远端配置。
