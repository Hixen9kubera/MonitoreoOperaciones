// ---------------------------------------------------------------------------
// Estado + helpers
// ---------------------------------------------------------------------------
const state = {
  view: "ml",
  cuenta: "todas",
  ml: { days: 14, status: "all", search: "", page: 1 },
  amz: { days: 14, status: "all", search: "", page: 1 },
  pipe: { search: "", page: 1 },
  alm: { clas: "all", texco: "all", search: "", page: 1, ocSearch: "" },
};
const charts = {};

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const api = async (path) => {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};
const n = (x) => (Number(x) || 0).toLocaleString("es-MX");

// Fechas: la API entrega 'YYYY-MM-DD'. Parseamos y formateamos SIEMPRE en UTC
// para que no haya desfase con la zona horaria del navegador.
const parseYMD = (ymd) => new Date(`${ymd}T00:00:00Z`);
const fechaCorta = (ymd) =>
  parseYMD(ymd).toLocaleDateString("es-MX", { day: "2-digit", month: "short", timeZone: "UTC" });
const diaSemana = (ymd) =>
  parseYMD(ymd).toLocaleDateString("es-MX", { weekday: "short", timeZone: "UTC" });
const fechaHora = (iso) => new Date(iso).toLocaleDateString("es-MX", { day: "2-digit", month: "short" });

