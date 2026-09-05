# LyOpenMAIC 开发说明

> 本文档记录智学课堂（LyOpenMAIC 桌面发行版）的分支策略、打包链路与关键修复。
> 上次重大更新：2026-09-05（v0.1.3）

## 1. 项目定位

基于清华大学开源项目 [OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) 适配的
**非官方桌面发行版「智学课堂」**（Electron + Next.js standalone）。

- `origin` → `chengyan1215/LyOpenMAIC`（我们的 fork，推送目标）
- `upstream` → `THU-MAIC/OpenMAIC`（清华官方，同步来源）

## 2. 分支模型（重要）

```
upstream/main ──快进(ff-only)──> main（镜像层：永远只放上游代码，自己绝不直接提交）
                                   │
                                   └── rebase ──> product/zhixue（产品层：全部定制 + 出货打包）
```

**纪律：**
- `main` 只允许 `git merge --ff-only upstream/main` 快进，保持与上游零偏差。
- 所有开发、出货都在 `product/zhixue`，同步上游时在其上 rebase。
- 通用 bug 修复尽量提 PR 回上游，合入后自然获得。
- 出货前打 tag（如 `v0.1.3`），保证客户问题可追溯到确切代码。

### 同步上游 SOP（每 1~2 个月或上游发版时）

```bash
git fetch upstream
git checkout main
git merge --ff-only upstream/main
git push origin main
git checkout product/zhixue
git rebase main            # 冲突集中在这里解决
pnpm install               # pnpm-lock.yaml 冲突不要手改，rebase 时 checkout --theirs 后重新生成
pnpm build && pnpm desktop:prepare && 桌面端冒烟验证
```

### 定制边界（减少 rebase 冲突的关键）

| 内容 | 位置 | 冲突风险 |
|---|---|---|
| Electron 壳 | `desktop/` 整目录 | 零（上游没有） |
| 品牌化前端 | `lib/brand/brand-config.ts`、`lib/store/settings.ts`、`app/layout.tsx`、`app/page.tsx`、`components/stage/scene-sidebar.tsx` | 上游改到同文件才有 |
| workspace/脚本 | `package.json`、`pnpm-workspace.yaml`、`.gitignore` | 必有，手工保自己的块 |

## 3. 打包链路（Windows）

```bash
pnpm desktop:dist
# = next build（standalone）→ desktop/scripts/prepare-runtime.mjs 拷贝 runtime
#   → repair-dependencies.mjs 补传递依赖 → electron-builder NSIS 出包
```

**本机完整打包命令**（WorkBuddy shell 下需要这些环境变量，坑详见 §5）：

```bash
cd D:/code/Lykt/LyOpenMAIC/desktop
PATH="/d/code/Lykt/shims:$PATH" PATHEXT=".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC" \
CODEBUDDY_SAFE_DELETE_ENABLED=0 \
npm_config_user_agent="pnpm/10.28.0 npm/? node/v22.22.2 win32 x64" \
INIT_CWD="D:\\code\\Lykt\\LyOpenMAIC" \
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
./node_modules/.bin/electron-builder --win nsis --x64
```

产物：`desktop/dist/智学课堂-Setup-<版本>.exe`。每次出货前升 `desktop/package.json` 版本号。

### 出包后必做的冒烟验证

1. 从 `dist/win-unpacked/resources/standalone` 用 node 起 `server.js`
2. `GET /api/health` 期待 200 `status:ok`；首页期待 200
3. 抽查 `standalone/node_modules/pg-types` 存在（§4 根因）

## 4. 关键修复记录

### 4.1 pg-types 启动崩溃（v0.1.1 事故根因）

- **现象**：安装版启动时 instrumentation 反复报错 344 次，90 秒健康检查超时，应用无法启动。
- **根因**：Turbopack 把 `pg` 外部化复制进 `.next/node_modules`（带 hash），但**传递依赖 `pg-types` 没跟随**。
- **修复**：`desktop/scripts/repair-dependencies.mjs` 在 prepare-runtime 后补齐 pg 依赖闭包（pg-types、pg-protocol 等 12 个包）。
- **教训**：外部化进 standalone 的包必须连传递依赖一起进产物。

