# Deadlock Monitor

MySQL 死锁监控可视化工具，支持**多目标监控**，实时展示多个 MySQL 实例的死锁信息。

## 功能特点

- 🔍 **实时死锁监控** - 定时刷新展示最新的死锁记录
- 📊 **左右对比布局** - 清晰展示死锁双方的线程信息
- 🎯 **中文界面** - 锁类型、锁模式等字段均已中文化
- 🚀 **轻量简洁** - 无需登录，开箱即用
- 🐳 **Docker 部署** - 一键容器化运行
- 🎛️ **多目标监控** - 支持同时监控多个 MySQL 实例
- ⚙️ **灵活配置** - 可配置监控周期和存储位置

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
# 启动所有服务
docker-compose up -d

# 访问 http://localhost:9527
# MySQL 端口：3307 (避免与本地 3306 冲突)
```

### 方式二：Docker 运行

```bash
# 启动 MySQL 容器（端口 3307，避免与本地 3306 冲突）
docker run -d \
  --name deadlock-mysql \
  -e MYSQL_ROOT_PASSWORD=root \
  -e MYSQL_DATABASE=deadlock_monitor \
  -v $(pwd)/init.sql:/docker-entrypoint-initdb.d/init.sql \
  -p 3307:3306 \
  mysql:8.0

# 启动监控容器
docker run -d \
  --name deadlock-monitor \
  --link deadlock-mysql:mysql \
  -e DB_HOST=mysql \
  -e DB_USER=root \
  -e DB_PASSWORD=root \
  -e DB_NAME=deadlock_monitor \
  -e PORT=9527 \
  -p 9527:9527 \
  ghcr.io/your-username/deadlock-monitor:latest

# 访问 http://localhost:9527
```

### 方式三：源码运行

```bash
# 安装依赖
npm install

# 配置环境变量（可选）
export DB_HOST=127.0.0.1
export DB_USER=root
export DB_PASSWORD=root
export DB_NAME=deadlock_monitor
export PORT=9527

# 启动服务
node server.js

# 访问 http://localhost:9527
```

## 环境配置

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DB_HOST` | MySQL 数据库主机 | `mysql` (Docker 内) / `127.0.0.1` (本地) |
| `DB_PORT` | MySQL 数据库端口 | `3306` |
| `DB_USER` | MySQL 用户名 | `root` |
| `DB_PASSWORD` | MySQL 密码 | `root` |
| `DB_NAME` | 死锁监控数据库名 | `deadlock_monitor` |
| `PORT` | 服务端口 | `9527` |

## 数据库初始化

执行 `init.sql` 脚本创建数据库和表：

```bash
mysql -u root -p < init.sql
```

## 使用说明

1. **访问 Web 界面**：http://localhost:9527
2. **切换到「监控任务」标签**
3. **添加监控任务**：
   - 填写任务名称
   - 目标 MySQL 信息（IP、端口、账号、密码）
   - 设置监控周期（5/10/30/60/120 秒）
   - 选择存储类型（本地 MySQL 或外部 MySQL）
4. **查看死锁数据**：切换到「死锁数据」标签，可按数据源过滤

## 数据收集

推荐使用 Percona Toolkit 的 `pt-deadlock-logger` 工具自动采集死锁数据：

```bash
pt-deadlock-logger \
  --user=root \
  --password=root \
  --host=172.17.0.1 \
  --dest=D:deadlock_monitor.deadlocks \
  --daemonize \
  --interval=10
```

更多选项请参考 [Percona 官方文档](https://www.percona.com/doc/percona-toolkit/LATEST/pt-deadlock-logger.html)

## API 接口

### 死锁数据
- `GET /api/deadlocks` - 获取死锁列表（支持 `?source=` 参数过滤）
- `GET /api/tasks/sources` - 获取数据源列表

### 任务管理
- `GET /api/tasks` - 获取监控任务列表
- `POST /api/tasks` - 创建监控任务
- `PUT /api/tasks/:id` - 更新监控任务
- `DELETE /api/tasks/:id` - 删除监控任务
- `POST /api/tasks/:id/toggle` - 启停监控任务

## 技术栈

- **后端**: Node.js + Express + mysql2
- **前端**: 原生 HTML/CSS/JavaScript
- **进程管理**: Supervisor
- **数据采集**: pt-deadlock-logger (Percona Toolkit)
- **部署**: Docker

## License

MIT License

## 致谢

- [Percona Toolkit](https://www.percona.com/software/database-tools/percona-toolkit) - 死锁数据采集工具
