# Monitoreo de Operaciones — Dashboard de KPIs

Dashboard web para monitorear las publicaciones en MercadoLibre (cuentas **BEKURA** y **SANCORFASHION**) y compararlas en tiempo real contra el catálogo de WooCommerce.

## KPIs incluidos

1. **Publicaciones por día** — barras apiladas (éxito / error) de los últimos 7/14/30 días. La fecha usa `created_at` de `ml_backlog` (el campo `published_at` está vacío en la BD).
2. **Errores y cómo corregirlos** — agrupados por tipo; cada producto (SKU + cuenta) aparece **una sola vez** por tipo de error, con una instrucción de remediación.
3. **Productos publicados** — tarjetas por SKU (éxito / error), con enlace a MercadoLibre y filtro por estado, cuenta y búsqueda de SKU.
4. **Sincronización con WooCommerce** — productos publicados en WC vs. sincronizados en ML, cuántos **faltan por sincronizar** y % de avance. Consulta la API de WooCommerce en vivo (se refresca cada 60 s).

## Stack

- **Node.js + Express** (un solo servicio)
- **MySQL** (`mysql2`) — base de datos Hostinger
- **Chart.js** (CDN) + frontend vanilla en `public/`

## Desarrollo local

```bash
npm install
npm run dev      # http://localhost:3000  (recarga automática)
```

Requiere un archivo `.env` con las credenciales (ver variables abajo).

---

## Despliegue en Railway

### Variables de entorno (Railway → Variables)

Copia estas del `.env` local **(no subas el `.env` al repo)**:

```
DB_HOST=srv1249.hstgr.io
DB_PORT=3306
DB_NAME=u531713409_kubera_ml
DB_USER=u531713409_brandon2026
DB_PASSWORD=********
WC_URL=https://chunche.shop
WC_CONSUMER_KEY=ck_********
WC_CONSUMER_SECRET=cs_********
ODOO_URL=https://ifullmx-brea.odoo.com
ODOO_DB=ifullmx-brea-main-6396587
ODOO_USER=jose@kubera.mx
ODOO_PASSWORD=********
```

> **Catálogo en vivo:** la app escanea el catálogo completo de WooCommerce
> (`status=any`, ~40 páginas) + Odoo (XML-RPC) al arrancar y lo refresca en
> segundo plano cada 10 min. El primer escaneo tras el deploy tarda ~1 min;
> después el dashboard carga al instante desde el snapshot en memoria.

> `PORT` lo inyecta Railway automáticamente — no hace falta definirlo.

### Comandos

**Build:**
```bash
npm install
```

**Start (deploy / arranque):**
```bash
npm start
```

Railway usa Nixpacks y detecta `package.json` automáticamente. El archivo
[`railway.json`](railway.json) ya deja configurado el `startCommand` (`npm start`) y
el healthcheck en `/api/health`.

### Opción A — Desde GitHub (recomendada)

```bash
git init
git add .
git commit -m "Dashboard de monitoreo de KPIs"
git branch -M main
git remote add origin <URL-de-tu-repo>
git push -u origin main
```

Luego en Railway: **New Project → Deploy from GitHub repo**, selecciona el repo y
agrega las variables de entorno. El deploy es automático en cada `push`.

### Opción B — Desde la CLI de Railway

```bash
npm i -g @railway/cli      # instalar CLI (una vez)
railway login              # autenticarse
railway init               # crear/enlazar proyecto
railway up                 # build + deploy
railway variables --set DB_HOST=... --set DB_PASSWORD=...   # (o cargarlas en el panel)
railway domain             # generar URL pública
```

---

## Estructura

```
server.js     API Express + rutas de KPIs
db.js         Pool de conexiones MySQL
wc.js         Cliente WooCommerce (conteo en vivo)
errorMap.js   Clasificación de errores → "cómo corregirlo"
public/       index.html · styles.css · app.js (dashboard)
railway.json  Config de build/deploy
```

## Endpoints API

| Endpoint | Descripción |
|---|---|
| `GET /api/health` | Estado + ping a la BD |
| `GET /api/summary?cuenta=` | Totales, tasa de éxito, hoy, semana |
| `GET /api/daily?days=14&cuenta=` | Publicaciones por día |
| `GET /api/errors?cuenta=` | Errores agrupados + remediación |
| `GET /api/products?status=&cuenta=&q=&limit=` | Tarjetas de productos |
| `GET /api/woocommerce` | Comparación de sincronización en tiempo real |

Parámetro `cuenta`: `todas` (default), `BEKURA` o `SANCORFASHION`.
