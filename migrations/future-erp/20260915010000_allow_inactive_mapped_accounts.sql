-- Mappings retain reporting identity; active controls eligibility for new native posting.
-- Replace v16 functions without rewriting immutable migration history or account data.
create or replace function "erp_financials"."validate_reporting_book_account_hierarchy"()
returns trigger
language plpgsql
as $reporting_book_account_hierarchy$
declare
  parent_classification text;
  parent_role text;
  parent_active boolean;
  cycle_found boolean;
  has_children boolean;
  has_mappings boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'reporting-book-accounts:' || new."tenant_id" || ':' || new."company_id" || ':' || new."book_id",
    0
  ));

  if tg_op = 'UPDATE' then
    if new."tenant_id" is distinct from old."tenant_id"
      or new."company_id" is distinct from old."company_id"
      or new."book_id" is distinct from old."book_id"
      or new."book_account_id" is distinct from old."book_account_id"
      or new."book_account_key" is distinct from old."book_account_key"
      or new."created_at" is distinct from old."created_at"
    then
      raise exception 'reporting-book account identity is immutable';
    end if;
    if new."version" <> old."version" and new."version" <> old."version" + 1 then
      raise exception 'reporting-book account version must remain stable for a replay or advance by exactly one';
    end if;
    if new."version" = old."version" and (
      new."account_number" is distinct from old."account_number"
      or new."name" is distinct from old."name"
      or new."classification" is distinct from old."classification"
      or new."account_type" is distinct from old."account_type"
      or new."account_subtype" is distinct from old."account_subtype"
      or new."account_role" is distinct from old."account_role"
      or new."parent_book_account_key" is distinct from old."parent_book_account_key"
      or new."currency_code" is distinct from old."currency_code"
      or new."active" is distinct from old."active"
      or new."updated_at" is distinct from old."updated_at"
      or new."last_operation_request_id" is distinct from old."last_operation_request_id"
      or new."last_operation_checksum" is distinct from old."last_operation_checksum"
    ) then
      raise exception 'reporting-book account mutation must advance its version';
    end if;
  end if;

  if new."parent_book_account_key" is not null then
    select parent."classification", parent."account_role", parent."active"
      into parent_classification, parent_role, parent_active
    from "erp_financials"."reporting_book_accounts" parent
    where parent."tenant_id" = new."tenant_id" and parent."company_id" = new."company_id"
      and parent."book_id" = new."book_id" and parent."book_account_key" = new."parent_book_account_key"
    for key share;
    if parent_classification is null or parent_classification <> new."classification" then
      raise exception 'reporting-book account parent must exist in the book and share its classification';
    end if;
    if parent_role <> 'header' or parent_active is not true then
      raise exception 'reporting-book account parent must be an active header account';
    end if;
    with recursive ancestors as (
      select account."book_account_key", account."parent_book_account_key"
      from "erp_financials"."reporting_book_accounts" account
      where account."tenant_id" = new."tenant_id" and account."company_id" = new."company_id"
        and account."book_id" = new."book_id" and account."book_account_key" = new."parent_book_account_key"
      union all
      select parent."book_account_key", parent."parent_book_account_key"
      from "erp_financials"."reporting_book_accounts" parent
      join ancestors child on child."parent_book_account_key" = parent."book_account_key"
      where parent."tenant_id" = new."tenant_id" and parent."company_id" = new."company_id"
        and parent."book_id" = new."book_id"
    )
    select exists (select 1 from ancestors where "book_account_key" = new."book_account_key") into cycle_found;
    if cycle_found then
      raise exception 'reporting-book account hierarchy cannot contain a cycle';
    end if;
  end if;

  select exists (
    select 1 from "erp_financials"."reporting_book_accounts" child
    where child."tenant_id" = new."tenant_id" and child."company_id" = new."company_id"
      and child."book_id" = new."book_id" and child."parent_book_account_key" = new."book_account_key"
  ) into has_children;
  select exists (
    select 1 from "erp_financials"."reporting_book_account_mappings" mapping
    where mapping."tenant_id" = new."tenant_id" and mapping."company_id" = new."company_id"
      and mapping."book_id" = new."book_id" and mapping."book_account_key" = new."book_account_key"
  ) into has_mappings;

  if has_children and (new."account_role" <> 'header' or new."active" is not true) then
    raise exception 'a reporting-book account with children must remain an active header account';
  end if;
  if has_mappings and new."account_role" <> 'posting' then
    raise exception 'a mapped reporting-book account must remain a posting account';
  end if;
  if tg_op = 'UPDATE' and (has_children or has_mappings)
    and new."account_type" is distinct from old."account_type" then
    raise exception 'reporting-book account type cannot change while children or mappings depend on it';
  end if;
  if has_children and exists (
    select 1 from "erp_financials"."reporting_book_accounts" child
    where child."tenant_id" = new."tenant_id" and child."company_id" = new."company_id"
      and child."book_id" = new."book_id" and child."parent_book_account_key" = new."book_account_key"
      and child."classification" <> new."classification"
  ) then
    raise exception 'reporting-book account and children must share a classification';
  end if;
  if has_mappings and exists (
    select 1
    from "erp_financials"."reporting_book_account_mappings" mapping
    join "erp_financials"."accounts" source_account
      on source_account."tenant_id" = mapping."tenant_id" and source_account."source_id" = mapping."source_id"
     and source_account."account_id" = mapping."account_id"
    where mapping."tenant_id" = new."tenant_id" and mapping."company_id" = new."company_id"
      and mapping."book_id" = new."book_id" and mapping."book_account_key" = new."book_account_key"
      and source_account."classification" <> new."classification"
  ) then
    raise exception 'reporting-book account classification must match every mapped source account';
  end if;
  return new;
end
$reporting_book_account_hierarchy$;

create or replace function "erp_financials"."validate_reporting_book_account_mapping"()
returns trigger
language plpgsql
as $reporting_book_account_mapping$
declare
  source_classification text;
  book_classification text;
  book_role text;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'reporting-book-accounts:' || new."tenant_id" || ':' || new."company_id" || ':' || new."book_id",
    0
  ));
  select account."classification" into source_classification
  from "erp_financials"."accounts" account
  where account."tenant_id" = new."tenant_id" and account."source_id" = new."source_id"
    and account."account_id" = new."account_id"
  for key share;
  select account."classification", account."account_role"
    into book_classification, book_role
  from "erp_financials"."reporting_book_accounts" account
  where account."tenant_id" = new."tenant_id" and account."company_id" = new."company_id"
    and account."book_id" = new."book_id" and account."book_account_key" = new."book_account_key"
  for key share;
  if source_classification is null or book_classification is null or source_classification <> book_classification then
    raise exception 'source and reporting-book account mappings must have equal classifications';
  end if;
  if book_role <> 'posting' then
    raise exception 'source accounts may only map to reporting-book posting accounts';
  end if;
  if tg_op = 'UPDATE' and (
    new."tenant_id" is distinct from old."tenant_id"
    or new."company_id" is distinct from old."company_id"
    or new."book_id" is distinct from old."book_id"
    or new."source_id" is distinct from old."source_id"
    or new."account_id" is distinct from old."account_id"
    or new."book_account_mapping_id" is distinct from old."book_account_mapping_id"
    or new."created_at" is distinct from old."created_at"
  ) then
    raise exception 'reporting-book source-account mapping identity is immutable';
  end if;
  return new;
end
$reporting_book_account_mapping$;
