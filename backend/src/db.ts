import { Pool } from 'pg';
import { DATABASE_CONFIG } from './consts';
import { timestampError, timestampLog } from './helpers';

export const pool = new Pool(DATABASE_CONFIG);

const { user, host, password, port } = DATABASE_CONFIG;

const adminPool = new Pool({
  user,
  host,
  password,
  port,
  database: 'postgres',
});

export const createDatabaseIfNotExists = async (dbName: string) => {
  const client = await adminPool.connect();
  try {
    const checkResult = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName]
    );

    if (checkResult.rowCount === 0) {
      await client.query(`CREATE DATABASE "${dbName}"`);
      timestampLog(`Database "${dbName}" created.`);
    }
  } catch (error) {
    timestampError(`Failed to create database "${dbName}":`, error);
    throw error;
  } finally {
    client.release();
  }
};

export const query = async (sql: string, params?: any[]) => {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(sql, params);
    return result;
  } finally {
    if (client) client.release();
  }
};

export const get = async (sql: string, params?: any[]) => {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(sql, params);
    return result.rows[0];
  } finally {
    if (client) client.release();
  }
};

export const all = async (sql: string, params?: any[]) => {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    if (client) client.release();
  }
};
