import "dotenv/config";

// Cliente mínimo de Supabase (PostgREST) para guardar y leer el histórico de
// aprobación. Se activa solo si están definidas las variables de entorno; si no,
// el resto de la app sigue funcionando igual (el histórico simplemente no corre).
const URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TABLA = process.env.SUPABASE_TABLA_APROBACION || "aprobacion_historial";

export function supabaseConfigurado() {
  return !!(URL && KEY);
}

async function sb(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Supabase HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

// Guarda (upsert por fecha) el snapshot diario de aprobación.
export async function guardarSnapshotAprobacion(fecha, m) {
  if (!supabaseConfigurado()) return false;
  await sb(`${TABLA}?on_conflict=fecha`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: [
      {
        fecha,
        aprobadas: m.aprobadas,
        pendientes: m.pendientes,
        asignados: m.asignados,
        total: m.total,
        pct_aprobadas: m.pct_aprobadas,
      },
    ],
  });
  return true;
}

// Lee el histórico (últimos N días) ordenado por fecha.
export async function leerHistorialAprobacion(dias = 90) {
  if (!supabaseConfigurado()) return null;
  return sb(`${TABLA}?select=fecha,aprobadas,pendientes,pct_aprobadas&order=fecha.asc&limit=${dias}`);
}