function barChart(canvasId, data, datasets) {
  if (charts[canvasId]) charts[canvasId].destroy();
  charts[canvasId] = new Chart($(`#${canvasId}`), {
    type: "bar",
    data: { labels: data.labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#e6edf3" } }, tooltip: { mode: "index", intersect: false } },
      scales: {
        x: { stacked: true, ticks: { color: "#8b949e", maxRotation: 60, minRotation: 45 }, grid: { color: "#21262d" } },
        y: { stacked: true, beginAtZero: true, ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
      },
    },
  });
}

// Chip de un SKU dentro de un grupo de error. Muestra cuentas (ML) o fecha (Amazon).
function skuChip(p) {
  if (p.falta_en) {
    const falta = p.falta_en.map((c) => `<span class="acc-bad">✗ ${c}</span>`).join("");
    const pub = (p.publicada_en || []).map((c) => `<span class="acc-ok">✓ ${c}</span>`).join("");
    return `<span class="err-sku">${p.sku} ${falta}${pub}</span>`;
  }
  return `<span class="err-sku">${p.sku}${p.cuenta ? ` <span class="acc">· ${p.cuenta}</span>` : ""}</span>`;
}

// Render genérico de errores agrupados (sirve para ML y Amazon).
function renderErrores(containerId, grupos) {
  const c = $(`#${containerId}`);
  if (!grupos.length) {
    c.innerHTML = `<div class="loading">Sin errores pendientes 🎉</div>`;
    return;
  }
  c.innerHTML = grupos
    .map(
      (g, i) => `
    <div class="err-group">
      <div class="err-head" data-eg="${containerId}-${i}">
        <div class="sev ${g.severidad}"></div>
        <div class="tipo">${g.tipo}</div>
        <div class="count">${n(g.total_productos)} producto(s)</div>
      </div>
      <div class="err-body" id="${containerId}-${i}">
        <div class="fix"><b>Cómo corregirlo:</b> ${g.comoCorregir}</div>
        <div class="err-skus">
          ${g.productos.map((p) => skuChip(p)).join("")}
        </div>
      </div>
    </div>`
    )
    .join("");
  $$(".err-head", c).forEach((h) =>
    h.addEventListener("click", () => $(`#${h.dataset.eg}`).classList.toggle("open"))
  );
}

// Paginador reutilizable.
function renderPager(containerId, data, onGo) {
  const el = $(`#${containerId}`);
  if (!data || data.pages <= 1) {
    el.innerHTML = data ? `<span class="pinfo">${n(data.total)} productos</span>` : "";
    return;
  }
  const p = data.page;
  el.innerHTML = `
    <button class="pbtn" ${p <= 1 ? "disabled" : ""} data-go="${p - 1}">‹ Anterior</button>
    <span class="pinfo">Página ${p} de ${data.pages} · ${n(data.total)} productos</span>
    <button class="pbtn" ${p >= data.pages ? "disabled" : ""} data-go="${p + 1}">Siguiente ›</button>`;
  $$(".pbtn", el).forEach((b) =>
    b.addEventListener("click", () => !b.disabled && onGo(Number(b.dataset.go)))
  );
}

// Tarjeta de producto genérica.
function prodCard({ cls, sku, badge, badgeCls, meta, link, fix }) {
  return `<div class="prod ${cls}">
    <div class="row1"><span class="sku">${sku}</span><span class="st ${badgeCls}">${badge}</span></div>
    <div class="meta">${meta}</div>
    ${link || ""}
    ${fix || ""}
  </div>`;
}

// ===========================================================================
// VISTA ML
// ===========================================================================
async function mlResumen() {
  const s = await api(`/api/summary?cuenta=${state.cuenta}`);
  const todas = state.cuenta === "todas";
  const splitHoy = todas ? `BEKURA ${n(s.hoy.bekura)} · SANCOR ${n(s.hoy.sancor)}` : `${n(s.hoy.ok)} publicaciones`;
  $("#ml-kpis").innerHTML = `
    <div class="kpi"><div class="label">SKUs publicados hoy</div><div class="value ok">${n(s.hoy.skus)}</div><div class="foot">${n(s.hoy.ok)} publicaciones · ${splitHoy}</div></div>
    <div class="kpi"><div class="label">SKUs esta semana</div><div class="value accent">${n(s.semana.skus)}</div><div class="foot">${n(s.semana.ok)} publicaciones desde el lunes</div></div>
    <div class="kpi"><div class="label">Total SKUs publicados</div><div class="value ok">${n(s.skus_ok)}</div><div class="foot">${n(s.ok)} publicaciones en total</div></div>
    <div class="kpi"><div class="label">Con error</div><div class="value err">${n(s.err)}</div><div class="foot">de ${n(s.total)} intentos</div></div>
    <div class="kpi"><div class="label">Tasa de éxito</div><div class="value ${s.tasa_exito >= 85 ? "ok" : "err"}">${s.tasa_exito}%</div><div class="foot">${todas ? "ambas cuentas" : state.cuenta}</div></div>`;
}
async function mlDaily() {
  const data = await api(`/api/daily?days=${state.ml.days}&cuenta=${state.cuenta}`);
  const labels = data.map((d) => `${diaSemana(d.fecha)} ${fechaCorta(d.fecha)}`);
  const todas = state.cuenta === "todas";
  // En "todas" mostramos el desglose por cuenta (apilado) + línea de SKUs únicos.
  // En una cuenta específica, solo sus publicaciones.
  const barras = todas
    ? [
        { label: "BEKURA", data: data.map((d) => d.bekura), backgroundColor: "#2ea043", borderRadius: 4, stack: "s" },
        { label: "SANCORFASHION", data: data.map((d) => d.sancor), backgroundColor: "#1f6feb", borderRadius: 4, stack: "s" },
        { label: "Con error", data: data.map((d) => d.err), backgroundColor: "#f85149", borderRadius: 4, stack: "s" },
      ]
    : [
        { label: "Publicadas (éxito)", data: data.map((d) => d.ok), backgroundColor: "#2ea043", borderRadius: 4, stack: "s" },
        { label: "Con error", data: data.map((d) => d.err), backgroundColor: "#f85149", borderRadius: 4, stack: "s" },
      ];
  const canvasId = "mlDailyChart";
  if (charts[canvasId]) charts[canvasId].destroy();
  charts[canvasId] = new Chart($(`#${canvasId}`), {
    type: "bar",
    data: { labels, datasets: barras },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#e6edf3" } },
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: {
            // Muestra los SKUs únicos del día (cada SKU se publica en las 2 cuentas).
            footer: (items) => {
              const d = data[items[0].dataIndex];
              return `SKUs únicos: ${n(d.skus)}  ·  ${n(d.ok)} publicaciones`;
            },
          },
        },
      },
      scales: {
        x: { stacked: true, ticks: { color: "#8b949e", maxRotation: 60, minRotation: 45 }, grid: { color: "#21262d" } },
        y: { stacked: true, beginAtZero: true, ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
      },
    },
  });
}
function haceCuanto(iso) {
  if (!iso) return "";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "hace " + s + "s";
  if (s < 3600) return "hace " + Math.round(s / 60) + " min";
  return "hace " + Math.round(s / 3600) + " h";
}
async function mlCatalogo() {
  $("#wcPanel").innerHTML = `<div class="loading">Cargando catálogo…</div>`;
  try {
    const w = await api(`/api/catalogo`);
    $("#wcLiveBadge").textContent = `Catálogo actualizado ${haceCuanto(w.ts)}`;
    $("#wcPanel").innerHTML = `
      <div class="wc-stat"><div class="n">${n(w.meta)}</div><div class="t">Meta: fichas en WC (simples + padres)</div></div>
      <div class="wc-stat"><div class="n" style="color:var(--ok)">${n(w.sincronizadas)}</div><div class="t">Sincronizadas en ML</div></div>
      <div class="wc-stat"><div class="n" style="color:var(--err)">${n(w.por_sincronizar)}</div><div class="t">Faltan por sincronizar</div></div>
      <div class="wc-stat"><div class="n" style="color:var(--accent)">${w.pct_sincronizado}%</div><div class="t">Avance hacia la meta</div><div class="bar"><span style="width:${Math.min(w.pct_sincronizado,100)}%"></span></div></div>`;
    $("#wcFaltCount").textContent = n(w.por_sincronizar);
    $("#wcFaltantes").innerHTML = w.faltantes.length
      ? w.faltantes.map((f) => `<div class="falt-item"><span class="sku">${f.sku}</span><span class="nm">${f.nombre || "—"} <span class="acc">· ${f.estado}/${f.tipo}</span></span></div>`).join("")
      : `<div class="loading">Todo sincronizado 🎉</div>`;
  } catch (e) {
    $("#wcPanel").innerHTML = `<div class="loading">Error: ${e.message}</div>`;
  }
}
async function mlErrores() {
  $("#ml-errors").innerHTML = `<div class="loading">Cargando errores…</div>`;
  renderErrores("ml-errors", await api(`/api/errors`));
}
async function mlReady() {
  $("#ml-ready").innerHTML = `<div class="loading">Cargando…</div>`;
  try {
    const r = await api(`/api/ready`);
    $("#readySub").textContent = `${r.total_con_error} de ${r.total_ready} en "ready" tienen error de ML`;
    if (!r.items.length) {
      $("#ml-ready").innerHTML = `<div class="loading">Ningún SKU en ready con error 🎉</div>`;
      return;
    }
    // Agrupamos por tipo de error para reutilizar el render de errores.
    const grupos = {};
    for (const it of r.items) {
      (grupos[it.tipo_error] ||= { tipo: it.tipo_error, comoCorregir: it.comoCorregir, severidad: it.severidad, productos: [] });
      const det = it.detalle[0] || {};
      grupos[it.tipo_error].productos.push({ sku: it.sku, falta_en: det.falta_en || [], publicada_en: det.publicada_en || [] });
    }
    const arr = Object.values(grupos).map((g) => ({ ...g, total_productos: g.productos.length })).sort((a, b) => b.total_productos - a.total_productos);
    renderErrores("ml-ready", arr);
  } catch (e) {
    $("#ml-ready").innerHTML = `<div class="loading">Error: ${e.message}</div>`;
  }
}
async function mlProductos() {
  $("#ml-products").innerHTML = `<div class="loading">Cargando productos…</div>`;
  const d = await api(
    `/api/products?status=${state.ml.status}&cuenta=${state.cuenta}&q=${encodeURIComponent(state.ml.search)}&page=${state.ml.page}`
  );
  $("#ml-products").innerHTML = d.items.length
    ? d.items
        .map((p) =>
          prodCard({
            cls: p.success ? "ok" : "err",
            sku: p.sku,
            badge: p.success ? "ÉXITO" : "ERROR",
            badgeCls: p.success ? "ok" : "err",
            meta: `${p.cuenta} · ${fechaHora(p.created_at)}${p.ml_item_id ? " · " + p.ml_item_id : ""}`,
            link: p.ml_url ? `<a href="${p.ml_url}" target="_blank" rel="noopener">Ver en ML ↗</a>` : "",
            fix: !p.success && p.comoCorregir ? `<div class="fixmini">⚠ ${p.comoCorregir}</div>` : "",
          })
        )
        .join("")
    : `<div class="loading">Sin resultados</div>`;
  renderPager("ml-pager", d, (pg) => { state.ml.page = pg; mlProductos(); });
}
async function loadML() {
  await Promise.allSettled([mlResumen(), mlDaily(), mlCatalogo(), mlErrores(), mlReady(), mlProductos()]);
}

