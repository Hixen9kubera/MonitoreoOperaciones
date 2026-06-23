import xmlrpc from "xmlrpc";
import "dotenv/config";

// Productos en status "ready" de WooCommerce, obtenidos por el XML-RPC de WordPress
// (xmlrpc.php → wp.getPosts), que sí filtra estados personalizados (la API REST de
// WC rechaza ?status=ready). Luego resolvemos el SKU de cada uno vía WC REST.
const WC_URL = (process.env.WC_URL || "").replace(/\/+$/, "");
const WP_USER = process.env.WP_USER;
const WP_PASS = (process.env.WP_APP_PASSWORD || "").replace(/\s+/g, "");
const WC_KEY = process.env.WC_CONSUMER_KEY || process.env.WC_KEY;
const WC_SECRET = process.env.WC_CONSUMER_SECRET || process.env.WC_SECRET;

function wpCall(method, params) {
  const client = xmlrpc.createSecureClient({ url: `${WC_URL}/xmlrpc.php` });
  return new Promise((resolve, reject) => {
    client.methodCall(method, params, (err, value) => (err ? reject(err) : resolve(value)));
  });
}

async function wcGet(qs) {
  const auth = "Basic " + Buffer.from(`${WC_KEY}:${WC_SECRET}`).toString("base64");
  const res = await fetch(`${WC_URL}/wp-json/wc/v3/${qs}`, {
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`WC GET ${res.status}`);
  return res.json();
}

// Devuelve { total, skus } de los productos en status "ready".
export async function productosReady() {
  const posts = await wpCall("wp.getPosts", [
    0,
    WP_USER,
    WP_PASS,
    { post_type: "product", post_status: "ready", number: 1000 },
    ["post_id"],
  ]);
  const ids = (posts || []).map((p) => p.post_id).filter(Boolean);
  const skus = [];
  for (let i = 0; i < ids.length; i += 100) {
    const inc = ids.slice(i, i + 100).join(",");
    const data = await wcGet(`products?include=${inc}&per_page=100&_fields=id,sku`);
    for (const d of data) if (d.sku) skus.push(d.sku);
  }
  return { total: ids.length, skus };
}
