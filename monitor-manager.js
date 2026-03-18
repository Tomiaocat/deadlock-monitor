/**
 * Monitor Manager - 监控任务管理器
 *
 * 职责：
 * 1. 从数据库读取监控任务配置
 * 2. 启动/停止 pt-deadlock-logger 进程
 * 3. 监听配置变化，动态调整监控进程
 */

import mysql from 'mysql2/promise';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

// 当前运行的监控进程 Map<taskId, ProcessInfo>
const currentProcesses = new Map();

// 检查数据库连接
async function checkDatabaseConnection() {
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    console.log('[MonitorManager] Database connection established');
    return true;
  } catch (err) {
    console.error('[MonitorManager] Database connection failed:', err.message);
    return false;
  }
}

// 等待数据库就绪
async function waitForDatabase() {
  console.log('[MonitorManager] Waiting for database connection...');
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

// 构建 pt-deadlock-logger 的目标连接字符串
function buildDestString(task) {
  if (task.storage_type === 'local') {
    // 本地存储：D=database,t=table,h=host,P=port,u=user,p=password
    return `D=deadlock_monitor,t=deadlocks,h=${process.env.DB_HOST || 'mysql'},P=${process.env.DB_PORT || 3306},u=${process.env.DB_USER || 'root'},p=${process.env.DB_PASSWORD || 'root'}`;
  } else {
    // 远程存储：D=remote_db,t=remote_table,h=remote_host,P=remote_port,u=remote_user,p=remote_password
    return `D=${task.remote_db},t=${task.remote_table},h=${task.remote_host},P=${task.remote_port},u=${task.remote_user},p=${task.remote_password}`;
  }
}

// 启动监控进程
function startProcess(task) {
  try {
    const dest = buildDestString(task);

    const args = [
      `--user=${task.target_user}`,
      `--password=${task.target_password}`,
      `--host=${task.target_host}`,
      `--port=${task.target_port}`,
      `--dest=${dest}`,
      `--interval=${task.interval}`,
      `--quiet`
    ];

    console.log(`[MonitorManager] Starting pt-deadlock-logger for task "${task.name}" (id=${task.id})`);
    console.log(`[MonitorManager] Command: pt-deadlock-logger ${args.join(' ')}`);

    const proc = spawn('pt-deadlock-logger', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });

    // 错误计数器，用于检测持续错误
    let errorCount = 0;
    let lastErrorTime = 0;
    const ERROR_THRESHOLD = 5; // 连续 5 次错误
    const ERROR_WINDOW_MS = 60000; // 1 分钟内

    proc.stdout.on('data', (data) => {
      console.log(`[MonitorManager:task-${task.id}] ${data.toString().trim()}`);
    });

    proc.stderr.on('data', (data) => {
      const errorMsg = data.toString().trim();
      console.error(`[MonitorManager:task-${task.id}] ERROR: ${errorMsg}`);

      // 检测连接错误（Server has gone away, Access denied, Can't connect 等）
      if (errorMsg.includes('Server has gone away') ||
          errorMsg.includes('Access denied') ||
          errorMsg.includes("Can't connect")) {
        const now = Date.now();
        if (now - lastErrorTime > ERROR_WINDOW_MS) {
          errorCount = 1;
          lastErrorTime = now;
        } else {
          errorCount++;
        }

        // 如果错误次数超过阈值，重启进程
        if (errorCount >= ERROR_THRESHOLD) {
          console.log(`[MonitorManager:task-${task.id}] Too many errors (${errorCount}), restarting process...`);
          errorCount = 0;
          try {
            proc.kill('SIGTERM');
            setTimeout(() => {
              try { proc.kill('SIGKILL'); } catch (e) {}
            }, 5000);
          } catch (e) {}
        }
      }
    });

    proc.on('exit', (code) => {
      console.log(`[MonitorManager] pt-deadlock-logger for task "${task.name}" exited with code ${code}`);
      currentProcesses.delete(task.id);
      // 30 秒后尝试重启
      setTimeout(() => {
        if (!currentProcesses.has(task.id)) {
          console.log(`[MonitorManager] Attempting to restart task "${task.name}"`);
          const freshTask = { ...task };
          startProcess(freshTask);
        }
      }, 30000);
    });

    currentProcesses.set(task.id, {
      process: proc,
      task: task,
      startedAt: new Date()
    });

    console.log(`[MonitorManager] Successfully started task "${task.name}" (PID: ${proc.pid})`);
  } catch (err) {
    console.error(`[MonitorManager] Failed to start task "${task.name}":`, err.message);
  }
}

