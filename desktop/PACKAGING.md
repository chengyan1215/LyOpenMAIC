# 智学课堂 Windows 打包指南

> 适用：本仓库（LyOpenMAIC）在 Windows（Boot Camp / D 盘慢速磁盘）上打 NSIS 安装包。
> 最后更新：2026-09-07（0.1.4/0.1.5 打包事故后固化全部教训；0.1.6 补充坑 8/9）

---

## 一、标准流程（照抄即可）

```bash
# 1. 提版本号（唯一位置）
#    desktop/package.json -> "version"
#    无其他硬编码引用，全局搜 0.1.x 确认即可

# 2. 完整打包（生产构建 + 运行时 + NSIS）
unset NODE_OPTIONS && \
export PATH="/c/Users/Fred/.workbuddy/binaries/node/workspace/node_modules/.bin:$PATH" && \
export NODE_OPTIONS="--max-old-space-size=12288" && \
cd D:/code/Lykt/LyOpenMAIC && pnpm desktop:dist

# 3. 只改了桌面壳/未改 Web 代码时的快速重打（跳过 next build，约 7 分钟）
unset NODE_OPTIONS && \
export PATH="/c/Users/Fred/.workbuddy/binaries/node/workspace/node_modules/.bin:$PATH" && \
cd D:/code/Lykt/LyOpenMAIC && \
pnpm --dir desktop prepare-runtime && pnpm --dir desktop dist
```

**流水线三阶段**：

| 阶段 | 做什么 | 本机耗时 |
|---|---|---|
| `next build` | Turbopack 全量生产构建，产出 `.next/standalone` | ~2 分钟 |
| `prepare-runtime` | 整拷 standalone → `desktop/runtime/standalone`，物化依赖闭包 | 20-30 分钟（慢盘瓶颈） |
| `electron-builder` | asar + Electron 运行时 + afterpack 硬链接镜像 + 签名 + NSIS 压缩 | ~10 分钟 |

## 二、必踩坑清单（每个都真实踩过）

