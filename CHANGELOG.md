# Changelog

## [0.24.0](https://github.com/maplezzk/llm-proxy/compare/v0.23.2...v0.24.0) (2026-07-26)


### Features

* 完善 Dashboard 用量筛选与数据清理 ([604144d](https://github.com/maplezzk/llm-proxy/commit/604144da5cdf7fc9e396d23ae69c8d8f4ba96bbb))
* 支持供应商和模型多协议路由 ([3a18224](https://github.com/maplezzk/llm-proxy/commit/3a18224a89f99b7ffeed1ac0b163324792fcf3e2))
* 支持多协议供应商与菜单栏用量分析 ([9dfed02](https://github.com/maplezzk/llm-proxy/commit/9dfed029dfd6ec24c1b93074849ff55387d8c9a7))
* 支持多协议供应商并增强用量分析 ([c01cfb9](https://github.com/maplezzk/llm-proxy/commit/c01cfb97f62e5432968af830beffefb84b915a98))


### Bug Fixes

* 分离 Dashboard 图表标签与绘图区 ([844602f](https://github.com/maplezzk/llm-proxy/commit/844602fdbd8a9d756455d4ed493b171ef71f573b))
* 对齐 Dashboard 堆叠柱状图 ([905a3aa](https://github.com/maplezzk/llm-proxy/commit/905a3aa0d3b452ebbae419e097fd8b79ea38e216))
* 测试页切换协议同步 Base URL ([ec2b518](https://github.com/maplezzk/llm-proxy/commit/ec2b518e52b87610dd30b1d2b6e69e7ec14fa391))

## [0.23.2](https://github.com/maplezzk/llm-proxy/compare/v0.23.1...v0.23.2) (2026-07-26)


### Bug Fixes

* 固定兼容 Node 20 的 npm 版本 ([e978a62](https://github.com/maplezzk/llm-proxy/commit/e978a62c32f6d0e2ff21bd5b8d3d73a739f33ec3))
* 固定兼容 Node 20 的 npm 版本 ([03b2447](https://github.com/maplezzk/llm-proxy/commit/03b244768b157331cea3012c9821fc810cb1a07e))

## [0.23.1](https://github.com/maplezzk/llm-proxy/compare/v0.23.0...v0.23.1) (2026-07-26)


### Bug Fixes

* 修复 npm CI 依赖源地址 ([abd41f3](https://github.com/maplezzk/llm-proxy/commit/abd41f37ba07e8c279c355cda5cd7206ba2a56fd))
* 修复 npm CI 依赖源地址 ([3757c02](https://github.com/maplezzk/llm-proxy/commit/3757c02550139a59f5eee7d2a82958c4e5d10562))

## [0.23.0](https://github.com/maplezzk/llm-proxy/compare/v0.22.3...v0.23.0) (2026-07-26)


### Features

* Adapters 页——映射表/批量导入/请求默认/连通性测试（U5） ([fcda474](https://github.com/maplezzk/llm-proxy/commit/fcda474af1944c238f7bfe576218dcf9c4616c10))
* admin-ui 应用外壳——导航/全局状态/i18n/Toast/Confirm/端口设置 ([c73bc79](https://github.com/maplezzk/llm-proxy/commit/c73bc7943f4dba2f2418188806f4f5e2657f4198))
* Capture 页——SSE 实时抓包/pairId 合并/jsoneditor 四阶段对比（U7） ([0be2f55](https://github.com/maplezzk/llm-proxy/commit/0be2f5534ca8d5591c7e76ac381aaa3338446899))
* Dashboard 页——统计卡片 + recharts 用量图表 + 存储清理（U3） ([f3e3100](https://github.com/maplezzk/llm-proxy/commit/f3e31007fe761124aeebd1efeacb38f9afafdd9d))
* Logs 页——类型/级别/日期/搜索筛选、分页、日志级别切换、详情展开复制（U6） ([86b74b8](https://github.com/maplezzk/llm-proxy/commit/86b74b87c7eeb265b9204cec1452058becc1d0a9))
* macOS App 菜单栏 + Dashboard 重新设计（参考 CodexBar / ClashMac） ([e2a23bf](https://github.com/maplezzk/llm-proxy/commit/e2a23bf433f3572afacb7aba5199d898cbadf232))
* macOS 菜单栏与 Dashboard 参考 CodexBar 重新设计 ([4289061](https://github.com/maplezzk/llm-proxy/commit/4289061e8b70bdbf6925bb236eb80ed033836d64))
* Providers 页 + 共享连通性测试弹窗 TestPanelDialog（U4） ([57731e5](https://github.com/maplezzk/llm-proxy/commit/57731e55823c9e7e9bf6b57f36f75a87bf7855d7))
* Settings 页——Proxy Key 设置/移除 + Vision 回退配置与缓存（U8） ([bf68406](https://github.com/maplezzk/llm-proxy/commit/bf68406a351a18d2107ceec7df304fac9e21b744))
* 拉取模型弹窗加搜索+批量选择；Dashboard 视觉语言统一 ([3541f18](https://github.com/maplezzk/llm-proxy/commit/3541f18d8065e654498620bf6266555f938cfc9b))
* 新增 admin-ui Vite+React19+Appica 构建管线与骨架 (U1) ([dbe8af7](https://github.com/maplezzk/llm-proxy/commit/dbe8af79741769259500cd113757c070b80584e1))
* 服务控制按钮加语义色（停止红/重启橙/重载蓝/启动绿） ([3ff432b](https://github.com/maplezzk/llm-proxy/commit/3ff432bfb413dce11d7dce243c919312c6ec0a40))
* 模型维度拆分供应商/适配器模型 + 维度选中实心主色 + 操作列彩色语义按钮 ([79bbcf7](https://github.com/maplezzk/llm-proxy/commit/79bbcf723c07598e14cdb0368f5d66dded33f997))
* 管理页细节优化——按钮统一/图表 i18n 与紧凑数字/存储清理增强/模型维度修正/通用设置收纳 ([3971f04](https://github.com/maplezzk/llm-proxy/commit/3971f04b4bee814b0ac7bf459d542618b5316865))
* 菜单中间区精简重构 ([a8b3754](https://github.com/maplezzk/llm-proxy/commit/a8b3754fb7092f0999428ec6e67cca817cc08ad5))
* 菜单向 ClashMac 视觉对齐 ([a01281d](https://github.com/maplezzk/llm-proxy/commit/a01281d3c9f8a7c40f465ebfadec7d0c0efb6e00))
* 菜单操作区上移至状态卡下方，适配器模型列表移至最底部 ([666c421](https://github.com/maplezzk/llm-proxy/commit/666c4219bd84400a667e7904958a2e1897e469d5))


### Bug Fixes

* 修复 Responses 协议转换与用量统计 ([06f8c15](https://github.com/maplezzk/llm-proxy/commit/06f8c155eb90b089715947c202b4880177d129d6))
* 修复 Responses 协议转换与用量统计 ([665eafd](https://github.com/maplezzk/llm-proxy/commit/665eafd37367ae5b9b7ed885927e3f2b57a75a93))
* 修复菜单栏服务停止与退出竞态 ([d1b14d5](https://github.com/maplezzk/llm-proxy/commit/d1b14d53338eb37664437be2e4885674182709dc))
* 修复菜单栏服务停止与退出竞态 ([b7bde64](https://github.com/maplezzk/llm-proxy/commit/b7bde64a85cfbd95cf82985902d83ec2fa352bfb))
* 模型切换改回悬停子菜单（NSPopUpButton 在 NSMenu 内不响应） ([4106d3e](https://github.com/maplezzk/llm-proxy/commit/4106d3e680c06c7a6ff24cd366b02ca646b33440))
* 消除管理页静默吞异常——失败可见化（toast+console.warn）与 Capture SSE 兜底 ([6026440](https://github.com/maplezzk/llm-proxy/commit/602644054e8d1cca4c2c0defeaec0f415a12c74a))
* 状态卡宽度对齐菜单宽度，服务控制按钮等宽撑满整行 ([2e6fbd0](https://github.com/maplezzk/llm-proxy/commit/2e6fbd02be21ca8f4bee590caf51bcc1fb318462))
* 移除添加模型/添加映射文案中重复的加号前缀 ([8f8da4e](https://github.com/maplezzk/llm-proxy/commit/8f8da4eaa95747bfc286b43b37d939fa05a43f17))
* 输入 TOKEN 卡片与趋势图同口径（仅计费输入，不含缓存读取/创建） ([67537b7](https://github.com/maplezzk/llm-proxy/commit/67537b74dacd199111695353d9135c2063d66670))

## [0.22.3](https://github.com/maplezzk/llm-proxy/compare/v0.22.2...v0.22.3) (2026-07-21)


### Bug Fixes

* 修复适配器编辑表单中适配前模型 ID 输入框过窄无法输入的问题 ([#175](https://github.com/maplezzk/llm-proxy/issues/175)) ([a1e2e24](https://github.com/maplezzk/llm-proxy/commit/a1e2e24117a64f389bc097fb9806fff2c344b203))

## [0.22.2](https://github.com/maplezzk/llm-proxy/compare/v0.22.1...v0.22.2) (2026-07-18)


### Bug Fixes

* OpenAI→Anthropic 流式转换兼容 choices[0] 内嵌 usage 的上游格式 ([#173](https://github.com/maplezzk/llm-proxy/issues/173)) ([888b2ae](https://github.com/maplezzk/llm-proxy/commit/888b2aeacb285446209b3a15620e39ca749b6103))

## [0.22.1](https://github.com/maplezzk/llm-proxy/compare/v0.22.0...v0.22.1) (2026-07-09)


### Bug Fixes

* 重建 package-lock.json,resolved 指向 registry.npmjs.org ([#171](https://github.com/maplezzk/llm-proxy/issues/171)) ([91ab79b](https://github.com/maplezzk/llm-proxy/commit/91ab79bbb92de77cb4a4cc66600448917a478cf0))

## [0.22.0](https://github.com/maplezzk/llm-proxy/compare/v0.21.2...v0.22.0) (2026-07-09)


### Features

* 适配器支持 stream 默认值，前端重构为默认请求参数区块 ([#169](https://github.com/maplezzk/llm-proxy/issues/169)) ([940cc79](https://github.com/maplezzk/llm-proxy/commit/940cc79f3fc0d6d351e1c931faa62ea85863c396))

## [0.21.2](https://github.com/maplezzk/llm-proxy/compare/v0.21.1...v0.21.2) (2026-07-02)


### Bug Fixes

* 统一 DB input_tokens 语义为计费部分,dashboard 4 字段展示 ([#167](https://github.com/maplezzk/llm-proxy/issues/167)) ([51c71e3](https://github.com/maplezzk/llm-proxy/commit/51c71e30c5401e0001ef989507e801b3c6db6435))

## [0.21.1](https://github.com/maplezzk/llm-proxy/compare/v0.21.0...v0.21.1) (2026-07-02)


### Bug Fixes

* 修复流式转换器返回的 token 用量语义不一致 ([#165](https://github.com/maplezzk/llm-proxy/issues/165)) ([0588f43](https://github.com/maplezzk/llm-proxy/commit/0588f43f4ee185000b2c06f80ec3e8b71d1a363d))

## [0.21.0](https://github.com/maplezzk/llm-proxy/compare/v0.20.0...v0.21.0) (2026-07-01)


### Features

* 用量数据持久化 + Dashboard 图表化重构 ([#162](https://github.com/maplezzk/llm-proxy/issues/162)) ([189aeb5](https://github.com/maplezzk/llm-proxy/commit/189aeb500bff2164b6d3d797620f803df095e948))


### Bug Fixes

* **macOS:** 修复 ProviderFormView 删除模型行偶发崩溃(EXC_BREAKPOINT/SIGTRAP) ([#159](https://github.com/maplezzk/llm-proxy/issues/159)) ([806a483](https://github.com/maplezzk/llm-proxy/commit/806a483396a085ec0747511ecac6d41d446d5061))
* **macOS:** 修复测试面板 responseBody 非 JSON 时 NSException 闪退 ([#163](https://github.com/maplezzk/llm-proxy/issues/163)) ([dfe975a](https://github.com/maplezzk/llm-proxy/commit/dfe975a65b31d0dfa9d771300fbd2656e18a548a))
* 修复 adapter 多模态误判 + 菜单栏退出后服务残留进程 ([#161](https://github.com/maplezzk/llm-proxy/issues/161)) ([8ec3641](https://github.com/maplezzk/llm-proxy/commit/8ec3641f33746ccf68aa38c6b1a332fc4da29ad0))
* 缓存命中率公式 + stream-converter text-block 闭合 + 用量公式调研 ([#164](https://github.com/maplezzk/llm-proxy/issues/164)) ([3fc8093](https://github.com/maplezzk/llm-proxy/commit/3fc809301e045f774e17aa295aaa9c5a470a79d2))

## [0.20.0](https://github.com/maplezzk/llm-proxy/compare/v0.19.0...v0.20.0) (2026-06-22)


### Features

* 移除请求体大小限制 ([#157](https://github.com/maplezzk/llm-proxy/issues/157)) ([e5f914d](https://github.com/maplezzk/llm-proxy/commit/e5f914d8e500445b5690e5f52dc3a601d8844bf6))

## [0.19.0](https://github.com/maplezzk/llm-proxy/compare/v0.18.1...v0.19.0) (2026-06-21)


### Features

* max_tokens 兜底 16384 + reasoning_effort 映射 Anthropic budget_tokens ([#155](https://github.com/maplezzk/llm-proxy/issues/155)) ([8b4d3cd](https://github.com/maplezzk/llm-proxy/commit/8b4d3cd19dc53ab03bfc8e949704989ed675584f))


### Bug Fixes

* 修复长时间运行的内存泄漏问题 ([#154](https://github.com/maplezzk/llm-proxy/issues/154)) ([86ba876](https://github.com/maplezzk/llm-proxy/commit/86ba876e4ec86d866bf01cb1f91db18199209342))

## [0.18.1](https://github.com/maplezzk/llm-proxy/compare/v0.18.0...v0.18.1) (2026-06-19)


### Bug Fixes

* 供应商保存时 [object Object] 错误 + macOS APP 错误吞掉 + Web 端 [@change](https://github.com/change) 失效 ([#152](https://github.com/maplezzk/llm-proxy/issues/152)) ([c0131a6](https://github.com/maplezzk/llm-proxy/commit/c0131a6380a6ab01458d79dba9c61b59b2696dfc))

## [0.18.0](https://github.com/maplezzk/llm-proxy/compare/v0.17.0...v0.18.0) (2026-06-19)


### Features

* 外挂识图结果缓存（图片→描述 LRU 缓存）+ tool_result 嵌套图片修复 ([#149](https://github.com/maplezzk/llm-proxy/issues/149)) ([#149](https://github.com/maplezzk/llm-proxy/issues/149)) ([b8fd092](https://github.com/maplezzk/llm-proxy/commit/b8fd092859207e22fc57963cb022a9d264070d8c))

## [0.17.0](https://github.com/maplezzk/llm-proxy/compare/v0.16.8...v0.17.0) (2026-06-19)


### Features

* 外挂识图(非多模态模型识图) + 配置 UI + 菜单栏状态机重构 ([#146](https://github.com/maplezzk/llm-proxy/issues/146)) ([53a5a5a](https://github.com/maplezzk/llm-proxy/commit/53a5a5abd3a30cd13b2a51e8a5d07353182f21c9))
* 支持 MiniMax thinking.type 透传配置 + 用户配置优先覆盖 ([#148](https://github.com/maplezzk/llm-proxy/issues/148)) ([b3efd73](https://github.com/maplezzk/llm-proxy/commit/b3efd731fa5f4a59bf9b1fd1c03628a3023356ff))


### Bug Fixes

* writeConfig 加校验防止保存无效配置 + macOS App 显示完整错误 + 启动失败写日志 ([#145](https://github.com/maplezzk/llm-proxy/issues/145)) ([2c75df4](https://github.com/maplezzk/llm-proxy/commit/2c75df4584104336e35c282706376d851ee545a1))

## [0.16.8](https://github.com/maplezzk/llm-proxy/compare/v0.16.7...v0.16.8) (2026-06-18)


### Bug Fixes

* 修复应用内自动更新安装后退出 + 排查日志 + 回归修复 ([#143](https://github.com/maplezzk/llm-proxy/issues/143)) ([80cc817](https://github.com/maplezzk/llm-proxy/commit/80cc81723b5c07439e5a9b09b9ddeb398fb41162))

## [0.16.7](https://github.com/maplezzk/llm-proxy/compare/v0.16.6...v0.16.7) (2026-06-18)


### Bug Fixes

* 修复 OpenAI→Anthropic 流式转换 usage 丢失与 cache 计算错误 ([#140](https://github.com/maplezzk/llm-proxy/issues/140)) ([7a1ddd2](https://github.com/maplezzk/llm-proxy/commit/7a1ddd2fca8f15e806b68bf20f1e22dfbb1aa5e3))

## [0.16.6](https://github.com/maplezzk/llm-proxy/compare/v0.16.5...v0.16.6) (2026-06-18)


### Bug Fixes

* 修复 macOS 自动更新 hdiutil attach 失败 ([#138](https://github.com/maplezzk/llm-proxy/issues/138)) ([963d466](https://github.com/maplezzk/llm-proxy/commit/963d46682861c4de2221d5329e1db9e8db922d30))

## [0.16.5](https://github.com/maplezzk/llm-proxy/compare/v0.16.4...v0.16.5) (2026-06-17)


### Bug Fixes

* 修复 macOS 控制台供应商测试按钮重复点击不生效 ([#137](https://github.com/maplezzk/llm-proxy/issues/137)) ([d26ce7c](https://github.com/maplezzk/llm-proxy/commit/d26ce7c587f070154eb5ec831ed5e4fd24e81257))
* 修复 OpenAI→Anthropic 流式转换 content+finish_reason 同 chunk 处理及无 [DONE] 补发 message_stop ([#135](https://github.com/maplezzk/llm-proxy/issues/135)) ([bc61dfa](https://github.com/maplezzk/llm-proxy/commit/bc61dfa5a25fa5345f03c95686ebf85ad1e7c536))

## [0.16.4](https://github.com/maplezzk/llm-proxy/compare/v0.16.3...v0.16.4) (2026-06-09)


### Bug Fixes

* 修复 OpenAI→Anthropic 流式转换重复 message_start ([#134](https://github.com/maplezzk/llm-proxy/issues/134)) ([c20e633](https://github.com/maplezzk/llm-proxy/commit/c20e633a010e328078b16d855c5901eee26ee928))
* 修复跨协议转换中图片消息处理的 5 个 bug ([#132](https://github.com/maplezzk/llm-proxy/issues/132)) ([f559747](https://github.com/maplezzk/llm-proxy/commit/f5597473e64cf54f5bc773672e27956d58ee81ab))

## [0.16.3](https://github.com/maplezzk/llm-proxy/compare/v0.16.2...v0.16.3) (2026-06-02)


### Bug Fixes

* 定时检查也弹窗提示（受24h延迟限制） ([#131](https://github.com/maplezzk/llm-proxy/issues/131)) ([e071add](https://github.com/maplezzk/llm-proxy/commit/e071adde44430f78a663efc8cde017be3da6974a))
* 更新检查优化 — 5分钟定时检查 + Later延迟24h + 自动更新开关 ([#129](https://github.com/maplezzk/llm-proxy/issues/129)) ([256186f](https://github.com/maplezzk/llm-proxy/commit/256186fa4274e181d5a64094ca6516ca0409b3aa))

## [0.16.2](https://github.com/maplezzk/llm-proxy/compare/v0.16.1...v0.16.2) (2026-06-02)


### Bug Fixes

* macOS 控制台 UI 多项问题修复 ([#127](https://github.com/maplezzk/llm-proxy/issues/127)) ([5bb003e](https://github.com/maplezzk/llm-proxy/commit/5bb003e96f689869beeb9b73d1e52ad68b8a649a))

## [0.16.1](https://github.com/maplezzk/llm-proxy/compare/v0.16.0...v0.16.1) (2026-06-01)


### Bug Fixes

* 修复抓包开启时 subscribers 句柄泄漏导致内存持续增长 ([#125](https://github.com/maplezzk/llm-proxy/issues/125)) ([9d5bfe3](https://github.com/maplezzk/llm-proxy/commit/9d5bfe3ea6d6530582e1ef1ca7b894d57c8f3e8a))

## [0.16.0](https://github.com/maplezzk/llm-proxy/compare/v0.15.1...v0.16.0) (2026-05-30)


### Features

* macOS 原生管理控制台 ([#122](https://github.com/maplezzk/llm-proxy/issues/122)) ([b7a4d72](https://github.com/maplezzk/llm-proxy/commit/b7a4d720cd6ed0ab1765a2b0912ac621a7fca61d))


### Bug Fixes

* 修复删除供应商/适配器确认弹窗不显示的问题 ([#123](https://github.com/maplezzk/llm-proxy/issues/123)) ([aace069](https://github.com/maplezzk/llm-proxy/commit/aace069a4b20de7ec2d4808d4859b28a2bd08108))

## [0.15.1](https://github.com/maplezzk/llm-proxy/compare/v0.15.0...v0.15.1) (2026-05-28)


### Bug Fixes

* 修复 Anthropic 协议上 namespace 工具丢失 + exec_command 误剥离 ([#120](https://github.com/maplezzk/llm-proxy/issues/120)) ([aa2247b](https://github.com/maplezzk/llm-proxy/commit/aa2247bed2f3a06684bcd9c65412567e1afda4ac))

## [0.15.0](https://github.com/maplezzk/llm-proxy/compare/v0.14.1...v0.15.0) (2026-05-28)


### Features

* OpenAI Responses API 跨协议完整转换（支持 Codex computer-use + namespace 工具） ([#116](https://github.com/maplezzk/llm-proxy/issues/116)) ([76ce6d4](https://github.com/maplezzk/llm-proxy/commit/76ce6d4ba3c70ec453f4332dc9d69f6591b06191))


### Bug Fixes

* 修复供应商远程模型导入勾选bug + 适配器一键导入供应商全部模型 ([#119](https://github.com/maplezzk/llm-proxy/issues/119)) ([b8b5ec1](https://github.com/maplezzk/llm-proxy/commit/b8b5ec13ae00cceeb6288035c7202e55d7137daf))

## [0.14.1](https://github.com/maplezzk/llm-proxy/compare/v0.14.0...v0.14.1) (2026-05-24)


### Bug Fixes

* stream 默认流式 + 清除 thinking 占位文案 + reasoning_signature 移入 finish chunk ([#114](https://github.com/maplezzk/llm-proxy/issues/114)) ([b1a59fd](https://github.com/maplezzk/llm-proxy/commit/b1a59fd8c3aceafea87d94bfb5ecdd66b50dea9a))

## [0.14.0](https://github.com/maplezzk/llm-proxy/compare/v0.13.1...v0.14.0) (2026-05-21)


### Features

* 端口配置持久化 + 菜单栏端口设置 + 启动失败弹窗 ([#111](https://github.com/maplezzk/llm-proxy/issues/111)) ([15284fc](https://github.com/maplezzk/llm-proxy/commit/15284fc86694c2dfe3ee249803028fee498f4166))
* 菜单栏启动时自动启动代理服务 ([#112](https://github.com/maplezzk/llm-proxy/issues/112)) ([8dcc39f](https://github.com/maplezzk/llm-proxy/commit/8dcc39f2bf02a8e8b5d4d25ccee561dab56525a7))

## [0.13.1](https://github.com/maplezzk/llm-proxy/compare/v0.13.0...v0.13.1) (2026-05-21)


### Bug Fixes

* 修复自动更新下载/安装多个问题 ([#109](https://github.com/maplezzk/llm-proxy/issues/109)) ([5e37f12](https://github.com/maplezzk/llm-proxy/commit/5e37f120181477b4f8c0596b783bb7dfad616cb7))

## [0.13.0](https://github.com/maplezzk/llm-proxy/compare/v0.12.5...v0.13.0) (2026-05-21)


### Features

* 直通流式请求支持 token 统计（含缓存命中） ([#108](https://github.com/maplezzk/llm-proxy/issues/108)) ([0fda9d4](https://github.com/maplezzk/llm-proxy/commit/0fda9d4c28e704648f53920b77c5b82059648bdd))


### Bug Fixes

* 修复协议抓包导致的内存泄露 ([#106](https://github.com/maplezzk/llm-proxy/issues/106)) ([67e2793](https://github.com/maplezzk/llm-proxy/commit/67e279331365ab5831acb25b4c1757013631dbcd))

## [0.12.5](https://github.com/maplezzk/llm-proxy/compare/v0.12.4...v0.12.5) (2026-05-19)


### Bug Fixes

* 修复更新下载临时目录不存在导致移动失败 ([#104](https://github.com/maplezzk/llm-proxy/issues/104)) ([93c4bea](https://github.com/maplezzk/llm-proxy/commit/93c4bea7cee9fb6e64bc87f7b1eb04bd2963f220))

## [0.12.4](https://github.com/maplezzk/llm-proxy/compare/v0.12.3...v0.12.4) (2026-05-19)


### Bug Fixes

* 修复 Anthropic/Responses API 跨协议 reasoning 丢失 ([#102](https://github.com/maplezzk/llm-proxy/issues/102)) ([8cc89a5](https://github.com/maplezzk/llm-proxy/commit/8cc89a56d1eef3851eccdab89e2af9a49fee0097))

## [0.12.3](https://github.com/maplezzk/llm-proxy/compare/v0.12.2...v0.12.3) (2026-05-17)


### Bug Fixes

* 修复Bundle.module崩溃，改用安全资源加载 ([210f062](https://github.com/maplezzk/llm-proxy/commit/210f0626c5d3a927e27d3609d9966b2625ecea46))
* 修复Bundle.module崩溃，改用安全资源加载 ([f95e717](https://github.com/maplezzk/llm-proxy/commit/f95e717ce12501cfeefc2861aa50a2933b7676df))

## [0.12.2](https://github.com/maplezzk/llm-proxy/compare/v0.12.1...v0.12.2) (2026-05-17)


### Bug Fixes

* 修复macOS菜单栏图标模糊问题 ([b718bad](https://github.com/maplezzk/llm-proxy/commit/b718bad59103e60f3cb689a4737bb94e75dca6ea))
* 修复macOS菜单栏图标模糊问题，支持Retina多分辨率渲染 ([adba183](https://github.com/maplezzk/llm-proxy/commit/adba1837fd68432d5614a62c64233bac9e422ee2))

## [0.12.1](https://github.com/maplezzk/llm-proxy/compare/v0.12.0...v0.12.1) (2026-05-16)


### Bug Fixes

* 抓包默认关闭，需手动点击「开始」启用 ([fc4e0e6](https://github.com/maplezzk/llm-proxy/commit/fc4e0e660259d6a2842d21100efb7c944028ff7d))
* 抓包默认关闭，需手动点击「开始」启用 ([7c2948e](https://github.com/maplezzk/llm-proxy/commit/7c2948eaf17acc22cf777b73cd47ba18fe3ef9ab))

## [0.12.0](https://github.com/maplezzk/llm-proxy/compare/v0.11.4...v0.12.0) (2026-05-16)


### Features

* 后端抓包支持启用/禁用开关 ([d4f2fe5](https://github.com/maplezzk/llm-proxy/commit/d4f2fe5e9459fc7dfd5afd6e88c97cd653b25bec))
* 后端抓包支持启用/禁用开关（前端停止按钮同步控制后端） ([ee53e03](https://github.com/maplezzk/llm-proxy/commit/ee53e030a1dc95235b37ad995196428432936574))


### Bug Fixes

* init() 先查询后端状态，已停止时不再自动启用 ([5c962cb](https://github.com/maplezzk/llm-proxy/commit/5c962cb6944ccaec4602039933ad66a98501a9da))
* 入站请求路径自动折叠双 /v1/v1 为 /v1 ([05aaa90](https://github.com/maplezzk/llm-proxy/commit/05aaa902e278963436e115cb31a7a5347e38aff0))
* 入站请求路径自动折叠双 /v1/v1 为 /v1 ([d37026b](https://github.com/maplezzk/llm-proxy/commit/d37026b34cda8dbc2a67e736570f43fee4acd7d0))

## [0.11.4](https://github.com/maplezzk/llm-proxy/compare/v0.11.3...v0.11.4) (2026-05-15)


### Bug Fixes

* CI 清除 Swift 全量构建缓存 ([32afbcf](https://github.com/maplezzk/llm-proxy/commit/32afbcfd4447969deda1dfd64744d963a262b510))
* CI 清除 Swift 全量构建缓存而非仅 .build 子目录 ([e4744f1](https://github.com/maplezzk/llm-proxy/commit/e4744f1853a08b98dab846e09938d34b47c7867b))

## [0.11.3](https://github.com/maplezzk/llm-proxy/compare/v0.11.2...v0.11.3) (2026-05-15)


### Bug Fixes

* CI 构建清空 Swift 缓存 + DMG 上传覆盖 ([#87](https://github.com/maplezzk/llm-proxy/issues/87)) ([413fdd3](https://github.com/maplezzk/llm-proxy/commit/413fdd3f708dc717c198e89dab1fd96090974df1))

## [0.11.2](https://github.com/maplezzk/llm-proxy/compare/v0.11.1...v0.11.2) (2026-05-15)


### Bug Fixes

* 缓存菜单栏图标避免轮询时重复新建导致图标消失 ([#85](https://github.com/maplezzk/llm-proxy/issues/85)) ([7704101](https://github.com/maplezzk/llm-proxy/commit/77041014cd963b61d1f9913356962caf3af46824))

## [0.11.1](https://github.com/maplezzk/llm-proxy/compare/v0.11.0...v0.11.1) (2026-05-15)


### Bug Fixes

* 适配器URL去重、校验提示优化、模型测试可观测性 ([#83](https://github.com/maplezzk/llm-proxy/issues/83)) ([54dceb5](https://github.com/maplezzk/llm-proxy/commit/54dceb5c9f96d36987bfc3d3c3a55a2dca0b5afc))

## [0.11.0](https://github.com/maplezzk/llm-proxy/compare/v0.10.2...v0.11.0) (2026-05-08)


### Features

* DMG 增加 Applications 快捷方式，支持一键拖拽安装 ([#81](https://github.com/maplezzk/llm-proxy/issues/81)) ([20abafe](https://github.com/maplezzk/llm-proxy/commit/20abafefc89fa4b5909ca32ec057b52c582d516e))

## [0.10.2](https://github.com/maplezzk/llm-proxy/compare/v0.10.1...v0.10.2) (2026-05-07)


### Bug Fixes

* 归一化 input_tokens 为总输入，缓存命中率用 cache_read / total_input ([#79](https://github.com/maplezzk/llm-proxy/issues/79)) ([113c19e](https://github.com/maplezzk/llm-proxy/commit/113c19ebb8f859392ab22774bcb5500cc5a25774))

## [0.10.1](https://github.com/maplezzk/llm-proxy/compare/v0.10.0...v0.10.1) (2026-05-07)


### Bug Fixes

* Anthropic→OpenAI 转换时 prompt_tokens 应包含缓存命中 token ([#77](https://github.com/maplezzk/llm-proxy/issues/77)) ([ab92055](https://github.com/maplezzk/llm-proxy/commit/ab920551f252ddfd70cdb4371d5f8d180fc429f7))

## [0.10.0](https://github.com/maplezzk/llm-proxy/compare/v0.9.0...v0.10.0) (2026-05-04)


### Features

* 增加 /admin/locale API，macOS app 和 Admin UI 语言同步 ([#74](https://github.com/maplezzk/llm-proxy/issues/74)) ([3eb5b79](https://github.com/maplezzk/llm-proxy/commit/3eb5b792828c508d461432f09caf7ac8a343b80c))

## [0.9.0](https://github.com/maplezzk/llm-proxy/compare/v0.8.0...v0.9.0) (2026-05-04)


### Features

* **macos-app:** 菜单合并、状态文字对比度优化、调试模式启动支持 ([#71](https://github.com/maplezzk/llm-proxy/issues/71)) ([93b04d6](https://github.com/maplezzk/llm-proxy/commit/93b04d61a87348b9b739e6da046e2136172bd829))
* **macos-app:** 菜单重设计 — 合并按钮、统一图标、适配器信息展示 ([#72](https://github.com/maplezzk/llm-proxy/issues/72)) ([1bc3cea](https://github.com/maplezzk/llm-proxy/commit/1bc3ceac6f70dd7dc3526437456710d5ad04cb1d))


### Bug Fixes

* 流式转换器从 message_start 事件提取 usage 防止 cache_create 丢失 ([#69](https://github.com/maplezzk/llm-proxy/issues/69)) ([d2e29c0](https://github.com/maplezzk/llm-proxy/commit/d2e29c0a833ad07b481d0c34008ba7ef09120eb5))

## [0.8.0](https://github.com/maplezzk/llm-proxy/compare/v0.7.1...v0.8.0) (2026-05-03)


### Features

* **admin-ui:** 侧栏增加配置重载按钮 ([#66](https://github.com/maplezzk/llm-proxy/issues/66)) ([4b508bd](https://github.com/maplezzk/llm-proxy/commit/4b508bd38a64d0a8c6727f088bccc83980b92d93))
* **macos-app:** 菜单栏增加重载配置菜单项 ([#67](https://github.com/maplezzk/llm-proxy/issues/67)) ([88bbd7a](https://github.com/maplezzk/llm-proxy/commit/88bbd7ae969c9159c2be44b2fa46eafe3fed6a6e))

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
