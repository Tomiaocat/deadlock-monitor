# Deadlock Monitor 使用指南

## 死锁监控数据采集

### 使用 pt-deadlock-logger

Percona Toolkit 的 `pt-deadlock-logger` 是推荐的数据采集工具。

#### 安装 Percona Toolkit

**Ubuntu/Debian:**
```bash
sudo apt-get install percona-toolkit
```

**CentOS/RHEL:**
```bash
sudo yum install percona-toolkit
```

**macOS (Homebrew):**
```bash
brew install percona-toolkit
```

#### 配置采集

**基本用法:**
```bash
pt-deadlock-logger \
  --user=root \
  --password=your_password \
  --host=your_host \
  --dest=D:deadlock_monitor.deadlocks \
  --interval=10
```

**守护进程模式（推荐）:**
```bash
pt-deadlock-logger \
  --user=root \
  --password=your_password \
  --host=your_host \
  --dest=D:deadlock_monitor.deadlocks \
  --daemonize \
  --run-time=1m \
  --interval=10 \
  --log=/var/log/pt-deadlock-logger.log
```

#### 常用参数说明

| 参数 | 说明 | 示例 |
|------|------|------|
| `--user` | MySQL 用户名 | `root` |
| `--password` | MySQL 密码 | `password` |
| `--host` | MySQL 主机 | `127.0.0.1` |
| `--port` | MySQL 端口 | `3306` |
| `--dest` | 目标表 | `D:database.table` |
| `--daemonize` | 守护进程模式 | - |
| `--interval` | 检查间隔（秒） | `10` |
| `--run-time` | 运行时长 | `1m` |
| `--log` | 日志文件 | `/var/log/pt-deadlock-logger.log` |

## Docker 部署

### 直接运行

```bash
docker run -d \
  --name deadlock-monitor \
  --network host \
  -e DB_HOST=172.17.0.1 \
  -e DB_USER=root \
  -e DB_PASSWORD=root \
  -e DB_NAME=deadlock_monitor \
  ghcr.io/your-username/deadlock-monitor:latest
```

### Docker Compose

创建 `docker-compose.yml`:

```yaml
version: '3.8'

services:
  deadlock-monitor:
    image: ghcr.io/your-username/deadlock-monitor:latest
    container_name: deadlock-monitor
    ports:
      - "3000:3000"
    environment:
      - DB_HOST=172.17.0.1
      - DB_USER=root
      - DB_PASSWORD=root
      - DB_NAME=deadlock_monitor
    restart: unless-stopped
```

运行:
```bash
docker-compose up -d
```

## 常见问题

### 1. 连接数据库失败

检查数据库连接配置：
```bash
# 测试数据库连接
mysql -h 172.17.0.1 -u root -p
```

确保防火墙允许连接，Docker 容器使用 `--network host` 模式可以访问宿主机网络。

### 2. 页面显示无数据

- 确认数据库中有死锁记录：`SELECT COUNT(*) FROM deadlocks;`
- 检查 pt-deadlock-logger 是否正常运行
- 刷新页面或检查浏览器控制台错误

### 3. 时间显示不正确

确认数据库时区设置：
```sql
SHOW VARIABLES LIKE 'time_zone';
```

服务会自动将 UTC 时间转换为北京时间 (UTC+8) 显示。

## 锁信息说明

### 锁类型 (lock_type)

| 值 | 说明 |
|-----|------|
| RECORD | 行锁 - 锁定单行记录 |
| TABLE | 表锁 - 锁定整张表 |
| PAGE | 页锁 - 锁定数据页 |
| GAP | 间隙锁 - 锁定索引间隙 |

### 锁模式 (lock_mode)

| 值 | 说明 |
|-----|------|
| X | 排他锁 - 写锁，不允许其他事务读写 |
| S | 共享锁 - 读锁，允许其他事务读 |
| IX | 意向排他锁 |
| IS | 意向共享锁 |

### 状态 (wait_hold)

| 值 | 说明 |
|-----|------|
| w | 等待中 - 线程在等待锁 |
| h | 已持有 - 线程持有锁 |

## 死锁分析建议

1. **高频死锁表** - 检查 `tbl` 字段，找出频繁出现死锁的表
2. **索引优化** - 检查 `idx` 字段，考虑优化索引设计
3. **SQL 审查** - 分析 `query` 字段，优化事务逻辑
4. **时间规律** - 观察 `ts` 字段，找出死锁高发时段

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

MIT License
