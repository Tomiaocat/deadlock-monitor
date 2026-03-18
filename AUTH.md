# 用户认证系统文档

## 概述

本次更新为死锁监控系统添加了完整的用户认证和授权功能，包括：

- JWT Token 认证
- 基于角色的访问控制 (RBAC)
- 命名空间数据隔离
- 审计日志
- 密码重置功能

## 默认账户

**首次登录请使用以下账户：**

| 用户名 | 密码 | 角色 |
|--------|------|------|
| admin | admin123 | 管理员 |

**重要：首次登录后请立即修改默认密码！**

## 角色权限

| 权限 | Admin | Editor | Viewer |
|------|-------|--------|--------|
| 查看死锁数据 | ✅ (所有) | ✅ (本命名空间) | ✅ (本命名空间) |
| 查看监控任务 | ✅ | ✅ | ✅ |
| 创建监控任务 | ✅ | ✅ | ❌ |
| 修改监控任务 | ✅ | ✅ | ❌ |
| 删除监控任务 | ✅ | ✅ | ❌ |
| 管理用户 | ✅ | ❌ | ❌ |
| 管理命名空间 | ✅ | ❌ | ❌ |
| 查看审计日志 | ✅ | ❌ | ❌ |

## 升级指南

### 从旧版本升级

1. **备份数据**
   ```bash
   mysqldump -u root -p deadlock_monitor > backup.sql
   ```

2. **执行迁移脚本**
   ```bash
   mysql -u root -p deadlock_monitor < migrate-auth.sql
   ```

3. **安装新依赖**
   ```bash
   npm install
   ```

4. **更新环境变量** (可选)
   ```bash
   # 设置 JWT 密钥 (生产环境必须)
   export JWT_SECRET="your-256-bit-secret-key"

   # 设置生产环境标志
   export NODE_ENV=production
   ```

5. **重启服务**
   ```bash
   docker-compose restart
   # 或
   node server.js
   ```

### 全新安装

1. **执行初始化脚本**
   ```bash
   mysql -u root -p < init.sql
   ```

2. **安装依赖**
   ```bash
   npm install
   ```

3. **启动服务**
   ```bash
   node server.js
   # 或
   docker-compose up -d
   ```

4. **访问登录页面**
   ```
   http://localhost:9527/login.html
   ```

## 命名空间隔离

命名空间用于实现多租户数据隔离：

- **Admin**: 可以访问所有命名空间
- **Editor/Viewer**: 只能访问被分配的命名空间

### 使用场景

1. **多团队环境**: 每个团队一个命名空间
2. **客户隔离**: 每个客户一个命名空间
3. **环境分离**: dev/staging/prod 分离

### 切换命名空间

用户可以通过页面右上角的命名空间下拉框切换当前视图。

## API 认证

### 获取 Token

```bash
POST /api/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "admin123"
}

# 响应
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "token_type": "Bearer",
  "expires_in": 900,
  "user": {
    "id": 1,
    "username": "admin",
    "role": "admin",
    "namespace_id": 1,
    "namespaces": [1]
  }
}
```

### 使用 Token

```bash
GET /api/tasks
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

### Token 刷新

Access Token 有效期 15 分钟，Refresh Token 有效期 7 天。

前端会自动在 Token 过期前刷新。

## 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `JWT_SECRET` | JWT 签名密钥 | `your-secret-key-change-in-production` |
| `NODE_ENV` | 运行环境 | `development` |
| `DB_HOST` | MySQL 主机 | `mysql` |
| `DB_PORT` | MySQL 端口 | `3306` |
| `DB_USER` | MySQL 用户 | `root` |
| `DB_PASSWORD` | MySQL 密码 | `root` |
| `DB_NAME` | 数据库名 | `deadlock_monitor` |
| `PORT` | 服务端口 | `3000` |

## 安全建议

### 生产环境部署

1. **修改 JWT_SECRET**
   ```bash
   # 生成 256-bit 随机密钥
   openssl rand -hex 32
   ```

2. **启用 HTTPS**
   - 使用反向代理 (Nginx/Apache)
   - 配置 SSL 证书

3. **修改默认密码**
   - 首次登录后立即修改 admin 密码

4. **定期备份**
   - 数据库定期备份
   - 审计日志定期归档

5. **限制访问**
   - 配置防火墙
   - 使用内网访问

## 审计日志

所有写操作都会记录到 `audit_log` 表：

- 用户登录/登出
- 创建/修改/删除监控任务
- 用户管理操作
- 命名空间管理操作

查看审计日志：
```sql
SELECT a.*, u.username
FROM audit_log a
LEFT JOIN users u ON a.user_id = u.id
ORDER BY a.created_at DESC
LIMIT 100;
```

## 故障排查

### 无法登录

1. 检查数据库连接
2. 确认用户表有数据
3. 查看服务器日志

### Token 过期

前端会自动刷新 Token，如果仍然过期：
1. 清除浏览器缓存
2. 重新登录

### 命名空间无数据

1. 确认用户有命名空间权限
2. 检查数据是否有 `namespace_id`
3. Admin 用户可以看到所有数据

## 文件清单

### 新增文件

| 文件 | 说明 |
|------|------|
| `middleware/auth.js` | 认证授权中间件 |
| `middleware/audit.js` | 审计日志中间件 |
| `routes/auth.js` | 认证 API 路由 |
| `routes/users.js` | 用户管理 API 路由 |
| `routes/namespaces.js` | 命名空间管理 API 路由 |
| `public/login.html` | 登录页面 |
| `public/js/auth.js` | 前端认证模块 |
| `migrate-auth.sql` | 数据迁移脚本 |

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `init.sql` | 添加认证表结构 |
| `server.js` | 集成认证中间件 |
| `public/index.html` | 添加用户菜单 |
| `package.json` | 添加依赖包 |

## 依赖包

```json
{
  "bcrypt": "^5.1.1",
  "jsonwebtoken": "^9.0.2",
  "helmet": "^7.1.0",
  "express-rate-limit": "^7.1.5",
  "cookie-parser": "^1.4.6",
  "crypto-js": "^4.2.0"
}
```
