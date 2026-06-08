// ---------------------------------------------------------------------------
// Estado y helpers
// ---------------------------------------------------------------------------
const state = {
  cuenta: "todas",
  days: 14,
  prodStatus: "all",
  search: "",
};
let dailyChart = null;

const $ = (sel) => document.querySelector(sel);
const api = async (path) => {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};
const n = (x) => (x ?? 0).toLocaleString("es-MX");
const fechaCorta = (iso) => {
  const d = new Date(iso);
  return d.toLocaleDateString("es-MX", { day: "2-digit", month: "short" });
};
const diaSemana = (iso) =>
  new Date(iso + "T00:00:00").toLocaleDateString("es-MX", { weekday: "short" });

// ---------------------------------------------------------------------------
// Resumen
// ---------------------------------------------------------------------------
async function cargarResumen() {
  const s = await api(`/api/summary?cuenta=${state.cuenta}`);
  const cuentasTxt = s.por_cuenta
    .map((c) => `${c.cuenta}: ${n(c.ok)}✓`)
    .join("  ·  ");
  $("#kpis").innerHTML = `
    <div class="kpi">
      <div class="label">Publicadas hoy</div>
      <div class="value ok">${n(s.hoy.ok)}</div>
      <div class="foot">${n(s.hoy.total)} intentos hoy</div>
    </div>
    <div class="kpi">
      <div class="label">Esta semana</div>
      <div class="value accent">${n(s.semana.ok)}</div>
      <div class="foot">${n(s.semana.total)} intentos desde el lunes</div>
    </div>
    <div class="kpi">
      <div class="label">Total publicadas OK</div>
      <div class="value ok">${n(s.ok)}</div>
      <div class="foot">${n(s.skus_ok)} SKUs únicos</div>
    </div>
    <div class="kpi">
      <div class="label">Con error</div>
      <div class="value err">${n(s.err)}</div>
      <div class="foot">de ${n(s.total)} intentos</div>
    </div>
    <div class="kpi">
      <div class="label">Tasa de éxito</div>
      <div class="value ${s.tasa_exito >= 85 ? "ok" : "err"}">${s.tasa_exito}%</div>
      <div class="foot">${cuentasTxt}</div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// KPI 1: Publicaciones por día
// ---------------------------------------------------------------------------
async function cargarDaily() {
  const data = await api(`/api/daily?days=${state.days}&cuenta=${state.cuenta}`);
  const labels = data.map((d) => `${diaSemana(d.fecha)} ${fechaCorta(d.fecha)}`);
  const ok = data.map((d) => d.ok);
  const err = data.map((d) => d.err);

  const ctx = $("#dailyChart");
  if (dailyChart) dailyChart.destroy();
  dailyChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Publicadas (éxito)",
          data: ok,
          backgroundColor: "#2ea043",
          borderRadius: 4,
          stack: "s",
        },
        {
          label: "Con error",
          data: err,
          backgroundColor: "#f85149",
          borderRadius: 4,
          stack: "s",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#e6edf3" } },
        tooltip: { mode: "index", intersect: false },
      },
      scales: {
        x: { ticks: { color: "#8b949e", maxRotation: 60, minRotation: 45 }, grid: { color: "#21262d" } },
        y: { ticks: { color: "#8b949e" }, grid: { color: "#21262d" }, beginAtZero: true, stacked: true },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// KPI 4: WooCommerce
// ---------------------------------------------------------------------------
async function cargarWC() {
  $("#wcPanel").innerHTML = `<div class="loading">Consultando WooCommerce…</div>`;
  try {
    const w = await api(`/api/woocommerce`);
    const live = w.wc_live != null ? n(w.wc_live) : "—";
    $("#wcLiveBadge").textContent =
      w.wc_live != null ? `WC en vivo: ${live} publicados` : "WC sin conexión";
    $("#wcPanel").innerHTML = `
      <div class="wc-stat"><div class="n">${n(w.wc_publish)}</div><div class="t">Productos publicados en WC</div></div>
      <div class="wc-stat"><div class="n" style="color:var(--ok)">${n(w.ml_sincronizados)}</div><div class="t">Sincronizados en MercadoLibre</div></div>
      <div class="wc-stat"><div class="n" style="color:var(--err)">${n(w.por_sincronizar)}</div><div class="t">Faltan por sincronizar</div></div>
      <div class="wc-stat">
        <div class="n" style="color:var(--accent)">${w.pct_sincronizado}%</div>
        <div class="t">Avance de sincronización</div>
        <div class="bar"><span style="width:${Math.min(w.pct_sincronizado, 100)}%"></span></div>
      </div>
    `;
    $("#wcFaltCount").textContent = n(w.por_sincronizar);
    $("#wcFaltantes").innerHTML = w.faltantes.length
      ? w.faltantes
          .map(
            (f) => `<div class="falt-item">
              <span class="sku">${f.sku}</span>
              <span class="nm" title="${(f.nombre || "").replace(/"/g, "")}">${f.nombre || "—"}</span>
            </div>`
          )
          .join("")
      : `<div class="loading">Todo sincronizado 🎉</div>`;
  } catch (e) {
    $("#wcPanel").innerHTML = `<div class="loading">Error: ${e.message}</div>`;
  }
}

// ---------------------------------------------------------------------------
// KPI 2: Errores
// ---------------------------------------------------------------------------
async function cargarErrores() {
  $("#errors").innerHTML = `<div class="loading">Cargando errores…</div>`;
  const grupos = await api(`/api/errors?cuenta=${state.cuenta}`);
  if (!grupos.length) {
    $("#errors").innerHTML = `<div class="loading">Sin errores registrados 🎉</div>`;
    return;
  }
  $("#errors").innerHTML = grupos
    .map(
      (g, i) => `
    <div class="err-group">
      <div class="err-head" data-i="${i}">
        <div class="sev ${g.severidad}"></div>
        <div class="tipo">${g.tipo}</div>
        <div class="count">${n(g.total_productos)} producto(s)</div>
      </div>
      <div class="err-body" id="eb-${i}">
        <div class="fix"><b>Cómo corregirlo:</b> ${g.comoCorregir}</div>
        <div class="err-skus">
          ${g.productos
            .map(
              (p) =>
                `<span class="err-sku" title="${(p.error || "").replace(/"/g, "")}">${p.sku} <span class="acc">· ${p.cuenta}</span></span>`
            )
            .join("")}
        </div>
      </div>
    </div>`
    )
    .join("");
  document.querySelectorAll(".err-head").forEach((h) => {
    h.addEventListener("click", () => {
      $(`#eb-${h.dataset.i}`).classList.toggle("open");
    });
  });
}

