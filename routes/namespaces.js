/**
 * 命名空间管理路由 (Admin Only)
 */

import { Router } from 'express';

const router = Router();

/**
 * GET /api/namespaces
 * 获取命名空间列表
 */
router.get('/', async (req, res) => {
  const pool = req.app.get('dbPool');

  try {
    const [namespaces] = await pool.query(`
      SELECT n.*, u.username as owner_username
      FROM namespaces n
      LEFT JOIN users u ON n.owner_id = u.id
      ORDER BY n.created_at DESC
    `);

    res.json(namespaces);
  } catch (err) {
    console.error('[Namespaces] Get namespaces error:', err.message);
    res.status(500).json({ error: 'Failed to get namespaces' });
  }
});

/**
 * GET /api/namespaces/available
 * 获取用户可访问的命名空间 (用于前端下拉选择)
 */
router.get('/available', async (req, res) => {
  const pool = req.app.get('dbPool');
  const userId = req.user.id;

  try {
    // Admin 可以看到所有命名空间
    if (req.user.role === 'admin') {
      const [namespaces] = await pool.query(`SELECT id, name, code FROM namespaces ORDER BY name`);
      return res.json(namespaces);
    }

    // 普通用户只能看到自己有权限的命名空间
    const [namespaces] = await pool.query(`
      SELECT n.id, n.name, n.code, un.is_default
      FROM user_namespaces un
      JOIN namespaces n ON un.namespace_id = n.id
      WHERE un.user_id = ?
      ORDER BY un.is_default DESC, n.name
    `, [userId]);

    res.json(namespaces);
  } catch (err) {
    console.error('[Namespaces] Get available namespaces error:', err.message);
    res.status(500).json({ error: 'Failed to get namespaces' });
  }
});

/**
 * GET /api/namespaces/:id
 * 获取单个命名空间详情
 */
router.get('/:id', async (req, res) => {
  const pool = req.app.get('dbPool');

  try {
    const [namespaces] = await pool.query(`
      SELECT n.*, u.username as owner_username,
             (SELECT COUNT(*) FROM monitor_tasks WHERE namespace_id = n.id) as task_count,
             (SELECT COUNT(*) FROM deadlocks WHERE namespace_id = n.id) as deadlock_count
      FROM namespaces n
      LEFT JOIN users u ON n.owner_id = u.id
      WHERE n.id = ?
    `, [req.params.id]);

    if (namespaces.length === 0) {
      return res.status(404).json({ error: 'Namespace not found' });
    }

    // 获取该命名空间下的用户
    const [users] = await pool.query(`
      SELECT u.id, u.username, u.display_name, un.is_default
      FROM user_namespaces un
      JOIN users u ON un.user_id = u.id
      WHERE un.namespace_id = ?
    `, [req.params.id]);

    res.json({
      ...namespaces[0],
      users
    });
  } catch (err) {
    console.error('[Namespaces] Get namespace error:', err.message);
    res.status(500).json({ error: 'Failed to get namespace' });
  }
});

/**
 * POST /api/namespaces
 * 创建命名空间
 */
router.post('/', async (req, res) => {
  const pool = req.app.get('dbPool');
  const { name, code, description } = req.body;

  if (!name || !code) {
    return res.status(400).json({ error: 'Name and code required' });
  }

  try {
    // 检查 code 是否已存在
    const [existing] = await pool.query(
      `SELECT id FROM namespaces WHERE code = ?`,
      [code]
    );

    if (existing.length > 0) {
      return res.status(400).json({ error: 'Namespace code already exists' });
    }

    const result = await pool.query(`
      INSERT INTO namespaces (name, code, description, owner_id)
      VALUES (?, ?, ?, ?)
    `, [name, code, description || null, req.user.id]);

    const namespaceId = result[0].insertId;

    // 创建者自动加入命名空间
    await pool.query(
      `INSERT INTO user_namespaces (user_id, namespace_id, is_default) VALUES (?, ?, 0)`,
      [req.user.id, namespaceId]
    );

    // 审计日志
    await pool.query(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
       VALUES (?, 'create_namespace', 'namespace', ?, ?)`,
      [req.user.id, namespaceId, JSON.stringify({ name, code })]
    );

    res.json({ id: namespaceId, message: 'Namespace created successfully' });
  } catch (err) {
    console.error('[Namespaces] Create namespace error:', err.message);
    res.status(500).json({ error: 'Failed to create namespace' });
  }
});

/**
 * PUT /api/namespaces/:id
 * 更新命名空间
 */
router.put('/:id', async (req, res) => {
  const pool = req.app.get('dbPool');
  const { name, description, owner_id } = req.body;

  try {
    // 检查命名空间是否存在
    const [existing] = await pool.query(`SELECT id FROM namespaces WHERE id = ?`, [req.params.id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Namespace not found' });
    }

    const updates = [];
    const values = [];

    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
    if (description !== undefined) { updates.push('description = ?'); values.push(description); }
    if (owner_id !== undefined) { updates.push('owner_id = ?'); values.push(owner_id); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.params.id);

    await pool.query(`UPDATE namespaces SET ${updates.join(', ')} WHERE id = ?`, values);

    // 审计日志
    await pool.query(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
       VALUES (?, 'update_namespace', 'namespace', ?, ?)`,
      [req.user.id, req.params.id, JSON.stringify({ updates })]
    );

    res.json({ message: 'Namespace updated successfully' });
  } catch (err) {
    console.error('[Namespaces] Update namespace error:', err.message);
    res.status(500).json({ error: 'Failed to update namespace' });
  }
});

/**
 * DELETE /api/namespaces/:id
 * 删除命名空间
 */
router.delete('/:id', async (req, res) => {
  const pool = req.app.get('dbPool');

  try {
    // 检查命名空间是否存在
    const [existing] = await pool.query(`SELECT id FROM namespaces WHERE id = ?`, [req.params.id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Namespace not found' });
    }

    // 不能删除默认命名空间
    const [isDefault] = await pool.query(`SELECT is_default FROM namespaces WHERE id = ?`, [req.params.id]);
    if (isDefault[0].is_default) {
      return res.status(400).json({ error: 'Cannot delete default namespace' });
    }

    await pool.query(`DELETE FROM namespaces WHERE id = ?`, [req.params.id]);

    // 审计日志
    await pool.query(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id)
       VALUES (?, 'delete_namespace', 'namespace', ?)`,
      [req.user.id, req.params.id]
    );

    res.json({ message: 'Namespace deleted successfully' });
  } catch (err) {
    console.error('[Namespaces] Delete namespace error:', err.message);
    res.status(500).json({ error: 'Failed to delete namespace' });
  }
});

export default router;
