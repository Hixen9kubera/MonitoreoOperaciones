# Sync de inventario Odoo → WooCommerce (Supabase Edge Function)

Sincroniza el stock disponible de Odoo (`qty_available`) hacia WooCommerce. Solo
actualiza los SKUs cuyo stock **cambió**. Arranca en **dry-run** (no escribe en WC).

## Componentes

- `sync_schema.sql` — tablas `inv_sync_cache` (mapeo + último stock empujado) y
  `sync_log` (bitácora), + el cron horario.
- `functions/sync-odoo-wc/index.ts` — la Edge Function.

## Pasos de despliegue

1. **Crear las tablas**: Supabase → SQL Editor → pega y corre `sync_schema.sql`.

2. **Instalar la CLI y enlazar el proyecto** (una vez):
   ```bash
   npm i -g supabase
   supabase login
   supabase link --project-ref <TU_PROJECT_REF>
   ```

3. **Cargar los secrets** (las credenciales NO van en el código):
   ```bash
   supabase secrets set \
     ODOO_URL=https://ifullmx-brea.odoo.com \
     ODOO_DB=ifullmx-brea-main-6396587 \
     ODOO_USER=jose@kubera.mx \
     ODOO_PASSWORD=*** \
     WC_URL=https://chunche.shop \
     WC_KEY=ck_*** \
     WC_SECRET=cs_*** \
     DRY_RUN=true \
     BATCH_LIMIT=200
   ```
   > `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase automáticamente.

4. **Desplegar la función**:
   ```bash
   supabase functions deploy sync-odoo-wc
   ```

5. **Probar en dry-run** (no escribe en WooCommerce):
   ```bash
   curl -X POST https://<PROJECT_REF>.functions.supabase.co/sync-odoo-wc \
        -H "Authorization: Bearer <ANON_KEY>"
   ```
   Revisa la tabla `sync_log` (con `dry_run=true`): ahí ves exactamente qué SKUs y a
   qué cantidad se actualizarían. Valida que tenga sentido.

6. **Activar el cron**: en `sync_schema.sql`, descomenta el bloque `cron.schedule`,
   reemplaza `<PROJECT_REF>` y `<ANON_KEY>`, y córrelo.

7. **Pasar a real**: cuando valides el dry-run, cambia el secret:
   ```bash
   supabase secrets set DRY_RUN=false
   ```
   La primera corrida en real hará el "backfill" completo en lotes de `BATCH_LIMIT`
   por ejecución (el cron horario drena el backlog); después solo empuja los cambios.

## Notas

- **Fuente de verdad**: Odoo. WooCommerce refleja el `qty_available` de Odoo.
- **Variaciones**: se actualizan en `/products/{padre}/variations/{id}`; simples en `/products/{id}`.
- **Idempotente**: si el stock no cambió respecto al último empujado, no hace nada.
- El dashboard puede leer `sync_log` para mostrar la trazabilidad de la sincronización.