### 4.2 aws-sdk 瘦身（v0.1.2）

- `@aws-sdk` 占 runtime **61% 文件数**（16 万个小文件）。
- 代码中全部为**懒加载动态 import()**（S3/Bedrock 后端），`.env` 无 AWS 配置 → 运行时永不加载。
- 打包钩子 robocopy/hardlink 均排除 `@aws-sdk`、`@aws-crypto`、`@smithy` 三目录，零风险。
- 若未来真要支持 S3 存储：把这三个包补回 `desktop/runtime/standalone/node_modules` 再打包。

### 4.3 打包提速：硬链接镜像（v0.1.2 起）

- **历史包袱**：runtime 有 20 万+小文件，electron-builder 内置拷贝 ~25 文件/s（1-2 小时）。
- **方案**：`desktop/scripts/afterpack-standalone.mjs`（afterPack 钩子）用 **NTFS 硬链接**（`fs.linkSync`）镜像 runtime → 暂存区，66,741 文件仅 **20.9 秒**（对比 robocopy /MT:48 约 50 文件/s）。
- **前提约束**：源/目标必须在同一卷；打包后**不能有任何工具原地修改暂存区 standalone 文件**（rcedit 只动 exe、NSIS 只读，目前安全）。若未来加此类步骤，需改回真实拷贝。
- 注意：`node_modules/.pnpm`（5.7 万文件）虽只被 .nft.json 元数据引用，但属 pnpm 硬链接结构，**保留不排除**。

## 5. 本机打包环境坑（WorkBuddy shell 下）

1. **本机 shell 无 pnpm**：`/d/code/Lykt/shims/pnpm.cmd` → node 直调 corepack 缓存的 pnpm 10.28.0。
2. **PATHEXT 被污染成 `.CPL`**：必须显式设置正常 PATHEXT，否则 PowerShell 子进程找不到 .cmd，electron-builder 依赖收集报 "No JSON content found"。
3. **包管理器检测**：desktop/ 无 lockfile，electron-builder 靠 `npm_config_user_agent` 含 "pnpm" + `INIT_CWD` 指向仓库根识别。
4. **删除护栏**：WorkBuddy 沙箱会拦 electron-builder 清理 dist → 打包时 `CODEBUDDY_SAFE_DELETE_ENABLED=0`（仅打包时）。
5. **代理 502**：electron-builder 下载 winCodeSign 会被代理挡 → 直连下载放入 `%LOCALAPPDATA%/electron-builder/Cache/winCodeSign/`（已完成，缓存长期有效）。

## 6. GPU 渲染模式（v0.1.3 起）

- 三档：**自动（默认）/ 强制硬件 / 强制软件**，菜单「设置 → 渲染模式…」切换，重启生效。
- 自动模式逻辑（`desktop/lib/gpu-state.cjs` + `main.cjs`）：
  - 优先硬件加速；上次硬件启动非正常退出，或 GPU 子进程累计崩溃 ≥2 次 → 自动降级软件渲染
  - 启动意图在 `app.whenReady()` **之前**落盘 `gpu-state.json`（userData 下），硬崩溃也留痕
  - 硬件会话正常退出会清零崩溃计数（偶发抽风不永久降级）
- 软件渲染 = `disableHardwareAcceleration` + `disable-gpu` + `in-process-gpu`（Boot Camp/精简 Windows 兼容保底）。

## 7. 版本历史

| 版本 | 日期 | 要点 |
|---|---|---|
| 0.1.0 | 2026-09-05 上午 | 首版（有 pg-types 缺陷） |
| 0.1.2 | 2026-09-05 下午 | pg-types 修复 + aws-sdk 排除 + 硬链接打包钩子 |
| 0.1.3 | 2026-09-05 晚 | GPU 渲染模式（自动降级 + 手动切换） |
