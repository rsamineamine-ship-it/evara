-- EVARA — schéma initial (PostgreSQL / Supabase). Montants en centimes (bigint) : jamais de flottants.
-- Isolation par entreprise via Row Level Security. À appliquer avec `supabase db push`.
create extension if not exists pgcrypto;

create table organizations (id uuid primary key default gen_random_uuid(), name text not null, currency char(3) not null default 'EUR', locale text not null default 'fr-FR', time_zone text not null default 'Europe/Paris', settings jsonb not null default '{}', plan text not null default 'discovery' check (plan in ('discovery','pro','business')), created_at timestamptz not null default now());
create table organization_members (org_id uuid not null references organizations on delete cascade, user_id uuid not null references auth.users on delete cascade, role text not null check (role in ('owner','admin','editor','viewer')), primary key (org_id, user_id));
create table profiles (id uuid primary key references auth.users on delete cascade, full_name text, created_at timestamptz not null default now());

create table customers (id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations on delete cascade, name text not null, company text, email text, phone text, address jsonb, company_id text, payment_terms jsonb not null default '{"kind":"net","days":30}', created_at timestamptz not null default now());
create table suppliers (like customers including all);
alter table suppliers add constraint suppliers_org_fk foreign key (org_id) references organizations on delete cascade;

create table document_counters (org_id uuid not null references organizations on delete cascade, kind text not null, year int not null, last_number int not null default 0, primary key (org_id, kind, year));
-- Numérotation sûre en concurrence : verrou de ligne, compteur qui ne recule jamais, consommé à l'émission uniquement.
create function next_document_number(p_org uuid, p_kind text, p_year int, p_prefix text) returns text language plpgsql security definer as $$
declare n int;
begin
  insert into document_counters(org_id, kind, year, last_number) values (p_org, p_kind, p_year, 1)
  on conflict (org_id, kind, year) do update set last_number = document_counters.last_number + 1 returning last_number into n;
  return p_prefix || '-' || p_year || '-' || lpad(n::text, 4, '0');
end $$;

create table quotes (id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations on delete cascade, customer_id uuid not null references customers, number text, status text not null default 'draft' check (status in ('draft','sent','viewed','accepted','declined','converted')), issue_date date not null, valid_until date not null, lines jsonb not null, discount_bp int not null default 0, total_ht bigint not null, total_vat bigint not null, total_ttc bigint not null, converted_invoice_id uuid, notes text, created_at timestamptz not null default now(), unique (org_id, number));
create table sales_invoices (id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations on delete cascade, customer_id uuid not null references customers, number text, status text not null default 'draft' check (status in ('draft','issued','sent','cancelled')), issue_date date not null, due_date date not null, lines jsonb not null, discount_bp int not null default 0, total_ht bigint not null, total_vat bigint not null, total_ttc bigint not null, quote_id uuid references quotes, replaces_invoice_id uuid references sales_invoices, notes text, created_at timestamptz not null default now(), unique (org_id, number), check (due_date >= issue_date));
create table credit_notes (id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations on delete cascade, invoice_id uuid not null references sales_invoices, number text not null, issue_date date not null, reason text not null, lines jsonb not null, total_ttc bigint not null, created_at timestamptz not null default now(), unique (org_id, number));
create table purchase_invoices (id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations on delete cascade, supplier_id uuid not null references suppliers, reference text not null, status text not null default 'to_review' check (status in ('to_review','approved','disputed')), issue_date date not null, due_date date not null, total_ht bigint not null, total_vat bigint not null, total_ttc bigint not null, attachment_id uuid, created_at timestamptz not null default now(), unique (org_id, supplier_id, reference));
create table financial_accounts (id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations on delete cascade, name text not null, currency char(3) not null default 'EUR', opening_balance bigint not null, opening_date date not null, opening_source text not null check (opening_source in ('user_entered','imported')));
create table transactions (id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations on delete cascade, account_id uuid not null references financial_accounts, date date not null, label text not null, amount bigint not null check (amount > 0), direction text not null check (direction in ('in','out')), category_id uuid, counterparty text, source text not null, external_ref text, import_id uuid, voided_at timestamptz, created_at timestamptz not null default now());
create table payments (id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations on delete cascade, document_type text not null check (document_type in ('sales_invoice','purchase_invoice')), document_id uuid not null, amount bigint not null check (amount > 0), date date not null, method text not null, transaction_id uuid references transactions, voided_at timestamptz, void_reason text, created_at timestamptz not null default now());
create table transaction_matches (id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations on delete cascade, transaction_id uuid not null references transactions, document_type text not null, document_id uuid not null, payment_id uuid references payments, amount bigint not null check (amount > 0), origin text not null, confirmed_by uuid not null, confirmed_at timestamptz not null default now(), voided_at timestamptz);
create table expenses (id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations on delete cascade, date date not null, label text not null, amount bigint not null check (amount > 0), vat bigint not null default 0, category_id uuid, supplier_id uuid references suppliers, purchase_invoice_id uuid references purchase_invoices, paid_transaction_id uuid references transactions, receipt_attachment_id uuid, created_at timestamptz not null default now());
create table recurring_items (id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations on delete cascade, label text not null, direction text not null, amount bigint not null, interval text not null, next_date date not null, confidence text not null check (confidence in ('confirmed','expected','uncertain')));
create table attachments (id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations on delete cascade, file_name text not null, mime_type text not null, size_bytes int not null check (size_bytes <= 10485760), storage_key text not null, created_at timestamptz not null default now());
create table automation_rules (id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations on delete cascade, key text not null, enabled boolean not null default true, unique (org_id, key));
create table automation_runs (id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations on delete cascade, rule_id uuid not null references automation_rules, idempotency_key text not null, status text not null, attempt int not null default 1, result text, error text, started_at timestamptz not null default now(), unique (org_id, idempotency_key, attempt));
create table notifications (id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations on delete cascade, kind text not null, title text not null, body text not null, read_at timestamptz, created_at timestamptz not null default now());
create table audit_logs (id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations on delete cascade, actor_id uuid, action text not null, entity_type text not null, entity_id uuid, details jsonb, at timestamptz not null default now());

