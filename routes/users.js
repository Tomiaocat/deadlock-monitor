/**
 * 用户管理路由 (Admin Only)
 */

import { Router } from 'express';
import bcrypt from 'bcrypt';

const router = Router();

/**
 * GET /api/users
 * 获取用户列表
 */
router.get('/', async (req, res) => {
  const pool = req.app.get('dbPool');

  try {
    const [users] = await pool.query(`
      SELECT u.id, u.username, u.email, u.display_name, u.is_active,
             u.last_login_at, u.last_login_ip, u.created_at,
             r.name as role, n.name as namespace_name
      FROM users u
      JOIN roles r ON u.role_id = r.id
      LEFT JOIN namespaces n ON u.namespace_id = n.id
      ORDER BY u.created_at DESC
    `);

    res.json(users);
  } catch (err) {
    console.error('[Users] Get users error:', err.message);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

/**
 * GET /api/users/:id
 * 获取单个用户详情
 */
router.get('/:id', async (req, res) => {
  const pool = req.app.get('dbPool');

  try {
    const [users] = await pool.query(`
      SELECT u.id, u.username, u.email, u.display_name, u.is_active,
             u.role_id, u.namespace_id, u.last_login_at, u.created_at,
             r.name as role
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE u.id = ?
    `, [req.params.id]);

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // 获取用户可访问的命名空间
    const [namespaces] = await pool.query(
      `SELECT n.id, n.name, n.code, un.is_default
       FROM user_namespaces un
       JOIN namespaces n ON un.namespace_id = n.id
       WHERE un.user_id = ?`,
      [req.params.id]
    );

    res.json({
      ...users[0],
      namespaces
    });
  } catch (err) {
    console.error('[Users] Get user error:', err.message);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

/**
 * POST /api/users
 * 创建用户
 */
router.post('/', async (req, res) => {
  const pool = req.app.get('dbPool');
  const { username, email, password, display_name, role_id, namespace_id, namespaces } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    // 检查用户名是否已存在
    const [existing] = await pool.query(
      `SELECT id FROM users WHERE username = ?`,
      [username]
    );

    if (existing.length > 0) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    // 哈希密码
    const passwordHash = await bcrypt.hash(password, 12);

    // 创建用户
    const result = await pool.query(`
      INSERT INTO users (username, email, password_hash, display_name, role_id, namespace_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [username, email || null, passwordHash, display_name || null, role_id || 3, namespace_id || null]);

    const userId = result[0].insertId;

    // 分配命名空间
    if (namespaces && namespaces.length > 0) {
      const values = namespaces.map(nsId => [`(${userId}, ${nsId}, 0)`]).join(',');
      await pool.query(`INSERT INTO user_namespaces (user_id, namespace_id, is_default) VALUES ${values}`);
    } else if (namespace_id) {
      await pool.query(
        `INSERT INTO user_namespaces (user_id, namespace_id, is_default) VALUES (?, ?, 1)`,
        [userId, namespace_id]
      );
    }

    // 审计日志
    await pool.query(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
       VALUES (?, 'create_user', 'user', ?, ?)`,
      [req.user.id, userId, JSON.stringify({ username, email, role_id })]
    );

    res.json({ id: userId, message: 'User created successfully' });
  } catch (err) {
    console.error('[Users] Create user error:', err.message);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

/**
 * PUT /api/users/:id
 * 更新用户
 */
router.put('/:id', async (req, res) => {
  const pool = req.app.get('dbPool');
  const { email, display_name, is_active, role_id, namespace_id, password } = req.body;

  try {
    // 检查用户是否存在
    const [existing] = await pool.query(`SELECT id FROM users WHERE id = ?`, [req.params.id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // 构建更新字段
    const updates = [];
    const values = [];

    if (email !== undefined) { updates.push('email = ?'); values.push(email); }
    if (display_name !== undefined) { updates.push('display_name = ?'); values.push(display_name); }
    if (is_active !== undefined) { updates.push('is_active = ?'); values.push(is_active); }
    if (role_id !== undefined) { updates.push('role_id = ?'); values.push(role_id); }
    if (namespace_id !== undefined) { updates.push('namespace_id = ?'); values.push(namespace_id); }

    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      updates.push('password_hash = ?');
      values.push(await bcrypt.hash(password, 12));
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.params.id);

    await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);

    // 审计日志
    await pool.query(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
       VALUES (?, 'update_user', 'user', ?, ?)`,
      [req.user.id, req.params.id, JSON.stringify({ updates })]
    );

    res.json({ message: 'User updated successfully' });
  } catch (err) {
    console.error('[Users] Update user error:', err.message);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

/**
 * DELETE /api/users/:id
 * 删除用户
 */
router.delete('/:id', async (req, res) => {
  const pool = req.app.get('dbPool');

  try {
    // 检查用户是否存在
    const [existing] = await pool.query(`SELECT id FROM users WHERE id = ?`, [req.params.id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // 不能删除自己
    if (parseInt(req.params.id) === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }

    await pool.query(`DELETE FROM users WHERE id = ?`, [req.params.id]);

    // 审计日志
    await pool.query(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id)
       VALUES (?, 'delete_user', 'user', ?)`,
      [req.user.id, req.params.id]
    );

    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    console.error('[Users] Delete user error:', err.message);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

/**
 * POST /api/users/:id/namespaces
 * 更新用户命名空间
 */
router.post('/:id/namespaces', async (req, res) => {
  const pool = req.app.get('dbPool');
  const { namespace_ids, default_namespace_id } = req.body;

  if (!namespace_ids || !Array.isArray(namespace_ids)) {
    return res.status(400).json({ error: 'namespace_ids array required' });
  }

  try {
    // 删除现有映射
    await pool.query(`DELETE FROM user_namespaces WHERE user_id = ?`, [req.params.id]);

    // 添加新映射
    if (namespace_ids.length > 0) {
      const values = namespace_ids.map(nsId => `(${req.params.id}, ${nsId}, ${default_namespace_id === nsId ? 1 : 0})`).join(',');
      await pool.query(`INSERT INTO user_namespaces (user_id, namespace_id, is_default) VALUES ${values}`);
    }

    // 更新默认命名空间
    if (default_namespace_id) {
      await pool.query(`UPDATE users SET namespace_id = ? WHERE id = ?`, [default_namespace_id, req.params.id]);
    }

    // 审计日志
    await pool.query(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
       VALUES (?, 'update_user_namespaces', 'user', ?, ?)`,
      [req.user.id, req.params.id, JSON.stringify({ namespace_ids, default_namespace_id })]
    );

    res.json({ message: 'User namespaces updated successfully' });
  } catch (err) {
    console.error('[Users] Update namespaces error:', err.message);
    res.status(500).json({ error: 'Failed to update namespaces' });
  }
});

export default router;
