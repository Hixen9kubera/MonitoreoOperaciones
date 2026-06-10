import ExcelJS from "exceljs";
import { q } from "./db.js";

const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
function fmtFecha(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  return `${DIAS[d.getUTCDay()]} ${ymd}`;
}

// Lunes de la semana actual (formato YYYY-MM-DD) según el servidor MySQL.
export async function lunesActual() {
  const [r] = await q(
    `SELECT DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY), '%Y-%m-%d') d`
  );
  return r.d;
}

// Genera el workbook de publicaciones en el rango [desde, hasta] (inclusive por día).
export async function generarExcel({ desde, hasta }) {
  // Rango: desde 00:00 del día `desde` hasta 00:00 del día siguiente a `hasta`.
  const rango = [desde, hasta];

  // Publicaciones exitosas en el rango, por cuenta.
  const pubs = await q(
    `SELECT sku, cuenta, ml_item_id, ml_url, created_at
     FROM ml_backlog
     WHERE success=1
       AND created_at >= ?
       AND created_at < DATE_ADD(?, INTERVAL 1 DAY)
     ORDER BY cuenta, created_at`,
    rango
  );

  // Resumen por día.
  const resumen = await q(
    `SELECT DATE_FORMAT(created_at,'%Y-%m-%d') d,
            SUM(success=1) pub,
            SUM(success=1 AND cuenta='BEKURA') bekura,
            SUM(success=1 AND cuenta='SANCORFASHION') sancor,
            COUNT(DISTINCT CASE WHEN success=1 THEN sku END) skus,
            SUM(success=0) err
     FROM ml_backlog
     WHERE created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)
     GROUP BY d ORDER BY d`,
    rango
  );

  const wb = new ExcelJS.Workbook();
  wb.creator = "Monitoreo de Operaciones";
  wb.created = new Date();

  // ---- Hoja 1: Resumen por día ----
  const hr = wb.addWorksheet("Resumen por día");
  hr.columns = [
    { header: "Fecha", key: "fecha", width: 16 },
    { header: "SKUs únicos", key: "skus", width: 14 },
    { header: "BEKURA", key: "bekura", width: 12 },
    { header: "SANCORFASHION", key: "sancor", width: 16 },
    { header: "Publicaciones (total)", key: "pub", width: 20 },
    { header: "Con error", key: "err", width: 12 },
  ];
  let tSkus = 0,
    tBek = 0,
    tSan = 0,
    tPub = 0,
    tErr = 0;
  for (const r of resumen) {
    hr.addRow({
      fecha: fmtFecha(r.d),
      skus: Number(r.skus),
      bekura: Number(r.bekura),
      sancor: Number(r.sancor),
      pub: Number(r.pub),
      err: Number(r.err),
    });
    tSkus += Number(r.skus);
    tBek += Number(r.bekura);
    tSan += Number(r.sancor);
    tPub += Number(r.pub);
    tErr += Number(r.err);
  }
  const totalRow = hr.addRow({
    fecha: "TOTAL",
    skus: tSkus,
    bekura: tBek,
    sancor: tSan,
    pub: tPub,
    err: tErr,
  });
  estilizarEncabezado(hr.getRow(1));
  totalRow.font = { bold: true };

  // ---- Hojas por cuenta: SKUs publicados + URL ----
  for (const cuenta of ["BEKURA", "SANCORFASHION"]) {
    const ws = wb.addWorksheet(cuenta);
    ws.columns = [
      { header: "SKU", key: "sku", width: 28 },
      { header: "ML Item ID", key: "id", width: 16 },
      { header: "URL", key: "url", width: 55 },
      { header: "Fecha publicación", key: "fecha", width: 20 },
    ];
    const filas = pubs.filter((p) => p.cuenta === cuenta);
    for (const p of filas) {
      const row = ws.addRow({
        sku: p.sku,
        id: p.ml_item_id || "",
        url: p.ml_url || "",
        fecha: p.created_at
          ? new Date(p.created_at).toISOString().slice(0, 16).replace("T", " ")
          : "",
      });
      if (p.ml_url) {
        const cell = row.getCell("url");
        cell.value = { text: p.ml_url, hyperlink: p.ml_url };
        cell.font = { color: { argb: "FF1F6FEB" }, underline: true };
      }
    }
    estilizarEncabezado(ws.getRow(1));
  }

  return { wb, totalSkus: tSkus, totalPub: tPub };
}

function estilizarEncabezado(row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF161B22" },
  };
}
