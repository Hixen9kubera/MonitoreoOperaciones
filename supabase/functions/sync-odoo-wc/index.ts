// ============================================================================
// Edge Function: sync-odoo-wc
// Sincroniza el inventario Odoo → WooCommerce.
//  - Lee qty_available de Odoo (JSON-RPC).
//  - Compara con el último valor empujado (tabla inv_sync_cache en Supabase).
//  - Solo actualiza en WooCommerce los SKUs cuyo stock CAMBIÓ.
//  - DRY_RUN=true (por defecto): NO escribe en WC, solo registra qué cambiaría.
// Procesa por lotes (BATCH_LIMIT) para respetar el límite de tiempo del Edge;
// el cron la dispara repetidamente hasta drenar el backlog.
// ============================================================================

const env = (k: string, def = "") => Deno.env.get(k) ?? def;

const ODOO_URL = env("ODOO_URL").replace(/\/+$/, "");
const ODOO_DB = env("ODOO_DB");
const ODOO_USER = env("ODOO_USER");
const ODOO_PASSWORD = env("ODOO_PASSWORD");

const WC_URL = env("WC_URL").replace(/\/+$/, "");
const WC_KEY = env("WC_KEY") || env("WC_CONSUMER_KEY");
const WC_SECRET = env("WC_SECRET") || env("WC_CONSUMER_SECRET");
const WC_AUTH = "Basic " + btoa(`${WC_KEY}:${WC_SECRET}`);

const SB_URL = env("SUPABASE_URL").replace(/\/+$/, "");
const SB_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

const DRY_RUN = env("DRY_RUN", "true").toLowerCase() !== "false"; // seguro por defecto
const BATCH_LIMIT = Number(env("BATCH_LIMIT", "200"));

// ---- Odoo JSON-RPC ----
async function odoo(service: string, method: string, args: unknown[]) {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }),
  });
  const j = await res.json();
  if (j.error) throw new Error("Odoo: " + JSON.stringify(j.error).slice(0, 200));
  return j.result;
}

// ---- Supabase REST ----
async function sb(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

// ---- WooCommerce ----
async function wcGet(qs: string) {
  const r = await fetch(`${WC_URL}/wp-json/wc/v3/${qs}`, { headers: { Authorization: WC_AUTH } });
  if (!r.ok) throw new Error(`WC GET ${r.status}`);
  return r.json();
}
async function wcPut(path: string, body: unknown) {
  const r = await fetch(`${WC_URL}/wp-json/wc/v3/${path}`, {
    method: "PUT",
    headers: { Authorization: WC_AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`WC PUT ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return r.json();
}

function uuid() {
  return crypto.randomUUID();
}

Deno.serve(async () => {
  const runId = uuid();
  try {
    // 1) Login Odoo + leer todos los SKUs con su stock disponible.
    const uid = await odoo("common", "login", [ODOO_DB, ODOO_USER, ODOO_PASSWORD]);
    const productos: { default_code: string; qty_available: number }[] = await odoo(
      "object",
      "execute_kw",
      [ODOO_DB, uid, ODOO_PASSWORD, "product.product", "search_read",
        [[["default_code", "!=", false]]], { fields: ["default_code", "qty_available"] }],
    );
    const odooQty = new Map<string, number>();
    for (const p of productos) odooQty.set(p.default_code, Math.round(p.qty_available || 0));

    // 2) Caché actual (qty_pushed por SKU).
    const cacheRows: any[] = (await sb(`inv_sync_cache?select=sku,wc_id,wc_type,parent_id,qty_pushed,no_en_wc&limit=100000`)) || [];
    const cache = new Map(cacheRows.map((r) => [r.sku, r]));

    // 3) Detectar pendientes: el stock de Odoo difiere del último empujado.
    const pendientes: string[] = [];
    for (const [sku, qty] of odooQty) {
      const c = cache.get(sku);
      if (!c || Number(c.qty_pushed) !== qty) pendientes.push(sku);
    }

    const lote = pendientes.slice(0, BATCH_LIMIT);
    const logs: any[] = [];
    let procesados = 0;

    for (const sku of lote) {
      const qty = odooQty.get(sku)!;
      let c = cache.get(sku);
      try {
        // Resolver mapeo WC si no lo tenemos (o si antes no existía).
        if (!c || !c.wc_id) {
          const found = await wcGet(`products?sku=${encodeURIComponent(sku)}&_fields=id,type,parent_id`);
          if (!Array.isArray(found) || !found.length) {
            await sb(`inv_sync_cache?on_conflict=sku`, {
              method: "POST",
              headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
              body: JSON.stringify([{ sku, qty_odoo: qty, no_en_wc: true, updated_at: new Date().toISOString() }]),
            });
            logs.push({ run_id: runId, sku, qty_nuevo: qty, accion: "skip_no_wc", dry_run: DRY_RUN, ok: true });
            continue;
          }
          const w = found[0];
          c = { sku, wc_id: w.id, wc_type: w.type, parent_id: w.parent_id || 0 };
        }

        if (DRY_RUN) {
          // No escribe en WC ni mueve qty_pushed: deja constancia de lo que cambiaría.
          logs.push({ run_id: runId, sku, wc_id: c.wc_id, qty_anterior: c.qty_pushed ?? null, qty_nuevo: qty, accion: "update", dry_run: true, ok: true });
          // Guardamos el mapeo y el qty_odoo, pero NO qty_pushed.
          await sb(`inv_sync_cache?on_conflict=sku`, {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify([{ sku, wc_id: c.wc_id, wc_type: c.wc_type, parent_id: c.parent_id, qty_odoo: qty, no_en_wc: false, updated_at: new Date().toISOString() }]),
          });
        } else {
          // Escribe el stock en WooCommerce (simple o variación).
          const payload = { manage_stock: true, stock_quantity: qty };
          if (c.wc_type === "variation")
            await wcPut(`products/${c.parent_id}/variations/${c.wc_id}`, payload);
          else await wcPut(`products/${c.wc_id}`, payload);

          await sb(`inv_sync_cache?on_conflict=sku`, {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify([{ sku, wc_id: c.wc_id, wc_type: c.wc_type, parent_id: c.parent_id, qty_odoo: qty, qty_pushed: qty, no_en_wc: false, updated_at: new Date().toISOString(), pushed_at: new Date().toISOString() }]),
          });
          logs.push({ run_id: runId, sku, wc_id: c.wc_id, qty_anterior: c.qty_pushed ?? null, qty_nuevo: qty, accion: "update", dry_run: false, ok: true });
        }
        procesados++;
      } catch (e) {
        logs.push({ run_id: runId, sku, qty_nuevo: qty, accion: "update", dry_run: DRY_RUN, ok: false, error: String(e).slice(0, 200) });
      }
    }

    // 4) Guardar bitácora.
    if (logs.length) {
      await sb(`sync_log`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(logs) });
    }

    return Response.json({
      run_id: runId,
      dry_run: DRY_RUN,
      total_skus: odooQty.size,
      pendientes: pendientes.length,
      procesados_este_run: procesados,
      restantes: Math.max(pendientes.length - lote.length, 0),
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
