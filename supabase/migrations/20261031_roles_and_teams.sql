-- Roles & teams
--
-- Adds three roles (Admin, Account Manager, Team Leader), a dispatcher -> team
-- leader link, and the row-level-security rules that go with them. Existing
-- roles keep working exactly as before, with ONE deliberate change: dispatchers
-- can no longer edit the price lists (labor rates, parts catalog, CBRE rate
-- card) -- they can still read them. See section 8.
--
-- Safe by default: a role with no policy for a table sees nothing in it.

-- 1. The new roles -----------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role = any (array['super_admin','admin','account_manager','team_leader','dispatcher','data_entry']::text[]));

-- 2. Team link: which Team Leader a dispatcher reports to --------------------
alter table public.profiles
  add column if not exists team_leader_id uuid references public.profiles(id) on delete set null;
create index if not exists profiles_team_leader_id_idx on public.profiles (team_leader_id);

-- Keeps the link honest: only a dispatcher can be on a team, and only a Team
-- Leader account from the SAME entity can lead it (so nobody can be attached
-- to a leader in another entity, which would expose their profile there).
create or replace function public.validate_team_leader_link()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- Moving someone to another entity drops their old team.
  if tg_op = 'UPDATE' then
    if new.entity_id is distinct from old.entity_id
       and new.team_leader_id is not distinct from old.team_leader_id then
      new.team_leader_id := null;
    end if;
  end if;

  if new.team_leader_id is not null then
    if new.role <> 'dispatcher' then
      new.team_leader_id := null;
    elsif not exists (
      select 1 from public.profiles t
      where t.id = new.team_leader_id
        and t.role = 'team_leader'
        and t.entity_id = new.entity_id
    ) then
      raise exception 'The team leader must be a Team Leader account in the same entity.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_validate_team_leader on public.profiles;
create trigger trg_profiles_validate_team_leader
  before insert or update on public.profiles
  for each row execute function public.validate_team_leader_link();

-- If a Team Leader is demoted or moved to another entity, their team is emptied
-- instead of being left pointing at someone who no longer leads it.
create or replace function public.clear_team_when_leader_changes()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if old.role = 'team_leader'
     and (new.role <> 'team_leader' or new.entity_id is distinct from old.entity_id) then
    update public.profiles set team_leader_id = null where team_leader_id = new.id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_profiles_clear_team on public.profiles;
create trigger trg_profiles_clear_team
  after update of role, entity_id on public.profiles
  for each row execute function public.clear_team_when_leader_changes();

