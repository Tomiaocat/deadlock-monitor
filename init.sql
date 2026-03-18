-- ============================================
-- Deadlock Monitor - Database Initialization
-- ============================================
-- 死锁监控表结构
-- 用于存储由 pt-deadlock-logger 采集的死锁数据
-- 支持多目标监控
-- ============================================

SET NAMES utf8mb4;
SET CHARACTER SET utf8mb4;

-- 创建数据库
CREATE DATABASE IF NOT EXISTS deadlock_monitor
DEFAULT CHARSET utf8mb4
COLLATE utf8mb4_0900_ai_ci;

USE deadlock_monitor;

-- ============================================
-- 监控任务配置表
-- ============================================
CREATE TABLE `monitor_tasks` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(64) NOT NULL COMMENT '任务名称',

  -- 目标 MySQL 配置
  `target_host` VARCHAR(64) NOT NULL COMMENT '目标 MySQL 主机',
  `target_port` INT DEFAULT 3306 COMMENT '目标 MySQL 端口',
  `target_user` VARCHAR(50) NOT NULL COMMENT '目标 MySQL 用户名',
  `target_password` VARCHAR(64) NOT NULL COMMENT '目标 MySQL 密码',

  -- 监控配置
  `interval` INT NOT NULL DEFAULT 10 COMMENT '监控周期（秒）: 5/10/30/60/120',

  -- 存储位置配置
  `storage_type` ENUM('local', 'remote') NOT NULL DEFAULT 'local' COMMENT '存储类型',

  -- 远程存储配置（storage_type='remote' 时使用）
  `remote_host` VARCHAR(64) COMMENT '远程 MySQL 主机',
  `remote_port` INT DEFAULT 3306 COMMENT '远程 MySQL 端口',
  `remote_user` VARCHAR(32) COMMENT '远程 MySQL 用户名',
  `remote_password` VARCHAR(64) COMMENT '远程 MySQL 密码',
  `remote_db` VARCHAR(64) COMMENT '远程数据库名',
  `remote_table` VARCHAR(64) COMMENT '远程表名',

  -- 状态控制
  `status` ENUM('active', 'paused', 'stopped') DEFAULT 'active',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX `idx_status` (`status`),
  INDEX `idx_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='监控任务配置表';

-- ============================================
-- 死锁记录表（多目标监控）
-- ============================================
-- 注意：此表由 pt-deadlock-logger 工具自动写入
-- server 字段用于标识数据来源（目标 MySQL 服务器）
-- 命名空间隔离通过 deadlocks_namespace_map 表实现
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
  PRIMARY KEY (`server`, `ts`, `thread`),
  KEY `idx_server` (`server`),
  KEY `idx_ts` (`ts`),
  KEY `idx_victim` (`victim`),
  KEY `idx_tbl` (`tbl`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='死锁记录表，由 pt-deadlock-logger 工具自动写入';

-- ============================================
-- 使用说明
-- ============================================
-- 1. 执行此脚本创建数据库和表结构
-- 2. 配置监控任务（通过 Web 界面或直接插入 monitor_tasks 表）
-- 3. 启动 deadlock-monitor 服务，自动运行 pt-deadlock-logger 采集进程
--
-- 监控任务配置示例:
-- INSERT INTO monitor_tasks (name, target_host, target_port, target_user, target_password, interval)
-- VALUES ('MySQL-Prod-01', '192.168.1.100', 3306, 'monitor', 'password123', 10);
--
-- pt-deadlock-logger 由 monitor-manager.js 自动管理，无需手动配置
-- ============================================

-- ============================================
-- 死锁数据 - 命名空间映射表
-- ============================================
-- 用于实现死锁数据的命名空间隔离
-- 死锁数据通过任务间接关联命名空间
CREATE TABLE IF NOT EXISTS `deadlocks_namespace_map` (
  `server` VARCHAR(64) NOT NULL COMMENT '数据来源服务器（target_host）',
  `namespace_id` INT NOT NULL COMMENT '命名空间 ID',
  `task_id` INT NOT NULL COMMENT '监控任务 ID',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`server`, `namespace_id`, `task_id`),
  INDEX `idx_namespace` (`namespace_id`),
  INDEX `idx_task` (`task_id`),
  FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`task_id`) REFERENCES `monitor_tasks`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='死锁数据 - 命名空间映射表';

-- ============================================
-- 用户认证与授权系统表结构
-- ============================================

-- 1. 命名空间表 (数据隔离)
CREATE TABLE IF NOT EXISTS `namespaces` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(64) NOT NULL UNIQUE COMMENT '命名空间名称',
  `code` VARCHAR(32) NOT NULL UNIQUE COMMENT '命名空间代码',
  `description` VARCHAR(255) COMMENT '描述',
  `owner_id` INT COMMENT '所有者用户 ID',
  `is_default` TINYINT(1) DEFAULT 0 COMMENT '是否为默认命名空间',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='命名空间表';

-- 2. 角色表
CREATE TABLE IF NOT EXISTS `roles` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(32) NOT NULL UNIQUE COMMENT '角色名称',
  `description` VARCHAR(255) COMMENT '角色描述',
  `permissions` JSON COMMENT '权限配置'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='角色表';

-- 3. 用户表
CREATE TABLE IF NOT EXISTS `users` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `username` VARCHAR(64) NOT NULL UNIQUE COMMENT '用户名',
  `email` VARCHAR(128) COMMENT '邮箱',
  `password_hash` VARCHAR(255) NOT NULL COMMENT '密码哈希 (bcrypt)',
  `display_name` VARCHAR(64) COMMENT '显示名称',
  `role_id` INT NOT NULL COMMENT '角色 ID',
  `namespace_id` INT COMMENT '默认命名空间 ID',
  `is_active` TINYINT(1) DEFAULT 1 COMMENT '是否启用',
  `last_login_at` TIMESTAMP NULL COMMENT '最后登录时间',
  `last_login_ip` VARCHAR(45) COMMENT '最后登录 IP',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`),
  FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='用户表';

