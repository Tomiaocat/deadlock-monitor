# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

MySQL 死锁监控可视化工具，支持**多目标监控**，实时展示多个 MySQL 实例的死锁信息。

## 快速开始

### Docker Compose（推荐）

```bash
# 启动所有服务
docker-compose up -d

# 访问 http://localhost:3000
```

### 本地开发

```bash
# 安装依赖
npm install

# 启动服务（默认端口 3000）
node server.js

# 访问 http://localhost:3000
```

## 环境配置

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `DB_HOST` | `mysql` | MySQL 主机（Docker 内）/ `172.17.0.1`（本地） |
| `DB_PORT` | `3306` | MySQL 端口 |
| `DB_USER` | `root` | MySQL 用户名 |
| `DB_PASSWORD` | `root` | MySQL 密码 |
| `DB_NAME` | `deadlock_monitor` | 数据库名 |
| `PORT` | `3000` | 服务端口 |

## 数据库初始化

执行 `init.sql` 创建数据库和表：
```bash
mysql -u root -p < init.sql
```

### 数据表结构

- **monitor_tasks**: 监控任务配置表（多目标监控）
- **deadlocks**: 死锁记录表（含 `source_server` 字段标识数据来源）

## 架构设计

### 单容器多进程架构

```
┌─────────────────────────────────────────┐
│  deadlock-monitor 容器                   │
│  ┌─────────────────────────────────┐    │
│  │  Supervisor (进程管理器)          │    │
│  │  ├─ Node.js Web 服务 (server.js) │    │
│  │  └─ 监控管理器 (monitor-manager.js)│   │
│  │      └─ 管理多个 pt-deadlock-logger │  │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

### 组件说明

| 文件 | 职责 |
|------|------|
| `server.js` | Express 服务器，提供 API 和静态文件服务 |
| `monitor-manager.js` | 监控任务管理器，动态启停 pt-deadlock-logger 进程 |
| `supervisord.conf` | Supervisor 配置，管理两个进程 |
| `public/index.html` | 前端页面，支持任务管理和数据展示 |

## API 接口

### 死锁数据
- `GET /api/deadlocks` - 获取死锁列表（支持 `?source=` 参数过滤）
- `GET /api/latest` - 获取最新死锁时间戳
- `GET /api/tasks/sources` - 获取数据源列表（用于过滤）

### 历史记录
- `GET /api/history` - 获取历史死锁记录（支持多字段组合搜索和分页）
  - 查询参数：
    - `source_server`: 目标 IP
    - `lock_type`: 锁类型
    - `lock_mode`: 锁模式
    - `idx`: 索引（模糊搜索）
    - `tbl`: 表名（模糊搜索）
    - `db`: 数据库名（模糊搜索）
    - `ip`: 客户端 IP
    - `hostname`: 主机名（模糊搜索）
    - `user`: 数据库用户
    - `wait_hold`: 锁状态（W=等待中，H=已持有）
    - `victim`: 是否牺牲品（1=是，0=否）
    - `query`: SQL 全文搜索（模糊搜索）
    - `date_from`: 开始日期（ISO 格式）
    - `date_to`: 结束日期（ISO 格式）
    - `page`: 页码（默认 1）
    - `pageSize`: 每页数量（默认 50）
  - 返回：`{ total, page, pageSize, totalPages, data: [...] }`
- `GET /api/history/filters` - 获取动态筛选选项
  - 返回：`{ source_servers: [], lock_types: [], lock_modes: [], databases: [], tables: [] }`

### 任务管理
- `GET /api/tasks` - 获取监控任务列表
- `GET /api/tasks/:id` - 获取单个任务
- `POST /api/tasks` - 创建监控任务
- `PUT /api/tasks/:id` - 更新监控任务
- `DELETE /api/tasks/:id` - 删除监控任务
- `POST /api/tasks/:id/toggle` - 启停监控任务
- `GET /api/status` - 获取监控状态

## Docker 部署

```bash
# 构建镜像
docker build -t deadlock-monitor:latest .

# 运行容器
docker run -d --name deadlock-monitor --network host \
  -e DB_HOST=172.17.0.1 \
  -e DB_USER=root \
  -e DB_PASSWORD=root \
  -e DB_NAME=deadlock_monitor \
  deadlock-monitor:latest
```

## 使用说明

1. **访问 Web 界面**：http://localhost:9527
2. **切换到「监控任务」标签**
3. **添加监控任务**：
   - 填写目标 MySQL 信息（IP、端口、账号、密码）
   - 设置监控周期（5/10/30/60/120 秒）
   - 选择存储类型（本地 MySQL 或外部 MySQL）
4. **查看死锁数据**：
   - **实时死锁**：切换到「实时死锁」标签，可查看最近 100 条死锁记录，按数据源过滤
   - **历史记录**：切换到「历史记录」标签，支持多字段组合搜索、分页、导出 CSV
     - 搜索字段：目标 IP、锁类型、锁模式、表名、索引、数据库名、客户端 IP、主机名、用户、锁状态、是否牺牲品、日期范围、SQL 全文搜索
     - 分页控制：首页、上一页、下一页、末页，可调整每页数量（20/50/100/200）
     - 导出功能：点击「导出 CSV」按钮导出当前搜索结果

## 前端页面

### 三个标签页

1. **实时死锁**：展示最近 100 条死锁记录，支持按数据源过滤，自动刷新
2. **历史记录**：多字段组合搜索、分页展示、CSV 导出
3. **监控任务**：任务的增删改查、启停控制

## 技术架构

- **后端**: Node.js (ESM) + Express + mysql2
- **前端**: 原生 HTML/CSS/JavaScript，深色主题 UI
- **进程管理**: Supervisor
- **数据采集**: pt-deadlock-logger (Percona Toolkit)
- **数据库**: MySQL 8.0

## 注意事项

1. **密码安全**: 当前密码以明文存储在数据库中，生产环境建议加密
2. **日志管理**: 日志文件位于 `/var/log/` 目录下
3. **健康检查**: 监控进程每 10 秒同步一次配置，异常自动重启
