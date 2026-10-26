#!/usr/bin/env bash
# Synthetic wide catalog to try navigation at scale: 12 schemas x 100 tables,
# 5-250 columns, foreign keys across schemas, some keyless tables and views,
# and three 1M-row tables. Deterministic thanks to setseed().
set -euo pipefail

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE catalogo"
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d catalogo <<'SQL'
SELECT setseed(0.42);

DO $$
DECLARE
  schemas text[] := array['sales','billing','inventory','logistics','auth','analytics','crm','hr','support','marketing','finance','catalog'];
  nouns text[] := array['account','order','invoice','payment','shipment','product','customer','supplier','ticket','campaign',
                        'employee','contract','refund','subscription','warehouse','carrier','lead','deal','budget','asset',
                        'claim','review','session','event','report','alert','task','note','document','price'];
  suffixes text[] := array['','_items','_events','_history','_daily','_snapshots','_links','_stats','_versions','_queue'];
  -- Attribute name and its SQL value expression (g is the row number).
  attrs text[][] := array[
    ['status', $e$(array['activo','pendiente','pagado','enviado','cancelado'])[1 + floor(random() * 5)::int]$e$],
    ['amount', $e$round((random() * 100000)::numeric, 2)$e$],
    ['currency', $e$(array['EUR','USD','GBP','JPY','MXN'])[1 + floor(random() * 5)::int]$e$],
    ['email', $e$'user' || g || '@example.com'$e$],
    ['phone', $e$'+34 6' || lpad((random() * 99999999)::int::text, 8, '0')$e$],
    ['name', $e$(array['Ada','Grace','Linus','Barbara','Edsger','Margaret','Ken'])[1 + floor(random() * 7)::int] || ' ' || (array['Madrid','Oslo','Kyoto','Lisboa','Quito'])[1 + floor(random() * 5)::int]$e$],
    ['title', $e$initcap(substr(md5(random()::text), 1, 10))$e$],
    ['description', $e$repeat(substr(md5(random()::text), 1, 8) || ' ', 1 + floor(random() * 12)::int)$e$],
    ['code', $e$upper(substr(md5(random()::text), 1, 6))$e$],
    ['slug', $e$'item-' || g$e$],
    ['priority', $e$floor(random() * 5)::int$e$],
    ['score', $e$round((random() * 100)::numeric, 1)$e$],
    ['weight_kg', $e$round((random() * 500)::numeric, 3)$e$],
    ['is_active', $e$random() < 0.7$e$],
    ['is_deleted', $e$random() < 0.05$e$],
    ['quantity', $e$floor(random() * 1000)::int$e$],
    ['external_ref', $e$gen_random_uuid()$e$],
    ['tags', $e$jsonb_build_object('plan', (array['free','pro','team'])[1 + floor(random() * 3)::int], 'seats', floor(random() * 50)::int)$e$],
    ['notes', $e$substr(md5(random()::text), 1, 20)$e$],
    ['due_on', $e$date '2020-01-01' + floor(random() * 2500)::int$e$],
    ['paid_at', $e$timestamptz '2020-01-01' + random() * interval '2500 days'$e$],
    ['opened_at', $e$timestamptz '2020-01-01' + random() * interval '2500 days'$e$],
    ['version', $e$floor(random() * 20)::int$e$],
    ['channel', $e$(array['web','app','tienda','teléfono'])[1 + floor(random() * 4)::int]$e$],
    ['country', $e$(array['ES','PT','FR','MX','JP','NO'])[1 + floor(random() * 6)::int]$e$],
    ['ip_address', $e$('10.' || floor(random() * 255)::int || '.' || floor(random() * 255)::int || '.1')::inet$e$],
    ['ratio', $e$random()$e$],
    ['user_agent', $e$(array['Mozilla/5.0','curl/8.4','okhttp/4.12'])[1 + floor(random() * 3)::int]$e$]
  ];
  attr_types text[] := array['text','numeric(12,2)','char(3)','text','text','text','text','text','text','text',
                             'smallint','numeric(5,1)','numeric(9,3)','boolean','boolean','integer','uuid','jsonb','text','date',
                             'timestamptz','timestamptz','integer','text','char(2)','inet','double precision','text'];
  created text[] := '{}';       -- qualified, quoted names
  created_nouns text[] := '{}'; -- unquoted base noun, for FK column names
  created_rows int[] := '{}';
  si int; ti int; k int; c int; f int;
  s text; t text; qualified text;
  ncols int; nrows int; nfks int; target int;
  coldefs text; colexprs text; colname text; expr text;
  keyless boolean;