// ===========================================================================
// VISTA AMAZON
// ===========================================================================
async function amzResumen() {
  const s = await api(`/api/amazon/summary`);
  const estados = s.por_estado.map((e) => `${e.estado}: ${n(e.c)}`).join("  ·  ");
  $("#amz-kpis").innerHTML = `
    <div class="kpi"><div class="label">Publicados</div><div class="value ok">${n(s.publicados)}</div><div class="foot">${estados}</div></div>
    <div class="kpi"><div class="label">SKUs OK</div><div class="value ok">${n(s.ok)}</div><div class="foot">de ${n(s.total)} en seguimiento</div></div>
    <div class="kpi"><div class="label">Con error</div><div class="value err">${n(s.err)}</div><div class="foot">INVALID / DELETED</div></div>
    <div class="kpi"><div class="label">Tasa de éxito</div><div class="value ${s.tasa_exito >= 85 ? "ok" : "err"}">${s.tasa_exito}%</div><div class="foot">estado actual por SKU</div></div>
    <div class="kpi"><div class="label">Intentos totales</div><div class="value accent">${n(s.intentos)}</div><div class="foot">${n(s.intentos_ok)} aceptados</div></div>`;
}
async function amzDaily() {
  const data = await api(`/api/amazon/daily?days=${state.amz.days}`);
  barChart("amzDailyChart", { labels: data.map((d) => `${diaSemana(d.fecha)} ${fechaCorta(d.fecha)}`) }, [
    { label: "Aceptados", data: data.map((d) => d.ok), backgroundColor: "#ff9900", borderRadius: 4, stack: "s" },
    { label: "Inválidos", data: data.map((d) => d.err), backgroundColor: "#f85149", borderRadius: 4, stack: "s" },
  ]);
}
async function amzErrores() {
  $("#amz-errors").innerHTML = `<div class="loading">Cargando errores…</div>`;
  renderErrores("amz-errors", await api(`/api/amazon/errors`));
}
async function amzProductos() {
  $("#amz-products").innerHTML = `<div class="loading">Cargando productos…</div>`;
  const d = await api(`/api/amazon/products?status=${state.amz.status}&q=${encodeURIComponent(state.amz.search)}&page=${state.amz.page}`);
  $("#amz-products").innerHTML = d.items.length
    ? d.items
        .map((p) =>
          prodCard({
            cls: p.success ? "ok" : "err",
            sku: p.sku,
            badge: p.status,
            badgeCls: p.success ? "ok" : "err",
            meta: `${fechaHora(p.created_at)}${p.asin ? " · ASIN " + p.asin : ""}${p.issue_count ? " · " + p.issue_count + " issues" : ""}`,
            fix: !p.success && p.error_label ? `<div class="fixmini">⚠ ${p.error_label}</div>` : "",
          })
        )
        .join("")
    : `<div class="loading">Sin resultados</div>`;
  renderPager("amz-pager", d, (pg) => { state.amz.page = pg; amzProductos(); });
}
async function loadAmazon() {
  await Promise.allSettled([amzResumen(), amzDaily(), amzErrores(), amzProductos()]);
}

