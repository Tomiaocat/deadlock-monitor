/**
 * Namespace Backfill Processor - 命名空间后置处理器
 *
 * 职责：
 * 1. 每 30 秒扫描 deadlocks 表
 * 2. 找出 namespace_id IS NULL 且 server 在映射表中不存在的记录
 * 3. 根据 server 匹配活跃的 monitor_tasks
 * 4. 批量插入到 deadlocks_namespace_map 表
 */

import mysql from 'mysql2/promise';

// Database connection
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'mysql',
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'root',
  database: process.env.DB_NAME || 'deadlock_monitor',
  timezone: '+08:00',
  waitForConnections: true,
  connectionLimit: 3,
  queueLimit: 0
});

// 检查数据库连接
async function checkDatabaseConnection() {
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    console.log('[NamespaceBackfill] Database connection established');
    return true;
  } catch (err) {
    console.error('[NamespaceBackfill] Database connection failed:', err.message);
    return false;
  }
}

// 等待数据库就绪
async function waitForDatabase() {
  console.log('[NamespaceBackfill] Waiting for database connection...');
  let attempts = 0;
  while (attempts < 30) {
    if (await checkDatabaseConnection()) {
      return true;
    }
    attempts++;
    await sleep(2000);
  }
  throw new Error('Database connection failed after 30 attempts');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 后置填充命名空间映射
async function backfillNamespaces() {
  try {
    const startTime = Date.now();

    // 1. 获取所有活跃任务及其命名空间
    const [tasks] = await pool.query(`
      SELECT DISTINCT target_host as server, namespace_id, id as task_id
      FROM monitor_tasks
      WHERE status = 'active' AND namespace_id IS NOT NULL
    `);

    if (tasks.length === 0) {
      console.log('[NamespaceBackfill] No active tasks with namespace found');
      return;
    }

    // 2. 获取已有映射的 server 列表（避免重复插入）
    const [existing] = await pool.query(`
      SELECT DISTINCT server FROM deadlocks_namespace_map
    `);
    const existingServers = new Set(existing.map(t => t.server));

    // 3. 过滤出新任务（需要建立映射的）
    const newTasks = tasks.filter(t => !existingServers.has(t.server));

    if (newTasks.length === 0) {
      console.log('[NamespaceBackfill] All servers already have mappings');
      return;
    }

    // 4. 获取需要处理的 server 列表
    const serversToProcess = [...new Set(newTasks.map(t => t.server))];

    // 5. 检查 deadlocks 表中是否有这些 server 的数据
    const placeholders = serversToProcess.map(() => '?').join(',');
    const [deadlockServers] = await pool.query(`
      SELECT DISTINCT server FROM deadlocks
      WHERE server IN (${placeholders})
    `, serversToProcess);

    if (deadlockServers.length === 0) {
      console.log('[NamespaceBackfill] No deadlock data found for new servers');
      return;
    }

    const deadlockServerSet = new Set(deadlockServers.map(d => d.server));
    const validTasks = newTasks.filter(t => deadlockServerSet.has(t.server));

    if (validTasks.length === 0) {
      console.log('[NamespaceBackfill] No valid tasks to process');
      return;
    }

    // 6. 批量插入映射
    // 使用 INSERT ... SELECT 从 monitor_tasks 表获取数据
    await pool.query(`
      INSERT INTO deadlocks_namespace_map (server, namespace_id, task_id)
      SELECT DISTINCT d.server, t.namespace_id, t.id
      FROM deadlocks d
      JOIN monitor_tasks t ON d.server = t.target_host
      WHERE d.server IN (${placeholders})
        AND t.status = 'active'
        AND t.namespace_id IS NOT NULL
      ON DUPLICATE KEY UPDATE created_at = created_at
    `, serversToProcess);

    const duration = Date.now() - startTime;
    console.log(`[NamespaceBackfill] Backfilled ${validTasks.length} task mappings in ${duration}ms`);
  } catch (err) {
    console.error('[NamespaceBackfill] Error during backfill:', err.message);
  }
}

// 清理过期的映射（任务已删除或已暂停）
async function cleanupMappings() {
  try {
    const startTime = Date.now();

    // 删除对应任务已暂停或已删除的映射
    const [result] = await pool.query(`
      DELETE FROM deadlocks_namespace_map
      WHERE task_id NOT IN (
        SELECT id FROM monitor_tasks WHERE status = 'active'
      )
    `);

    if (result.affectedRows > 0) {
      console.log(`[NamespaceBackfill] Cleaned up ${result.affectedRows} stale mappings in ${Date.now() - startTime}ms`);
    }
  } catch (err) {
    console.error('[NamespaceBackfill] Error during cleanup:', err.message);
  }
}

// 主循环
async function main() {
  console.log('[NamespaceBackfill] Starting Namespace Backfill Processor...');

  try {
    await waitForDatabase();
    console.log('[NamespaceBackfill] Database is ready');

    // 初始执行
    await backfillNamespaces();
    await cleanupMappings();

    // 每 30 秒执行一次后置填充
    setInterval(async () => {
      await backfillNamespaces();
    }, 30000);

    // 每 5 分钟清理一次过期映射
    setInterval(async () => {
      await cleanupMappings();
    }, 300000);

    // 处理进程退出信号
    process.on('SIGTERM', () => {
      console.log('[NamespaceBackfill] Received SIGTERM, shutting down...');
      process.exit(0);
    });

    process.on('SIGINT', () => {
      console.log('[NamespaceBackfill] Received SIGINT, shutting down...');
      process.exit(0);
    });

    console.log('[NamespaceBackfill] Processor is running (backfill every 30s, cleanup every 5m)');
  } catch (err) {
    console.error('[NamespaceBackfill] Fatal error:', err.message);
    process.exit(1);
  }
}

// 启动
main();