-- 3. profiles ----------------------------------------------------------------
-- Admin + Account Manager read everyone in their own entity (the KPI scorecards
-- need the dispatchers' scorecard inputs). A Team Leader reads only their own
-- team (plus their own row, via the existing "own profile select" rule).
create policy "admin and account manager read entity profiles" on public.profiles
  for select to authenticated
  using (
    public.current_role_name() = any (array['admin','account_manager'])
    and entity_id = public.current_entity_id()
  );

create policy "team leader read own team profiles" on public.profiles
  for select to authenticated
  using (
    public.current_role_name() = 'team_leader'
    and team_leader_id = auth.uid()
  );

-- An Admin manages Account Managers, Team Leaders and Dispatchers in their own
-- entity -- never another Admin or a Super Admin, never themselves, and can't
-- hand out a role above those three or move anyone to another entity.
-- (Creating logins goes through the admin-create-user function, not this table.)
create policy "admin update lower roles in own entity" on public.profiles
  for update to authenticated
  using (
    public.current_role_name() = 'admin'
    and entity_id = public.current_entity_id()
    and role = any (array['account_manager','team_leader','dispatcher'])
  )
  with check (
    public.current_role_name() = 'admin'
    and entity_id = public.current_entity_id()
    and role = any (array['account_manager','team_leader','dispatcher'])
  );

create policy "admin delete lower roles in own entity" on public.profiles
  for delete to authenticated
  using (
    public.current_role_name() = 'admin'
    and entity_id = public.current_entity_id()
    and role = any (array['account_manager','team_leader','dispatcher'])
  );

-- 4. work_orders -------------------------------------------------------------
-- Admin, Account Manager, Team Leader read the whole entity. Only Admin also
-- adds/edits; nobody but a Super Admin (or the old Data Entry role) deletes.
create policy "office roles read work orders" on public.work_orders
  for select to authenticated
  using (
    public.current_role_name() = any (array['admin','account_manager','team_leader'])
    and public.in_my_entity(entity_id)
  );

create policy "admin insert work orders" on public.work_orders
  for insert to authenticated
  with check (public.current_role_name() = 'admin' and public.in_my_entity(entity_id));

create policy "admin update work orders" on public.work_orders
  for update to authenticated
  using (public.current_role_name() = 'admin' and public.in_my_entity(entity_id))
  with check (public.current_role_name() = 'admin' and public.in_my_entity(entity_id));

-- 5. proposals (+ line items, photos, photo files) ---------------------------
-- Admin, Account Manager and Team Leader can view and edit proposals in their
-- entity (Team Leader Check saves proposals and photos). No delete -- that
-- stays with the Super Admin. Line items and photos are edited as part of a
-- proposal, so those two tables allow every action via the parent proposal.
create policy "proposal staff read proposals" on public.proposals
  for select to authenticated
  using (
    public.current_role_name() = any (array['admin','account_manager','team_leader'])
    and public.in_my_entity(entity_id)
  );

create policy "proposal staff insert proposals" on public.proposals
  for insert to authenticated
  with check (
    public.current_role_name() = any (array['admin','account_manager','team_leader'])
    and public.in_my_entity(entity_id)
  );

create policy "proposal staff update proposals" on public.proposals
  for update to authenticated
  using (
    public.current_role_name() = any (array['admin','account_manager','team_leader'])
    and public.in_my_entity(entity_id)
  )
  with check (
    public.current_role_name() = any (array['admin','account_manager','team_leader'])
    and public.in_my_entity(entity_id)
  );

create policy "proposal staff access line items via parent proposal" on public.proposal_line_items
  for all to authenticated
  using (exists (
    select 1 from public.proposals p
    where p.id = proposal_line_items.proposal_id
      and public.in_my_entity(p.entity_id)
      and public.current_role_name() = any (array['admin','account_manager','team_leader'])
  ))
  with check (exists (
    select 1 from public.proposals p
    where p.id = proposal_line_items.proposal_id
      and public.in_my_entity(p.entity_id)
      and public.current_role_name() = any (array['admin','account_manager','team_leader'])
  ));

create policy "proposal staff access photos via parent proposal" on public.proposal_photos
  for all to authenticated
  using (exists (
    select 1 from public.proposals p
    where p.id = proposal_photos.proposal_id
      and public.in_my_entity(p.entity_id)
      and public.current_role_name() = any (array['admin','account_manager','team_leader'])
  ))
  with check (exists (
    select 1 from public.proposals p
    where p.id = proposal_photos.proposal_id
      and public.in_my_entity(p.entity_id)
      and public.current_role_name() = any (array['admin','account_manager','team_leader'])
  ));

create policy "proposal staff access proposal photo files" on storage.objects
  for all to authenticated
  using (
    bucket_id = 'proposal-photos'
    and exists (
      select 1 from public.proposals p
      where p.id::text = (storage.foldername(objects.name))[1]
        and public.in_my_entity(p.entity_id)
        and public.current_role_name() = any (array['admin','account_manager','team_leader'])
    )
  )
  with check (
    bucket_id = 'proposal-photos'
    and exists (
      select 1 from public.proposals p
      where p.id::text = (storage.foldername(objects.name))[1]
        and public.in_my_entity(p.entity_id)
        and public.current_role_name() = any (array['admin','account_manager','team_leader'])
    )
  );

-- 6. quote_outcomes (AI Learning) --------------------------------------------
-- Everyone in an entity can already read and add outcomes; let the new office
-- roles correct them too, same as the existing roles can.
create policy "office roles update quote_outcomes" on public.quote_outcomes
  for update to authenticated
  using (
    public.current_role_name() = any (array['admin','account_manager','team_leader'])
    and public.in_my_entity(entity_id)
  );

-- 7. Reading price lists, clients, entities, AI Learning -- nothing to add:
-- the existing read rules already allow any signed-in user in the entity.

-- 8. Price lists: Admin can edit; dispatchers become read-only ---------------
-- (labor rates, parts catalog and CBRE rate card). Account Manager and Team
-- Leader were never given edit rights. Deleting stays Super Admin only.
drop policy if exists "authenticated can insert labor_rates" on public.labor_rates;
create policy "authenticated can insert labor_rates" on public.labor_rates
  for insert
  with check (public.current_role_name() = any (array['super_admin','data_entry','admin']) and public.in_my_entity(entity_id));
drop policy if exists "authenticated can update labor_rates" on public.labor_rates;
create policy "authenticated can update labor_rates" on public.labor_rates
  for update
  using (public.current_role_name() = any (array['super_admin','data_entry','admin']) and public.in_my_entity(entity_id));

drop policy if exists "authenticated can insert parts_price_list" on public.parts_price_list;
create policy "authenticated can insert parts_price_list" on public.parts_price_list
  for insert
  with check (public.current_role_name() = any (array['super_admin','data_entry','admin']) and public.in_my_entity(entity_id));
drop policy if exists "authenticated can update parts_price_list" on public.parts_price_list;
create policy "authenticated can update parts_price_list" on public.parts_price_list
  for update
  using (public.current_role_name() = any (array['super_admin','data_entry','admin']) and public.in_my_entity(entity_id));

drop policy if exists "authenticated can insert cbre_rate_card" on public.cbre_rate_card;
create policy "authenticated can insert cbre_rate_card" on public.cbre_rate_card
  for insert
  with check (public.current_role_name() = any (array['super_admin','data_entry','admin']) and public.in_my_entity(entity_id));
drop policy if exists "authenticated can update cbre_rate_card" on public.cbre_rate_card;
create policy "authenticated can update cbre_rate_card" on public.cbre_rate_card
  for update
  using (public.current_role_name() = any (array['super_admin','data_entry','admin']) and public.in_my_entity(entity_id));