// ===========================================================================
// VISTA PIPELINE
// ===========================================================================
async function pipeSummary() {
  const s = await api(`/api/pipeline/summary`);
  const cat = s.catalogo || {};
  $("#pipe-cat").innerHTML = `
    <div class="kpi"><div class="label">SKUs vendibles en WC</div><div class="value accent">${n(cat.skus_vendibles)}</div><div class="foot">${n(cat.simples)} simples + ${n(cat.variaciones)} variaciones</div></div>
    <div class="kpi"><div class="label">Fichas WC</div><div class="value">${n(cat.total_fichas)}</div><div class="foot">${n(cat.padres)} padres (excluidos)</div></div>
    <div class="kpi"><div class="label">Productos en Odoo</div><div class="value">${n(s.odoo?.totales?.templates)}</div><div class="foot">${n(s.odoo?.totales?.productos)} variantes (product.product)</div></div>`;

  const r = s.odoo?.residencia || {};
  $("#pipe-odoo").innerHTML = Object.entries(r).length
    ? Object.entries(r).map(([k, v]) => `<div class="wc-stat"><div class="n" style="color:${k.includes('1')?'var(--ok)':k.includes('2')?'var(--blue)':'var(--muted)'}">${n(v)}</div><div class="t">${k}</div></div>`).join("")
    : `<div class="loading">Sin datos de Odoo</div>`;

  $("#pipe-stages").innerHTML = s.etapas
    .map((e) => {
      const pct = e.total ? Math.round((e.ok / e.total) * 100) : 0;
      const det = Object.entries(e.detalle).map(([k, v]) => `<span class="chip">${k}: ${n(v)}</span>`).join("");
      return `<div class="stage">
        <div class="stage-top"><h3>${e.nombre}</h3><span class="stage-pct">${pct}%</span></div>
        <div class="bar"><span style="width:${pct}%"></span></div>
        <div class="stage-nums">
          <span class="ok">${n(e.ok)} ok</span>
          <span class="pend">${n(e.pendiente)} pendiente</span>
          <span class="er">${n(e.error)} error</span>
        </div>
        <div class="chips">${det}</div>
      </div>`;
    })
    .join("");

  const labels = s.status_wc.map((x) => x.estado);
  if (charts.pipeStatusChart) charts.pipeStatusChart.destroy();
  charts.pipeStatusChart = new Chart($("#pipeStatusChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Productos",
        data: s.status_wc.map((x) => x.c),
        backgroundColor: ["#4493f8", "#d29922", "#2ea043", "#8b949e", "#a371f7"],
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { ticks: { color: "#e6edf3" }, grid: { display: false } }, y: { beginAtZero: true, ticks: { color: "#8b949e" }, grid: { color: "#21262d" } } },
    },
  });
}
async function pipeProductos() {
  $("#pipe-products").innerHTML = `<div class="loading">Cargando productos…</div>`;
  const d = await api(`/api/pipeline/productos?q=${encodeURIComponent(state.pipe.search)}&page=${state.pipe.page}`);
  $("#pipe-products").innerHTML = d.items.length
    ? d.items
        .map((p) =>
          prodCard({
            cls: p.completo ? "ok" : "err",
            sku: p.sku,
            badge: p.status_wc,
            badgeCls: p.completo ? "ok" : "warn",
            meta: (p.nombre || "—").slice(0, 60),
            fix: p.falta.length
              ? `<div class="fixmini">Falta: ${p.falta.map((f) => `<span class="tagfalta">${f}</span>`).join(" ")}</div>`
              : `<div class="fixmini ok">Listo para publicar ✓</div>`,
          })
        )
        .join("")
    : `<div class="loading">Sin resultados</div>`;
  renderPager("pipe-pager", d, (pg) => { state.pipe.page = pg; pipeProductos(); });
}
async function loadPipeline() {
  await Promise.allSettled([pipeSummary(), pipeProductos()]);
}

