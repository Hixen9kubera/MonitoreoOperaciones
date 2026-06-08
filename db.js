import mysql from "mysql2/promise";
import "dotenv/config";

// Pool de conexiones MySQL (Hostinger). Reutilizable en todas las rutas.
export const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 8,
  queueLimit: 0,
  enableKeepAlive: true,
  // Hostinger cierra conexiones ociosas; el keepAlive evita "server has gone away".
  keepAliveInitialDelay: 10000,
  timezone: "Z",
});

export async function q(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}
