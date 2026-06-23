-- Tabla para el histórico diario de aprobación en WooCommerce (plugin WC KAM Revision Manager).
-- Ejecuta esto en Supabase → SQL Editor.

create table if not exists public.aprobacion_historial (
  id            bigint generated always as identity primary key,
  fecha         date not null unique,          -- una fila por día (upsert por fecha)
  aprobadas     integer not null default 0,
  pendientes    integer not null default 0,
  asignados     integer not null default 0,
  total         integer not null default 0,
  pct_aprobadas numeric(5,1) not null default 0,
  created_at    timestamptz not null default now()
);

comment on table public.aprobacion_historial is
  'Snapshot diario de aprobación en Woo (aprobadas/pendientes) para trazabilidad en el tiempo.';