// ===========================================================================
// VISTA ALMACÉN (Odoo)
// ===========================================================================
const CLASES = {
  sin_inventario: { label: "SIN INVENTARIO", desc: "0 stock + en OC", color: "var(--err)" },
  fantasma: { label: "FANTASMAS", desc: "0 stock + sin OC", color: "var(--muted)" },
  con_stock_sin_oc: { label: "CON STOCK SIN OC", desc: "stock + sin OC", color: "var(--warn)" },
  normal: { label: "Normal", desc: "stock + en OC", color: "var(--ok)" },
};
async function almResumen() {
  const r = await api(`/api/almacen/resumen`);
  $("#alm-kpis").innerHTML = `
    <div class="kpi"><div class="label">SKUs en Odoo</div><div class="value">${n(r.total)}</div><div class="foot">universo con SKU · actualizado ${haceCuanto(r.ts)}</div></div>
    <div class="kpi"><div class="label">Ligados a OC</div><div class="value accent">${r.pct_ligados}%</div><div class="foot">${n(r.ligados_oc)} SKUs</div></div>
    <div class="kpi"><div class="label">Con 0 stock</div><div class="value err">${r.pct_cero_stock}%</div><div class="foot">${n(r.cero_stock)} SKUs</div></div>
    <div class="kpi"><div class="label">Órdenes de compra</div><div class="value">${n(r.total_ordenes)}</div><div class="foot">no canceladas</div></div>`;

  const c = r.clasificaciones;
  $("#alm-clas").innerHTML = Object.entries(CLASES)
    .map(([k, m]) => `
      <div class="kpi clas-card" data-clas="${k}" title="Filtrar lista">
        <div class="label">${m.label}</div>
        <div class="value" style="color:${m.color}">${n(c[k])}</div>
        <div class="foot">${m.desc}</div>
      </div>`)
    .join("");
  $$(".clas-card").forEach((el) =>
    el.addEventListener("click", () => {
      state.alm.clas = state.alm.clas === el.dataset.clas ? "all" : el.dataset.clas;
      $$(".clas-card").forEach((x) => x.classList.toggle("sel", x.dataset.clas === state.alm.clas));
      state.alm.page = 1;
      almSkus();
    })
  );

  const res = r.residencia_stock || {};
  $("#alm-texco").innerHTML = `
    <div class="wc-stat"><div class="n" style="color:var(--ok)">${n(r.texco_stock["Texco 1"])}</div><div class="t">SKUs con stock en Texco 1</div></div>
    <div class="wc-stat"><div class="n" style="color:var(--blue)">${n(r.texco_stock["Texco 2"])}</div><div class="t">SKUs con stock en Texco 2</div></div>
    <div class="wc-stat"><div class="n">${n((res["Texco 1"]||{}).sin_oc)}</div><div class="t">Texco 1 con stock SIN OC</div></div>
    <div class="wc-stat"><div class="n">${n(r.ordenes_por_texco?.["Texco 1"] || 0)} / ${n(r.ordenes_por_texco?.["Texco 2"] || 0)}</div><div class="t">OC con destino Texco 1 / Texco 2</div></div>`;
}

