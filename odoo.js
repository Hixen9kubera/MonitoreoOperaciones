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

// Contenedores que pertenecen a Texco 2 (definido por el negocio, por número).
export const CONTENEDORES_TEXCO2 = [71, 72, 73, 74, 75, 76, 77, 78, 80, 82, 83, 84, 85, 86, 94];

// Extrae el número de contenedor del texto de packing_list.
export function numeroContenedor(pl) {
  if (!pl) return null;
  const m = pl.match(/cont(?:enedor)?\.?\s*#?\s*(\d+)/i);
  if (m) return Number(m[1]);
  const nums = pl.match(/\d+/g);
  return nums ? Number(nums[nums.length - 1]) : null;
}

// Clasifica una ubicación interna (por su complete_name) en un almacén.
function almacenDeUbicacion(completeName) {
  if (!completeName) return "Otro";
  if (completeName.startsWith("TEXCO/")) return "Texco 1";
  if (completeName.startsWith("TEX2/")) return "Texco 2";
  if (completeName.startsWith("DROP/")) return "Drop Off";
  return "Otro";
}

// Resuelve el Texco de cada tipo de recepción usando su UBICACIÓN DESTINO real
// (default_location_dest_id), no el nombre del almacén. Decisión del negocio:
// las OC dicen "TEXCO II" pero su destino es "TEXCO/Entrada" (Texco 1), que es
// donde físicamente aterrizan los productos.
async function mapaPickingType2Texco(pickingTypeIds) {
  const ids = [...new Set(pickingTypeIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const pts = await execute("stock.picking.type", "search_read", [[["id", "in", ids]]], {
    fields: ["id", "default_location_dest_id"],
  });
  const destIds = [...new Set(pts.map((p) => p.default_location_dest_id?.[0]).filter(Boolean))];
  const locs = destIds.length
    ? await execute("stock.location", "search_read", [[["id", "in", destIds]]], {
        fields: ["id", "complete_name"],
      })
    : [];
  const locName = new Map(locs.map((l) => [l.id, l.complete_name]));
  return new Map(
    pts.map((p) => [p.id, almacenDeUbicacion(locName.get(p.default_location_dest_id?.[0]))])
  );
}

// Carga TODO el inventario de almacén: productos con SKU, su stock por almacén,
// si están ligados a una OC (cualquier estado) y la clasificación.
// Devuelve también el listado de órdenes de compra y un mapa pid->stock.
export async function cargarInventario() {
  const [productos, locs, quants, lineasOC, ordenesRaw] = await Promise.all([
    execute("product.product", "search_read", [[["default_code", "!=", false]]], {
      fields: ["id", "default_code", "name"],
    }),
    execute("stock.location", "search_read", [[["usage", "=", "internal"]]], {
      fields: ["id", "complete_name"],
    }),
    execute(
      "stock.quant",
      "search_read",
      [[["location_id.usage", "=", "internal"], ["quantity", ">", 0]]],
      { fields: ["product_id", "location_id", "quantity"] }
    ),
    // read_group por producto sobre TODAS las líneas de OC (incluye borradores).
    execute("purchase.order.line", "read_group", [[["id", ">", 0]]], {
      fields: ["product_id"],
      groupby: ["product_id"],
      limit: 30000,
    }),
    // Órdenes de compra (excluye canceladas) para el listado.
    execute("purchase.order", "search_read", [[["state", "!=", "cancel"]]], {
      fields: ["id", "name", "packing_list", "picking_type_id", "state", "order_line", "date_order"],
    }),
  ]);

  const loc2wh = new Map(locs.map((l) => [l.id, almacenDeUbicacion(l.complete_name)]));

  // Stock por producto (pid) y por almacén.
  const stockPorPid = new Map();
  for (const qd of quants) {
    const pid = qd.product_id?.[0];
    if (!pid) continue;
    const wh = loc2wh.get(qd.location_id?.[0]) || "Otro";
    const s = stockPorPid.get(pid) || { total: 0, "Texco 1": 0, "Texco 2": 0, "Drop Off": 0, Otro: 0 };
    s.total += qd.quantity;
    s[wh] = (s[wh] || 0) + qd.quantity;
    stockPorPid.set(pid, s);
  }

  const enOC = new Set(lineasOC.map((x) => x.product_id?.[0]).filter(Boolean));

  // Clasificación por SKU.
  const resumen = {
    total: productos.length,
    ligados_oc: 0,
    cero_stock: 0,
    sin_inventario: 0,
    fantasmas: 0,
    con_stock_sin_oc: 0,
    normal: 0,
    texco1_stock: 0,
    texco2_stock: 0,
  };
  const lista = [];
  for (const p of productos) {
    const st = stockPorPid.get(p.id) || { total: 0, "Texco 1": 0, "Texco 2": 0 };
    const has = st.total > 0;
    const inpo = enOC.has(p.id);
    let clas;
    if (!has && inpo) {
      clas = "sin_inventario";
      resumen.sin_inventario++;
    } else if (!has && !inpo) {
      clas = "fantasma";
      resumen.fantasmas++;
    } else if (has && !inpo) {
      clas = "con_stock_sin_oc";
      resumen.con_stock_sin_oc++;
    } else {
      clas = "normal";
      resumen.normal++;
    }
    if (inpo) resumen.ligados_oc++;
    if (!has) resumen.cero_stock++;
    if (st["Texco 1"] > 0) resumen.texco1_stock++;
    if (st["Texco 2"] > 0) resumen.texco2_stock++;
    lista.push({
      sku: p.default_code,
      nombre: p.name,
      stock: Math.round(st.total),
      t1: Math.round(st["Texco 1"] || 0),
      t2: Math.round(st["Texco 2"] || 0),
      en_oc: inpo,
      clas,
    });
  }

  // Texco de cada OC por su ubicación destino real.
  const pt2tex = await mapaPickingType2Texco(ordenesRaw.map((o) => o.picking_type_id?.[0]));
  const ordenes = ordenesRaw
    .map((o) => ({
      id: o.id,
      name: o.name,
      contenedor: o.packing_list || null,
      texco: pt2tex.get(o.picking_type_id?.[0]) || "Otro",
      estado: o.state,
      num_skus: (o.order_line || []).length,
      fecha: o.date_order,
    }))
    .sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));

  // --- Contenedores de Texco 2: recepción por contenedor (faltan por recibir) ---
  const t2set = new Set(CONTENEDORES_TEXCO2);
  const ordenesT2 = ordenesRaw
    .map((o) => ({ ...o, cont: numeroContenedor(o.packing_list) }))
    .filter((o) => o.cont != null && t2set.has(o.cont));

  const texco2 = await recepcionContenedores(ordenesT2);

  return { resumen, lista, stockPorPid, ordenes, pt2tex, texco2 };
}

// Para una lista de OC (con campo .cont), agrega la recepción por SKU:
// un SKU está "recibido" si la suma recibida >= suma ordenada. "faltan" = no recibidos.
async function recepcionContenedores(ordenesT2) {
  const poIds = ordenesT2.map((o) => o.id);
  let lineas = [];
  if (poIds.length) {
    lineas = await execute(
      "purchase.order.line",
      "search_read",
      [[["order_id", "in", poIds]]],
      { fields: ["order_id", "product_id", "product_qty", "qty_received"] }
    );
  }
  // Agregamos por OC -> producto.
  const porPo = new Map();
  for (const l of lineas) {
    const poId = l.order_id?.[0];
    if (!porPo.has(poId)) porPo.set(poId, new Map());
    const prods = porPo.get(poId);
    const pid = l.product_id?.[0];
    const cur = prods.get(pid) || { ordenada: 0, recibida: 0 };
    cur.ordenada += l.product_qty || 0;
    cur.recibida += l.qty_received || 0;
    prods.set(pid, cur);
  }

  let totalRecibidos = 0,
    totalFaltan = 0;
  const contenedores = [];
  for (const o of ordenesT2) {
    const prods = porPo.get(o.id) || new Map();
    let recibidos = 0,
      faltan = 0,
      conRecepcion = false;
    for (const v of prods.values()) {
      const ok = v.recibida >= v.ordenada && v.ordenada > 0;
      if (v.recibida > 0) conRecepcion = true;
      if (ok) recibidos++;
      else faltan++;
    }
    const item = {
      cont: o.cont,
      contenedor: o.packing_list,
      orden: o.name,
      estado: o.state,
      total_skus: prods.size,
      recibidos,
      faltan,
      con_recepcion: conRecepcion,
    };
    contenedores.push(item);
    // Para el pastel global solo cuentan los contenedores CON recepción (aunque parcial).
    if (conRecepcion) {
      totalRecibidos += recibidos;
      totalFaltan += faltan;
    }
  }
  contenedores.sort((a, b) => a.cont - b.cont);
  return {
    contenedores,
    con_recepcion: contenedores.filter((c) => c.con_recepcion).length,
    pie: { recibidos: totalRecibidos, faltan: totalFaltan },
  };
}

// Detalle de una orden de compra: SKUs con cantidad ordenada, recibida y stock actual.
export async function detalleOrden(poId, stockPorPid, pt2tex) {
  const [po] = await execute(
    "purchase.order",
    "search_read",
    [[["id", "=", Number(poId)]]],
    {
      fields: ["name", "packing_list", "picking_type_id", "state", "date_order", "amount_total"],
    }
  );
  if (!po) return null;
  const texco =
    (pt2tex && pt2tex.get(po.picking_type_id?.[0])) ||
    (await mapaPickingType2Texco([po.picking_type_id?.[0]])).get(po.picking_type_id?.[0]) ||
    "Otro";
  const lineas = await execute(
    "purchase.order.line",
    "search_read",
    [[["order_id", "=", Number(poId)]]],
    { fields: ["product_id", "product_qty", "qty_received"] }
  );
  const items = lineas
    .map((l) => {
      const pid = l.product_id?.[0];
      const disp = l.product_id?.[1] || "";
      // El display es "[SKU] Nombre".
      const m = disp.match(/^\[([^\]]+)\]\s*(.*)$/);
      const st = (stockPorPid && stockPorPid.get(pid)) || { total: 0, "Texco 1": 0, "Texco 2": 0 };
      return {
        sku: m ? m[1] : disp,
        nombre: m ? m[2] : "",
        ordenada: l.product_qty,
        recibida: l.qty_received,
        stock: Math.round(st.total),
        t1: Math.round(st["Texco 1"] || 0),
        t2: Math.round(st["Texco 2"] || 0),
      };
    })
    .sort((a, b) => a.sku.localeCompare(b.sku));
  return {
    id: Number(poId),
    name: po.name,
    contenedor: po.packing_list || null,
    texco,
    estado: po.state,
    fecha: po.date_order,
    amount_total: po.amount_total,
    total_skus: items.length,
    items,
  };
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
