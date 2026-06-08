import "dotenv/config";

// Cliente ligero de WooCommerce (REST API v3).
// Se usa para obtener, en tiempo real, cuantos productos publicados existen en la tienda.

const WC_URL = (process.env.WC_URL || "").replace(/\/+$/, "");
const KEY = process.env.WC_CONSUMER_KEY || process.env.WC_KEY;
const SECRET = process.env.WC_CONSUMER_SECRET || process.env.WC_SECRET;

function authHeader() {
  const token = Buffer.from(`${KEY}:${SECRET}`).toString("base64");
  return `Basic ${token}`;
}

// Devuelve el total de productos publicados leyendo la cabecera X-WP-Total,
// sin necesidad de paginar todo el catalogo.
export async function contarProductosPublicados(status = "publish") {
  if (!WC_URL || !KEY || !SECRET) {
    throw new Error("Faltan credenciales de WooCommerce en el .env");
  }
  const url = `${WC_URL}/wp-json/wc/v3/products?status=${encodeURIComponent(
    status
  )}&per_page=1`;
  const res = await fetch(url, {
    headers: { Authorization: authHeader() },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`WooCommerce respondió HTTP ${res.status}`);
  }
  const total = Number(res.headers.get("x-wp-total"));
  return Number.isFinite(total) ? total : null;
}
