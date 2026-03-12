# Deadlock Monitor

MySQL 死锁监控可视化工具，实时展示数据库死锁信息，帮助快速定位和分析死锁原因。

## 功能特点

- 🔍 **实时死锁监控** - 定时刷新展示最新的死锁记录
- 📊 **左右对比布局** - 清晰展示死锁双方的线程信息
- 🎯 **中文界面** - 锁类型、锁模式等字段均已中文化
- 🚀 **轻量简洁** - 无需登录，开箱即用
- 🐳 **Docker 部署** - 一键容器化运行

## 效果预览

![死锁监控界面](docs/screenshot.png)

## 快速开始

### 方式一：Docker 运行（推荐）

```bash
# 拉取镜像并运行
docker run -d \
  --name deadlock-monitor \
  --network host \
  -e DB_HOST=172.17.0.1 \
  -e DB_USER=root \
  -e DB_PASSWORD=root \
  -e DB_NAME=deadlock_monitor \
  ghcr.io/your-username/deadlock-monitor:latest

# 访问 http://localhost:3000
```

### 方式二：Docker Compose

```bash
docker-compose up -d
```

### 方式三：源码运行

```bash
# 安装依赖
npm install

# 配置环境变量（可选）
export DB_HOST=172.17.0.1
export DB_USER=root
export DB_PASSWORD=root
export DB_NAME=deadlock_monitor

# 启动服务
node server.js

# 访问 http://localhost:3000
```

## 环境配置

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DB_HOST` | MySQL 数据库主机 | `172.17.0.1` |
| `DB_PORT` | MySQL 数据库端口 | `3306` |
| `DB_USER` | MySQL 用户名 | `root` |
| `DB_PASSWORD` | MySQL 密码 | `root` |
| `DB_NAME` | 死锁监控数据库名 | `deadlock_monitor` |
| `PORT` | 服务监听端口 | `3000` |

## 数据库初始化

执行以下 SQL 创建死锁监控表：

```sql
CREATE DATABASE IF NOT EXISTS deadlock_monitor DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

USE deadlock_monitor;

CREATE TABLE `deadlocks` (
  `server` char(20) NOT NULL COMMENT '发生死锁的数据库服务器标识（IP 或主机名）',
  `ts` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '死锁发生的时间戳',
  `thread` int(10) unsigned NOT NULL COMMENT '发生死锁的线程 ID',
  `txn_id` bigint(20) unsigned NOT NULL COMMENT '事务 ID',
  `txn_time` smallint(5) unsigned NOT NULL COMMENT '事务执行时间（秒）',
  `user` char(16) NOT NULL COMMENT '执行事务的数据库用户',
  `hostname` char(20) NOT NULL COMMENT '客户端主机名',
  `ip` char(15) NOT NULL COMMENT '客户端 IP 地址',
  `db` char(64) NOT NULL COMMENT '涉及的数据库名',
  `tbl` char(64) NOT NULL COMMENT '涉及的表名',
  `idx` char(64) NOT NULL COMMENT '涉及的索引名',
  `lock_type` char(16) NOT NULL COMMENT '锁类型（如 RECORD、TABLE 等）',
  `lock_mode` char(1) NOT NULL COMMENT '锁模式：X=排他锁，S=共享锁',
  `wait_hold` char(1) NOT NULL COMMENT '锁状态：W=等待，H=持有',
  `victim` tinyint(3) unsigned NOT NULL COMMENT '是否为死锁牺牲品：1=是，0=否',
  `query` longtext NOT NULL COMMENT '导致死锁的 SQL 语句',
  PRIMARY KEY (`server`,`ts`,`thread`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='死锁记录表，由 pt-deadlock-logger 工具自动写入';
```

## 数据收集

推荐使用 Percona Toolkit 的 `pt-deadlock-logger` 工具自动采集死锁数据：

```bash
pt-deadlock-logger \
  --user=root \
  --password=root \
  --host=172.17.0.1 \
  --dest=D:deadlock_monitor.deadlocks \
  --daemonize \
  --run-time=1m \
  --interval=10
```

更多选项请参考 [Percona 官方文档](https://www.percona.com/doc/percona-toolkit/LATEST/pt-deadlock-logger.html)

## 字段说明

### 死锁信息

| 字段 | 说明 | 示例 |
|------|------|------|
| 表 | 发生死锁的数据表 | `miniso_invc_stock` |
| 索引 | 涉及的索引 | `idx_update_time` |
| 锁类型 | 锁的粒度 | 行锁 (RECORD)、表锁 (TABLE) |
| 锁模式 | 锁的模式 | 排他锁 (X)、共享锁 (S) |
| 状态 | 锁的等待/持有状态 | 等待中 (w)、已持有 (h) |

### 线程信息

| 字段 | 说明 |
|------|------|
| 线程 ID | MySQL 线程 ID |
| 数据库 | 涉及的数据库名 |
| 用户 | 数据库用户 |
| IP/主机 | 客户端连接信息 |
| SQL | 导致死锁的 SQL 语句 |

## API 接口

### `GET /api/deadlocks`

获取死锁列表（按时间倒序，最多 100 条）

```json
[
  {
    "id": 1773339475000,
    "timestamp": "2026/03/12 18:17:55",
    "table": "miniso_invc_stock",
    "index": "idx_update_time",
    "lockType": "RECORD",
    "lockMode": "X",
    "victim": {
      "thread": 542646560,
      "db": "miniso_invc_gray_20",
      "query": "INSERT INTO..."
    },
    "other": {
      "thread": 274202319,
      "db": "miniso_invc_gray_20",
      "query": "INSERT INTO..."
    }
  }
]
```

### `GET /api/latest`

获取最新死锁时间戳（用于轮询）

## 技术栈

- **后端**: Node.js + Express + mysql2
- **前端**: 原生 HTML/CSS/JavaScript
- **部署**: Docker

## 开发

```bash
# 安装依赖
npm install

# 启动开发服务
npm run dev

# 构建 Docker 镜像
docker build -t deadlock-monitor:latest .
```

## License

MIT License

## 致谢

- [Percona Toolkit](https://www.percona.com/software/database-tools/percona-toolkit) - 死锁数据采集工具