async function almTexco2() {
  const d = await api(`/api/almacen/texco2`);
  // Pastel recibido vs faltante (global, contenedores con recepción).
  if (charts.t2Pie) charts.t2Pie.destroy();
  charts.t2Pie = new Chart($("#t2Pie"), {
    type: "doughnut",
    data: {
      labels: ["Recibidos", "Faltan por recibir"],
      datasets: [{ data: [d.pie.recibidos, d.pie.faltan], backgroundColor: ["#2ea043", "#f85149"], borderWidth: 0 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { color: "#e6edf3" } },
        title: { display: true, text: `${d.con_recepcion} contenedores con recepción`, color: "#8b949e" } },
    },
  });
  // Lista por contenedor: cuántos faltan por recibir.
  $("#t2-conts").innerHTML = d.contenedores
    .map((c) => {
      const pct = c.total_skus ? Math.round((c.recibidos / c.total_skus) * 100) : 0;
      const estado = c.con_recepcion ? "" : `<span class="t2-norec">sin recepción</span>`;
      return `<div class="t2-cont ${c.con_recepcion ? "" : "off"}">
        <div class="t2-cont-top"><b>Cont. ${c.cont}</b> <span class="acc">${c.orden}</span> ${estado}</div>
        <div class="t2-cont-name">${c.contenedor}</div>
        <div class="t2-bar"><span style="width:${pct}%"></span></div>
        <div class="t2-cont-nums"><span class="ok">${n(c.recibidos)} recibidos</span> · <span class="er">${n(c.faltan)} faltan</span> · ${n(c.total_skus)} SKUs</div>
      </div>`;
    })
    .join("");
}

