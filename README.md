# llm-proxy

本地统一 LLM 模型代理工具 — 热加载配置管理模块。

## 安装

```bash
npm install -g llm-proxy

# 或本地开发
git clone <repo>
cd llm-proxy
npm install
npm run build
```

## 配置

编辑 `~/.llm-proxy/config.yaml`：

```yaml
providers:
  - name: anthropic-main
    type: anthropic
    api_key: ${ANTHROPIC_API_KEY}
    models:
      - name: claude-sonnet
        model: claude-sonnet-4-20250514
      - name: claude-haiku
        model: claude-3-haiku-20240307

  - name: openai-main
    type: openai
    api_key: ${OPENAI_API_KEY}
    models:
      - name: gpt-4o
        model: gpt-4o
      - name: gpt-4o-mini
        model: gpt-4o-mini
```

API Key 通过环境变量注入，配置文件本身不保存明文密钥。

## 使用

```bash
# 启动代理
llm-proxy start

# 修改配置后重新加载（零中断）
llm-proxy reload

# 查看状态
llm-proxy status

# 停止代理
llm-proxy stop
```

## 管理 API

代理启动后在 `http://127.0.0.1:9000` 提供管理 API：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/admin/config` | GET | 查看当前配置（Key 脱敏） |
| `/admin/config/reload` | POST | 重新加载配置 |
| `/admin/health` | GET | 健康检查 |
| `/admin/status/providers` | GET | Provider 状态统计 |

## 开发

```bash
npm test              # 运行测试
npm run dev           # 开发模式运行
npm run typecheck     # 类型检查
npm run build         # 构建
```

## 架构

- **TypeScript (Node.js)**，运行时依赖仅 `yaml` 库
- 配置通过 YAML 编辑 + `POST /admin/config/reload` 热加载
- 运行时配置原子替换，进行中请求不受影响
- 零依赖 Promise 链式 Mutex 处理并发