### 坑 1：WorkBuddy 沙箱 node shim 拖垮构建 ⚠️ 最高优先级
- **现象**：构建卡死几十分钟无输出，或 `.next` 清理报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`
- **根因**：WorkBuddy 全局注入的 `NODE_OPTIONS` 带了 safe-delete shim，拦截构建的海量文件操作
- **对策**：构建命令**必须先 `unset NODE_OPTIONS`** 再设自己的堆参数；在 WorkBuddy 里跑必须绕过沙箱（dangerouslyDisableSandbox）

### 坑 2：TypeScript 阶段 OOM
- **现象**：构建在 "Running TypeScript" 阶段 exit 134
- **根因**：默认 4GB Node 堆不够
- **对策**：`NODE_OPTIONS="--max-old-space-size=12288"`（机器 32GB）

### 坑 3：旧安装包被嵌进新安装包（套娃）
- **现象**：安装包体积异常（正常 ~300MB，异常 1GB+）
- **根因**：Next standalone 镜像整个仓库根，`desktop/dist` 里的历史 Setup.exe 被一起打包
- **对策**：已修复——`prepare-runtime.mjs` 拷贝后自动删除 `runtime/standalone/desktop/dist`。**打包前 dist 里不要留旧 exe**（可挪到 `D:\code\Lykt\_stale-build-artifacts\`）

### 坑 4：standalone 里的空壳包 → 客户端启动即崩
- **现象**：客户机器日志 `Cannot find module 'next'`（本地 dev 正常，装到客户机器起不来）
- **根因**：`next build` 偶发生成的 `.next/standalone/node_modules/<pkg>` 是空目录（本应是 pnpm 链接落地），旧脚本对空壳无感知，"0 added" 照样出包
- **对策**：已修复——`repair-dependencies.mjs` 现在会：
  1. 对缺 `package.json` 的条目自动从仓库真实安装（pnpm store）物化
  2. 对 `Next 16` 外部化的**哈希名包**（`.next/node_modules/pg-4c0d8067d674414d` 这类）先剥 16 位十六进制后缀还原真实包名再物化——**它们不是构建垃圾，运行时会按字面路径 require**
  3. 结束时校验 `node_modules/next/package.json` 必须存在，否则抛错拦截出包
- **验收时必须人工再查一次**（见下方验收清单）

### 坑 4b：只做静态检查不够，smoke test 是必做项
- **现象**：依赖检查全过，但客户机器上 instrumentation 加载失败（`Failed to load external module pg-4c0d...`）
- **教训**：静态查 `package.json` 存在性查不出哈希外部包问题，`node server.js` 冒烟测试才拦得住。**smoke test 是必做步骤，不是可选项**

### 坑 5：单线程拷贝在慢盘上是小时级
- **对策**：`repair-dependencies.mjs` 的 `copyTree()` 在 Windows 上走 `robocopy /MT:16`。**不要改回 fs.cpSync**

### 坑 6：AWS SDK 白白搬运
- **根因**：上游带的 S3 存储依赖 + `lib/ai/providers.ts` 的 Bedrock 动态 import，静态追踪把 16 万个小文件全追进来，但业务（DeepSeek）永远用不到
- **现状**：`afterpack-standalone.mjs` 已排除 `@aws-sdk`/`@aws-crypto`/`@smithy`，**最终安装包里没有 AWS**
- **待办**：把排除前移到 prepare-runtime/repair 的拷贝 filter，可省 30-50% 打包时间（2026-09-07 未实施）

### 坑 7：Electron 后台启动方式
- **现象**：electron 包进 `&`+sleep 的 shell 里随任务退出被杀
- **对策**：electron 必须作为**独立 run_in_background 任务**的前台子进程运行

### 坑 8：全量构建前必须挪走 `desktop/runtime/standalone`（0.1.6 新增）
- **现象**：TypeScript 阶段挂在 `desktop/runtime/standalone/**` 里的旧测试文件（`Module has no exported member`）；且 NFT 警告把整个项目追踪进 `.next/standalone`
- **根因**：①生产类型检查用的是 `tsconfig.build.json`，它的 `exclude` 会**整体替换**继承列表，缺 `desktop` 就会扫到旧运行时副本；②旧运行时副本存在时，NFT 全项目追踪把它一并卷进构建产物
- **对策**：全量打包前 `mv desktop/runtime/standalone /d/code/Lykt/_stale-build-artifacts/`（同盘 rename 秒完成，prepare-runtime 会重新生成）；`tsconfig.build.json` 已补 `desktop`——**改根 tsconfig.json 的 exclude 时必须同步改它**
- **0.1.7 补充**：即使 exclude 已修好类型检查，**NFT 仍会把 `desktop/runtime/standalone`（~135MB）追进 `.next/standalone`**，安装包从 451MB 涨到 547MB。mv 挪走这一步**不可省略**；若忘记，可在 prepare-runtime 后补救：把 `.next/standalone/desktop/runtime` 与 `desktop/runtime/standalone/desktop/runtime` 挪走，只重跑 `pnpm --dir desktop dist`（electron-builder 层，约 4.5 分钟），不必重跑 next build

### 坑 9：Turbopack NFT 全项目过追踪，安装包多 ~65MB（0.1.6 新增，未根治）
- **现象**：构建警告 "whole project was traced unintentionally"，`.next/standalone` 里混入 assets(83MB)/packages/tests/e2e 等仓库源码，Setup exe 451MB（0.1.5 为 385MB）
- **根因**：`lib/document/extractors/local-media.ts`、`lib/server/provider-config.ts`、`lib/server/usage-storage.ts` 里有 cwd 级 fs 操作，Turbopack NFT 因此追踪全项目；**`outputFileTracingExcludes` 在 Turbopack 下不生效**（加了没用的垃圾目录仍在）
- **现状**：垃圾文件惰性、不影响运行（skills 经 outputFileTracingIncludes 保证在包内）。根治方向：给上述三处 fs 操作加 `/*turbopackIgnore: true*/` 或静态限定到子目录，再裁体积——需先审计运行时真正读哪些仓库文件（skills/configs yaml/data）

### 坑 10：钉住端口绝不能落在 Windows 动态端口区（0.1.7 新增）
- **现象**：0.1.6 时代某次启动随机选中 61419 并钉住；几天后 Windows（WinNAT/Hyper-V）把 61320-61419 划进**启动时随机生成的保留段**，端口绑不上 → 应用静默回落到默认端口 → origin 变化 → 用户课程再次"消失"，且旧 origin 里持久化的 `ttsEnabled:false`（历史默认值）导致放课静音
- **根因**：①`listen(0)` 让 OS 从临时端口区（49152-65535）选端口，该区间的子段会被 WinNAT 在每次开机时随机圈走（`netsh interface ipv4 show excludedportrange protocol=tcp` 可查）；②端口变更无日志，排查困难
- **对策**（均已在 0.1.7 落地）：①`findFreePort` 改为在 **39500-44999**（低于动态端口下界，永不进 WinNAT 保留段）顺序扫描；②`resolveServerPort` 在端口被迫变更时 `writeLog` 记录新旧端口与后果；③settings 持久化版本 v4→v5，迁移时强制 `ttsEnabled:true` 一次（历史 false 是出厂默认值而非用户选择，见 `lib/store/settings.ts` migrate）
- **排查命令**：`netsh interface ipv4 show excludedportrange protocol=tcp`；用户"课程消失"时先查 `$APPDATA/智学课堂/server-port.json` 与 `logs/` 里的"端口已变更"记录

## 三、出包后验收清单（90 秒，必做）

```bash
cd D:/code/Lykt/LyOpenMAIC/desktop/dist/win-unpacked