async function almSkus() {
  $("#alm-skus").innerHTML = `<div class="loading">Cargando SKUs…</div>`;
  const d = await api(`/api/almacen/skus?clas=${state.alm.clas}&texco=${state.alm.texco}&q=${encodeURIComponent(state.alm.search)}&page=${state.alm.page}`);
  const clasLbl = state.alm.clas === "all" ? "todos" : CLASES[state.alm.clas]?.label;
  $("#alm-skus-sub").textContent = `· ${clasLbl} (${n(d.total)})`;
  $("#alm-skus").innerHTML = d.items.length
    ? d.items.map((p) => {
        const m = CLASES[p.clas] || {};
        return prodCard({
          cls: p.clas === "fantasma" || p.clas === "sin_inventario" ? "err" : p.clas === "con_stock_sin_oc" ? "warn-card" : "ok",
          sku: p.sku,
          badge: m.label || p.clas,
          badgeCls: p.en_oc ? "ok" : "warn",
          meta: `Stock: ${n(p.stock)} (T1 ${n(p.t1)} · T2 ${n(p.t2)}) · ${p.en_oc ? "en OC" : "sin OC"}`,
        });
      }).join("")
    : `<div class="loading">Sin resultados</div>`;
  renderPager("alm-skus-pager", d, (pg) => { state.alm.page = pg; almSkus(); });
}

async function almOrdenes() {
  $("#alm-ordenes").innerHTML = `<div class="loading">Cargando órdenes…</div>`;
  const d = await api(`/api/almacen/ordenes?q=${encodeURIComponent(state.alm.ocSearch)}`);
  $("#alm-ordenes").innerHTML = d.items.length
    ? d.items.map((o) => `
        <div class="oc-card" data-oc="${o.id}">
          <div class="oc-top"><b>${o.name}</b><span class="oc-texco">${o.texco}</span></div>
          <div class="oc-cont">${o.contenedor || "— sin contenedor —"}</div>
          <div class="oc-meta">${n(o.num_skus)} SKUs · ${o.estado}</div>
        </div>`).join("")
    : `<div class="loading">Sin resultados</div>`;
  $$(".oc-card").forEach((el) => el.addEventListener("click", () => abrirOrden(el.dataset.oc)));
}

async function abrirOrden(id) {
  $("#alm-main").classList.add("hidden");
  $("#alm-detalle").classList.remove("hidden");
  $("#oc-detalle-head").innerHTML = `<div class="loading">Cargando orden…</div>`;
  $("#oc-tabla").innerHTML = "";
  try {
    const o = await api(`/api/almacen/orden/${id}`);
    $("#oc-detalle-head").innerHTML = `
      <h2>${o.name} <span class="oc-texco">${o.texco}</span></h2>
      <div class="oc-detalle-meta">
        <div><span class="lbl">Contenedor</span> ${o.contenedor || "—"}</div>
        <div><span class="lbl">Estado</span> ${o.estado}</div>
        <div><span class="lbl">SKUs</span> ${n(o.total_skus)}</div>
      </div>`;
    $("#oc-tabla").innerHTML = `
      <thead><tr><th>SKU</th><th>Producto</th><th>Ordenada</th><th>Recibida</th><th>Falta</th><th>Stock actual</th></tr></thead>
      <tbody>${o.items.map((i) => {
        const falta = Math.max((i.ordenada || 0) - (i.recibida || 0), 0);
        return `<tr class="${falta > 0 ? "row-falta" : ""}">
          <td class="sku">${i.sku}</td><td class="nm">${i.nombre || ""}</td>
          <td>${n(i.ordenada)}</td><td>${n(i.recibida)}</td>
          <td class="${falta > 0 ? "er" : "ok"}">${n(falta)}</td>
          <td>${n(i.stock)}</td></tr>`;
      }).join("")}</tbody>`;
  } catch (e) {
    $("#oc-detalle-head").innerHTML = `<div class="loading">Error: ${e.message}</div>`;
  }
}
function cerrarOrden() {
  $("#alm-detalle").classList.add("hidden");
  $("#alm-main").classList.remove("hidden");
}
async function loadAlmacen() {
  cerrarOrden();
  await Promise.allSettled([almResumen(), almTexco2(), almSkus(), almOrdenes()]);
}

