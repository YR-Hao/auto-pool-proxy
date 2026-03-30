# Codex Switchboard

一个单机版、本地优先的 OpenAI 兼容代理，目标是解决：

- Codex CLI 始终只连一个本地入口
- 本地代理负责在多个官方订阅号和第三方号池之间切换
- 只保留参考 [sub2api](https://github.com/Wei-Shaw/sub2api) 里真正有用的核心能力：账号管理、故障切换、token/cost 统计、Web 仪表盘

## 设计原则

- 不做用户系统
- 不做拼车和订阅管理
- 不引入 Redis / Postgres
- 不做会话粘性和历史修复
- 单进程 + SQLite
- Web 界面只做本地运维，不做复杂后台

## 架构

```text
Codex CLI -> http://127.0.0.1:5728 -> 当前上游 / 备用上游 / 号池
                                  \
                                   -> SQLite: upstreams / usage_logs
```

关键行为：

1. 默认把请求转发到当前默认上游。
2. 当前上游失败时，自动按优先级尝试其他已启用上游。
3. 你切换默认上游，影响的是之后的所有请求。
4. 这个项目只负责代理中转，不负责修复 Codex 自己的会话历史问题。

## 功能

- 上游管理：添加、启用/禁用、设默认、优先级
- 自动故障切换：默认上游失败时降级到可用上游
- 用量统计：请求数、token、cost、最近请求
- 本地代理：透传 OpenAI 兼容请求，支持 JSON 和 SSE

## 成本统计

成本不硬编码官方价格，而是每个上游自己维护 `pricingRules`。这样你可以：

- 按官方订阅号和第三方号池分别配置价格
- 按模型通配符配置，例如 `gpt-5*`
- 避免价格变动时代码过期

示例：

```json
[
  {
    "match": "gpt-5*",
    "inputPerMillion": 5,
    "outputPerMillion": 15
  }
]
```

## 运行

```bash
pnpm install
pnpm dev
```

默认监听：

- 代理和 Web：`http://127.0.0.1:5728`
- 数据库：`./data/switchboard.sqlite`
- 启动时导入上游：`./upstreams.json`

可选环境变量：

```bash
HOST=127.0.0.1
PORT=5728
DATA_DIR=./data
UPSTREAMS_CONFIG_PATH=./upstreams.json
REQUEST_TIMEOUT_MS=300000
ADMIN_TOKEN=your-token
```

`upstreams.json` 会在服务启动时自动导入到本地数据库；如果同名上游已经存在，会按文件内容更新。

如果设置了 `ADMIN_TOKEN`，访问 `/api/*` 时需要带：

```bash
Authorization: Bearer your-token
```

## Codex CLI 接入思路

把 Codex 的 OpenAI Base URL 指向本地代理地址，然后让它始终打到同一个本地入口。这样你切换的只是本地代理背后的默认上游，而不是 Codex 的入口本身。

这个代理不尝试接管或修复 Codex 的会话历史；它只负责“把请求稳定地转到你当前想用的上游”。

## 参考来源

- [Sub2API README](https://github.com/Wei-Shaw/sub2api)
- 它保留给我的核心启发是：多账号调度、失败切换、token 计费、仪表盘
- 这个项目故意删掉了它的用户系统、订阅体系、Redis、sticky session 和复杂管理面