# 1. 关键依赖完整（空壳包检查，缺一个都不能发货）
ls resources/standalone/node_modules/next/package.json \
   resources/standalone/node_modules/react/package.json \
   resources/standalone/node_modules/@next/env/package.json

# 2. 运行时无套娃（desktop/dist 不应存在）
ls resources/standalone/desktop/dist 2>/dev/null && echo "❌ 有套娃" || echo "✅ 干净"

# 3. server.js 与运行时清单在
ls resources/standalone/server.js resources/standalone/desktop-runtime.json

# 4. 体积合理性：Setup exe 应在 280-350MB 区间
ls -la ../dist/*.exe
```

**smoke test（必做，曾拦下静态检查漏掉的哈希外部包问题）**：
```bash
cd D:/code/Lykt/LyOpenMAIC/desktop/dist/win-unpacked/resources/standalone
PORT=5099 HOSTNAME=127.0.0.1 node server.js &
sleep 8 && curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5099
# 期望 200；Ctrl+C 退出
```

## 四、故障速查表

| 症状 | 原因 | 处理 |
|---|---|---|
| 构建无输出卡死 >10 分钟 | 沙箱 shim（坑 1） | unset NODE_OPTIONS + 绕沙箱重跑 |
| exit 134 | 堆内存不足（坑 2） | NODE_OPTIONS 加 --max-old-space-size=12288 |
| 类型检查扫到 dist 里的旧 .ts | tsconfig exclude 缺失 | tsconfig.json exclude 需含 `"desktop"`（已加） |
| 安装包 >500MB | 套娃（坑 3） | 检查 prepare-runtime 是否最新版 |
| 客户机器 Cannot find module 'xxx' | 空壳包（坑 4） | 重跑 repair-dependencies 后重新出包 |
| 删除旧产物被拦 | WorkBuddy 删除保护 | 用 mv 挪到 `D:\code\Lykt\_stale-build-artifacts\` |
| 打包中途 electron 进程消失 | 后台任务方式错误（坑 7） | 独立后台任务运行 |

## 五、背景知识（为什么这么慢/这么大）

- **慢**：D 盘（Boot Camp）文件系统基准 250-400ms/操作（SSD <1ms），打包全程几十万小文件操作。文件数大头：依赖闭包（AWS 闭包曾占 61%）+ Next 52 个路由的 code-splitting 产物。**治本：构建移到 SSD 或 Mac 侧，Windows 只做 NSIS 封装**
- **大**：Electron 470MB 解包（压后 ~200MB）是地板；业务运行时 ~100MB；安装包合理区间 280-350MB
- **体积突然暴涨先查套娃**，不是依赖变多

## 六、残留待办

- [ ] AWS 排除前移到 prepare-runtime/repair 拷贝 filter（省 30-50% 时间）
- [ ] `D:\code\Lykt\_stale-build-artifacts\`（约 5GB：旧安装包 + 旧打包快照 + 坏运行时隔离区）确认新版无问题后手动删除