BEGIN
  FOR si IN 1..array_length(schemas, 1) LOOP
    s := schemas[si];
    EXECUTE format('CREATE SCHEMA %I', s);
    FOR ti IN 1..100 LOOP
      k := (ti - 1) * 3 + si % 3;
      t := nouns[1 + k % 30] || suffixes[1 + k / 30];
      qualified := format('%I.%I', s, t);
      keyless := ti % 20 = 0;
      IF ti = 1 AND si IN (1, 4, 6) THEN
        ncols := 30; nrows := 1000000;
      ELSIF random() < 0.05 THEN
        ncols := 120 + floor(random() * 131)::int; nrows := floor(random() * 300)::int;
      ELSE
        ncols := 5 + floor(random() * 36)::int; nrows := floor(random() * 300)::int;
      END IF;

      coldefs := CASE WHEN keyless THEN 'id bigint NOT NULL' ELSE 'id bigint PRIMARY KEY' END;
      colexprs := 'g';

      -- Foreign keys to tables created earlier, possibly in another schema.
      nfks := CASE WHEN array_length(created, 1) IS NULL THEN 0 ELSE floor(random() * 4)::int END;
      FOR f IN 1..nfks LOOP
        target := 1 + floor(random() * array_length(created, 1))::int;
        IF created_rows[target] < 0 THEN CONTINUE; END IF; -- keyless target
        colname := created_nouns[target] || '_id';
        IF position(format('%I ', colname) IN coldefs) > 0 THEN colname := colname || '_' || f; END IF;
        coldefs := coldefs || format(', %I bigint REFERENCES %s', colname, created[target]);
        colexprs := colexprs || CASE WHEN created_rows[target] = 0 THEN ', NULL'
          ELSE format(', CASE WHEN random() < 0.1 THEN NULL ELSE 1 + floor(random() * %s)::bigint END', created_rows[target]) END;
      END LOOP;

      FOR c IN 1..ncols LOOP
        colname := attrs[1 + (c - 1) % 28][1] || CASE WHEN c > 28 THEN '_' || ((c - 1) / 28) ELSE '' END;
        expr := attrs[1 + (c - 1) % 28][2];
        coldefs := coldefs || format(', %I %s', colname, attr_types[1 + (c - 1) % 28])
          || CASE WHEN c % 3 = 0 THEN ' NOT NULL' ELSE '' END;
        colexprs := colexprs || CASE WHEN c % 3 = 0 THEN ', ' || expr
          ELSE format(', CASE WHEN random() < 0.1 THEN NULL ELSE %s END', expr) END;
      END LOOP;
      coldefs := coldefs || ', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz';
      colexprs := colexprs || $e$, timestamptz '2020-01-01' + random() * interval '2500 days', CASE WHEN random() < 0.5 THEN NULL ELSE now() END$e$;

      EXECUTE format('CREATE TABLE %s (%s)', qualified, coldefs);
      EXECUTE format('INSERT INTO %s SELECT %s FROM generate_series(1, %s) g', qualified, colexprs, nrows);
      created := created || qualified;
      created_nouns := created_nouns || nouns[1 + k % 30];
      created_rows := created_rows || CASE WHEN keyless THEN -1 ELSE nrows END;

      IF ti % 33 = 0 THEN
        EXECUTE format('CREATE VIEW %I.%I AS SELECT * FROM %s WHERE id %% 2 = 0', s, t || '_view', qualified);
      END IF;
    END LOOP;
  END LOOP;
END
$$;

ANALYZE;
SQL
