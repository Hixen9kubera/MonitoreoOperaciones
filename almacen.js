import { cargarInventario, detalleOrden } from "./odoo.js";

// Snapshot en memoria del inventario de almacén (Odoo). Pesado (~7s), así que se
// refresca en segundo plano y se sirve al instante.
const REFRESCO_MS = 15 * 60 * 1000; // 15 minutos

let snapshot = null; // { resumen, lista, stockPorPid, ordenes, ts }
let enProgreso = null;

async function construir() {
  const data = await cargarInventario();
  return { ...data, ts: new Date().toISOString() };
}

export async function getInventario({ force = false } = {}) {
  if (enProgreso) return enProgreso;
  if (snapshot && !force) return snapshot;
  enProgreso = construir()
    .then((s) => {
      snapshot = s;
      return s;
    })
    .finally(() => {
      enProgreso = null;
    });
  return enProgreso;
}

export function getInventarioInfo() {
  return { listo: !!snapshot, ts: snapshot?.ts || null, escaneando: !!enProgreso };
}

// Detalle de una OC (usa el stock cacheado del snapshot).
export async function getDetalleOrden(poId) {
  const snap = await getInventario();
  return detalleOrden(poId, snap.stockPorPid, snap.pt2tex);
}

export function iniciarRefrescoInventario() {
  getInventario().catch((e) => console.error("Inventario inicial falló:", e.message));
  setInterval(() => {
    getInventario({ force: true }).catch((e) =>
      console.error("Refresco de inventario falló:", e.message)
    );
  }, REFRESCO_MS);
}
