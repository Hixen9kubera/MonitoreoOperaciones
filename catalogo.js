import { escanearCatalogo } from "./wc.js";
import { totalProductos, residenciaPorAlmacen } from "./odoo.js";

// Snapshot en memoria del catálogo (WooCommerce + Odoo).
// El escaneo completo de WC tarda ~45-78s (límite del servidor de la tienda),
// así que lo refrescamos en segundo plano y servimos el último resultado al instante.
const REFRESCO_MS = 10 * 60 * 1000; // 10 minutos

let snapshot = null; // { wc, odoo, ts }
let enProgreso = null; // promesa del escaneo en curso (single-flight)

async function construir() {
  const [wc, odooTot, odooRes] = await Promise.all([
    escanearCatalogo(),
    totalProductos().catch((e) => ({ error: e.message })),
    residenciaPorAlmacen().catch((e) => ({ error: e.message })),
  ]);
  return {
    wc,
    odoo: { totales: odooTot, residencia: odooRes },
    ts: new Date().toISOString(),
  };
}

// Devuelve el snapshot. Si no hay, lo construye (y espera). Si `force`, re-escanea.
export async function getCatalogo({ force = false } = {}) {
  if (enProgreso) return enProgreso; // ya hay un escaneo en curso → reúsalo
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

export function getSnapshotInfo() {
  return {
    listo: !!snapshot,
    ts: snapshot?.ts || null,
    escaneando: !!enProgreso,
  };
}

// Arranca el ciclo de refresco en segundo plano.
export function iniciarRefrescoAutomatico() {
  getCatalogo().catch((e) => console.error("Escaneo inicial falló:", e.message));
  setInterval(() => {
    getCatalogo({ force: true }).catch((e) =>
      console.error("Refresco de catálogo falló:", e.message)
    );
  }, REFRESCO_MS);
}
