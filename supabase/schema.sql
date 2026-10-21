-- =====================================================================
--  M-A Building Field Orders — Supabase database setup
--  Paste this whole file into Supabase → SQL Editor → New query → Run.
--  Safe to run once on a new project.
-- =====================================================================

-- ---------- PROFILES (one row per employee login) ----------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  full_name   text,
  phone       text,
  role        text not null default 'field' check (role in ('field', 'admin')),
  created_at  timestamptz not null default now()
);

-- Helper used by security rules: is the signed-in user an admin?
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- Automatically create a profile when a user is added in Authentication → Users
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Only admins may change someone's role (SQL editor / service role is allowed)
create or replace function public.protect_profile_role()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.role is distinct from old.role
     and auth.uid() is not null
     and not public.is_admin() then
    raise exception 'Only admins can change roles';
  end if;
  return new;
end;
$$;

create trigger profiles_protect_role
  before update on public.profiles
  for each row execute function public.protect_profile_role();

-- ---------- JOBSITES ----------
create table public.jobsites (
  id          bigint generated always as identity primary key,
  job_number  text,
  name        text not null,
  address     text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------- CATALOG (materials & equipment admins maintain) ----------
create table public.catalog_items (
  id           bigint generated always as identity primary key,
  name         text not null,
  category     text not null default 'Material' check (category in ('Material', 'Equipment')),
  unit         text not null default 'ea',
  description  text,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- ---------- ORDERS ----------
create table public.orders (
  id               bigint generated always as identity primary key,
  jobsite_id       bigint not null references public.jobsites (id),
  requested_by     uuid not null default auth.uid() references public.profiles (id),
  needed_by        date,
  priority         text not null default 'Normal' check (priority in ('Normal', 'Urgent')),
  delivery_method  text not null default 'Deliver to site' check (delivery_method in ('Deliver to site', 'Will pick up')),
  delivery_notes   text,
  status           text not null default 'Pending'
                   check (status in ('Pending', 'Approved', 'Ordered', 'Delivered', 'Rejected', 'Cancelled')),
  admin_notes      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index orders_status_idx on public.orders (status);
create index orders_requested_by_idx on public.orders (requested_by);

create table public.order_items (
  id               bigint generated always as identity primary key,
  order_id         bigint not null references public.orders (id) on delete cascade,
  catalog_item_id  bigint references public.catalog_items (id),
  item_name        text not null,
  category         text,
  quantity         numeric not null check (quantity > 0),
  unit             text,
  notes            text
);

create index order_items_order_idx on public.order_items (order_id);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();

-- ---------- PUSH NOTIFICATION SUBSCRIPTIONS (one per phone/browser) ----------
create table public.push_subscriptions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);

-- ---------- SUBMIT ORDER (order + items saved together) ----------
create or replace function public.submit_order(
  p_jobsite_id      bigint,
  p_needed_by       date,
  p_priority        text,
  p_delivery_method text,
  p_delivery_notes  text,
  p_items           jsonb
)
returns bigint
language plpgsql security invoker set search_path = public
as $$
declare
  v_id bigint;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one item';
  end if;

  insert into public.orders (jobsite_id, requested_by, needed_by, priority, delivery_method, delivery_notes)
  values (p_jobsite_id, auth.uid(), p_needed_by,
          coalesce(p_priority, 'Normal'), coalesce(p_delivery_method, 'Deliver to site'),
          nullif(trim(p_delivery_notes), ''))
  returning id into v_id;

  insert into public.order_items (order_id, catalog_item_id, item_name, category, quantity, unit, notes)
  select v_id,
         nullif(x ->> 'catalog_item_id', '')::bigint,
         x ->> 'item_name',
         x ->> 'category',
         (x ->> 'quantity')::numeric,
         x ->> 'unit',
         nullif(trim(x ->> 'notes'), '')
  from jsonb_array_elements(p_items) as x;

  return v_id;
end;
$$;

-- =====================================================================
--  SECURITY (Row Level Security)
--  Field users: see/submit only their own orders.  Admins: everything.
-- =====================================================================
alter table public.profiles           enable row level security;
alter table public.jobsites           enable row level security;
alter table public.catalog_items      enable row level security;
alter table public.orders             enable row level security;
alter table public.order_items        enable row level security;
alter table public.push_subscriptions enable row level security;

-- profiles
create policy "profiles: read own or admin" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());
create policy "profiles: update own or admin" on public.profiles
  for update to authenticated using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- jobsites & catalog: everyone signed in can read, admins manage
create policy "jobsites: read" on public.jobsites
  for select to authenticated using (true);
create policy "jobsites: admin write" on public.jobsites
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "catalog: read" on public.catalog_items
  for select to authenticated using (true);
create policy "catalog: admin write" on public.catalog_items
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- orders
create policy "orders: read own or admin" on public.orders
  for select to authenticated using (requested_by = auth.uid() or public.is_admin());
create policy "orders: create own" on public.orders
  for insert to authenticated with check (requested_by = auth.uid() and status = 'Pending');
create policy "orders: requester can cancel pending" on public.orders
  for update to authenticated
  using (requested_by = auth.uid() and status = 'Pending')
  with check (requested_by = auth.uid() and status in ('Pending', 'Cancelled'));
create policy "orders: admin update" on public.orders
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "orders: admin delete" on public.orders
  for delete to authenticated using (public.is_admin());

-- order items
create policy "items: read if order visible" on public.order_items
  for select to authenticated using (
    exists (select 1 from public.orders o
            where o.id = order_id and (o.requested_by = auth.uid() or public.is_admin())));
create policy "items: add to own pending order" on public.order_items
  for insert to authenticated with check (
    exists (select 1 from public.orders o
            where o.id = order_id and o.requested_by = auth.uid() and o.status = 'Pending'));
create policy "items: admin manage" on public.order_items
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- push subscriptions: each user manages their own devices
create policy "push: own" on public.push_subscriptions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Live updates for the admin dashboard
alter publication supabase_realtime add table public.orders;

-- =====================================================================
--  SAMPLE DATA — edit or delete from the app's Admin screens later
-- =====================================================================
insert into public.jobsites (job_number, name, address) values
  ('24-101', 'Sample Jobsite — Main St Renovation', '123 Main St');

insert into public.catalog_items (name, category, unit) values
  ('2x4x8 SPF Stud',                 'Material',  'ea'),
  ('1/2" Drywall 4x8',               'Material',  'sheet'),
  ('5/8" Type X Drywall 4x12',       'Material',  'sheet'),
  ('Concrete Mix 80 lb',             'Material',  'bag'),
  ('#4 Rebar 20 ft',                 'Material',  'ea'),
  ('Drywall Screws 1-5/8" (5 lb)',   'Material',  'box'),
  ('Scissor Lift 19 ft',             'Equipment', 'day'),
  ('Mini Excavator',                 'Equipment', 'day'),
  ('Dumpster 20 yd',                 'Equipment', 'ea'),
  ('Portable Generator',             'Equipment', 'day');
