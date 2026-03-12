import express from 'express';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Database connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || '172.17.0.1',
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'root',
  database: process.env.DB_NAME || 'deadlock_monitor',
  timezone: '+08:00',  // 数据库存的是北京时间
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0
});

// Serve static files
app.use(express.static(join(__dirname, 'public')));

// API: Get deadlocks grouped by timestamp
app.get('/api/deadlocks', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT * FROM deadlocks
      ORDER BY ts DESC, thread DESC
      LIMIT 100
    `);

    // Group deadlocks by timestamp (each deadlock has 2 threads)
    const grouped = [];
    const used = new Set();

    for (let i = 0; i < rows.length; i++) {
      const key = rows[i].ts.getTime();
      if (used.has(key)) continue;

      // Find matching thread (same timestamp, different thread)
      const match = rows.find((r, j) => j !== i && r.ts.getTime() === key);

      if (match) {
        const victim = rows[i].victim === 1 ? rows[i] : match;
        const other = rows[i].victim === 1 ? match : rows[i];

        // 格式化为北京时间 (UTC+8)
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

// API: Get latest deadlock timestamp for polling
app.get('/api/latest', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT MAX(ts) as latest_ts FROM deadlocks
    `);
    res.json({ timestamp: rows[0].latest_ts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Deadlock Monitor running at http://localhost:${port}`);
});
