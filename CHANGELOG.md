# Changelog

## [0.7.1](https://github.com/maplezzk/llm-proxy/compare/v0.7.0...v0.7.1) (2026-05-03)


### Bug Fixes

* **macos-app:** 通过 login shell 启动子进程，继承 ~/.zshrc 中的环境变量 ([#64](https://github.com/maplezzk/llm-proxy/issues/64)) ([14d06fa](https://github.com/maplezzk/llm-proxy/commit/14d06fae085f9af03d9a3936a46750effb6da9ca))

## [0.7.0](https://github.com/maplezzk/llm-proxy/compare/v0.6.0...v0.7.0) (2026-05-03)


### Features

* **macos-app:** 捕获子进程 stdout/stderr 到日志文件，菜单栏增加打开日志目录 ([#61](https://github.com/maplezzk/llm-proxy/issues/61)) ([52d09c0](https://github.com/maplezzk/llm-proxy/commit/52d09c0b59c65d8bf4712a701168baee4e06c07c))

## [0.6.0](https://github.com/maplezzk/llm-proxy/compare/v0.5.8...v0.6.0) (2026-05-03)


### Features

* 简化快速启动体验，config 不存在时自动创建并引导至 Admin UI ([#58](https://github.com/maplezzk/llm-proxy/issues/58)) ([df0a5b8](https://github.com/maplezzk/llm-proxy/commit/df0a5b80b5f48c44bd06249c51047f38c9f7a230))


### Bug Fixes

* CLI 日志默认使用英文，仅当 config 中显式设置 locale: zh 时才使用中文 ([#60](https://github.com/maplezzk/llm-proxy/issues/60)) ([46dd564](https://github.com/maplezzk/llm-proxy/commit/46dd56452b83464a871721c7ab61960ba3756a40))

## [0.5.8](https://github.com/maplezzk/llm-proxy/compare/v0.5.7...v0.5.8) (2026-05-03)


### Bug Fixes

* npm publish 漏掉 locales 目录，导致 i18n 翻译文件加载失败 ([#55](https://github.com/maplezzk/llm-proxy/issues/55)) ([ab880b4](https://github.com/maplezzk/llm-proxy/commit/ab880b4193de9446944c5ad08b1d3c36d5670225))
* 修正 dashboard 缓存命中率计算口径防止超过 100% ([#57](https://github.com/maplezzk/llm-proxy/issues/57)) ([889dd10](https://github.com/maplezzk/llm-proxy/commit/889dd10611b6a0b399fdf1c99bf09300daff3863))

## [0.5.7](https://github.com/maplezzk/llm-proxy/compare/v0.5.6...v0.5.7) (2026-05-02)


### Bug Fixes

* 避免数组字面量直接初始化 Bundle.module 导致启动崩溃 ([#53](https://github.com/maplezzk/llm-proxy/issues/53)) ([c9d5ff7](https://github.com/maplezzk/llm-proxy/commit/c9d5ff773137df557f0b37522011b10a7b227248))

## [0.5.6](https://github.com/maplezzk/llm-proxy/compare/v0.5.5...v0.5.6) (2026-05-02)


### Bug Fixes

* macOS 26.4.1 中 CFBundleIdentifier 含连字符导致菜单栏图标不显示 ([#51](https://github.com/maplezzk/llm-proxy/issues/51)) ([92a427c](https://github.com/maplezzk/llm-proxy/commit/92a427cfd1b547cf3aba48eb175b52a77393e321))

## [0.5.5](https://github.com/maplezzk/llm-proxy/compare/v0.5.4...v0.5.5) (2026-05-02)


### Bug Fixes

* npm 全局安装后 bin entry 找不到 tsx 和 src 源码 ([#49](https://github.com/maplezzk/llm-proxy/issues/49)) ([181d47a](https://github.com/maplezzk/llm-proxy/commit/181d47a7c342203d5369472c25494ff0db3d8cc2))

## [0.5.4](https://github.com/maplezzk/llm-proxy/compare/v0.5.3...v0.5.4) (2026-05-02)


### Bug Fixes

* 统一开发/生产环境托盘图标加载，移除 SF Symbol 回退 ([#47](https://github.com/maplezzk/llm-proxy/issues/47)) ([52eff3f](https://github.com/maplezzk/llm-proxy/commit/52eff3f91b70d81e7918b094bbdec63b53264722))

## [0.5.3](https://github.com/maplezzk/llm-proxy/compare/v0.5.2...v0.5.3) (2026-05-02)


### Bug Fixes

* macOS app 因 SPM 资源 bundle 未打包导致启动崩溃 ([#45](https://github.com/maplezzk/llm-proxy/issues/45)) ([e976212](https://github.com/maplezzk/llm-proxy/commit/e97621245035a8ae51f0f9ecf879d1f22c311b2a))

## [0.5.2](https://github.com/maplezzk/llm-proxy/compare/v0.5.1...v0.5.2) (2026-05-02)


### Bug Fixes

* macOS app 安装包 Info.plist 缺少 CFBundleIconFile 导致显示默认图标 ([#42](https://github.com/maplezzk/llm-proxy/issues/42)) ([392dd4c](https://github.com/maplezzk/llm-proxy/commit/392dd4c0c3c0a75bf959156e1d4d46b6a0897307))

## [0.5.1](https://github.com/maplezzk/llm-proxy/compare/v0.5.0...v0.5.1) (2026-05-02)


### Bug Fixes

* Admin UI 日志按时间降序排列（时间戳+ID 双字段排序） ([#40](https://github.com/maplezzk/llm-proxy/issues/40)) ([0858c65](https://github.com/maplezzk/llm-proxy/commit/0858c65c5f6787441a3ff02e0e87e8cacf4d8c80))
* 客户端未传 stream 时显式设为 false，防止上游默认返回 SSE ([#38](https://github.com/maplezzk/llm-proxy/issues/38)) ([ec97f84](https://github.com/maplezzk/llm-proxy/commit/ec97f84ce41e0fccbdaa0a035357f355b9b08612))

## [0.5.0](https://github.com/maplezzk/llm-proxy/compare/v0.4.1...v0.5.0) (2026-05-02)


### Features

* 添加 max_body_size 配置参数控制请求体大小限制 ([#33](https://github.com/maplezzk/llm-proxy/issues/33)) ([fefb4ab](https://github.com/maplezzk/llm-proxy/commit/fefb4ab882f811de55ec350b6813ac1a99aef064))
* 适配器支持 max_tokens 配置，max_tokens=0 时不传该字段 ([#36](https://github.com/maplezzk/llm-proxy/issues/36)) ([4f65f0c](https://github.com/maplezzk/llm-proxy/commit/4f65f0c094c266404f8aafadf6e09b573537519e))


### Bug Fixes

* restart 命令增加 stale PID 检测，适配器表单添加 max_tokens 字段 ([#37](https://github.com/maplezzk/llm-proxy/issues/37)) ([27ca1c6](https://github.com/maplezzk/llm-proxy/commit/27ca1c6f96d025042ebbb6f91fe111527f8c5995))
* 日志消息全部改为英文 ([#35](https://github.com/maplezzk/llm-proxy/issues/35)) ([b32e411](https://github.com/maplezzk/llm-proxy/commit/b32e411a1908ab747c0bf445f9deb4a46d78e2d9))

## [0.4.1](https://github.com/maplezzk/llm-proxy/compare/v0.4.0...v0.4.1) (2026-05-02)


### Bug Fixes

* **ci:** 将macOS构建整合到release.yml，解决release-please不触发release-app事件 ([#31](https://github.com/maplezzk/llm-proxy/issues/31)) ([b354646](https://github.com/maplezzk/llm-proxy/commit/b354646873ab4b80f640ce649b1361579d6a05f9))

## [0.4.0](https://github.com/maplezzk/llm-proxy/compare/v0.3.0...v0.4.0) (2026-05-02)


### Features

* add i18n multilingual infrastructure (zh/en) ([#29](https://github.com/maplezzk/llm-proxy/issues/29)) ([0ee670b](https://github.com/maplezzk/llm-proxy/commit/0ee670b1694185662c5795b4809ccd81237c0a3e))

## [0.3.0](https://github.com/maplezzk/llm-proxy/compare/v0.2.0...v0.3.0) (2026-05-01)


### Features

* 协议抓包合并为单条记录，增上游/适配器信息，四阶段堆叠展示 ([#22](https://github.com/maplezzk/llm-proxy/issues/22)) ([ebdf443](https://github.com/maplezzk/llm-proxy/commit/ebdf4431dc3186c8bf7e69d68626232f5ed9cc6a))
* 引入 release-please 自动版本管理 ([#24](https://github.com/maplezzk/llm-proxy/issues/24)) ([cc819cc](https://github.com/maplezzk/llm-proxy/commit/cc819cc43bd27a0c6092855abe473f6724e5e57a))
* 统一图标设计 ([#16](https://github.com/maplezzk/llm-proxy/issues/16)) ([c330888](https://github.com/maplezzk/llm-proxy/commit/c330888a84e330e2d724b1560b7f5167dc294822))
* 菜单栏使用自定义 SVG 图标 ([b26d43c](https://github.com/maplezzk/llm-proxy/commit/b26d43cdae59261f711db392d4b1a26dcf768df6))


### Bug Fixes

* Anthropic缓存token透传到OpenAI格式 ([#26](https://github.com/maplezzk/llm-proxy/issues/26)) ([0b6234d](https://github.com/maplezzk/llm-proxy/commit/0b6234db555cfdfa7a4e1467f08aa5dd4ff161fe))
* DMG 文件名含版本号匹配 Homebrew cask ([566eea9](https://github.com/maplezzk/llm-proxy/commit/566eea9a53e743b05406721bcbade6624ea8b6d7))
* Logger 改为文件+内存双源查询，日志不再丢失 ([#25](https://github.com/maplezzk/llm-proxy/issues/25)) ([eda84a8](https://github.com/maplezzk/llm-proxy/commit/eda84a89d0e0d88716540e4b49c5f3cdde89b3de))
* menubar 启动 proxy 时设置 CWD 到 Resources ([#13](https://github.com/maplezzk/llm-proxy/issues/13)) ([5da8dbf](https://github.com/maplezzk/llm-proxy/commit/5da8dbf46e80c25be015fb35259c4fd267aa1e24))
* README 修复为中英双语版本 ([ea4073b](https://github.com/maplezzk/llm-proxy/commit/ea4073bf4cea13c9522b799f15345500f18374ca))
* README 修复为中英双语版本 ([e2e2e83](https://github.com/maplezzk/llm-proxy/commit/e2e2e831721ecbb0125c8d1a4a30bebc5ed22af7))
* README 拆分为中英双语两个文件 ([db38af5](https://github.com/maplezzk/llm-proxy/commit/db38af540d2427beb01143e83637ab491abddcf8))
* README 拆分为中英双语两个文件 ([680ac14](https://github.com/maplezzk/llm-proxy/commit/680ac14efb27d829962d8ff358e38965ac4ed35e))
* release-app.yml 补充 npm ci 安装依赖 ([#7](https://github.com/maplezzk/llm-proxy/issues/7)) ([d8a9b14](https://github.com/maplezzk/llm-proxy/commit/d8a9b14b97d6449c5bcac962cb6506e8cf7497cc))
* 修复重启/刷新图标 ([a4df33e](https://github.com/maplezzk/llm-proxy/commit/a4df33e195a2d724ee3133478c87699814622d7e))
* 去掉系统退出图标，刷新加 emoji ([06c8132](https://github.com/maplezzk/llm-proxy/commit/06c81321407afdbb186a5ee2f735e5da1b64c9b1))
* 构建脚本 ROOT_DIR 路径错误 ([#12](https://github.com/maplezzk/llm-proxy/issues/12)) ([1cda2ca](https://github.com/maplezzk/llm-proxy/commit/1cda2ca9fce30bccf906aa7f9ff9710ce1870feb))
* 跨协议 OpenAI→Anthropic 工具调用缺少 thinking 块和 tool_result 未合并 ([#21](https://github.com/maplezzk/llm-proxy/issues/21)) ([9af87c8](https://github.com/maplezzk/llm-proxy/commit/9af87c8dfbae62e68f9b30519836555885d709d0))

## [0.2.0](https://github.com/maplezzk/llm-proxy/compare/v0.1.6...v0.2.0) (2026-05-01)


### Features

* 协议抓包合并为单条记录，增上游/适配器信息，四阶段堆叠展示 ([#22](https://github.com/maplezzk/llm-proxy/issues/22)) ([ebdf443](https://github.com/maplezzk/llm-proxy/commit/ebdf4431dc3186c8bf7e69d68626232f5ed9cc6a))
* 引入 release-please 自动版本管理 ([#24](https://github.com/maplezzk/llm-proxy/issues/24)) ([cc819cc](https://github.com/maplezzk/llm-proxy/commit/cc819cc43bd27a0c6092855abe473f6724e5e57a))
* 菜单栏使用自定义 SVG 图标 ([b26d43c](https://github.com/maplezzk/llm-proxy/commit/b26d43cdae59261f711db392d4b1a26dcf768df6))


### Bug Fixes

* Anthropic缓存token透传到OpenAI格式 ([#26](https://github.com/maplezzk/llm-proxy/issues/26)) ([0b6234d](https://github.com/maplezzk/llm-proxy/commit/0b6234db555cfdfa7a4e1467f08aa5dd4ff161fe))
* Logger 改为文件+内存双源查询，日志不再丢失 ([#25](https://github.com/maplezzk/llm-proxy/issues/25)) ([eda84a8](https://github.com/maplezzk/llm-proxy/commit/eda84a89d0e0d88716540e4b49c5f3cdde89b3de))
* 修复重启/刷新图标 ([a4df33e](https://github.com/maplezzk/llm-proxy/commit/a4df33e195a2d724ee3133478c87699814622d7e))
* 去掉系统退出图标，刷新加 emoji ([06c8132](https://github.com/maplezzk/llm-proxy/commit/06c81321407afdbb186a5ee2f735e5da1b64c9b1))
* 跨协议 OpenAI→Anthropic 工具调用缺少 thinking 块和 tool_result 未合并 ([#21](https://github.com/maplezzk/llm-proxy/issues/21)) ([9af87c8](https://github.com/maplezzk/llm-proxy/commit/9af87c8dfbae62e68f9b30519836555885d709d0))
