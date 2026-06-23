-- ============================================================================
-- Sincronización de inventario Odoo → WooCommerce con Supabase Edge Functions
-- Ejecuta esto en Supabase → SQL Editor (una vez).
-- ============================================================================

-- 1) Caché/mapeo por SKU. Guarda el último stock EMPUJADO a WC para detectar cambios.
create table if not exists public.inv_sync_cache (
  sku         text primary key,
  wc_id       integer,                 -- id del producto/variación en WooCommerce
  wc_type     text,                    -- 'simple' | 'variation'
  parent_id   integer,                 -- padre (si es variación)
  qty_odoo    numeric,                 -- último qty_available leído de Odoo
  qty_pushed  numeric,                 -- último stock realmente escrito en WC
  no_en_wc    boolean default false,   -- true si el SKU no existe en WooCommerce
  updated_at  timestamptz default now(),
  pushed_at   timestamptz
);

-- 2) Bitácora de cada cambio (trazabilidad).
create table if not exists public.sync_log (
  id           bigint generated always as identity primary key,
  run_id       uuid,
  sku          text,
  wc_id        integer,
  qty_anterior numeric,
  qty_nuevo    numeric,
  accion       text,        -- 'update' | 'skip_no_wc' | 'sin_cambio'
  dry_run      boolean,
  ok           boolean,
  error        text,
  ts           timestamptz default now()
);
create index if not exists sync_log_ts_idx on public.sync_log (ts desc);

-- 3) Programar la Edge Function cada hora (requiere pg_cron + pg_net).
--    Reemplaza <PROJECT_REF> y <ANON_KEY> por los de tu proyecto.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- select cron.schedule('sync-odoo-wc-hourly', '0 * * * *', $$
--   select net.http_post(
--     url     := 'https://<PROJECT_REF>.functions.supabase.co/sync-odoo-wc',
--     headers := jsonb_build_object('Authorization','Bearer <ANON_KEY>','Content-Type','application/json'),
--     body    := '{}'::jsonb
--   );
-- $$);
