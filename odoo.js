import xmlrpc from "xmlrpc";
import "dotenv/config";

// Cliente de Odoo vía XML-RPC.
const URL = (process.env.ODOO_URL || "").replace(/\/+$/, "");
const DB = process.env.ODOO_DB;
const USER = process.env.ODOO_USER;
const PASS = process.env.ODOO_PASSWORD;

// Almacenes (lot_stock_id) descubiertos en la investigación.
export const ALMACENES = {
  "Texco 1": 108658, // TEXCO/FERRAFORME
  "Texco 2": 353191, // TEX2/FERRAFORME/STAGE
  "Drop Off": 318021, // DROP/FERRAFORME
};

function client(path) {
  const secure = URL.startsWith("https");
  const base = { url: `${URL}/xmlrpc/2/${path}` };
  return secure ? xmlrpc.createSecureClient(base) : xmlrpc.createClient(base);
}

function call(cli, method, params) {
  return new Promise((resolve, reject) => {
    cli.methodCall(method, params, (err, value) =>
      err ? reject(err) : resolve(value)
    );
  });
}

let uidCache = null;
async function uid() {
  if (uidCache) return uidCache;
  const common = client("common");
  uidCache = await call(common, "authenticate", [DB, USER, PASS, {}]);
  if (!uidCache) throw new Error("Autenticación Odoo falló");
  return uidCache;
}

async function execute(model, method, args = [], kwargs = {}) {
  const id = await uid();
  const obj = client("object");
  return call(obj, "execute_kw", [DB, id, PASS, model, method, args, kwargs]);
}

// Odoo 17 falla con dominio vacío vía XML-RPC; usamos un dominio "todo".
const TODO = [["id", ">", 0]];

export async function totalProductos() {
  const [templates, productos] = await Promise.all([
    execute("product.template", "search_count", [TODO]),
    execute("product.product", "search_count", [TODO]),
  ]);
  return { templates, productos };
}

// Cuenta productos distintos con stock>0 en cada almacén.
export async function residenciaPorAlmacen() {
  const out = {};
  for (const [nombre, loc] of Object.entries(ALMACENES)) {
    const quants = await execute("stock.quant", "search_read", [
      [
        ["location_id", "child_of", loc],
        ["quantity", ">", 0],
      ],
    ], { fields: ["product_id"] });
    const prods = new Set(
      quants.map((q) => Array.isArray(q.product_id) && q.product_id[0]).filter(Boolean)
    );
    out[nombre] = prods.size;
  }
  return out;
}

// Dado un conjunto de SKUs (default_code), devuelve un mapa sku -> "Texco 1" | "Texco 2" | "Drop Off"
// según dónde tiene stock. Útil para cruzar con el catálogo de WooCommerce.
export async function residenciaDeSkus(skus) {
  if (!skus || !skus.length) return {};
  const mapa = {};
  // Buscamos los product.product que tengan esos default_code.
  for (let i = 0; i < skus.length; i += 500) {
    const lote = skus.slice(i, i + 500);
    const prods = await execute("product.product", "search_read", [
      [["default_code", "in", lote]],
    ], { fields: ["id", "default_code"] });
    const idToSku = {};
    for (const p of prods) idToSku[p.id] = p.default_code;
    const ids = prods.map((p) => p.id);
    if (!ids.length) continue;
    for (const [nombre, loc] of Object.entries(ALMACENES)) {
      const quants = await execute("stock.quant", "search_read", [
        [
          ["location_id", "child_of", loc],
          ["quantity", ">", 0],
          ["product_id", "in", ids],
        ],
      ], { fields: ["product_id"] });
      for (const q of quants) {
        const sku = idToSku[Array.isArray(q.product_id) && q.product_id[0]];
        if (sku && !mapa[sku]) mapa[sku] = nombre;
      }
    }
  }
  return mapa;
}
