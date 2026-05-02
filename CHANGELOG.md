# Changelog

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
