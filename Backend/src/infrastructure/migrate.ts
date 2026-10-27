import { Pool } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
export async function migrate(pool: Pool) {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(7381041)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const directory = path.resolve(__dirname, '../../src/infrastructure/migrations');
    for (const name of (await readdir(directory)).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
      if ((await c.query('SELECT 1 FROM schema_migrations WHERE version=$1',[name])).rowCount) continue;
      await c.query('BEGIN');
      try { await c.query(await readFile(path.join(directory,name),'utf8')); await c.query('INSERT INTO schema_migrations(version) VALUES($1)',[name]); await c.query('COMMIT'); }
      catch(e) { await c.query('ROLLBACK'); throw e; }
    }
  } finally { await c.query('SELECT pg_advisory_unlock(7381041)'); c.release(); }
}
if (require.main === module) {
  const pool = new Pool({connectionString: process.env.DATABASE_URL});
  migrate(pool).then(() => console.info('Migrations applied.')).catch(() => {console.error('Migration failed. Check local database configuration.');process.exitCode=1;}).finally(() => pool.end());
}
