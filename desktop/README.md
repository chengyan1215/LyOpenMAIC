# 智学课堂桌面版

这是 LyOpenMAIC 的 Windows 桌面发行层。客户端内置 Electron 和 Next.js standalone 运行时，用户无需安装 Docker、Node.js 或 Git。

## 本地开发

```powershell
pnpm install
pnpm desktop:dev
```

首次启动时填写 DeepSeek API Key。密钥通过 Electron `safeStorage` 加密并保存在当前 Windows 用户的应用数据目录，不会写入安装目录或构建产物。

## 生成安装包

```powershell
pnpm desktop:dist
```

命令会依次执行 Next.js 生产构建、整理 standalone 运行时，再通过 electron-builder 生成 NSIS 安装程序。结果位于 `desktop/dist/`。

## 开源说明

智学课堂是基于清华大学 OpenMAIC 开源项目适配的非官方桌面发行版。打包时会将仓库 `LICENSE` 一并放入应用资源目录。
