# 设置中心

设置中心完全位于 `desktop/`，由标题栏右侧的齿轮打开一个独立 Electron 窗口。
OpenMAIC 的页面、组件、状态管理和提示词不需要为桌面设置中心做任何修改。

## 模块边界

- `settings-center/`：设置窗口的 HTML、CSS 和交互脚本。
- `preload.cjs`：注入桌面标题栏，并向两个受隔离的渲染窗口暴露有限 IPC。
- `main.cjs`：创建设置窗口，验证输入，并在课堂窗口所属 origin 中读写现有持久化键。
- `lib/config-store.cjs`：继续使用 Electron `safeStorage` 加密桌面 DeepSeek API Key。

设置中心复用 OpenMAIC 已有的 `maic:account:user-profile-storage` 和
`maic:account:settings-storage` 数据格式。保存时只合并设置中心负责的字段，
不会覆盖未知字段、服务商密钥或后续版本新增配置。

## 分类

- 通用：外观、语言、最近课堂。
- 学习档案：头像、称呼、自我介绍。它与首页个人介绍卡是同一份数据。
- AI 服务：桌面安全连接、默认模型摘要，以及进入 OpenMAIC 原有完整服务商设置的入口。
- 课堂与能力：桌面版课程编辑（Pro）、语音讲解、语音输入、自动播放、播放速度、图片、视频和大纲确认。
- 存储与运行：数据目录、GPU 模式、临时缓存、日志和手动刷新。
- 关于：版本、发行说明和实现边界。

首次安装不再弹出单独配置向导。没有 API Key 时仍可进入首页浏览和整理课堂；
需要生成内容时，可从设置中心配置桌面 DeepSeek 连接，或打开原有完整设置选择其他服务。

桌面开发启动和 `desktop:prepare` 正式构建都会注入
`NEXT_PUBLIC_MAIC_EDITOR_ENABLED=1`，因此已有课堂顶部的 Pro 编辑控制在开发版和安装包中均默认可用。

## 生效规则

主题会立即预览。语言、学习档案和课堂能力写入现有持久化数据，刷新课堂页后由
OpenMAIC 按原流程重新载入。设置中心提供显式“刷新课堂页”按钮，避免用户在编辑课堂时
被突然刷新。

## 验证

`node desktop/scripts/verify-settings-center.mjs` 使用隔离的 Electron 数据目录启动真实桌面入口。
通过 `SETTINGS_TEST_UPSTREAM` 指向已经运行的本地 Next 服务，避免启动第二个 Next 开发实例。
验证截图写入 `e2e/screenshots/settings-center/`。