-- 4. 用户 - 命名空间映射 (多对多)
CREATE TABLE IF NOT EXISTS `user_namespaces` (
  `user_id` INT NOT NULL COMMENT '用户 ID',
  `namespace_id` INT NOT NULL COMMENT '命名空间 ID',
  `is_default` TINYINT(1) DEFAULT 0 COMMENT '是否为默认命名空间',
  PRIMARY KEY (`user_id`, `namespace_id`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='用户命名空间映射表';

-- 5. 会话表 (JWT 管理)
CREATE TABLE IF NOT EXISTS `user_sessions` (
  `id` VARCHAR(64) PRIMARY KEY COMMENT 'JWT jti',
  `user_id` INT NOT NULL COMMENT '用户 ID',
  `refresh_token_hash` VARCHAR(255) COMMENT 'Refresh Token 哈希',
  `ip_address` VARCHAR(45) COMMENT 'IP 地址',
  `user_agent` VARCHAR(255) COMMENT 'User-Agent',
  `expires_at` TIMESTAMP NOT NULL COMMENT '过期时间',
  `revoked` TINYINT(1) DEFAULT 0 COMMENT '是否已撤销',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_expires_at` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='用户会话表';

-- 6. 审计日志表
CREATE TABLE IF NOT EXISTS `audit_log` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT COMMENT '用户 ID',
  `action` VARCHAR(64) NOT NULL COMMENT '操作',
  `resource_type` VARCHAR(32) COMMENT '资源类型',
  `resource_id` INT COMMENT '资源 ID',
  `details` JSON COMMENT '详细信息',
  `ip_address` VARCHAR(45) COMMENT 'IP 地址',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_action` (`action`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='审计日志表';

-- 7. 密码重置表
CREATE TABLE IF NOT EXISTS `password_resets` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `reset_token_hash` VARCHAR(255) NOT NULL,
  `expires_at` TIMESTAMP NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `idx_user_id` (`user_id`),
  INDEX `idx_reset_token` (`reset_token_hash`),
  INDEX `idx_expires_at` (`expires_at`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='密码重置表';

-- ============================================
-- 修改现有表添加命名空间支持
-- ============================================

-- monitor_tasks 添加命名空间和外键
ALTER TABLE `monitor_tasks`
  ADD COLUMN IF NOT EXISTS `namespace_id` INT COMMENT '数据归属命名空间' AFTER `status`,
  ADD COLUMN IF NOT EXISTS `created_by` INT COMMENT '创建用户' AFTER `namespace_id`;

-- ============================================
-- 初始化基础数据
-- ============================================

-- 创建默认命名空间
INSERT INTO `namespaces` (`name`, `code`, `description`, `is_default`)
VALUES ('Default', 'default', '默认命名空间', 1)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- 创建默认角色
INSERT INTO `roles` (`name`, `description`, `permissions`) VALUES
('admin', '管理员 - 拥有所有权限',
 JSON_OBJECT('permissions', JSON_ARRAY('view', 'create', 'edit', 'delete', 'manage_users', 'manage_namespaces'))),
('editor', '编辑 - 可以增删改查',
 JSON_OBJECT('permissions', JSON_ARRAY('view', 'create', 'edit', 'delete'))),
('viewer', '查看者 - 只能查看',
 JSON_OBJECT('permissions', JSON_ARRAY('view')))
ON DUPLICATE KEY UPDATE `description` = VALUES(`description`);

-- 创建初始管理员账户 (密码：admin123，首次登录后请修改)
-- 密码哈希由 bcrypt 生成，cost=12
INSERT INTO `users` (`username`, `password_hash`, `display_name`, `role_id`, `namespace_id`, `email`)
SELECT 'admin',
       '$2b$12$eslBVVAPyjvOiwYx2Bl0juoTnm9KqmOw.JCt260fRNB.ZWJZkBSnm',
       '系统管理员',
       (SELECT id FROM roles WHERE name = 'admin'),
       (SELECT id FROM namespaces WHERE code = 'default'),
       'admin@example.com'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'admin');

-- 分配默认命名空间给管理员
INSERT INTO `user_namespaces` (`user_id`, `namespace_id`, `is_default`)
SELECT
  (SELECT id FROM users WHERE username = 'admin'),
  (SELECT id FROM namespaces WHERE code = 'default'),
  1
WHERE NOT EXISTS (
  SELECT 1 FROM user_namespaces
  WHERE user_id = (SELECT id FROM users WHERE username = 'admin')
);