// ---------------------------------------------------------------------------
// KPI 3: Productos
// ---------------------------------------------------------------------------
async function cargarProductos() {
  $("#products").innerHTML = `<div class="loading">Cargando productos…</div>`;
  const data = await api(
    `/api/products?status=${state.prodStatus}&cuenta=${state.cuenta}&q=${encodeURIComponent(
      state.search
    )}&limit=150`
  );
  if (!data.length) {
    $("#products").innerHTML = `<div class="loading">Sin resultados</div>`;
    return;
  }
  $("#products").innerHTML = data
    .map((p) => {
      const cls = p.success ? "ok" : "err";
      const link = p.ml_url
        ? `<a href="${p.ml_url}" target="_blank" rel="noopener">Ver en ML ↗</a>`
        : "";
      const fix = !p.success && p.comoCorregir
        ? `<div class="fixmini">⚠ ${p.comoCorregir}</div>`
        : "";
      return `<div class="prod ${cls}">
        <div class="row1">
          <span class="sku">${p.sku}</span>
          <span class="st ${cls}">${p.success ? "ÉXITO" : "ERROR"}</span>
        </div>
        <div class="meta">${p.cuenta} · ${fechaCorta(p.created_at)}${p.ml_item_id ? " · " + p.ml_item_id : ""}</div>
        ${link}
        ${fix}
      </div>`;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Carga global + eventos
// ---------------------------------------------------------------------------
async function cargarTodo() {
  $("#updated").textContent = "Actualizando…";
  await Promise.allSettled([
    cargarResumen(),
    cargarDaily(),
    cargarWC(),
    cargarErrores(),
    cargarProductos(),
  ]);
  $("#updated").textContent =
    "Actualizado " + new Date().toLocaleTimeString("es-MX");
}

$("#cuenta").addEventListener("change", (e) => {
  state.cuenta = e.target.value;
  cargarTodo();
});
$("#refresh").addEventListener("click", cargarTodo);

document.querySelectorAll("[data-days]").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll("[data-days]").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.days = Number(b.dataset.days);
    cargarDaily();
  });
});

document.querySelectorAll("[data-status]").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll("[data-status]").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.prodStatus = b.dataset.status;
    cargarProductos();
  });
});

let searchTimer;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value.trim();
    cargarProductos();
  }, 350);
});

// Auto-refresh del panel WooCommerce cada 60s (tiempo real)
setInterval(cargarWC, 60000);

cargarTodo();
