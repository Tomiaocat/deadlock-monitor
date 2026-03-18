/**
 * 认证相关路由
 *
 * - 登录/登出
 * - Token 刷新
 * - 密码重置
 * - 用户信息
 */

import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_AUDIENCE = 'deadlock-monitor-api';
const JWT_ISSUER = 'deadlock-monitor';

/**
 * 生成 Access Token
 */
function generateAccessToken(user, namespaces) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role,
      namespace_id: user.namespace_id,
      namespaces: namespaces
    },
    JWT_SECRET,
    {
      audience: JWT_AUDIENCE,
      issuer: JWT_ISSUER,
      expiresIn: '15m',
      jwtid: crypto.randomUUID()
    }
  );
}

/**
 * 生成 Refresh Token
 */
function generateRefreshToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      type: 'refresh'
    },
    JWT_SECRET,
    {
      audience: JWT_AUDIENCE,
      issuer: JWT_ISSUER,
      expiresIn: '7d',
      jwtid: crypto.randomUUID()
    }
  );
}

/**
 * POST /api/auth/login
 * 用户登录
 */
router.post('/login', async (req, res) => {
  const pool = req.app.get('dbPool');
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    // 查询用户
    const [users] = await pool.query(
      `SELECT u.*, r.name as role_name, n.code as namespace_code
       FROM users u
       JOIN roles r ON u.role_id = r.id
       LEFT JOIN namespaces n ON u.namespace_id = n.id
       WHERE u.username = ? AND u.is_active = 1`,
      [username]
    );

    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user = users[0];
    // 映射 role_name 到 role，供 generateAccessToken 使用
    user.role = user.role_name;

    // 验证密码
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // 获取用户可访问的命名空间
    const [userNamespaces] = await pool.query(
      `SELECT namespace_id FROM user_namespaces WHERE user_id = ?`,
      [user.id]
    );
    const namespaces = userNamespaces.map(row => row.namespace_id);

    // 如果没有显式分配命名空间，使用默认命名空间
    if (namespaces.length === 0 && user.namespace_id) {
      namespaces.push(user.namespace_id);
    }

    // 生成 Token
    const accessToken = generateAccessToken(user, namespaces);
    const refreshToken = generateRefreshToken(user);

    // 保存 refresh token 到会话表
    const jti = crypto.randomUUID();
    const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const ipAddress = req.ip || req.connection?.remoteAddress;
    const userAgent = req.get('user-agent') || '';

    await pool.query(
      `INSERT INTO user_sessions (id, user_id, refresh_token_hash, ip_address, user_agent, expires_at)
       VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))`,
      [jti, user.id, refreshTokenHash, ipAddress, userAgent]
    );

    // 更新最后登录信息
    await pool.query(
      `UPDATE users SET last_login_at = NOW(), last_login_ip = ? WHERE id = ?`,
      [ipAddress, user.id]
    );

    // 设置 refresh token cookie
    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000  // 7 天
    });

    // 记录登录审计
    await pool.query(
      `INSERT INTO audit_log (user_id, action, details, ip_address)
       VALUES (?, 'login', ?, ?)`,
      [user.id, JSON.stringify({ username, userAgent }), ipAddress]
    );

    res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 900,  // 15 分钟
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        role: user.role_name,
        namespace_id: user.namespace_id,
        namespace_code: user.namespace_code,
        namespaces: namespaces
      }
    });
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/auth/refresh
 * 刷新 Access Token
 */
