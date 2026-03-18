/**
 * 认证授权中间件
 *
 * 功能：
 * 1. JWT Token 验证
 * 2. 角色权限检查
 * 3. 命名空间隔离
 */

import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_AUDIENCE = 'deadlock-monitor-api';
const JWT_ISSUER = 'deadlock-monitor';

// 角色权限映射
const ROLE_PERMISSIONS = {
  admin: ['view', 'create', 'edit', 'delete', 'manage_users', 'manage_namespaces'],
  editor: ['view', 'create', 'edit', 'delete'],
  viewer: ['view']
};

/**
 * 验证 JWT Token
 * 提取用户信息并附加到 req.user
 */
export function authenticate(req, res, next) {
  try {
    // 从 Authorization header 获取 token
    const authHeader = req.headers.authorization;
    let token = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }

    // 也支持从 cookie 获取
    if (!token && req.cookies && req.cookies.access_token) {
      token = req.cookies.access_token;
    }

    if (!token) {
      return res.status(401).json({
        error: 'Authentication required',
        code: 'NO_TOKEN'
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET, {
      audience: JWT_AUDIENCE,
      issuer: JWT_ISSUER
    });

    // 附加用户信息到 request
    req.user = {
      id: decoded.sub,
      username: decoded.username,
      role: decoded.role,
      namespaceId: decoded.namespace_id,
      namespaces: decoded.namespaces || [decoded.namespace_id]
    };

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Token expired',
        code: 'TOKEN_EXPIRED'
      });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({
        error: 'Invalid token',
        code: 'INVALID_TOKEN'
      });
    }
    return res.status(500).json({
      error: 'Authentication failed',
      code: 'AUTH_FAILED'
    });
  }
}

/**
 * 检查用户是否具有指定角色
 * @param  {...string} roles - 允许的角色列表
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        required: roles,
        current: req.user.role
      });
    }

    next();
  };
}

/**
 * 检查用户是否有指定权限
 * @param {string} permission - 权限名称 (view/create/edit/delete)
 */
export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userPermissions = ROLE_PERMISSIONS[req.user.role] || [];

    if (!userPermissions.includes(permission)) {
      return res.status(403).json({
        error: `Permission denied: ${permission}`,
        role: req.user.role
      });
    }

    next();
  };
}

/**
 * 命名空间隔离中间件
 * 确保用户只能访问自己命名空间的数据
 */
export function requireNamespace() {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Admin 可以访问所有命名空间
    if (req.user.role === 'admin') {
      // Admin 可以通过查询参数指定 namespace_id
      const requestedNamespace = req.query.namespace_id;
      if (requestedNamespace) {
        req.namespaceId = parseInt(requestedNamespace);
      } else {
        req.namespaceId = req.user.namespaceId;
      }
      return next();
    }

    // 非 Admin 用户只能访问自己的命名空间
    const currentNamespace = req.user.namespaceId;

    // 检查用户是否有权访问请求的命名空间
    const requestedNamespace = req.query.namespace_id;
    if (requestedNamespace) {
      const requestedId = parseInt(requestedNamespace);
      if (!req.user.namespaces.includes(requestedId)) {
        return res.status(403).json({
          error: 'Access denied to this namespace',
          requested: requestedId,
          allowed: req.user.namespaces
        });
      }
      req.namespaceId = requestedId;
    } else {
      req.namespaceId = currentNamespace;
    }

    next();
  };
}

/**
 * 可选的认证中间件
 * 如果提供了 token 则验证，否则允许匿名访问
 */
export function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    let token = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }

    if (!token && req.cookies && req.cookies.access_token) {
      token = req.cookies.access_token;
    }

    if (token) {
      const decoded = jwt.verify(token, JWT_SECRET, {
        audience: JWT_AUDIENCE,
        issuer: JWT_ISSUER
      });

      req.user = {
        id: decoded.sub,
        username: decoded.username,
        role: decoded.role,
        namespaceId: decoded.namespace_id,
        namespaces: decoded.namespaces || [decoded.namespace_id]
      };
    }

    next();
  } catch (err) {
    // Token 无效时继续，不阻止请求
    next();
  }
}

/**
 * 生成 Access Token
 */
export function generateAccessToken(user, namespaces) {
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
      expiresIn: '15m',  // 15 分钟
      jwtid: crypto.randomUUID()
    }
  );
}

/**
 * 生成 Refresh Token
 */
export function generateRefreshToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      type: 'refresh'
    },
    JWT_SECRET,
    {
      audience: JWT_AUDIENCE,
      issuer: JWT_ISSUER,
      expiresIn: '7d',  // 7 天
      jwtid: crypto.randomUUID()
    }
  );
}

export { JWT_SECRET };