// 停止监控进程
function stopProcess(taskId, taskName) {
  const procInfo = currentProcesses.get(taskId);
  if (procInfo) {
    console.log(`[MonitorManager] Stopping task "${taskName}" (PID: ${procInfo.process.pid})`);

    // 发送 SIGTERM 信号
    procInfo.process.kill('SIGTERM');

    // 5 秒后强制杀死
    setTimeout(() => {
      if (procInfo.process && !procInfo.process.killed) {
        try {
          procInfo.process.kill('SIGKILL');
        } catch (e) {
          // 进程可能已经退出
        }
      }
    }, 5000);

    currentProcesses.delete(taskId);
    console.log(`[MonitorManager] Task "${taskName}" stopped`);
  }
}

// 同步监控进程（启动新任务，停止已删除/暂停的任务）
async function syncMonitorProcesses() {
  try {
    const [tasks] = await pool.query(`
      SELECT * FROM monitor_tasks
      WHERE status IN ('active', 'paused')
      ORDER BY id
    `);

    const running = new Set(currentProcesses.keys());
    const expected = new Set(tasks.filter(t => t.status === 'active').map(t => t.id));

    // 停止已删除、暂停的任务
    for (const id of running) {
      if (!expected.has(id)) {
        const task = currentProcesses.get(id)?.task;
        if (task) {
          const taskStatus = tasks.find(t => t.id === id)?.status;
          if (taskStatus === 'paused') {
            console.log(`[MonitorManager] Task "${task.name}" is paused, stopping...`);
          } else {
            console.log(`[MonitorManager] Task "${task.name}" no longer active, stopping...`);
          }
          stopProcess(id, task.name);
        }
      }
    }

    // 启动新任务
    for (const task of tasks) {
      if (task.status === 'active' && !running.has(task.id)) {
        startProcess(task);
      }
    }

    // 输出状态摘要
    const activeCount = currentProcesses.size;
    console.log(`[MonitorManager] Sync complete: ${activeCount} active monitor process(es)`);
  } catch (err) {
    console.error('[MonitorManager] Error syncing processes:', err.message);
  }
}

// 获取运行状态摘要
function getStatusSummary() {
  const status = {
    total: currentProcesses.size,
    tasks: []
  };

  for (const [id, info] of currentProcesses) {
    const uptime = Math.floor((Date.now() - info.startedAt.getTime()) / 1000);
    status.tasks.push({
      id: id,
      name: info.task.name,
      target: `${info.task.target_host}:${info.task.target_port}`,
      pid: info.process.pid,
      uptime: uptime
    });
  }

  return status;
}

// 主循环
async function main() {
  console.log('[MonitorManager] Starting Monitor Manager...');

  try {
    await waitForDatabase();
    console.log('[MonitorManager] Database is ready');

    // 初始同步
    await syncMonitorProcesses();

    // 定期同步（每 10 秒检查一次配置变化）
    setInterval(async () => {
      await syncMonitorProcesses();
    }, 10000);

    // 定期输出状态（每 60 秒）
    setInterval(() => {
      const status = getStatusSummary();
      console.log(`[MonitorManager] Status: ${status.total} process(es) running`);
      status.tasks.forEach(t => {
        console.log(`  - Task ${t.id} "${t.name}" -> ${t.target} (PID: ${t.pid}, Uptime: ${t.uptime}s)`);
      });
    }, 60000);

    // 处理进程退出信号
    process.on('SIGTERM', () => {
      console.log('[MonitorManager] Received SIGTERM, shutting down...');
      for (const [id, info] of currentProcesses) {
        stopProcess(id, info.task.name);
      }
      process.exit(0);
    });

    process.on('SIGINT', () => {
      console.log('[MonitorManager] Received SIGINT, shutting down...');
      for (const [id, info] of currentProcesses) {
        stopProcess(id, info.task.name);
      }
      process.exit(0);
    });

    console.log('[MonitorManager] Monitor Manager is running');
  } catch (err) {
    console.error('[MonitorManager] Fatal error:', err.message);
    process.exit(1);
  }
}

// 启动
main();
