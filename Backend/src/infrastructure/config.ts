export function config() {
  const retention = Number(process.env.RETENTION_DAYS ?? 30);
  const port = Number(process.env.PORT ?? 3000);
  if (!process.env.DATABASE_URL || !process.env.ADMIN_TOKEN || process.env.ADMIN_TOKEN.length < 32 || !Number.isInteger(retention) || retention < 1 || retention > 30 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Set DATABASE_URL, ADMIN_TOKEN (at least 32 characters), PORT and RETENTION_DAYS (1..30).');
  }
  return { databaseUrl: process.env.DATABASE_URL, adminToken: process.env.ADMIN_TOKEN, retention, port, host: process.env.HOST ?? '127.0.0.1' };
}
