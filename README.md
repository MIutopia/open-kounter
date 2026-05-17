# Open Kounter

Open Kounter 是一个基于 EdgeOne Pages Functions 和 Blob 存储的无服务器计数器服务，旨在替代 LeanCloud 为静态网站（如 Hexo）提供 PV/UV 统计功能。它包含一个完整的管理后台，支持数据管理、导入导出、域名白名单、旧版 KV 一键迁移和 Passkey 无密码登录。

![Open Kounter Demo](./other/demoOfAdmin.webp)

更详细的介绍和部署指南请参考：
- [LeanCloud 遗憾谢幕：基于 EdgeOne KV 打造高性能 PV/UV 访客统计](https://www.mintimate.cn/2026/02/14/openKounter/)

## EdgeOne Pages 上部署

你可以通过 EdgeOne Pages 一键部署或手动配置构建：

一键部署：

[![使用 EdgeOne Pages 部署](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://console.cloud.tencent.com/edgeone/pages/new?repository-url=https://github.com/Mintimate/open-kounter)

> **注意**：点击上方按钮前，建议先 Fork 本仓库，并在跳转后的页面中确认仓库地址为你 Fork 后的地址。

手动部署配置：

- 框架预设：Node.js（或留空，EdgeOne 会识别 `edgeone.json`）
- 构建命令：`npm run build`
- 输出目录：`dist`
- Node 版本：`22`

更多 EdgeOne Pages文档：https://pages.edgeone.ai/zh/document/product-introduction

### 为什么从 KV 切换到 Blob

Open Kounter 早期使用 EdgeOne Pages KV 保存计数器、配置和认证信息，但 KV 的全球同步是最终一致模型，在多节点场景下会有明显同步延迟。

- 计数器刚写入后，后台列表或下一次读取可能短时间内看不到最新值。
- 域名白名单、Token、Passkey 相关状态在边缘节点之间同步时，也可能出现短暂不一致。
- 对于计数器这类“写完就要立刻读到最新结果”的场景，KV 的全球同步延迟会直接影响可用性。

现在主存储已经切换为 Blob，并在核心读取路径中使用强一致读取。这样做的目标很明确：解决 KV 全球同步存在延迟的问题，让计数、配置和认证状态在写入后能更快、更稳定地读到最新值。

### 配置 Blob 存储（必需）

本项目使用 Blob 作为主存储，部署后会在 cloud-functions 中自动创建并使用名为 `open-kounter` 的 Blob Store。

1. **开启 Blob 能力**
  - 在 EdgeOne Pages 控制台进入项目设置 > 存储
  - 确认项目已开通 Blob 能力

2. **首次访问自动创建 Store**
  - 默认会使用 `open-kounter` 作为 Blob Store 名称
  - 如需自定义名称，可设置环境变量 `OPEN_KOUNTER_BLOB_STORE`

3. **Passkey 域名配置（可选）**
  - Passkey 默认会使用当前页面 `Origin` 的 hostname 作为 RP ID
  - 如需固定 RP ID 或跨环境统一配置，可设置环境变量 `PASSKEY_RP_ID`
  - 如需自定义显示名称，可设置环境变量 `PASSKEY_RP_NAME`

4. **重新部署项目**
  - 启用 Blob 或调整环境变量后建议重新部署

### 旧版 KV 迁移（可选）

如果你是从旧版 KV 存储迁移，请额外绑定旧 KV 命名空间，变量名仍为：`OPEN_KOUNTER`。

- 新部署且没有历史数据时，不需要绑定 KV。
- 已有旧 KV 数据时，可在登录页或后台“数据备份”面板中点击“旧 KV 迁移到 Blob”。

### 初始化

部署并配置完成后，访问你的项目网址，首次访问将引导你设置管理员 Token。


## 目录结构与文件说明

```tree
.
├── client/
│   └── adapter.js          # 客户端适配器，模拟 LeanCloud 行为
├── cloud-functions/        # 主后端逻辑 (Blob API)
│   └── api/
│       ├── auth.js         # 认证逻辑
│       ├── counter.js      # 核心计数器逻辑
│       ├── init.js         # 初始化与迁移接口
│       └── passkey.js      # Passkey 相关逻辑
├── edge-functions/         # 兼容旧版 KV 的迁移出口
│   └── legacy-api/
│       └── migrate.js      # 导出旧 KV 数据供 Blob 导入
├── src/                    # 前端管理后台 (Vue 3 + Vite)
│   ├── components/
│   │   ├── dashboard/
│   │   │   ├── CounterList.vue          # 计数器列表
│   │   │   ├── DataBackup.vue           # 数据备份与恢复
│   │   │   ├── DomainConfig.vue         # 域名白名单配置
│   │   │   ├── PasskeyManager.vue       # Passkey 管理
│   │   │   ├── SingleCounterManager.vue # 单个计数器管理
│   │   │   └── TotalStats.vue           # 统计概览
│   │   ├── Dashboard.vue   # 仪表盘主组件
│   │   └── Login.vue       # 登录组件
│   ├── utils/              # 工具函数
│   ├── App.vue             # 主应用组件
│   ├── main.js             # 入口文件
│   └── style.css           # 全局样式
├── edgeone.json            # EdgeOne 配置文件
├── index.html              # HTML 入口
├── package.json            # 项目依赖
├── tailwind.config.js      # Tailwind 配置
└── vite.config.js          # Vite 配置
```

## API 接口文档

所有 API 的基础路径为 `/api`。

### 公开接口 (无需认证)

#### 1. 获取计数
- **URL**: `GET /api/counter`
- **参数**: `target` (必填，计数器的 Key，如 `site-pv`)
- **响应**:
  ```json
  {
    "code": 0,
    "data": {
      "time": 100,
      "target": "site-pv",
      "created_at": 1700000000000,
      "updated_at": 1700000000000
    }
  }
  ```

#### 2. 增加计数 (自增)
- **URL**: `POST /api/counter`
- **Body**:
  ```json
  {
    "action": "inc",
    "target": "site-pv"
  }
  ```
- **说明**: 受域名白名单限制。

#### 3. 批量增加计数
- **URL**: `POST /api/counter`
- **Body**:
  ```json
  {
    "action": "batch_inc",
    "requests": [
      { "target": "site-pv" },
      { "target": "/posts/hello-world/" }
    ]
  }
  ```
- **说明**: 常用于同时更新站点总 PV 和单页 PV。受域名白名单限制。

### 管理接口 (需要认证)

需要在 Header 中携带 `Authorization: Bearer <YOUR_TOKEN>`。

#### 1. 设置计数器值
- **URL**: `POST /api/counter`
- **Body**:
  ```json
  {
    "action": "set",
    "target": "site-pv",
    "value": 1000
  }
  ```

#### 2. 删除计数器
- **URL**: `POST /api/counter`
- **Body**:
  ```json
  {
    "action": "delete",
    "target": "site-pv"
  }
  ```

#### 3. 获取计数器列表
- **URL**: `POST /api/counter`
- **Body**:
  ```json
  {
    "action": "list",
    "page": 1,
    "pageSize": 20
  }
  ```

#### 4. 导出所有数据
- **URL**: `POST /api/counter`
- **Body**: `{ "action": "export_all" }`
- **响应**: 包含所有计数器数据和配置的 JSON 对象。

#### 5. 导入数据
- **URL**: `POST /api/counter`
- **Body**:
  ```json
  {
    "action": "import_all",
    "data": { ... } // 导出的 JSON 数据
  }
  ```

#### 6. 配置域名白名单
- **URL**: `POST /api/counter`
- **Body**:
  ```json
  {
    "action": "set_config",
    "allowedDomains": ["example.com", "*.example.com"]
  }
  ```

## 许可证

本项目基于 [MIT License](./LICENSE) 开源。