router.post('/refresh', async (req, res) => {
  const pool = req.app.get('dbPool');
  const refreshToken = req.cookies?.refresh_token;

  if (!refreshToken) {
    return res.status(401).json({ error: 'Refresh token required' });
  }

  try {
    // 验证 refresh token
    const decoded = jwt.verify(refreshToken, JWT_SECRET, {
      audience: JWT_AUDIENCE,
      issuer: JWT_ISSUER
    });

    if (decoded.type !== 'refresh') {
      return res.status(401).json({ error: 'Invalid token type' });
    }

    // 检查会话是否有效
    const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const [sessions] = await pool.query(
      `SELECT s.*, u.username, u.is_active
       FROM user_sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.id = ? AND s.refresh_token_hash = ? AND s.revoked = 0 AND s.expires_at > NOW()`,
      [decoded.jti, refreshTokenHash]
    );

    if (sessions.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    const session = sessions[0];

    if (!session.is_active) {
      return res.status(403).json({ error: 'User account is disabled' });
    }

    // 获取用户信息
    const [users] = await pool.query(
      `SELECT u.*, r.name as role_name, n.code as namespace_code
       FROM users u
       JOIN roles r ON u.role_id = r.id
       LEFT JOIN namespaces n ON u.namespace_id = n.id
       WHERE u.id = ?`,
      [session.user_id]
    );

    const user = users[0];
    // 映射 role_name 到 role，供 generateAccessToken 使用
    user.role = user.role_name;

    // 获取命名空间
    const [userNamespaces] = await pool.query(
      `SELECT namespace_id FROM user_namespaces WHERE user_id = ?`,
      [user.id]
    );
    const namespaces = userNamespaces.map(row => row.namespace_id);
    if (namespaces.length === 0 && user.namespace_id) {
      namespaces.push(user.namespace_id);
    }

    // 生成新的 access token
    const accessToken = generateAccessToken(user, namespaces);

    res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 900
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Refresh token expired' });
    }
    console.error('[Auth] Refresh error:', err.message);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

/**
 * POST /api/auth/logout
 * 用户登出
 */
router.post('/logout', async (req, res) => {
  const pool = req.app.get('dbPool');
  const refreshToken = req.cookies?.refresh_token;

  if (refreshToken) {
    try {
      const decoded = jwt.verify(refreshToken, JWT_SECRET, {
        audience: JWT_AUDIENCE,
        issuer: JWT_ISSUER
      });

      if (decoded.jti) {
        // 撤销会话
        await pool.query(
          `UPDATE user_sessions SET revoked = 1 WHERE id = ?`,
          [decoded.jti]
        );
      }
    } catch (err) {
      // Token 无效也继续清除 cookie
    }
  }

  // 清除 cookie
  res.clearCookie('refresh_token');

  res.json({ message: 'Logged out successfully' });
});

/**
 * GET /api/auth/me
 * 获取当前用户信息
 */
router.get('/me', async (req, res) => {
  const pool = req.app.get('dbPool');
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const [users] = await pool.query(
      `SELECT u.id, u.username, u.email, u.display_name, r.name as role,
              n.id as namespace_id, n.code as namespace_code, n.name as namespace_name,
              u.is_active, u.last_login_at, u.created_at
       FROM users u
       JOIN roles r ON u.role_id = r.id
       LEFT JOIN namespaces n ON u.namespace_id = n.id
       WHERE u.id = ?`,
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = users[0];

    // 获取可访问的命名空间
    const [namespaces] = await pool.query(
      `SELECT n.id, n.name, n.code, un.is_default
       FROM user_namespaces un
       JOIN namespaces n ON un.namespace_id = n.id
       WHERE un.user_id = ?`,
      [userId]
    );

    res.json({
      ...user,
      namespaces
    });
  } catch (err) {
    console.error('[Auth] Get user error:', err.message);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

/**
 * PUT /api/auth/namespace
 * 切换当前命名空间
 */
router.put('/namespace', async (req, res) => {
  const pool = req.app.get('dbPool');
  const userId = req.user?.id;
  const { namespace_id } = req.body;

  if (!userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (!namespace_id) {
    return res.status(400).json({ error: 'namespace_id required' });
  }

  try {
    // 检查用户是否有权访问该命名空间
    const [access] = await pool.query(
      `SELECT 1 FROM user_namespaces WHERE user_id = ? AND namespace_id = ?`,
      [userId, namespace_id]
    );

    if (access.length === 0) {
      // 检查是否是用户的默认命名空间
      const [defaultAccess] = await pool.query(
        `SELECT 1 FROM users WHERE id = ? AND namespace_id = ?`,
        [userId, namespace_id]
      );
      if (defaultAccess.length === 0) {
        return res.status(403).json({ error: 'Access denied to this namespace' });
      }
    }

    // 更新用户的默认命名空间
    await pool.query(
      `UPDATE users SET namespace_id = ? WHERE id = ?`,
      [namespace_id, userId]
    );

    res.json({ message: 'Namespace switched successfully', namespace_id });
  } catch (err) {
    console.error('[Auth] Switch namespace error:', err.message);
    res.status(500).json({ error: 'Failed to switch namespace' });
  }
});

/**
 * POST /api/auth/forgot-password
 * 忘记密码 - 生成重置令牌
 */
router.post('/forgot-password', async (req, res) => {
  const pool = req.app.get('dbPool');
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  try {
    // 查找用户
    const [users] = await pool.query(
      `SELECT id, username, email FROM users WHERE email = ? AND is_active = 1`,
      [email]
    );

    if (users.length === 0) {
      // 为了安全，不透露用户是否存在
      return res.json({ message: 'If the email exists, a reset link will be sent' });
    }

    // 生成重置令牌
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);  // 1 小时有效

    // 存储重置令牌
    await pool.query(
      `INSERT INTO password_resets (user_id, reset_token_hash, expires_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE reset_token_hash = ?, expires_at = ?`,
      [users[0].id, resetTokenHash, expiresAt, resetTokenHash, expiresAt]
    );

    // TODO: 发送邮件
    // const resetUrl = `${process.env.BASE_URL}/reset-password.html?token=${resetToken}`;
    // await sendEmail(email, 'Password Reset', `Click here to reset: ${resetUrl}`);

    console.log(`[Password Reset] Token for ${email}: ${resetToken}`);

    res.json({ message: 'If the email exists, a reset link will be sent' });
  } catch (err) {
    console.error('[Auth] Forgot password error:', err.message);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

/**
 * POST /api/auth/reset-password
 * 重置密码
 */
router.post('/reset-password', async (req, res) => {
  const pool = req.app.get('dbPool');
  const { token, new_password } = req.body;

  if (!token || !new_password) {
    return res.status(400).json({ error: 'Token and new password required' });
  }

  if (new_password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const resetTokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // 验证重置令牌
    const [resets] = await pool.query(
      `SELECT pr.user_id, u.username
       FROM password_resets pr
       JOIN users u ON pr.user_id = u.id
       WHERE pr.reset_token_hash = ? AND pr.expires_at > NOW() AND u.is_active = 1`,
      [resetTokenHash]
    );

    if (resets.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const { user_id, username } = resets[0];

    // 哈希新密码
    const passwordHash = await bcrypt.hash(new_password, 12);

    // 更新密码
    await pool.query(
      `UPDATE users SET password_hash = ? WHERE id = ?`,
      [passwordHash, user_id]
    );

    // 删除已使用的重置令牌
    await pool.query(`DELETE FROM password_resets WHERE user_id = ?`, [user_id]);

    // 撤销所有会话
    await pool.query(`UPDATE user_sessions SET revoked = 1 WHERE user_id = ?`, [user_id]);

    // 记录审计
    await pool.query(
      `INSERT INTO audit_log (user_id, action, details)
       VALUES (?, 'password_reset', ?)`,
      [user_id, JSON.stringify({ username })]
    );

    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    console.error('[Auth] Reset password error:', err.message);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

export default router;
