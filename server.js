import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { q } from "./db.js";
import {
  clasificarError,
  parseAmazonIssues,
  fixAmazonPorCategoria,
} from "./errorMap.js";
import {
  getCatalogo,
  getSnapshotInfo,
  iniciarRefrescoAutomatico,
} from "./catalogo.js";
import { aprobacionWoo } from "./wc.js";
import { productosReady } from "./publisher.js";
import {
  supabaseConfigurado,
  guardarSnapshotAprobacion,
  leerHistorialAprobacion,
} from "./supabase.js";
import { generarExcel, lunesActual } from "./export.js";
import {
  getInventario,
  getInventarioInfo,
  getDetalleOrden,
  iniciarRefrescoInventario,
} from "./almacen.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

const CUENTAS = ["BEKURA", "SANCORFASHION"];
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

// Prefijo "padre" de un SKU = sus dos primeros segmentos (TEC-0001-NEG-BLN → TEC-0001).
function prefijoPadre(sku) {
  return (sku || "").split("-").slice(0, 2).join("-");
}

// Estado de publicación en ML por SKU y por cuenta.
// Devuelve Map: sku -> { BEKURA:{publicada,error,ml_status,fecha}, SANCORFASHION:{...} }
// y un Set de prefijos-padre que ya tienen alguna variación publicada con éxito.
async function estadoMlPorSku() {
  // ¿Alguna vez publicada con éxito? (por sku+cuenta)
  const ok = await q(
    `SELECT sku, cuenta, MAX(success) ever_ok FROM ml_backlog GROUP BY sku, cuenta`
  );
  // Último intento por sku+cuenta (para el error vigente)
  const ult = await q(
    `SELECT b.sku, b.cuenta, b.success, b.error, b.ml_status, b.created_at
     FROM ml_backlog b
     INNER JOIN (SELECT sku, cuenta, MAX(created_at) mx FROM ml_backlog GROUP BY sku, cuenta) l
       ON l.sku=b.sku AND l.cuenta=b.cuenta AND l.mx=b.created_at`
  );
  const everOk = new Map();
  for (const r of ok) everOk.set(`${r.sku}__${r.cuenta}`, Number(r.ever_ok) === 1);

  const mapa = new Map();
  const prefijosPublicados = new Set();
  for (const r of ult) {
    if (!mapa.has(r.sku)) mapa.set(r.sku, {});
    const pub = everOk.get(`${r.sku}__${r.cuenta}`) || false;
    if (pub) prefijosPublicados.add(prefijoPadre(r.sku));
    mapa.get(r.sku)[r.cuenta] = {
      publicada: pub,
      error: !pub && r.success === 0 ? r.error : null,
      ml_status: r.ml_status,
      fecha: r.created_at,
    };
  }
  return { mapa, prefijosPublicados };
}

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
    // Semana actual (desde el lunes) — con SKUs únicos
    const [sem] = await q(
      `SELECT COUNT(*) total, SUM(success=1) ok,
              COUNT(DISTINCT CASE WHEN success=1 THEN sku END) skus
       FROM ml_backlog
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY) ${f.sql}`,
      f.params
    );
    // Hoy — publicaciones, SKUs únicos y desglose por cuenta
    const [hoy] = await q(
      `SELECT COUNT(*) total, SUM(success=1) ok,
              COUNT(DISTINCT CASE WHEN success=1 THEN sku END) skus,
              SUM(success=1 AND cuenta='BEKURA') bekura,
              SUM(success=1 AND cuenta='SANCORFASHION') sancor
       FROM ml_backlog WHERE DATE(created_at) = CURDATE() ${f.sql}`,
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
      hoy: {
        total: Number(hoy.total) || 0,
        ok: Number(hoy.ok) || 0,
        skus: Number(hoy.skus) || 0,
        bekura: Number(hoy.bekura) || 0,
        sancor: Number(hoy.sancor) || 0,
      },
      semana: {
        total: Number(sem.total) || 0,
        ok: Number(sem.ok) || 0,
        skus: Number(sem.skus) || 0,
      },
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
    const f = cuentaWhere(req.query.cuenta);
    const [now] = await q(`SELECT DATE_FORMAT(NOW(), '%Y-%m-%d') today`);

    // Rango: por días (days) o por rango explícito (desde/hasta).
    let desde, hasta;
    if (RE_FECHA.test(req.query.desde || "") || RE_FECHA.test(req.query.hasta || "")) {
      hasta = RE_FECHA.test(req.query.hasta || "") ? req.query.hasta : now.today;
      desde = RE_FECHA.test(req.query.desde || "") ? req.query.desde : addDaysStr(hasta, -13);
    } else {
      const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 366);
      hasta = now.today;
      desde = addDaysStr(hasta, -(days - 1));
    }
    // Si el rango viene invertido, lo corregimos.
    if (desde > hasta) [desde, hasta] = [hasta, desde];

    // Conteo por día dentro del rango (inclusive).
    const rows = await q(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') d, COUNT(*) total,
              SUM(success=1) ok, SUM(success=0) err,
              SUM(success=1 AND cuenta='BEKURA') bekura,
              SUM(success=1 AND cuenta='SANCORFASHION') sancor,
              COUNT(DISTINCT CASE WHEN success=1 THEN sku END) skus
       FROM ml_backlog
       WHERE created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY) ${f.sql}
       GROUP BY d ORDER BY d`,
      [desde, hasta, ...f.params]
    );
    const map = new Map(
      rows.map((r) => [
        r.d,
        {
          total: Number(r.total),
          ok: Number(r.ok),
          err: Number(r.err),
          bekura: Number(r.bekura),
          sancor: Number(r.sancor),
          skus: Number(r.skus),
        },
      ])
    );

    // Resumen ÚNICO del rango completo (un SKU no se cuenta dos veces aunque se
    // publique en varios días → distinto de la suma de SKUs únicos por día).
    const [res2] = await q(
      `SELECT COUNT(*) publicaciones,
              COUNT(DISTINCT CASE WHEN success=1 THEN sku END) skus_unicos,
              SUM(success=1 AND cuenta='BEKURA') bekura,
              SUM(success=1 AND cuenta='SANCORFASHION') sancor,
              SUM(success=0) err
       FROM ml_backlog
       WHERE success IS NOT NULL AND created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY) ${f.sql}`,
      [desde, hasta, ...f.params]
    );

    // Relleno de días del rango.
    const dias = [];
    let cur = desde;
    let guard = 0;
    while (cur <= hasta && guard++ < 400) {
      dias.push({ fecha: cur, ...(map.get(cur) || { total: 0, ok: 0, err: 0, bekura: 0, sancor: 0, skus: 0 }) });
      cur = addDaysStr(cur, 1);
    }
    res.json({
      desde,
      hasta,
      dias,
      resumen: {
        skus_unicos: Number(res2.skus_unicos) || 0,
        publicaciones: Number(res2.bekura || 0) + Number(res2.sancor || 0),
        bekura: Number(res2.bekura) || 0,
        sancor: Number(res2.sancor) || 0,
        err: Number(res2.err) || 0,
      },
    });
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
app.get("/api/errors", async (_req, res) => {
  try {
    const { mapa } = await estadoMlPorSku();
    // Consolidamos por SKU (un solo registro para las 2 cuentas). Un SKU entra a la
    // lista si tiene error en al menos una cuenta donde aún no está publicado.
    const grupos = new Map();
    for (const [sku, cuentas] of mapa.entries()) {
      const errorEn = [];
      const publicadaEn = [];
      let errorTexto = null;
      for (const c of CUENTAS) {
        const est = cuentas[c];
        if (!est) continue;
        if (est.publicada) publicadaEn.push(c);
        else if (est.error) {
          errorEn.push(c);
          errorTexto = est.error;
        }
      }
      if (!errorEn.length) continue; // ya publicada en ambas o sin error
      const cls = clasificarError(errorTexto);
      if (!grupos.has(cls.tipo)) {
        grupos.set(cls.tipo, {
          tipo: cls.tipo,
          comoCorregir: cls.comoCorregir,
          severidad: cls.severidad,
          ejemplo: errorTexto,
          productos: [],
        });
      }
      grupos.get(cls.tipo).productos.push({
        sku,
        falta_en: errorEn, // cuentas donde falta por el error
        publicada_en: publicadaEn, // cuentas donde ya está publicada
      });
    }
    const out = [...grupos.values()]
      .map((g) => ({
        tipo: g.tipo,
        comoCorregir: g.comoCorregir,
        severidad: g.severidad,
        ejemplo: g.ejemplo,
        total_productos: g.productos.length,
        productos: g.productos.sort((a, b) => a.sku.localeCompare(b.sku)),
      }))
      .sort((a, b) => b.total_productos - a.total_productos);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --------------------------------------------------------------------------
// Capacidad del Publisher ML.
// Capacidad máxima = 336 (48 h × 7 publicaciones/h). "En espera" = productos en
// status "ready" de WC MENOS los que tienen error de ML (se omiten y se guardan
// sus SKUs). El publisher corre cada hora en punto (MX); la barra se refresca a :20.
// --------------------------------------------------------------------------
const PUBLISHER_CAPACIDAD = 336;
app.get("/api/publisher/capacidad", async (_req, res) => {
  try {
    const ready = await productosReady(); // { total, skus }
    const { mapa } = await estadoMlPorSku();
    const skusError = [];
    let completos = 0; // publicados en AMBAS cuentas → ya no esperan
    let en_espera = 0; // incluye no intentados y parciales (solo 1 cuenta)
    for (const sku of ready.skus) {
      const c = mapa.get(sku);
      const bek = !!c?.BEKURA?.publicada;
      const san = !!c?.SANCORFASHION?.publicada;
      const algunError = !!(c && (c.BEKURA?.error || c.SANCORFASHION?.error));
      if (bek && san) completos++; // en ambas cuentas → completo
      else if (!bek && !san && algunError) skusError.push(sku); // bloqueado por error
      else en_espera++; // nunca intentado o parcial (solo 1 cuenta) → sigue en espera
    }
    const con_error = skusError.length;
    res.json({
      capacidad: PUBLISHER_CAPACIDAD,
      ready_total: ready.total,
      con_error,
      completos, // publicados en ambas cuentas
      en_espera,
      pct: Math.round((en_espera / PUBLISHER_CAPACIDAD) * 1000) / 10,
      skus_error: skusError,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --------------------------------------------------------------------------
// Aprobación en WooCommerce (plugin WC KAM Revision Manager) + histórico.
// --------------------------------------------------------------------------
app.get("/api/aprobacion", async (_req, res) => {
  try {
    const m = await aprobacionWoo();
    res.json({ ...m, historico: supabaseConfigurado() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/aprobacion/historial", async (_req, res) => {
  try {
    if (!supabaseConfigurado())
      return res.json({ configurado: false, items: [] });
    const items = (await leerHistorialAprobacion(120)) || [];
    res.json({ configurado: true, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Snapshot diario de aprobación → Supabase (upsert por fecha). No-op si no está configurado.
async function snapshotAprobacion() {
  if (!supabaseConfigurado()) return;
  try {
    const m = await aprobacionWoo();
    const [{ hoy }] = await q(`SELECT DATE_FORMAT(NOW(),'%Y-%m-%d') hoy`);
    await guardarSnapshotAprobacion(hoy, m);
    console.log(`Snapshot aprobación guardado (${hoy}): ${m.aprobadas} aprobadas / ${m.pendientes} pendientes`);
  } catch (e) {
    console.error("Snapshot aprobación falló:", e.message);
  }
}

// --------------------------------------------------------------------------
// KPI 3: Tarjetas de productos (éxito / error)
// --------------------------------------------------------------------------
app.get("/api/products", async (req, res) => {
  try {
    const f = cuentaWhere(req.query.cuenta);
    const status = req.query.status || "all"; // ok | error | all
    const PER = 24;
    const page = Math.max(Number(req.query.page) || 1, 1);
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

    // Filtro opcional por rango de fechas (refleja el filtro de días del dashboard).
    let rangoInner = "",
      rangoOuter = "";
    const rangoP = [];
    if (RE_FECHA.test(req.query.desde || "") && RE_FECHA.test(req.query.hasta || "")) {
      rangoInner = " AND created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY) ";
      rangoOuter = " AND b.created_at >= ? AND b.created_at < DATE_ADD(?, INTERVAL 1 DAY) ";
      rangoP.push(req.query.desde, req.query.hasta);
    }

    // Subconsulta: una fila por SKU+cuenta (la publicación más reciente dentro del rango).
    const base = `
       FROM ml_backlog b
       INNER JOIN (
          SELECT sku, cuenta, MAX(created_at) mx
          FROM ml_backlog
          WHERE 1=1 ${f.sql} ${rangoInner}
          GROUP BY sku, cuenta
       ) last ON last.sku=b.sku AND last.cuenta=b.cuenta AND last.mx=b.created_at
       WHERE 1=1 ${statusSql} ${searchSql} ${f.sql} ${rangoOuter}`;
    const baseParams = [...f.params, ...rangoP, ...searchParams, ...f.params, ...rangoP];

    const [{ total }] = await q(`SELECT COUNT(*) total ${base}`, baseParams);
    const rows = await q(
      `SELECT b.sku, b.cuenta, b.ml_item_id, b.ml_url, b.success, b.error,
              b.ml_status, b.created_at ${base}
       ORDER BY b.created_at DESC
       LIMIT ? OFFSET ?`,
      [...baseParams, PER, (page - 1) * PER]
    );
    res.json({
      page,
      per_page: PER,
      total: Number(total),
      pages: Math.max(Math.ceil(Number(total) / PER), 1),
      items: rows.map((r) => ({
        sku: r.sku,
        cuenta: r.cuenta,
        ml_item_id: r.ml_item_id,
        ml_url: r.ml_url,
        success: !!r.success,
        error: r.error,
        ml_status: r.ml_status,
        created_at: r.created_at,
        comoCorregir: r.success ? null : clasificarError(r.error).comoCorregir,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --------------------------------------------------------------------------
// KPI 4: Comparación con WooCommerce (sincronización en tiempo real)
// --------------------------------------------------------------------------
app.get("/api/catalogo", async (req, res) => {
  try {
    const force = req.query.force === "1";
    const cat = await getCatalogo({ force });
    const { mapa, prefijosPublicados } = await estadoMlPorSku();

    // Una ficha cuenta como "sincronizada" si tiene publicación exitosa en ML
    // (simple: por su SKU; padre: por cualquiera de sus variaciones, vía prefijo).
    const fichaPublicada = (f) => {
      if (f.type === "variable") return prefijosPublicados.has(f.sku);
      const est = mapa.get(f.sku);
      return !!(est && (est.BEKURA?.publicada || est.SANCORFASHION?.publicada));
    };

    const faltantes = [];
    let sincronizadas = 0;
    for (const f of cat.wc.fichas) {
      if (fichaPublicada(f)) sincronizadas++;
      else
        faltantes.push({
          sku: f.sku,
          nombre: f.name,
          tipo: f.type,
          estado: f.status,
        });
    }
    const meta = cat.wc.total_fichas; // 3,834 (decisión: medir por ficha/producto)
    const por_sincronizar = meta - sincronizadas;

    res.json({
      ts: cat.ts,
      meta, // total fichas (simples + padres)
      sincronizadas,
      por_sincronizar,
      pct_sincronizado: meta ? Math.round((sincronizadas / meta) * 1000) / 10 : 0,
      wc: {
        total_fichas: cat.wc.total_fichas,
        simples: cat.wc.simples,
        padres: cat.wc.padres,
        variaciones: cat.wc.variaciones,
        skus_vendibles: cat.wc.skus_vendibles,
        por_estado: cat.wc.por_estado,
      },
      odoo: cat.odoo,
      faltantes: faltantes.slice(0, 300),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Estado del snapshot (para mostrar "actualizado hace…").
app.get("/api/catalogo/estado", (_req, res) => res.json(getSnapshotInfo()));

// --------------------------------------------------------------------------
// SKUs en estado "ready" de WooCommerce que ADEMÁS tienen error de ML (no publican).
// --------------------------------------------------------------------------
app.get("/api/ready", async (_req, res) => {
  try {
    const cat = await getCatalogo();
    const { mapa } = await estadoMlPorSku();

    // Indexamos errores por SKU y por prefijo-padre.
    const errPorSku = new Map();
    const errPorPrefijo = new Map();
    for (const [sku, cuentas] of mapa.entries()) {
      const errorEn = [],
        publicadaEn = [];
      let errorTexto = null;
      for (const c of CUENTAS) {
        const e = cuentas[c];
        if (!e) continue;
        if (e.publicada) publicadaEn.push(c);
        else if (e.error) {
          errorEn.push(c);
          errorTexto = e.error;
        }
      }
      if (!errorEn.length) continue;
      const info = { sku, falta_en: errorEn, publicada_en: publicadaEn, error: errorTexto };
      errPorSku.set(sku, info);
      const pf = prefijoPadre(sku);
      if (!errPorPrefijo.has(pf)) errPorPrefijo.set(pf, []);
      errPorPrefijo.get(pf).push(info);
    }

    const items = [];
    for (const f of cat.wc.fichas) {
      if (f.status !== "ready") continue;
      let detalle = null;
      if (f.type === "variable") {
        const lista = errPorPrefijo.get(f.sku);
        if (lista && lista.length) detalle = lista;
      } else {
        const info = errPorSku.get(f.sku);
        if (info) detalle = [info];
      }
      if (!detalle) continue; // ready pero sin error de ML → no entra (cruce "ambos")
      const cls = clasificarError(detalle[0].error);
      items.push({
        sku: f.sku,
        nombre: f.name,
        tipo: f.type,
        tipo_error: cls.tipo,
        comoCorregir: cls.comoCorregir,
        severidad: cls.severidad,
        detalle,
      });
    }
    res.json({
      ts: cat.ts,
      total_ready: cat.wc.por_estado?.ready || 0,
      total_con_error: items.length,
      items,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================================================
// PUBLICADOR AMAZON
// ==========================================================================

// Resumen Amazon (estado actual por SKU en amazon_progress + intentos en backlog)
app.get("/api/amazon/summary", async (_req, res) => {
  try {
    const [prog] = await q(
      `SELECT COUNT(*) total,
              SUM(success) ok,
              SUM(success=0) err,
              SUM(status='PUBLISHED') publicados
       FROM amazon_progress`
    );
    const [intentos] = await q(
      `SELECT COUNT(*) total, SUM(success) ok FROM amazon_backlog`
    );
    const porEstado = await q(
      `SELECT status, COUNT(*) c FROM amazon_progress GROUP BY status ORDER BY c DESC`
    );
    const total = Number(prog.total) || 0;
    const ok = Number(prog.ok) || 0;
    res.json({
      total,
      ok,
      err: Number(prog.err) || 0,
      publicados: Number(prog.publicados) || 0,
      tasa_exito: total ? Math.round((ok / total) * 1000) / 10 : 0,
      intentos: Number(intentos.total) || 0,
      intentos_ok: Number(intentos.ok) || 0,
      por_estado: porEstado.map((r) => ({ estado: r.status, c: Number(r.c) })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Publicaciones por día Amazon (ancladas al último envío, pues no hay actividad reciente)
app.get("/api/amazon/daily", async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 120);
    const rows = await q(
      `SELECT DATE_FORMAT(submitted_at, '%Y-%m-%d') d, COUNT(*) total,
              SUM(success) ok, SUM(success=0) err
       FROM amazon_backlog GROUP BY d ORDER BY d`
    );
    const map = new Map(
      rows.map((r) => [
        r.d,
        { total: Number(r.total), ok: Number(r.ok), err: Number(r.err) },
      ])
    );
    const [mx] = await q(
      `SELECT DATE_FORMAT(MAX(submitted_at), '%Y-%m-%d') d FROM amazon_backlog`
    );
    const anchor = mx.d || (await q(`SELECT DATE_FORMAT(NOW(),'%Y-%m-%d') d`))[0].d;
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const key = addDaysStr(anchor, -i);
      out.push({ fecha: key, ...(map.get(key) || { total: 0, ok: 0, err: 0 }) });
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Errores Amazon: parsea issues (severidad ERROR), agrupa por mensaje.
// Solo SKUs que aún no están publicados con éxito.
app.get("/api/amazon/errors", async (_req, res) => {
  try {
    const rows = await q(
      `SELECT b.sku, b.issues, b.submitted_at
       FROM amazon_backlog b
       INNER JOIN (
          SELECT sku, MAX(submitted_at) mx FROM amazon_backlog
          WHERE success=0 GROUP BY sku
       ) last ON last.sku=b.sku AND last.mx=b.submitted_at
       WHERE b.success=0 AND b.issues IS NOT NULL AND b.issues <> ''
         AND NOT EXISTS (SELECT 1 FROM amazon_progress p WHERE p.sku=b.sku AND p.success=1)
         AND NOT EXISTS (SELECT 1 FROM amazon_backlog s WHERE s.sku=b.sku AND s.success=1)`
    );
    const grupos = new Map();
    for (const r of rows) {
      const issues = parseAmazonIssues(r.issues);
      // Un SKU puede tener varios issues ERROR; cada tipo se cuenta una vez por SKU.
      const vistos = new Set();
      for (const is of issues) {
        const key = is.message || `code ${is.code}`;
        if (vistos.has(key)) continue;
        vistos.add(key);
        if (!grupos.has(key)) {
          grupos.set(key, {
            tipo: key,
            comoCorregir: fixAmazonPorCategoria(is.categorias, is.message),
            severidad: "validacion",
            code: is.code,
            atributos: is.atributos,
            productos: new Map(),
          });
        }
        grupos.get(key).productos.set(r.sku, { sku: r.sku, created_at: r.submitted_at });
      }
    }
    const out = [...grupos.values()]
      .map((g) => ({
        tipo: g.tipo,
        comoCorregir: g.comoCorregir,
        severidad: g.severidad,
        code: g.code,
        total_productos: g.productos.size,
        productos: [...g.productos.values()],
      }))
      .sort((a, b) => b.total_productos - a.total_productos);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Tarjetas de productos Amazon (estado actual), paginadas 24.
app.get("/api/amazon/products", async (req, res) => {
  try {
    const status = req.query.status || "all"; // ok | error | all
    const PER = 24;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const search = (req.query.q || "").trim();

    let where = "WHERE 1=1";
    const params = [];
    if (status === "ok") where += " AND success=1 ";
    else if (status === "error") where += " AND success=0 ";
    if (search) {
      where += " AND sku LIKE ? ";
      params.push(`%${search}%`);
    }
    const [{ total }] = await q(
      `SELECT COUNT(*) total FROM amazon_progress ${where}`,
      params
    );
    const rows = await q(
      `SELECT sku, asin, status, success, error_label, issue_count, published_at, updated_at
       FROM amazon_progress ${where}
       ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [...params, PER, (page - 1) * PER]
    );
    res.json({
      page,
      per_page: PER,
      total: Number(total),
      pages: Math.max(Math.ceil(Number(total) / PER), 1),
      items: rows.map((r) => ({
        sku: r.sku,
        asin: r.asin,
        status: r.status,
        success: !!r.success,
        error_label: r.error_label,
        issue_count: r.issue_count,
        created_at: r.updated_at,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================================================
// KUBERA PIPELINE
// ==========================================================================

// Resumen de etapas del pipeline + distribución de estado en WooCommerce.
app.get("/api/pipeline/summary", async (_req, res) => {
  try {
    const scraping = await q(
      `SELECT scrape_estado e, COUNT(*) c FROM scraping_alibaba GROUP BY scrape_estado`
    );
    const atributos = await q(
      `SELECT estado e, COUNT(*) c FROM atributos_ia GROUP BY estado`
    );
    const costos = await q(
      `SELECT ml_estado e, COUNT(*) c FROM costos_ml GROUP BY ml_estado`
    );
    // Estados de WC y residencia/totales de Odoo desde el snapshot en vivo.
    const cat = await getCatalogo();
    const statusWc = Object.entries(cat.wc.por_estado).map(([estado, c]) => ({
      estado,
      c: Number(c),
    }));

    const armarEtapa = (nombre, rows, okValores) => {
      let ok = 0,
        pendiente = 0,
        error = 0,
        total = 0;
      const detalle = {};
      for (const r of rows) {
        const c = Number(r.c);
        total += c;
        detalle[r.e || "—"] = c;
        if (okValores.includes(r.e)) ok += c;
        else if (/pend/i.test(r.e || "")) pendiente += c;
        else error += c;
      }
      return { nombre, total, ok, pendiente, error, detalle };
    };

    res.json({
      etapas: [
        armarEtapa("Scraping Alibaba", scraping, ["ok"]),
        armarEtapa("Atributos IA", atributos, ["ok"]),
        armarEtapa("Costos ML", costos, ["ok"]),
      ],
      status_wc: statusWc.sort((a, b) => b.c - a.c),
      catalogo: {
        ts: cat.ts,
        total_fichas: cat.wc.total_fichas,
        simples: cat.wc.simples,
        padres: cat.wc.padres,
        variaciones: cat.wc.variaciones,
        skus_vendibles: cat.wc.skus_vendibles,
      },
      odoo: cat.odoo,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Productos del pipeline (no publicados) con el detalle de QUÉ les falta. Paginado 24.
app.get("/api/pipeline/productos", async (req, res) => {
  try {
    const PER = 24;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const search = (req.query.q || "").trim();
    const etapa = req.query.etapa || "all"; // scraping | atributos | costos | fotos | precio | all

    let extra = "";
    const params = [];
    if (search) {
      extra += " AND p.sku LIKE ? ";
      params.push(`%${search}%`);
    }

    const base = `
      FROM productos p
      LEFT JOIN scraping_alibaba s ON s.sku=p.sku
      LEFT JOIN atributos_ia a ON a.sku=p.sku
      LEFT JOIN costos_ml c ON c.sku=p.sku
      WHERE p.status_wc <> 'publish' ${extra}`;

    const [{ total }] = await q(`SELECT COUNT(*) total ${base}`, params);
    const rows = await q(
      `SELECT p.sku, p.nombre, p.status_wc, p.tiene_precio, p.num_fotos,
              s.scrape_estado, a.estado attr_estado, c.ml_estado costo_estado ${base}
       ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`,
      [...params, PER, (page - 1) * PER]
    );

    const items = rows.map((r) => {
      const falta = [];
      if (r.scrape_estado !== "ok") falta.push("Scraping");
      if (r.attr_estado !== "ok") falta.push("Atributos IA");
      if (r.costo_estado !== "ok") falta.push("Costos ML");
      if (!r.num_fotos) falta.push("Fotos");
      if (!r.tiene_precio) falta.push("Precio");
      return {
        sku: r.sku,
        nombre: r.nombre,
        status_wc: r.status_wc,
        falta,
        completo: falta.length === 0,
      };
    });
    res.json({
      page,
      per_page: PER,
      total: Number(total),
      pages: Math.max(Math.ceil(Number(total) / PER), 1),
      items,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --------------------------------------------------------------------------
// Exportar a Excel: SKUs publicados (por cuenta) + resumen por día.
// /api/export?desde=YYYY-MM-DD&hasta=YYYY-MM-DD  (desde por defecto = lunes)
// --------------------------------------------------------------------------
app.get("/api/export", async (req, res) => {
  try {
    const desde = RE_FECHA.test(req.query.desde || "")
      ? req.query.desde
      : await lunesActual();
    const [{ hoy }] = await q(`SELECT DATE_FORMAT(NOW(),'%Y-%m-%d') hoy`);
    const hasta = RE_FECHA.test(req.query.hasta || "") ? req.query.hasta : hoy;

    const { wb } = await generarExcel({ desde, hasta });
    const nombre = `publicaciones_${desde}_a_${hasta}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${nombre}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================================================
// ALMACÉN (Odoo: inventario + órdenes de compra)
// ==========================================================================

// Resumen: KPIs, clasificaciones y vistas por Texco (residencia de stock y almacén de OC).
app.get("/api/almacen/resumen", async (req, res) => {
  try {
    const snap = await getInventario({ force: req.query.force === "1" });
    const r = snap.resumen;
    const pct = (x) => (r.total ? Math.round((x / r.total) * 1000) / 10 : 0);

    // Vista por residencia de stock: clasificación de SKUs CON stock en cada Texco.
    const porResidencia = { "Texco 1": { con_oc: 0, sin_oc: 0 }, "Texco 2": { con_oc: 0, sin_oc: 0 } };
    // Vista por almacén de OC: SKUs ligados a OC, según el Texco de sus órdenes.
    for (const p of snap.lista) {
      for (const t of ["Texco 1", "Texco 2"]) {
        const key = t === "Texco 1" ? "t1" : "t2";
        if (p[key] > 0) (p.en_oc ? porResidencia[t].con_oc++ : porResidencia[t].sin_oc++);
      }
    }

    // Almacén de OC: cuántos SKUs distintos hay por Texco de las órdenes.
    const porAlmacenOC = {};
    for (const o of snap.ordenes) {
      porAlmacenOC[o.texco] = (porAlmacenOC[o.texco] || 0) + 1;
    }

    res.json({
      ts: snap.ts,
      total: r.total,
      ligados_oc: r.ligados_oc,
      pct_ligados: pct(r.ligados_oc),
      cero_stock: r.cero_stock,
      pct_cero_stock: pct(r.cero_stock),
      clasificaciones: {
        sin_inventario: r.sin_inventario,
        fantasma: r.fantasmas,
        con_stock_sin_oc: r.con_stock_sin_oc,
        normal: r.normal,
      },
      residencia_stock: porResidencia,
      texco_stock: { "Texco 1": r.texco1_stock, "Texco 2": r.texco2_stock },
      ordenes_por_texco: porAlmacenOC,
      total_ordenes: snap.ordenes.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Estado del snapshot de inventario.
app.get("/api/almacen/estado", (_req, res) => res.json(getInventarioInfo()));

// Contenedores de Texco 2: pastel recibido vs faltante + faltan por recibir por contenedor.
app.get("/api/almacen/texco2", async (_req, res) => {
  try {
    const snap = await getInventario();
    res.json({ ts: snap.ts, ...snap.texco2 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Listado de SKUs filtrable por clasificación / texco / búsqueda, paginado 24.
app.get("/api/almacen/skus", async (req, res) => {
  try {
    const snap = await getInventario();
    const PER = 24;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const clas = req.query.clas || "all"; // sin_inventario|fantasma|con_stock_sin_oc|normal|all
    const texco = req.query.texco || "all"; // t1|t2|all
    const search = (req.query.q || "").trim().toLowerCase();

    let items = snap.lista;
    if (clas !== "all") items = items.filter((p) => p.clas === clas);
    if (texco === "t1") items = items.filter((p) => p.t1 > 0);
    else if (texco === "t2") items = items.filter((p) => p.t2 > 0);
    if (search) items = items.filter((p) => p.sku.toLowerCase().includes(search));

    const total = items.length;
    const slice = items.slice((page - 1) * PER, page * PER);
    res.json({
      page,
      per_page: PER,
      total,
      pages: Math.max(Math.ceil(total / PER), 1),
      items: slice,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Listado de órdenes de compra (filtrable por texco / búsqueda).
app.get("/api/almacen/ordenes", async (req, res) => {
  try {
    const snap = await getInventario();
    const texco = req.query.texco || "all";
    const search = (req.query.q || "").trim().toLowerCase();
    let items = snap.ordenes;
    if (texco !== "all") items = items.filter((o) => o.texco === (texco === "t1" ? "Texco 1" : "Texco 2"));
    if (search)
      items = items.filter(
        (o) =>
          o.name.toLowerCase().includes(search) ||
          (o.contenedor || "").toLowerCase().includes(search)
      );
    res.json({ total: items.length, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Detalle de una orden de compra.
app.get("/api/almacen/orden/:id", async (req, res) => {
  try {
    const det = await getDetalleOrden(req.params.id);
    if (!det) return res.status(404).json({ error: "Orden no encontrada" });
    res.json(det);
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
  // Primer escaneo del catálogo (WC + Odoo) y refresco cada 10 min en segundo plano.
  iniciarRefrescoAutomatico();
  // Inventario de almacén (Odoo) en segundo plano, refresco cada 15 min.
  iniciarRefrescoInventario();
  // Snapshot diario de aprobación (solo si Supabase está configurado).
  snapshotAprobacion();
  setInterval(snapshotAprobacion, 6 * 60 * 60 * 1000); // cada 6 h (upsert por día)
});
