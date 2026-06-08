// ---------------------------------------------------------------------------
// Estado + helpers
// ---------------------------------------------------------------------------
const state = {
  view: "ml",
  cuenta: "todas",
  ml: { days: 14, status: "all", search: "", page: 1 },
  amz: { days: 14, status: "all", search: "", page: 1 },
  pipe: { search: "", page: 1 },
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
          ${g.productos
            .map(
              (p) =>
                `<span class="err-sku">${p.sku}${p.cuenta ? ` <span class="acc">· ${p.cuenta}</span>` : ""}</span>`
            )
            .join("")}
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
  const cuentasTxt = s.por_cuenta.map((c) => `${c.cuenta}: ${n(c.ok)}✓`).join("  ·  ");
  $("#ml-kpis").innerHTML = `
    <div class="kpi"><div class="label">Publicadas hoy</div><div class="value ok">${n(s.hoy.ok)}</div><div class="foot">${n(s.hoy.total)} intentos hoy</div></div>
    <div class="kpi"><div class="label">Esta semana</div><div class="value accent">${n(s.semana.ok)}</div><div class="foot">${n(s.semana.total)} intentos desde el lunes</div></div>
    <div class="kpi"><div class="label">Total publicadas OK</div><div class="value ok">${n(s.ok)}</div><div class="foot">${n(s.skus_ok)} SKUs únicos</div></div>
    <div class="kpi"><div class="label">Con error</div><div class="value err">${n(s.err)}</div><div class="foot">de ${n(s.total)} intentos</div></div>
    <div class="kpi"><div class="label">Tasa de éxito</div><div class="value ${s.tasa_exito >= 85 ? "ok" : "err"}">${s.tasa_exito}%</div><div class="foot">${cuentasTxt}</div></div>`;
}
async function mlDaily() {
  const data = await api(`/api/daily?days=${state.ml.days}&cuenta=${state.cuenta}`);
  barChart("mlDailyChart", { labels: data.map((d) => `${diaSemana(d.fecha)} ${fechaCorta(d.fecha)}`) }, [
    { label: "Publicadas (éxito)", data: data.map((d) => d.ok), backgroundColor: "#2ea043", borderRadius: 4, stack: "s" },
    { label: "Con error", data: data.map((d) => d.err), backgroundColor: "#f85149", borderRadius: 4, stack: "s" },
  ]);
}
async function mlWC() {
  $("#wcPanel").innerHTML = `<div class="loading">Consultando WooCommerce…</div>`;
  try {
    const w = await api(`/api/woocommerce`);
    $("#wcLiveBadge").textContent = w.wc_live != null ? `WC en vivo: ${n(w.wc_live)} publicados` : "WC sin conexión";
    $("#wcPanel").innerHTML = `
      <div class="wc-stat"><div class="n">${n(w.wc_publish)}</div><div class="t">Productos publicados en WC</div></div>
      <div class="wc-stat"><div class="n" style="color:var(--ok)">${n(w.ml_sincronizados)}</div><div class="t">Sincronizados en ML</div></div>
      <div class="wc-stat"><div class="n" style="color:var(--err)">${n(w.por_sincronizar)}</div><div class="t">Faltan por sincronizar</div></div>
      <div class="wc-stat"><div class="n" style="color:var(--accent)">${w.pct_sincronizado}%</div><div class="t">Avance</div><div class="bar"><span style="width:${Math.min(w.pct_sincronizado,100)}%"></span></div></div>`;
    $("#wcFaltCount").textContent = n(w.por_sincronizar);
    $("#wcFaltantes").innerHTML = w.faltantes.length
      ? w.faltantes.map((f) => `<div class="falt-item"><span class="sku">${f.sku}</span><span class="nm">${f.nombre || "—"}</span></div>`).join("")
      : `<div class="loading">Todo sincronizado 🎉</div>`;
  } catch (e) {
    $("#wcPanel").innerHTML = `<div class="loading">Error: ${e.message}</div>`;
  }
}
async function mlErrores() {
  $("#ml-errors").innerHTML = `<div class="loading">Cargando errores…</div>`;
  renderErrores("ml-errors", await api(`/api/errors?cuenta=${state.cuenta}`));
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
  await Promise.allSettled([mlResumen(), mlDaily(), mlWC(), mlErrores(), mlProductos()]);
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
// Routing + eventos
// ===========================================================================
async function loadView(refresh = false) {
  $("#updated").textContent = "Actualizando…";
  if (state.view === "ml") await loadML();
  else if (state.view === "amazon") await loadAmazon();
  else if (state.view === "pipeline") await loadPipeline();
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

// Auto-refresh del panel WooCommerce (solo si la vista ML está activa)
setInterval(() => { if (state.view === "ml") mlWC(); }, 60000);

loadView();
