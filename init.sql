-- ============================================
-- Deadlock Monitor - Database Initialization
-- ============================================
-- 死锁监控表结构
-- 用于存储由 pt-deadlock-logger 采集的死锁数据
-- ============================================

-- 创建数据库
CREATE DATABASE IF NOT EXISTS deadlock_monitor
DEFAULT CHARSET utf8mb4
COLLATE utf8mb4_0900_ai_ci;

USE deadlock_monitor;

-- 创建死锁记录表
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
  PRIMARY KEY (`server`,`ts`,`thread`),
  KEY `idx_ts` (`ts`),
  KEY `idx_thread` (`thread`),
  KEY `idx_victim` (`victim`),
  KEY `idx_tbl` (`tbl`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='死锁记录表，由 pt-deadlock-logger 工具自动写入';

-- ============================================
-- 使用说明
-- ============================================
-- 1. 执行此脚本创建数据库和表结构
-- 2. 配置 pt-deadlock-logger 工具将死锁数据写入此表
-- 3. 启动 deadlock-monitor 服务查看死锁信息
--
-- pt-deadlock-logger 配置示例:
-- pt-deadlock-logger --user=root --password=xxx --host=localhost \
--   --dest=D:deadlock_monitor.deadlocks --daemonize --interval=10
-- ============================================