create index on transactions (org_id, date); create index on payments (org_id, document_id); create index on sales_invoices (org_id, due_date); create index on purchase_invoices (org_id, due_date); create index on audit_logs (org_id, at desc);

-- Les documents émis ne sont jamais supprimés ni modifiés librement.
create function forbid_issued_change() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and old.status <> 'draft' then raise exception 'Un document émis ne peut pas être supprimé'; end if;
  if tg_op = 'UPDATE' and old.status <> 'draft' and (new.lines is distinct from old.lines or new.total_ttc <> old.total_ttc or new.number is distinct from old.number) then raise exception 'Un document émis est immuable : émettez un avoir'; end if;
  return coalesce(new, old);
end $$;
create trigger sales_invoices_immutable before update or delete on sales_invoices for each row execute function forbid_issued_change();

-- Row Level Security : un utilisateur ne voit que les entreprises dont il est membre ; lecture seule pour les « viewer ».
create function is_member(p_org uuid) returns boolean language sql stable security definer as $$ select exists (select 1 from organization_members where org_id = p_org and user_id = auth.uid()) $$;
create function can_write(p_org uuid) returns boolean language sql stable security definer as $$ select exists (select 1 from organization_members where org_id = p_org and user_id = auth.uid() and role in ('owner','admin','editor')) $$;
do $$
declare t text;
begin
  foreach t in array array['customers','suppliers','quotes','sales_invoices','credit_notes','purchase_invoices','financial_accounts','transactions','payments','transaction_matches','expenses','recurring_items','attachments','automation_rules','automation_runs','notifications','audit_logs','document_counters'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select using (is_member(org_id))', t || '_read', t);
    if t not in ('audit_logs') then execute format('create policy %I on %I for all using (can_write(org_id)) with check (can_write(org_id))', t || '_write', t); end if;
  end loop;
end $$;
alter table organizations enable row level security; create policy org_read on organizations for select using (is_member(id));
alter table organization_members enable row level security; create policy members_read on organization_members for select using (is_member(org_id));
alter table profiles enable row level security; create policy profile_own on profiles for all using (id = auth.uid()) with check (id = auth.uid());
