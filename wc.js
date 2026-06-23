import "dotenv/config";

// Cliente de WooCommerce (REST API v3).
const WC_URL = (process.env.WC_URL || "").replace(/\/+$/, "");
const KEY = process.env.WC_CONSUMER_KEY || process.env.WC_KEY;
const SECRET = process.env.WC_CONSUMER_SECRET || process.env.WC_SECRET;

function authHeader() {
  return `Basic ${Buffer.from(`${KEY}:${SECRET}`).toString("base64")}`;
}

async function wcGet(qs) {
  if (!WC_URL || !KEY || !SECRET) throw new Error("Faltan credenciales de WooCommerce");
  const res = await fetch(`${WC_URL}/wp-json/wc/v3/${qs}`, {
    headers: { Authorization: authHeader() },
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) throw new Error(`WooCommerce HTTP ${res.status} (${qs})`);
  return {
    total: Number(res.headers.get("x-wp-total")) || 0,
    pages: Number(res.headers.get("x-wp-totalpages")) || 1,
    data: await res.json(),
  };
}

// Ejecuta varias promesas en lotes para no saturar la API.
async function enLotes(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const lote = items.slice(i, i + size);
    out.push(...(await Promise.all(lote.map(fn))));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Escaneo completo del catálogo (status=any). Devuelve TODAS las fichas
// (simples + padres variables) con su SKU, tipo, estado y variaciones.
// Los estados personalizados (ready/inprogress) solo se ven leyendo el campo
// `status` de cada producto, no por el filtro estándar de la API.
// ---------------------------------------------------------------------------
export async function escanearCatalogo() {
  const first = await wcGet("products?status=any&per_page=100&page=1&_fields=id,sku,type,status,variations,name");
  const totalPages = first.pages;
  const fichas = [...first.data];
  if (totalPages > 1) {
    const restPages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
    const rest = await enLotes(restPages, 6, async (pg) => {
      const r = await wcGet(`products?status=any&per_page=100&page=${pg}&_fields=id,sku,type,status,variations,name`);
      return r.data;
    });
    for (const arr of rest) fichas.push(...arr);
  }

  // Conteos
  let simples = 0,
    padres = 0,
    variaciones = 0;
  const porEstado = {};
  for (const f of fichas) {
    porEstado[f.status] = (porEstado[f.status] || 0) + 1;
    if (f.type === "variable") {
      padres++;
      variaciones += (f.variations || []).length;
    } else {
      simples++;
    }
  }

  return {
    fichas, // [{id, sku, type, status, variations:[ids], name}]
    total_fichas: fichas.length,
    simples,
    padres,
    variaciones,
    skus_vendibles: simples + variaciones, // simples + variaciones, SIN padres
    por_estado: porEstado,
  };
}

// Conteo rápido de publicados (cabecera X-WP-Total) — usado como dato "en vivo".
export async function contarProductosPublicados(status = "publish") {
  const r = await wcGet(`products?status=${encodeURIComponent(status)}&per_page=1`);
  return r.total;
}

// ---------------------------------------------------------------------------
// Aprobación en WooCommerce — plugin "WC KAM Revision Manager" (namespace wckamrm).
// Usa autenticación de WordPress (Application Password), distinta de las llaves WC.
// ---------------------------------------------------------------------------
const WP_USER = process.env.WP_USER;
const WP_PASS = (process.env.WP_APP_PASSWORD || "").replace(/\s+/g, "");

function wpAuthHeader() {
  return `Basic ${Buffer.from(`${WP_USER}:${WP_PASS}`).toString("base64")}`;
}

export async function aprobacionWoo() {
  if (!WP_USER || !WP_PASS) throw new Error("Faltan credenciales de WordPress (WP_USER / WP_APP_PASSWORD)");
  const res = await fetch(`${WC_URL}/wp-json/wckamrm/v1/stats`, {
    headers: { Authorization: wpAuthHeader() },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`KAM stats HTTP ${res.status}`);
  const d = await res.json();
  const aprobadas = Number(d.total_approved) || 0;
  const pendientes = Number(d.total_pending) || 0;
  const base = aprobadas + pendientes;
  return {
    aprobadas,
    pendientes,
    asignados: Number(d.total_assigned) || 0,
    cola: Number(d.queue_free) || 0,
    total: Number(d.total_products) || 0,
    pct_aprobadas: base ? Math.round((aprobadas / base) * 1000) / 10 : 0,
  };
}
