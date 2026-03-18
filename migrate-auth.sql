-- ============================================
-- 用户认证系统 - 数据迁移脚本
-- ============================================
-- 用于从旧版本升级到带用户认证的新版本
-- 执行此脚本将为现有数据添加命名空间支持并创建用户表
-- ============================================

SET NAMES utf8mb4;
SET CHARACTER SET utf8mb4;

USE deadlock_monitor;

-- ============================================
-- 1. 创建认证相关表
-- ============================================

-- 命名空间表
CREATE TABLE IF NOT EXISTS `namespaces` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(64) NOT NULL UNIQUE,
  `code` VARCHAR(32) NOT NULL UNIQUE,
  `description` VARCHAR(255),
  `owner_id` INT,
  `is_default` TINYINT(1) DEFAULT 0,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 角色表
CREATE TABLE IF NOT EXISTS `roles` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(32) NOT NULL UNIQUE,
  `description` VARCHAR(255),
  `permissions` JSON
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 用户表
CREATE TABLE IF NOT EXISTS `users` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `username` VARCHAR(64) NOT NULL UNIQUE,
  `email` VARCHAR(128),
  `password_hash` VARCHAR(255) NOT NULL,
  `display_name` VARCHAR(64),
  `role_id` INT NOT NULL,
  `namespace_id` INT,
  `is_active` TINYINT(1) DEFAULT 1,
  `last_login_at` TIMESTAMP NULL,
  `last_login_ip` VARCHAR(45),
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`),
  FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 用户命名空间映射
CREATE TABLE IF NOT EXISTS `user_namespaces` (
  `user_id` INT NOT NULL,
  `namespace_id` INT NOT NULL,
  `is_default` TINYINT(1) DEFAULT 0,
  PRIMARY KEY (`user_id`, `namespace_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 会话表
CREATE TABLE IF NOT EXISTS `user_sessions` (
  `id` VARCHAR(64) PRIMARY KEY,
  `user_id` INT NOT NULL,
  `refresh_token_hash` VARCHAR(255),
  `ip_address` VARCHAR(45),
  `user_agent` VARCHAR(255),
  `expires_at` TIMESTAMP NOT NULL,
  `revoked` TINYINT(1) DEFAULT 0,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_expires_at` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 审计日志表
CREATE TABLE IF NOT EXISTS `audit_log` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT,
  `action` VARCHAR(64) NOT NULL,
  `resource_type` VARCHAR(32),
  `resource_id` INT,
  `details` JSON,
  `ip_address` VARCHAR(45),
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_action` (`action`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 密码重置表
CREATE TABLE IF NOT EXISTS `password_resets` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `reset_token_hash` VARCHAR(255) NOT NULL,
  `expires_at` TIMESTAMP NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `idx_user_id` (`user_id`),
  INDEX `idx_reset_token` (`reset_token_hash`),
  INDEX `idx_expires_at` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================
-- 2. 修改现有表添加命名空间支持
-- ============================================

-- monitor_tasks 添加命名空间字段
ALTER TABLE `monitor_tasks`
  ADD COLUMN `namespace_id` INT COMMENT '数据归属命名空间' AFTER `status`,
  ADD COLUMN `created_by` INT COMMENT '创建用户' AFTER `namespace_id`;

-- ============================================
-- 3. 创建死锁 - 命名空间映射表
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
-- 4. 初始化基础数据
-- ============================================

-- 创建默认命名空间 (如果不存在)
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

-- 创建初始管理员账户 (密码：admin123)
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

-- ============================================
-- 4. 迁移现有数据到默认命名空间
-- ============================================

-- 将现有的 monitor_tasks 分配到默认命名空间
UPDATE `monitor_tasks`
SET `namespace_id` = (SELECT id FROM namespaces WHERE code = 'default')
WHERE `namespace_id` IS NULL;

-- 将现有的 deadlocks 分配到默认命名空间
UPDATE `deadlocks`
SET `namespace_id` = (SELECT id FROM namespaces WHERE code = 'default')
WHERE `namespace_id` IS NULL;

-- ============================================
-- 5. 完成提示
-- ============================================

SELECT '迁移完成！' as message;
SELECT '默认管理员账户：' as info, 'admin' as username, 'admin123' as password;
SELECT '请立即修改默认密码！' as warning;
