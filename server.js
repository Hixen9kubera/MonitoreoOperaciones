import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { q } from "./db.js";
import { clasificarError } from "./errorMap.js";
import { contarProductosPublicados } from "./wc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// Helper: filtro opcional por cuenta (BEKURA / SANCORFASHION).
function cuentaWhere(cuenta, alias = "") {
  const p = alias ? `${alias}.` : "";
  if (cuenta && cuenta !== "todas") {
    return { sql: ` AND ${p}cuenta = ? `, params: [cuenta] };
  }
  return { sql: "", params: [] };
}

// --------------------------------------------------------------------------
// Salud
// --------------------------------------------------------------------------
app.get("/api/health", async (_req, res) => {
  try {
    await q("SELECT 1");
    res.json({ ok: true, ts: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --------------------------------------------------------------------------
// Resumen general
// --------------------------------------------------------------------------
app.get("/api/summary", async (req, res) => {
  try {
    const f = cuentaWhere(req.query.cuenta);
    const [tot] = await q(
      `SELECT COUNT(*) total, SUM(success) ok, SUM(success=0) err,
              COUNT(DISTINCT CASE WHEN success=1 THEN sku END) skus_ok
       FROM ml_backlog WHERE 1=1 ${f.sql}`,
      f.params
    );
    const porCuenta = await q(
      `SELECT cuenta, COUNT(*) total, SUM(success) ok, SUM(success=0) err
       FROM ml_backlog WHERE 1=1 ${f.sql} GROUP BY cuenta ORDER BY total DESC`,
      f.params
    );
    // Semana actual (desde el lunes)
    const [sem] = await q(
      `SELECT COUNT(*) total, SUM(success) ok FROM ml_backlog
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY) ${f.sql}`,
      f.params
    );
    // Hoy
    const [hoy] = await q(
      `SELECT COUNT(*) total, SUM(success) ok FROM ml_backlog
       WHERE DATE(created_at) = CURDATE() ${f.sql}`,
      f.params
    );
    const total = Number(tot.total) || 0;
    const ok = Number(tot.ok) || 0;
    res.json({
      total,
      ok,
      err: Number(tot.err) || 0,
      skus_ok: Number(tot.skus_ok) || 0,
      tasa_exito: total ? Math.round((ok / total) * 1000) / 10 : 0,
      hoy: { total: Number(hoy.total) || 0, ok: Number(hoy.ok) || 0 },
      semana: { total: Number(sem.total) || 0, ok: Number(sem.ok) || 0 },
      por_cuenta: porCuenta.map((r) => ({
        cuenta: r.cuenta,
        total: Number(r.total),
        ok: Number(r.ok),
        err: Number(r.err),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --------------------------------------------------------------------------
// KPI 1: Publicaciones por día
// --------------------------------------------------------------------------
app.get("/api/daily", async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 120);
    const f = cuentaWhere(req.query.cuenta);
    // Bucketing por día en el calendario del servidor MySQL (formato string,
    // así evitamos cualquier desfase de zona horaria al convertir a Date en JS).
    const rows = await q(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') d, COUNT(*) total,
              SUM(success) ok, SUM(success=0) err
       FROM ml_backlog
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${f.sql}
       GROUP BY d ORDER BY d`,
      [days - 1, ...f.params]
    );
    const map = new Map(
      rows.map((r) => [
        r.d,
        { total: Number(r.total), ok: Number(r.ok), err: Number(r.err) },
      ])
    );
    // "Hoy" según el mismo servidor MySQL.
    const [now] = await q(`SELECT DATE_FORMAT(NOW(), '%Y-%m-%d') today`);
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const key = addDaysStr(now.today, -i);
      const v = map.get(key) || { total: 0, ok: 0, err: 0 };
      out.push({ fecha: key, ...v });
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Suma/resta días a una fecha 'YYYY-MM-DD' usando UTC (sin desfase de zona horaria).
function addDaysStr(yyyymmdd, delta) {
  const d = new Date(`${yyyymmdd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// --------------------------------------------------------------------------
// KPI 2: Errores agrupados por tipo, con productos afectados y cómo corregir
// --------------------------------------------------------------------------
app.get("/api/errors", async (req, res) => {
  try {
    const f = cuentaWhere(req.query.cuenta);
    const rows = await q(
      `SELECT sku, cuenta, ml_status, error, created_at
       FROM ml_backlog
       WHERE success=0 AND error IS NOT NULL AND error <> '' ${f.sql}
       ORDER BY created_at DESC`,
      f.params
    );
    // Agrupar por tipo de error. Dentro de cada tipo, un producto (sku+cuenta) solo
    // aparece una vez (el más reciente). "El error no se repite, pero sí por producto".
    const grupos = new Map();
    for (const r of rows) {
      const cls = clasificarError(r.error);
      if (!grupos.has(cls.tipo)) {
        grupos.set(cls.tipo, {
          tipo: cls.tipo,
          comoCorregir: cls.comoCorregir,
          severidad: cls.severidad,
          ejemplo: r.error,
          productos: new Map(),
        });
      }
      const g = grupos.get(cls.tipo);
      const key = `${r.sku}__${r.cuenta}`;
      if (!g.productos.has(key)) {
        g.productos.set(key, {
          sku: r.sku,
          cuenta: r.cuenta,
          ml_status: r.ml_status,
          created_at: r.created_at,
          error: r.error,
        });
      }
    }
    const out = [...grupos.values()]
      .map((g) => ({
        tipo: g.tipo,
        comoCorregir: g.comoCorregir,
        severidad: g.severidad,
        ejemplo: g.ejemplo,
        total_productos: g.productos.size,
        productos: [...g.productos.values()],
      }))
      .sort((a, b) => b.total_productos - a.total_productos);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --------------------------------------------------------------------------
// KPI 3: Tarjetas de productos (éxito / error)
// --------------------------------------------------------------------------
app.get("/api/products", async (req, res) => {
  try {
    const f = cuentaWhere(req.query.cuenta);
    const status = req.query.status || "all"; // ok | error | all
    const limit = Math.min(Math.max(Number(req.query.limit) || 120, 1), 500);
    const search = (req.query.q || "").trim();

    let statusSql = "";
    if (status === "ok") statusSql = " AND success=1 ";
    else if (status === "error") statusSql = " AND success=0 ";

    let searchSql = "";
    const searchParams = [];
    if (search) {
      searchSql = " AND sku LIKE ? ";
      searchParams.push(`%${search}%`);
    }

    // Una fila por SKU+cuenta: la publicación más reciente.
    const rows = await q(
      `SELECT b.sku, b.cuenta, b.ml_item_id, b.ml_url, b.success, b.error,
              b.ml_status, b.created_at
       FROM ml_backlog b
       INNER JOIN (
          SELECT sku, cuenta, MAX(created_at) mx
          FROM ml_backlog
          WHERE 1=1 ${f.sql}
          GROUP BY sku, cuenta
       ) last ON last.sku=b.sku AND last.cuenta=b.cuenta AND last.mx=b.created_at
       WHERE 1=1 ${statusSql} ${searchSql} ${f.sql}
       ORDER BY b.created_at DESC
       LIMIT ?`,
      [...f.params, ...searchParams, ...f.params, limit]
    );
    res.json(
      rows.map((r) => ({
        sku: r.sku,
        cuenta: r.cuenta,
        ml_item_id: r.ml_item_id,
        ml_url: r.ml_url,
        success: !!r.success,
        error: r.error,
        ml_status: r.ml_status,
        created_at: r.created_at,
        comoCorregir: r.success ? null : clasificarError(r.error).comoCorregir,
      }))
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --------------------------------------------------------------------------
// KPI 4: Comparación con WooCommerce (sincronización en tiempo real)
// --------------------------------------------------------------------------
app.get("/api/woocommerce", async (_req, res) => {
  try {
    // Catálogo en WC (status publish) según el espejo local `productos`.
    const [cat] = await q(
      `SELECT COUNT(*) c FROM productos WHERE status_wc='publish'`
    );
    // SKUs publicados con éxito en ML.
    const [mlOk] = await q(
      `SELECT COUNT(DISTINCT sku) c FROM ml_backlog WHERE success=1`
    );
    // Productos publish que aún NO tienen publicación exitosa en ML.
    const faltantes = await q(
      `SELECT p.sku, p.nombre, p.wc_id, p.status_wc
       FROM productos p
       WHERE p.status_wc='publish'
         AND NOT EXISTS (
            SELECT 1 FROM ml_backlog b WHERE b.sku=p.sku AND b.success=1
         )
       ORDER BY p.updated_at DESC
       LIMIT 200`
    );
    const [faltCount] = await q(
      `SELECT COUNT(*) c FROM productos p
       WHERE p.status_wc='publish'
         AND NOT EXISTS (SELECT 1 FROM ml_backlog b WHERE b.sku=p.sku AND b.success=1)`
    );

    // Conteo en vivo desde la API de WooCommerce (autoritativo).
    let wc_live = null;
    let wc_error = null;
    try {
      wc_live = await contarProductosPublicados("publish");
    } catch (e) {
      wc_error = e.message;
    }

    const wc_publish = Number(cat.c) || 0;
    const ml_sincronizados = Number(mlOk.c) || 0;
    const por_sincronizar = Number(faltCount.c) || 0;
    res.json({
      wc_publish,
      wc_live,
      wc_error,
      ml_sincronizados,
      por_sincronizar,
      pct_sincronizado: wc_publish
        ? Math.round(((wc_publish - por_sincronizar) / wc_publish) * 1000) / 10
        : 0,
      faltantes: faltantes.map((r) => ({
        sku: r.sku,
        nombre: r.nombre,
        wc_id: r.wc_id,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SPA fallback
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Monitoreo de operaciones escuchando en puerto ${PORT}`);
});
