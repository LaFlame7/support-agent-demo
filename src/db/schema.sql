-- All workflow state lives here. No step keeps anything important in memory,
-- so any process can die at any point and another one picks up where it stopped.

create table if not exists tickets (
  id           integer generated always as identity primary key,
  channel      text not null,
  external_id  text not null,
  customer_ref text not null,
  subject      text not null,
  -- bumped on every new customer message; a draft is only valid for the version it was written for
  version      integer not null default 1,
  status       text not null default 'new'
               check (status in ('new', 'drafting', 'awaiting_approval', 'human_handling', 'replied')),
  -- drafting lease: an expired lease means the worker that held it died
  lease_until  timestamptz,
  attempts     integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (channel, external_id)
);

create table if not exists messages (
  id                  integer generated always as identity primary key,
  ticket_id           integer not null references tickets (id),
  external_message_id text not null,
  author              text not null check (author in ('customer', 'agent')),
  body                text not null,
  created_at          timestamptz not null default now(),
  -- webhooks are delivered at least once
  unique (ticket_id, external_message_id)
);

create table if not exists proposals (
  id             integer generated always as identity primary key,
  ticket_id      integer not null references tickets (id),
  ticket_version integer not null,
  status         text not null
                 check (status in ('pending_approval', 'approved', 'rejected', 'escalated', 'superseded')),
  category       text not null,
  draft_reply    text not null,
  final_reply    text,
  cited_kb_ids   jsonb not null default '[]',
  risk_flags     jsonb not null default '[]',
  model          text not null,
  prompt_version text not null,
  trace          jsonb not null default '{}',
  decided_by     text,
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz not null default now(),
  -- one draft per ticket version, however many times drafting is retried
  unique (ticket_id, ticket_version),
  -- a decision always has a named person behind it
  check (status not in ('approved', 'rejected')
         or (decided_by is not null and length(trim(decided_by)) > 0 and decided_at is not null)),
  check (status <> 'approved' or final_reply is not null)
);

create table if not exists outbox (
  id                  integer generated always as identity primary key,
  -- at most one outgoing reply per approved proposal
  proposal_id         integer not null unique references proposals (id),
  ticket_id           integer not null references tickets (id),
  idempotency_key     text not null unique,
  body                text not null,
  status              text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'dead')),
  -- doubles as a fencing token: only the holder of the latest attempt may record the result
  attempts            integer not null default 0,
  lease_until         timestamptz,
  next_attempt_at     timestamptz not null default now(),
  provider_message_id text,
  last_error          text,
  created_at          timestamptz not null default now(),
  sent_at             timestamptz
);

create index if not exists outbox_ready on outbox (status, next_attempt_at);
create index if not exists tickets_ready on tickets (status, updated_at);

create table if not exists audit_log (
  id        integer generated always as identity primary key,
  entity    text not null,
  entity_id integer not null,
  action    text not null,
  actor     text not null,
  details   jsonb not null default '{}',
  at        timestamptz not null default now()
);
