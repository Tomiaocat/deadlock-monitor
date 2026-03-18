/**
 * 审计日志中间件
 *
 * 记录所有写操作到 audit_log 表
 */

export function createAuditLogger(dbPool) {
  return async (req, res, next) => {
    // 保存原始 json.send
    const originalSend = res.send.bind(res);
    const originalJson = res.json.bind(res);

    // 记录审计日志
    const logAudit = async (action, details) => {
      try {
        const userId = req.user?.id || null;
        const ipAddress = req.ip || req.connection?.remoteAddress || null;

        await dbPool.query(
          `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details, ip_address)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            userId,
            action,
            details.resourceType || null,
            details.resourceId || null,
            JSON.stringify(details),
            ipAddress
          ]
        );
      } catch (err) {
        console.error('[AuditLogger] Failed to log audit:', err.message);
      }
    };

    // 拦截响应
    res.send = function(body) {
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
        logAudit(req.path, {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode
        });
      }
      return originalSend(body);
    };

    res.json = function(body) {
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
        logAudit(req.path, {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          responseBody: body
        });
      }
      return originalJson(body);
    };

    next();
  };
}
