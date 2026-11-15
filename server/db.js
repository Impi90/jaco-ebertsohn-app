'use strict';
// Database connection. In production this uses the `pg` driver with DATABASE_URL.
// For local testing without npm access, set PSQL_DB=<name> to run queries through the psql CLI.
// DB_SCHEMA (optional) keeps all of the app's tables in their own Postgres schema,
// so the app can share a database with another app without touching its tables.

const SCHEMA = process.env.DB_SCHEMA || '';
if (SCHEMA && !/^[a-z_][a-z0-9_]{0,40}$/.test(SCHEMA)) throw new Error('DB_SCHEMA must be lower-case letters, digits or _');
const SEARCH_PATH = SCHEMA ? `-c search_path=${SCHEMA}` : undefined;

function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') v = JSON.stringify(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function psqlAdapter(dbName) {
  const { execFile } = require('child_process');
  return {
    kind: 'psql',
    schema: SCHEMA,
    query(text, params = []) {
      const sql = text.replace(/\$(\d+)/g, (_, n) => literal(params[Number(n) - 1]));
      const rowsWanted = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql);
      const q = rowsWanted ? `WITH t AS (${sql}) SELECT coalesce(json_agg(t), '[]'::json) FROM t` : sql;
      return new Promise((resolve, reject) => {
        const env = SEARCH_PATH ? { ...process.env, PGOPTIONS: SEARCH_PATH } : process.env;
        execFile('psql', ['-d', dbName, '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', q], { maxBuffer: 64 * 1024 * 1024, env }, (err, stdout, stderr) => {
          if (err) {
            const e = new Error(String(stderr || err.message).trim());
            if (/duplicate key/.test(stderr)) e.code = '23505';
            return reject(e);
          }
          try { resolve({ rows: rowsWanted ? JSON.parse(stdout || '[]') : [] }); } catch (e) { reject(e); }
        });
      });
    },
    end: async () => {},
  };
}

function pgPool() {
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  // Render's internal URL (host without a dot) needs no TLS; external URLs do.
  let host = '';
  try { host = new URL(url).hostname; } catch (e) { /* leave empty */ }
  const ssl = host.includes('.') && !/^(localhost|127\.)/.test(host) ? { rejectUnauthorized: false } : false;
  const pool = new Pool({ connectionString: url, ssl, max: 5, idleTimeoutMillis: 30000, options: SEARCH_PATH });
  pool.on('error', e => console.error('db pool error', e.message));
  return { kind: 'pg', schema: SCHEMA, query: (t, p) => pool.query(t, p), end: () => pool.end() };
}

module.exports = process.env.PSQL_DB ? psqlAdapter(process.env.PSQL_DB) : pgPool();