// ===========================================================================
// Routing + eventos
// ===========================================================================
async function loadView(refresh = false) {
  $("#updated").textContent = "Actualizando…";
  if (state.view === "ml") await loadML();
  else if (state.view === "amazon") await loadAmazon();
  else if (state.view === "pipeline") await loadPipeline();
  else if (state.view === "almacen") await loadAlmacen();
  $("#updated").textContent = "Actualizado " + new Date().toLocaleTimeString("es-MX");
}

$$(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    $$(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    state.view = t.dataset.view;
    $$(".view").forEach((v) => v.classList.add("hidden"));
    $(`#view-${state.view}`).classList.remove("hidden");
    loadView();
  })
);

$("#refresh").addEventListener("click", () => loadView(true));
$("#cuenta").addEventListener("change", (e) => { state.cuenta = e.target.value; state.ml.page = 1; loadML(); });

// Segmentos ML
$$("[data-mldays]").forEach((b) => b.addEventListener("click", () => {
  $$("[data-mldays]").forEach((x) => x.classList.remove("active")); b.classList.add("active");
  state.ml.days = Number(b.dataset.mldays); mlDaily();
}));
$$("[data-mlstatus]").forEach((b) => b.addEventListener("click", () => {
  $$("[data-mlstatus]").forEach((x) => x.classList.remove("active")); b.classList.add("active");
  state.ml.status = b.dataset.mlstatus; state.ml.page = 1; mlProductos();
}));
// Segmentos Amazon
$$("[data-amzdays]").forEach((b) => b.addEventListener("click", () => {
  $$("[data-amzdays]").forEach((x) => x.classList.remove("active")); b.classList.add("active");
  state.amz.days = Number(b.dataset.amzdays); amzDaily();
}));
$$("[data-amzstatus]").forEach((b) => b.addEventListener("click", () => {
  $$("[data-amzstatus]").forEach((x) => x.classList.remove("active")); b.classList.add("active");
  state.amz.status = b.dataset.amzstatus; state.amz.page = 1; amzProductos();
}));

// Búsquedas con debounce
function bindSearch(selector, apply) {
  const el = $(selector);
  let t;
  el.addEventListener("input", (e) => {
    clearTimeout(t);
    t = setTimeout(() => apply(e.target.value.trim()), 350);
  });
}
bindSearch("[data-mlsearch]", (v) => { state.ml.search = v; state.ml.page = 1; mlProductos(); });
bindSearch("[data-amzsearch]", (v) => { state.amz.search = v; state.amz.page = 1; amzProductos(); });
bindSearch("[data-pipesearch]", (v) => { state.pipe.search = v; state.pipe.page = 1; pipeProductos(); });
bindSearch("[data-almsearch]", (v) => { state.alm.search = v; state.alm.page = 1; almSkus(); });
bindSearch("[data-ocsearch]", (v) => { state.alm.ocSearch = v; almOrdenes(); });
$("#almTexco").addEventListener("change", (e) => { state.alm.texco = e.target.value; state.alm.page = 1; almSkus(); });
$("#ocVolver").addEventListener("click", cerrarOrden);

// ---- Exportar a Excel ----
function ymdLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function lunesDeEstaSemana() {
  const d = new Date();
  const dow = (d.getDay() + 6) % 7; // 0 = lunes
  d.setDate(d.getDate() - dow);
  return ymdLocal(d);
}
function initExport() {
  const hoy = ymdLocal(new Date());
  $("#expDesde").value = lunesDeEstaSemana();
  $("#expHasta").value = hoy;
}
$("#expSemana").addEventListener("click", () => {
  $("#expDesde").value = lunesDeEstaSemana();
  $("#expHasta").value = ymdLocal(new Date());
});
$("#expDescargar").addEventListener("click", () => {
  const desde = $("#expDesde").value;
  const hasta = $("#expHasta").value;
  const qs = new URLSearchParams();
  if (desde) qs.set("desde", desde);
  if (hasta) qs.set("hasta", hasta);
  window.location.href = `/api/export?${qs.toString()}`;
});
initExport();

// Auto-refresh del panel de catálogo (solo si la vista ML está activa)
setInterval(() => { if (state.view === "ml") mlCatalogo(); }, 120000);

loadView();
