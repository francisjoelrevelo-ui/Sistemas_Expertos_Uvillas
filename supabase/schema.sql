-- =====================================================================
-- UvillaDx · Esquema de base de datos en Supabase
-- Ejecutar UNA vez en: Supabase → SQL Editor → New query → Run
-- =====================================================================

-- Tabla de diagnósticos: cada fila pertenece a un usuario autenticado
create table if not exists public.diagnosticos (
  id           uuid primary key,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  fecha        timestamptz not null,
  organo       text not null check (organo in ('hojas', 'frutos', 'tallos')),
  clase_id     text not null,           -- id de la clase en knowledgeBase.json (p. ej. "esclerotiniosis")
  diagnostico  text not null,           -- nombre legible del diagnóstico
  estado       text not null,           -- confirmado | probable | no_concluyente | sano
  fc           numeric(6, 4) not null,  -- factor de certeza final
  temperatura  numeric(4, 1),
  humedad      numeric(4, 1),
  ubicacion    text,
  fuente_ml    text,                    -- modelo | simulador
  datos        jsonb not null,          -- predicción, reglas disparadas, respuestas, ranking y traza
  imagen       text,                    -- miniatura JPEG (data URL, ~40 KB)
  creado       timestamptz not null default now(),
  actualizado  timestamptz not null default now()
);

create index if not exists diagnosticos_user_fecha_idx on public.diagnosticos (user_id, fecha desc);

-- Mantener "actualizado" al día en cada modificación
create or replace function public.tocar_actualizado()
returns trigger language plpgsql as $$
begin
  new.actualizado := now();
  return new;
end $$;

drop trigger if exists diagnosticos_actualizado on public.diagnosticos;
create trigger diagnosticos_actualizado
  before update on public.diagnosticos
  for each row execute function public.tocar_actualizado();

-- Seguridad por fila (RLS): cada usuario solo ve y modifica SUS diagnósticos
alter table public.diagnosticos enable row level security;

drop policy if exists "leer propios"      on public.diagnosticos;
drop policy if exists "insertar propios"  on public.diagnosticos;
drop policy if exists "editar propios"    on public.diagnosticos;
drop policy if exists "eliminar propios"  on public.diagnosticos;

create policy "leer propios" on public.diagnosticos
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "insertar propios" on public.diagnosticos
  for insert to authenticated with check ((select auth.uid()) = user_id);

create policy "editar propios" on public.diagnosticos
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "eliminar propios" on public.diagnosticos
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Permisos de la API (por si "exponer tablas automáticamente" estuviera desactivado).
-- Los usuarios anónimos no tienen ningún acceso.
grant select, insert, update, delete on public.diagnosticos to authenticated;
revoke all on public.diagnosticos from anon;
