/**
 * Deadlock Monitor - Main Server
 *
 * Features:
 * - Multi-target MySQL deadlock monitoring
 * - User authentication and authorization (JWT)
 * - Namespace-based data isolation
 * - Role-based access control (RBAC)
 */

import express from 'express';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';

import { authenticate, requireRole, requireNamespace, optionalAuth } from './middleware/auth.js';
import { createAuditLogger } from './middleware/audit.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import namespaceRoutes from './routes/namespaces.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// ============================================
// Security Middleware
// ============================================

app.use(helmet({
  contentSecurityPolicy: false,  // 允许内联脚本
  crossOriginEmbedderPolicy: false
}));

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================
// Rate Limiting
// ============================================

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 分钟
  max: 20,  // 每个 IP 最多 20 次登录尝试
  message: { error: 'Too many login attempts, please try again later' }
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,  // 每 15 分钟最多 500 次 API 调用
  message: { error: 'Too many requests, please try again later' }
});

app.use('/api/auth/login', authLimiter);
app.use('/api', apiLimiter);

// ============================================
// Database Connection
// ============================================

const pool = mysql.createPool({
  host: process.env.DB_HOST || '172.17.0.1',
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'root',
  database: process.env.DB_NAME || 'deadlock_monitor',
  charset: 'utf8mb4',
  timezone: '+08:00',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Store pool in app for routes to access
app.set('dbPool', pool);

// Audit logging middleware
app.use(createAuditLogger(pool));

// ============================================
// Static Files
// ============================================

app.use(express.static(join(__dirname, 'public')));

// ============================================
// Public Routes (No Auth Required)
// ============================================

// 公开认证路由（登录/刷新/密码重置）
app.use('/api/auth', (req, res, next) => {
  // 只允许公开端点
  if (req.path === '/login' || req.path === '/refresh' ||
      req.path === '/forgot-password' || req.path === '/reset-password') {
    next();
  } else if (req.path === '/logout') {
    // logout 需要认证
    authenticate(req, res, next);
  } else {
    // 其他端点（如/me）需要认证
    authenticate(req, res, next);
  }
}, authRoutes);

// Health check
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

// ============================================
// Protected Routes (Auth Required)
// ============================================

app.use(authenticate);

// Audit log for all protected routes
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    pool.query(
      `INSERT INTO audit_log (user_id, action, resource_type, details, ip_address)
       VALUES (?, ?, ?, ?, ?)`,
      [
        req.user?.id || null,
        `${req.method} ${req.path}`,
        req.path.split('/')[2],
        JSON.stringify({ body: req.body }),
        req.ip || req.connection?.remoteAddress
      ]
    );
  }
  next();
});

// User management (Admin only)
app.use('/api/users', requireRole('admin'), userRoutes);

// Namespace management (Admin only)
// Except /available endpoint which is open to all authenticated users
app.use('/api/namespaces', (req, res, next) => {
  if (req.path === '/available') {
    // 所有认证用户都可以访问
    next();
  } else {
    // 其他端点需要 admin 权限
    requireRole('admin')(req, res, next);
  }
}, namespaceRoutes);

// ============================================
// Deadlock Data APIs (with namespace isolation)
// ============================================

// GET /api/deadlocks - Get recent deadlocks
app.get('/api/deadlocks', requireNamespace(), async (req, res) => {
  try {
    const { source } = req.query;

    // 1. 先获取用户可访问的任务对应的 server 列表
    let serverFilter = '';
    let serverParams = [];

    if (req.user.role !== 'admin') {
      const [taskServers] = await pool.query(`
        SELECT DISTINCT target_host as server
        FROM monitor_tasks
        WHERE status = 'active'
          AND namespace_id IN (
            SELECT namespace_id FROM user_namespaces WHERE user_id = ?
            UNION
            SELECT id FROM namespaces WHERE owner_id = ?
          )
      `, [req.user.id, req.user.id]);

      if (taskServers.length === 0) {
        return res.json([]); // 用户没有可访问的任务
      }

      serverFilter = ' AND server IN (?)';
      serverParams = [taskServers.map(t => t.server)];
    }

    // 2. 查询死锁数据
    let query = `SELECT * FROM deadlocks WHERE 1=1 ${serverFilter}`;
    const params = [...serverParams];

    if (source) {
      query += ` AND server = ?`;
      params.push(source);
    }

    query += ` ORDER BY ts DESC, thread DESC LIMIT 100`;

    const [rows] = await pool.query(query, params);

    // Group deadlocks by timestamp
    const grouped = [];
    const used = new Set();

    for (let i = 0; i < rows.length; i++) {
      const key = rows[i].ts.getTime();
      if (used.has(key)) continue;

      const match = rows.find((r, j) => j !== i && r.ts.getTime() === key);

      if (match) {
        const victim = rows[i].victim === 1 ? rows[i] : match;
        const other = rows[i].victim === 1 ? match : rows[i];

        const formatDateTime = (date) => {
          const bjTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
          return bjTime.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
          });
        };

        grouped.push({
          id: key,
          timestamp: formatDateTime(rows[i].ts),
          source_server: rows[i].server,
          victim,
          other,
          table: rows[i].tbl,
          index: rows[i].idx,
          lockType: rows[i].lock_type,
          lockMode: rows[i].lock_mode
        });
        used.add(key);
      }
    }

    res.json(grouped);
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/latest - Get latest deadlock timestamp
app.get('/api/latest', async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT MAX(ts) as latest_ts FROM deadlocks`);
    res.json({ timestamp: rows[0].latest_ts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Task Management APIs
// ============================================

// GET /api/tasks - Get all monitor tasks (with namespace filter)
app.get('/api/tasks', requireNamespace(), async (req, res) => {
  try {
    let query = `
      SELECT id, name, target_host, target_port, target_user,
             \`interval\`, storage_type, remote_host, remote_port,
             remote_db, remote_table, status, namespace_id, created_at, updated_at
      FROM monitor_tasks
      WHERE 1=1
    `;
    const params = [];

    // Namespace isolation - users can see tasks from their accessible namespaces
    if (req.user.role !== 'admin') {
      query += `
        AND namespace_id IN (
          SELECT namespace_id FROM user_namespaces WHERE user_id = ?
          UNION
          SELECT id FROM namespaces WHERE owner_id = ?
        )
      `;
      params.push(req.user.id, req.user.id);
    }

    query += ` ORDER BY id DESC`;

    const [tasks] = await pool.query(query, params);
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tasks/sources - Get unique source servers (accessible by user)
app.get('/api/tasks/sources', requireNamespace(), async (req, res) => {
  try {
    // 返回用户可访问的任务对应的 server 列表
    let query = `
      SELECT DISTINCT target_host as server
      FROM monitor_tasks
      WHERE status = 'active'
    `;
    const params = [];

    if (req.user.role !== 'admin') {
      query += `
        AND namespace_id IN (
          SELECT namespace_id FROM user_namespaces WHERE user_id = ?
          UNION
          SELECT id FROM namespaces WHERE owner_id = ?
        )
      `;
      params.push(req.user.id, req.user.id);
    }

    const [rows] = await pool.query(query, params);
    res.json(rows.map(r => r.server));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tasks/:id - Get single task
app.get('/api/tasks/:id', requireNamespace(), async (req, res) => {
  try {
    let query = `SELECT * FROM monitor_tasks WHERE id = ?`;
    const params = [req.params.id];

    if (req.user.role !== 'admin') {
      query += `
        AND namespace_id IN (
          SELECT namespace_id FROM user_namespaces WHERE user_id = ?
          UNION
          SELECT id FROM namespaces WHERE owner_id = ?
        )
      `;
      params.push(req.user.id, req.user.id);
    }

    const [tasks] = await pool.query(query, params);

    if (tasks.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    res.json(tasks[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tasks - Create new task (Editor+)
app.post('/api/tasks', requireRole('editor', 'admin'), async (req, res) => {
  try {
    const {
      name, target_host, target_port, target_user, target_password,
      interval, storage_type, remote_host, remote_port,
      remote_user, remote_password, remote_db, remote_table
    } = req.body;

    if (!name || !target_host || !target_user || !target_password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await pool.query(`
      INSERT INTO monitor_tasks
      (name, target_host, target_port, target_user, target_password,
       \`interval\`, storage_type, remote_host, remote_port,
       remote_user, remote_password, remote_db, remote_table,
       namespace_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      name,
      target_host,
      target_port || 3306,
      target_user,
      target_password,
      interval || 10,
      storage_type || 'local',
      remote_host || null,
      remote_port || 3306,
      remote_user || null,
      remote_password || null,
      remote_db || null,
      remote_table || null,
      req.user.namespaceId,
      req.user.id
    ]);

    res.json({
      id: result[0].insertId,
      message: 'Task created successfully'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/tasks/:id - Update task (Editor+)
app.put('/api/tasks/:id', requireRole('editor', 'admin'), requireNamespace(), async (req, res) => {
  try {
    const {
      name, target_host, target_port, target_user, target_password,
      interval, storage_type, remote_host, remote_port,
      remote_user, remote_password, remote_db, remote_table, status
    } = req.body;

    // Check if task exists (with namespace check)
    let checkQuery = `SELECT id FROM monitor_tasks WHERE id = ?`;
    const checkParams = [req.params.id];

    if (req.user.role !== 'admin') {
      checkQuery += `
        AND namespace_id IN (
          SELECT namespace_id FROM user_namespaces WHERE user_id = ?
          UNION
          SELECT id FROM namespaces WHERE owner_id = ?
        )
      `;
      checkParams.push(req.user.id, req.user.id);
    }

    const [existing] = await pool.query(checkQuery, checkParams);

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    let updateQuery = `
      UPDATE monitor_tasks SET
        name = ?, target_host = ?, target_port = ?, target_user = ?, target_password = ?,
        \`interval\` = ?, storage_type = ?, remote_host = ?, remote_port = ?,
        remote_user = ?, remote_password = ?, remote_db = ?, remote_table = ?, status = ?
      WHERE id = ?
    `;
    const updateParams = [
      name,
      target_host,
      target_port || 3306,
      target_user,
      target_password,
      interval || 10,
      storage_type || 'local',
      remote_host || null,
      remote_port || 3306,
      remote_user || null,
      remote_password || null,
      remote_db || null,
      remote_table || null,
      status || 'active',
      req.params.id
    ];

    await pool.query(updateQuery, updateParams);

    res.json({ message: 'Task updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/tasks/:id - Delete task (Editor+)
app.delete('/api/tasks/:id', requireRole('editor', 'admin'), requireNamespace(), async (req, res) => {
  try {
    let query = `DELETE FROM monitor_tasks WHERE id = ?`;
    const params = [req.params.id];

    if (req.user.role !== 'admin') {
      query += `
        AND namespace_id IN (
          SELECT namespace_id FROM user_namespaces WHERE user_id = ?
          UNION
          SELECT id FROM namespaces WHERE owner_id = ?
        )
      `;
      params.push(req.user.id, req.user.id);
    }

    const [result] = await pool.query(query, params);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    res.json({ message: 'Task deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tasks/:id/toggle - Toggle task status (Editor+)
app.post('/api/tasks/:id/toggle', requireRole('editor', 'admin'), requireNamespace(), async (req, res) => {
  try {
    let query = `SELECT status FROM monitor_tasks WHERE id = ?`;
    const params = [req.params.id];

    if (req.user.role !== 'admin') {
      query += `
        AND namespace_id IN (
          SELECT namespace_id FROM user_namespaces WHERE user_id = ?
          UNION
          SELECT id FROM namespaces WHERE owner_id = ?
        )
      `;
      params.push(req.user.id, req.user.id);
    }

    const [tasks] = await pool.query(query, params);

    if (tasks.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const newStatus = tasks[0].status === 'active' ? 'paused' : 'active';

    await pool.query(`UPDATE monitor_tasks SET status = ? WHERE id = ?`, [newStatus, req.params.id]);

    res.json({ message: `Task ${newStatus === 'active' ? 'activated' : 'paused'} successfully` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/status - Get monitor manager status
app.get('/api/status', requireNamespace(), async (req, res) => {
  try {
    let query = `
      SELECT id, name, target_host, target_port, status, \`interval\`
      FROM monitor_tasks
      WHERE status = 'active'
    `;
    const params = [];

    if (req.user.role !== 'admin') {
      query += `
        AND namespace_id IN (
          SELECT namespace_id FROM user_namespaces WHERE user_id = ?
          UNION
          SELECT id FROM namespaces WHERE owner_id = ?
        )
      `;
      params.push(req.user.id, req.user.id);
    }

    const [activeTasks] = await pool.query(query, params);

    res.json({
      activeTasks: activeTasks.length,
      tasks: activeTasks
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// History API
// ============================================

// GET /api/history/filters - Get filter options
app.get('/api/history/filters', requireNamespace(), async (req, res) => {
  try {
    // 1. 先获取用户可访问的 server 列表（子查询，数据量小）
    let serverWhere = '';
    let serverParams = [];

    if (req.user.role !== 'admin') {
      const [taskServers] = await pool.query(`
        SELECT DISTINCT target_host as server
        FROM monitor_tasks
        WHERE status = 'active'
          AND namespace_id IN (
            SELECT namespace_id FROM user_namespaces WHERE user_id = ?
            UNION
            SELECT id FROM namespaces WHERE owner_id = ?
          )
      `, [req.user.id, req.user.id]);

      if (taskServers.length === 0) {
        return res.json({
          servers: [],
          lock_types: [],
          lock_modes: [],
          databases: [],
          tables: []
        });
      }

      serverWhere = ' AND server IN (?)';
      serverParams = [taskServers.map(t => t.server)];
    }

    // 2. 查询过滤选项
    const params = [...serverParams];

    const [servers] = await pool.query(`SELECT DISTINCT server FROM deadlocks WHERE 1=1 ${serverWhere} ORDER BY server`, params);
    const [lockTypes] = await pool.query(`SELECT DISTINCT lock_type FROM deadlocks WHERE 1=1 ${serverWhere} ORDER BY lock_type`, params);
    const [lockModes] = await pool.query(`SELECT DISTINCT lock_mode FROM deadlocks WHERE 1=1 ${serverWhere} ORDER BY lock_mode`, params);
    const [databases] = await pool.query(`SELECT DISTINCT db FROM deadlocks WHERE 1=1 ${serverWhere} ORDER BY db`, params);
    const [tables] = await pool.query(`SELECT DISTINCT tbl FROM deadlocks WHERE 1=1 ${serverWhere} ORDER BY tbl`, params);

    res.json({
      servers: servers.map(r => r.server),
      lock_types: lockTypes.map(r => r.lock_type),
      lock_modes: lockModes.map(r => r.lock_mode),
      databases: databases.map(r => r.db),
      tables: tables.map(r => r.tbl)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history - Get history records with pagination
app.get('/api/history', requireNamespace(), async (req, res) => {
  try {
    const {
      server, lock_type, lock_mode, idx, tbl, db, ip, hostname,
      user, wait_hold, victim, query, date_from, date_to,
      page = 1, pageSize = 50
    } = req.query;

    // 1. 先获取用户可访问的 server 列表（子查询，数据量小）
    let serverWhere = '';
    let serverParams = [];

    if (req.user.role !== 'admin') {
      const [taskServers] = await pool.query(`
        SELECT DISTINCT target_host as server
        FROM monitor_tasks
        WHERE status = 'active'
          AND namespace_id IN (
            SELECT namespace_id FROM user_namespaces WHERE user_id = ?
            UNION
            SELECT id FROM namespaces WHERE owner_id = ?
          )
      `, [req.user.id, req.user.id]);

      if (taskServers.length === 0) {
        return res.json({ total: 0, page: 1, pageSize: 50, totalPages: 0, data: [] });
      }

      serverWhere = ' AND server IN (?)';
      serverParams = [taskServers.map(t => t.server)];
    }

    // 2. 组合其他过滤条件
    let whereClause = `WHERE 1=1 ${serverWhere}`;
    let params = [...serverParams];

    if (server) { whereClause += ` AND server = ?`; params.push(server); }
    if (lock_type) { whereClause += ` AND lock_type = ?`; params.push(lock_type); }
    if (lock_mode) { whereClause += ` AND lock_mode = ?`; params.push(lock_mode); }
    if (idx) { whereClause += ` AND idx LIKE ?`; params.push(`%${idx}%`); }
    if (tbl) { whereClause += ` AND tbl LIKE ?`; params.push(`%${tbl}%`); }
    if (db) { whereClause += ` AND db LIKE ?`; params.push(`%${db}%`); }
    if (ip) { whereClause += ` AND ip = ?`; params.push(ip); }
    if (hostname) { whereClause += ` AND hostname LIKE ?`; params.push(`%${hostname}%`); }
    if (user) { whereClause += ` AND user = ?`; params.push(user); }
    if (wait_hold) { whereClause += ` AND wait_hold = ?`; params.push(wait_hold); }
    if (victim !== undefined && victim !== '') { whereClause += ` AND victim = ?`; params.push(parseInt(victim)); }
    if (query) { whereClause += ` AND query LIKE ?`; params.push(`%${query}%`); }
    if (date_from) { whereClause += ` AND ts >= ?`; params.push(date_from); }
    if (date_to) { whereClause += ` AND ts <= ?`; params.push(date_to); }

    const pageNum = parseInt(page);
    const pageSizeNum = parseInt(pageSize);
    const offset = (pageNum - 1) * pageSizeNum;

    const [countRows] = await pool.query(`SELECT COUNT(*) as total FROM deadlocks ${whereClause}`, params);
    const total = countRows[0].total;

    const dataQuery = `SELECT * FROM deadlocks ${whereClause} ORDER BY ts DESC, thread DESC LIMIT ? OFFSET ?`;
    const [rows] = await pool.query(dataQuery, [...params, pageSizeNum, offset]);

    const formatDateTime = (date) => {
      const bjTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
      return bjTime.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });
    };

    const formattedRows = rows.map(row => ({
      ...row,
      ts: formatDateTime(row.ts),
      ts_raw: row.ts.toISOString()
    }));

    res.json({
      total,
      page: pageNum,
      pageSize: pageSizeNum,
      totalPages: Math.ceil(total / pageSizeNum),
      data: formattedRows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Error Handling
// ============================================

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ============================================
// Start Server
// ============================================

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Deadlock Monitor running at http://localhost:${port}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
