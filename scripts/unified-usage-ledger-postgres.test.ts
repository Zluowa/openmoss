import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const migrationsDirectory = join(repositoryRoot, "supabase", "migrations");
const requiredCommands = ["initdb", "pg_ctl", "psql"] as const;
const TEST_REQUEST_DIGEST = `hmac-sha256:${"a".repeat(64)}`;
const RESTRICTED_PLAN_USER_ID = "10101010-1010-4010-8010-101010101010";

// These migrations mutate the CN MemFire phone realm only. A global Supabase
// fixture must not apply them: the reconcile migration intentionally refuses
// to run unless the immutable deployment binding is `cn`. The CN-specific
// migration path is exercised by regional-migration-postgres.test.ts.
const CN_ONLY_PHONE_REALM_MIGRATIONS = new Set([
  "20260815000000_auth_realm_phone_format.sql",
  "20260815010000_auth_realm_phone_reconcile.sql",
]);

function migrationsForGlobalFixture(migrationFiles: readonly string[]): readonly string[] {
  return migrationFiles.filter(
    (migrationFile) => !CN_ONLY_PHONE_REALM_MIGRATIONS.has(migrationFile),
  );
}

function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  return result.status === 0;
}

// This test applies the complete Supabase migration history to a disposable
// PostgreSQL cluster. Keep it opt-in so constrained developer machines and the
// ordinary focused suite never allocate a database implicitly.
const hasLocalPostgres =
  process.env.MOSS_RUN_USAGE_LEDGER_POSTGRES_INTEGRATION === "1" &&
  requiredCommands.every(commandAvailable);

function freeTcpPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a PostgreSQL test port"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

function run(command: string, args: readonly string[], input?: string) {
  return spawnSync(command, [...args], {
    encoding: "utf8",
    input,
    env: { ...process.env, PGTZ: "UTC" },
    maxBuffer: 8 * 1024 * 1024,
  });
}

function dollarQuotedJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized.includes("$moss_usage$")) {
    throw new Error("Unexpected test fixture delimiter");
  }
  return `$moss_usage$${serialized}$moss_usage$::jsonb`;
}

function globalGoogleAuthFixtureSql(userId: string, email: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(userId)) {
    throw new Error("Invalid fixture user id");
  }
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+$/u.test(email)) {
    throw new Error("Invalid fixture email");
  }
  return `
    insert into auth.users (
      id,
      email,
      email_confirmed_at,
      raw_user_meta_data,
      raw_app_meta_data
    ) values (
      '${userId}',
      '${email}',
      now(),
      '{}'::jsonb,
      jsonb_build_object('provider', 'google', 'providers', jsonb_build_array('google'))
    );
    insert into auth.identities (id, user_id, provider, identity_data)
    values (
      '${userId}',
      '${userId}',
      'google',
      jsonb_build_object('sub', '${userId}')
    );
  `;
}

describe.skipIf(!hasLocalPostgres)("unified usage ledger PostgreSQL runtime", () => {
  let temporaryDirectory = "";
  let dataDirectory = "";
  let postgresLogFile = "";
  let socketDirectory = "";
  let port = 0;

  function psqlResult(input: string) {
    return run(
      "psql",
      [
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-h",
        socketDirectory,
        "-p",
        String(port),
        "-d",
        "postgres",
        "-A",
        "-t",
        "-q",
      ],
      input,
    );
  }

  function sql(input: string): string {
    const result = psqlResult(input);
    if (result.status !== 0) {
      throw new Error(
        `PostgreSQL command failed (${result.status ?? "signal"}):\n${result.stderr}\n${result.stdout}`,
      );
    }
    return result.stdout.trim();
  }

  function asServiceRole(input: string): string {
    return sql(`set role service_role;\n${input}`);
  }

  function payloadDigest(payload: unknown): string {
    return sql(`select public.moss_usage_canonical_payload_digest(${dollarQuotedJson(payload)});`);
  }

  function event(input: {
    eventId: string;
    idempotencyKey: string;
    kind: string;
    operationId: string;
    payload: unknown;
    sequence?: string;
  }) {
    return {
      schemaVersion: 1,
      eventId: input.eventId,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      payloadDigest: payloadDigest(input.payload),
      occurredAt: "2026-08-13T01:02:03.000Z",
      observedAt: "2026-08-13T01:02:04.000Z",
      subject: {
        provider: "codex",
        providerInstanceId: "codex_moss",
        accountRef: "account-ref-runtime",
      },
      operation: { operationId: input.operationId },
      source: {
        namespace: "runtime-postgres-test",
        adapterVersion: "v1",
        sourceEventId: input.eventId,
        sequence: input.sequence ?? "1",
        authority: "gateway-measured",
      },
      redaction: "content-free-v1",
      payload: input.payload,
    };
  }

  function append(unifiedEvent: unknown): Record<string, unknown> {
    return JSON.parse(
      asServiceRole(
        `select public.moss_append_unified_usage_event(${dollarQuotedJson(unifiedEvent)});`,
      ),
    ) as Record<string, unknown>;
  }

  beforeAll(async () => {
    port = await freeTcpPort();
    temporaryDirectory = mkdtempSync(join(tmpdir(), "moss-unified-usage-postgres-"));
    dataDirectory = join(temporaryDirectory, "data");
    postgresLogFile = join(temporaryDirectory, "postgres.log");
    // PostgreSQL caps Unix socket paths at roughly 100 bytes on macOS. The
    // system temp directory can be much longer than /tmp after symlink
    // resolution, so keep the socket in its own short, private directory.
    socketDirectory = mkdtempSync("/tmp/moss-usage-pg-sock-");
    mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });

    const initialized = run("initdb", [
      "-D",
      dataDirectory,
      "-A",
      "trust",
      "--no-locale",
      "--encoding=UTF8",
    ]);
    if (initialized.status !== 0) {
      throw new Error(`initdb failed:\n${initialized.stderr}\n${initialized.stdout}`);
    }

    const started = run("pg_ctl", [
      "-D",
      dataDirectory,
      "-l",
      postgresLogFile,
      "-o",
      `-F -p ${port} -k ${socketDirectory} -c listen_addresses=''`,
      "-w",
      "start",
    ]);
    if (started.status !== 0) {
      throw new Error(`pg_ctl start failed:\n${started.stderr}\n${started.stdout}`);
    }

    sql(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid()
      returns uuid
      language sql
      stable
      set search_path = ''
      as $$ select null::uuid $$;
      create table auth.users (
        id uuid primary key,
        email text,
        email_confirmed_at timestamptz,
        phone text,
        phone_confirmed_at timestamptz,
        raw_user_meta_data jsonb not null default '{}'::jsonb,
        raw_app_meta_data jsonb not null default '{}'::jsonb
      );
      create table auth.identities (
        id uuid primary key,
        user_id uuid not null references auth.users(id) on delete cascade,
        provider text not null,
        identity_data jsonb not null default '{}'::jsonb
      );
    `);

    const migrationFiles = migrationsForGlobalFixture(
      readdirSync(migrationsDirectory)
        .filter((name) => name.endsWith(".sql"))
        .sort(),
    );
    for (const migrationFile of migrationFiles) {
      if (migrationFile === "20260813000000_unified_usage_ledger.sql") {
        sql(globalGoogleAuthFixtureSql(RESTRICTED_PLAN_USER_ID, "restricted-ledger@example.test"));
        sql(`
          update public.account_entitlements
          set plan_code = 'enterprise-restricted',
              status = 'active',
              model_allowlist = array['gpt-5.5']::text[]
          where user_id = '${RESTRICTED_PLAN_USER_ID}';
        `);
      }
      sql(readFileSync(join(migrationsDirectory, migrationFile), "utf8"));
      if (migrationFile === "20260726000000_realtime_voice_control_plane.sql") {
        expect(JSON.parse(sql("select public.moss_bind_cloud_region('global');"))).toMatchObject({
          bound: true,
          cloud_region: "global",
        });
      }
    }
  }, 120_000);

  afterAll(() => {
    if (dataDirectory && existsSync(dataDirectory)) {
      run("pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "stop"]);
    }
    if (temporaryDirectory && existsSync(temporaryDirectory)) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    if (socketDirectory && existsSync(socketDirectory)) {
      rmSync(socketDirectory, { recursive: true, force: true });
    }
  });

  it("crosses FORCE RLS only through server authority and appends exact replays once", () => {
    const payload = {
      meters: [
        { metric: "input_text_token", unit: "token", quantity: "12" },
        { metric: "output_text_token", unit: "token", quantity: "3" },
      ],
    };
    const first = event({
      eventId: "runtime-event-001",
      idempotencyKey: "runtime-request-001",
      kind: "usage.delta",
      operationId: "runtime-operation-001",
      payload,
    });

    expect(append(first)).toMatchObject({ status: "inserted", eventId: "runtime-event-001" });
    expect(append(first)).toMatchObject({ status: "idempotent", eventId: "runtime-event-001" });
    expect(sql("select count(*) from public.unified_usage_events;")).toBe("1");

    const authenticatedCall = psqlResult(
      `set role authenticated; select public.moss_append_unified_usage_event(${dollarQuotedJson(first)});`,
    );
    expect(authenticatedCall.status).not.toBe(0);
    expect(authenticatedCall.stderr).toMatch(/permission denied for function/u);

    const authenticatedCompletionHandoff = psqlResult(`
      set role authenticated;
      select public.moss_enqueue_model_completion(
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        'completed', 200, 1, 1, 1, null
      );
    `);
    expect(authenticatedCompletionHandoff.status).not.toBe(0);
    expect(authenticatedCompletionHandoff.stderr).toMatch(/permission denied for function/u);

    const directWrite = psqlResult(`
      set role authenticated;
      insert into public.unified_usage_settlement_outbox (
        outbox_key, event_id, legacy_source, legacy_source_ref, attempt, state
      ) values (
        'outbox-authenticated', 'runtime-event-001', 'usage_events',
        'legacy-event-001', 0, 'enqueued'
      );
    `);
    expect(directWrite.status).not.toBe(0);

    const rlsFlags = JSON.parse(
      sql(`
        select jsonb_agg(jsonb_build_object(
          'table', c.relname,
          'rls', c.relrowsecurity,
          'force', c.relforcerowsecurity
        ) order by c.relname)
        from pg_catalog.pg_class as c
        where c.relname like 'unified_usage_%'
          and c.relkind = 'r';
      `),
    ) as Array<{ table: string; rls: boolean; force: boolean }>;
    expect(rlsFlags).toHaveLength(5);
    expect(rlsFlags.every((row) => row.rls && row.force)).toBe(true);
  });

  it("does not expand an existing restricted or custom plan during catalog migration", () => {
    expect(
      sql(`
        select plan_code || '|' || to_jsonb(model_allowlist)::text || '|' ||
          to_jsonb(audio_transcription_model_allowlist)::text
        from public.account_entitlements
        where user_id = '${RESTRICTED_PLAN_USER_ID}';
      `),
    ).toBe('enterprise-restricted|["gpt-5.5"]|[]');
  });

  it("realigns a plan that is later promoted onto starter catalog policy", () => {
    sql(`
      update public.account_entitlements
      set plan_code = 'starter',
          model_allowlist = array['gpt-5.5']::text[],
          audio_transcription_model_allowlist = array[]::text[]
      where user_id = '${RESTRICTED_PLAN_USER_ID}';
    `);

    expect(
      sql(`
        select plan_code || '|' || to_jsonb(model_allowlist)::text || '|' ||
          to_jsonb(audio_transcription_model_allowlist)::text
        from public.account_entitlements
        where user_id = '${RESTRICTED_PLAN_USER_ID}';
      `),
    ).toBe(
      "starter|" +
        sql("select to_jsonb(public.moss_enabled_gateway_models())::text;") +
        "|" +
        sql("select to_jsonb(public.moss_enabled_audio_transcription_models())::text;"),
    );

    sql(`
      update public.account_entitlements
      set plan_code = 'enterprise-restricted'
      where user_id = '${RESTRICTED_PLAN_USER_ID}';
    `);
    expect(
      sql(`
        select plan_code || '|' || to_jsonb(model_allowlist)::text || '|' ||
          to_jsonb(audio_transcription_model_allowlist)::text
        from public.account_entitlements
        where user_id = '${RESTRICTED_PLAN_USER_ID}';
      `),
    ).toBe("enterprise-restricted|[]|[]");

    sql(`
      update public.account_entitlements
      set model_allowlist = array['gpt-5.5']::text[],
          status = 'paused'
      where user_id = '${RESTRICTED_PLAN_USER_ID}';
    `);
    expect(
      sql(`
        select status || '|' || to_jsonb(model_allowlist)::text || '|' ||
          to_jsonb(audio_transcription_model_allowlist)::text
        from public.account_entitlements
        where user_id = '${RESTRICTED_PLAN_USER_ID}';
      `),
    ).toBe('paused|["gpt-5.5"]|[]');
  });

  it("quarantines digest conflicts without retaining the conflicting payload", () => {
    const conflictingPayload = {
      meters: [{ metric: "request_count", unit: "count", quantity: "2" }],
    };
    const conflict = event({
      eventId: "runtime-event-conflict",
      idempotencyKey: "runtime-request-001",
      kind: "usage.delta",
      operationId: "runtime-operation-conflict",
      payload: conflictingPayload,
      sequence: "2",
    });
    expect(append(conflict)).toMatchObject({
      status: "idempotency_conflict",
      eventId: "runtime-event-001",
    });
    expect(
      sql(`
        select count(*)
        from public.unified_usage_idempotency_conflicts
        where incoming_event_id = 'runtime-event-conflict'
          and existing_digest <> incoming_digest;
      `),
    ).toBe("1");

    const conflictColumns = sql(`
      select string_agg(column_name, ',' order by ordinal_position)
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'unified_usage_idempotency_conflicts';
    `);
    expect(conflictColumns).not.toMatch(/payload|content|path|phone|credential/u);

    const contentBearing = {
      ...event({
        eventId: "runtime-content-event",
        idempotencyKey: "runtime-content-request",
        kind: "usage.delta",
        operationId: "runtime-content-operation",
        payload: { meters: [{ metric: "request_count", unit: "count", quantity: "1" }] },
      }),
      prompt: "content must not enter the ledger",
    };
    expect(append(contentBearing)).toMatchObject({ status: "content_disallowed" });
    expect(sql("select count(*) from public.unified_usage_events;")).toBe("1");
  });

  it("persists quota windows and server-only outbox rows as append-only facts", () => {
    const payload = {
      windows: [
        {
          window: {
            windowKey: "provider-secondary-window",
            sourceWindowId: "secondary-17",
            sourceRole: "secondary",
            cycleKind: "provider-defined",
            durationSeconds: 604800,
            resetsAt: "2026-08-20T00:00:00.000Z",
            startBasis: "provider",
            revision: "17",
            fieldMask: ["durationSeconds", "resetsAt", "revision"],
          },
          usedMeters: [{ metric: "request_count", unit: "count", quantity: "12" }],
          limitMeters: [{ metric: "request_count", unit: "count", quantity: "50" }],
          remainingMeters: [{ metric: "request_count", unit: "count", quantity: "38" }],
          usedPercent: 24,
        },
      ],
    };
    const quotaEvent = event({
      eventId: "runtime-quota-event",
      idempotencyKey: "runtime-quota-request",
      kind: "quota.snapshot",
      operationId: "runtime-quota-operation",
      payload,
      sequence: "3",
    });
    expect(append(quotaEvent)).toMatchObject({ status: "inserted" });
    const providerExecutionEvent = event({
      eventId: "runtime-provider-execution-event",
      idempotencyKey: "runtime-provider-execution-request",
      kind: "usage.delta",
      operationId: "runtime-provider-execution-operation",
      payload: {
        meters: [{ metric: "provider_execution_second", unit: "second", quantity: "23.75" }],
      },
      sequence: "4",
    });
    expect(append(providerExecutionEvent)).toMatchObject({ status: "inserted" });
    expect(
      sql(`
        select cycle_kind || '|' || start_basis || '|' || duration_seconds::text
        from public.unified_usage_quota_window_snapshots
        where event_id = 'runtime-quota-event';
      `),
    ).toBe("provider-defined|provider|604800");

    expect(
      asServiceRole(`
        insert into public.unified_usage_settlement_outbox (
          outbox_key, event_id, legacy_source, legacy_source_ref, attempt, state
        ) values (
          'outbox-runtime-001', 'runtime-event-001', 'usage_events',
          'legacy-event-001', 0, 'enqueued'
        ) returning state;
      `),
    ).toBe("enqueued");

    const attemptedMutation = psqlResult(`
      update public.unified_usage_settlement_outbox
      set state = 'delivered'
      where outbox_key = 'outbox-runtime-001';
    `);
    expect(attemptedMutation.status).not.toBe(0);
    expect(attemptedMutation.stderr).toMatch(/append-only/u);
  });

  it("authorizes only whisper audio and charges request quota with zero tokens", () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const audioRequestId = "22222222-2222-4222-8222-222222222222";
    sql(`
      ${globalGoogleAuthFixtureSql(userId, "runtime-ledger@example.test")}
      update public.account_quotas
      set token_limit = 0
      where user_id = '${userId}';
    `);

    const entitlement = JSON.parse(
      sql(`
        select jsonb_build_object(
          'models', model_allowlist,
          'audio', audio_transcription_model_allowlist
        )
        from public.account_entitlements
        where user_id = '${userId}';
      `),
    ) as { models: string[]; audio: string[] };
    const enabledModels = JSON.parse(
      sql("select to_jsonb(public.moss_enabled_gateway_models());"),
    ) as string[];
    expect(entitlement.models).toEqual(enabledModels);
    expect(entitlement.models).toEqual(
      expect.arrayContaining([
        "gpt-5.5",
        "gpt-5-pro",
        "gpt-5.6-luna",
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "claude-fable-5",
        "claude-haiku-4-5-20251001",
        "claude-haiku-4-5-20251001-thinking",
        "claude-opus-4-5-20251101",
        "claude-opus-4-5-20251101-thinking",
        "claude-opus-4-6-thinking",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-opus-5",
        "claude-sonnet-4-5-20250929",
        "claude-sonnet-4-5-20250929-thinking",
        "claude-sonnet-4-6-thinking",
        "claude-sonnet-5",
        "deepseek-v4-pro",
        "kimi-k3",
      ]),
    );
    for (const disabledModel of [
      "gpt-5-codex",
      "deepseek-v3.1",
      "deepseek-ocr",
      "whisper-1",
      "gpt-5.3",
      "deepseek-r1-250528",
      "deepseek-v3-0324",
    ]) {
      expect(entitlement.models).not.toContain(disabledModel);
    }
    expect(entitlement.audio).toEqual(["whisper-1"]);

    const reservation = JSON.parse(
      asServiceRole(`
        select public.moss_reserve_model_request(
          '${userId}',
          '${audioRequestId}',
          '/v1/audio/transcriptions',
          'whisper-1',
          987654321,
          '${audioRequestId}',
          'explicit',
          '${TEST_REQUEST_DIGEST}'
        );
      `),
    ) as Record<string, unknown>;
    expect(reservation.allowed).toBe(true);
    expect(
      sql(`
        select endpoint || '|' || model || '|' || reserved_tokens::text
        from public.usage_events
        where request_id = '${audioRequestId}';
      `),
    ).toBe("/v1/audio/transcriptions|whisper-1|0");

    const wrongAudioModel = JSON.parse(
      asServiceRole(`
        select public.moss_reserve_model_request(
          '${userId}',
          '33333333-3333-4333-8333-333333333333',
          '/v1/audio/transcriptions',
          'gpt-5.5',
          0,
          '33333333-3333-4333-8333-333333333333',
          'explicit',
          '${TEST_REQUEST_DIGEST}'
        );
      `),
    ) as Record<string, unknown>;
    const whisperOnText = JSON.parse(
      asServiceRole(`
        select public.moss_reserve_model_request(
          '${userId}',
          '44444444-4444-4444-8444-444444444444',
          '/v1/responses',
          'whisper-1',
          1,
          '44444444-4444-4444-8444-444444444444',
          'explicit',
          '${TEST_REQUEST_DIGEST}'
        );
      `),
    ) as Record<string, unknown>;
    expect(wrongAudioModel).toMatchObject({ allowed: false, reason: "model_not_allowed" });
    expect(whisperOnText).toMatchObject({ allowed: false, reason: "model_not_allowed" });

    const completion = JSON.parse(
      asServiceRole(`
        select public.moss_complete_model_request(
          '${userId}',
          '${audioRequestId}',
          'completed',
          200,
          123456789,
          987654321,
          25,
          null
        );
      `),
    ) as Record<string, unknown>;
    expect(completion).toMatchObject({ updated: true, already_completed: false });
    expect(
      sql(`
        select jsonb_build_object(
          'requests', quota.requests_used,
          'input', quota.input_tokens_used,
          'output', quota.output_tokens_used,
          'eventInput', event.input_tokens,
          'eventOutput', event.output_tokens
        )
        from public.account_quotas as quota
        join public.usage_events as event on event.quota_id = quota.id
        where event.request_id = '${audioRequestId}';
      `),
    ).toBe('{"input": 0, "output": 0, "requests": 1, "eventInput": 0, "eventOutput": 0}');
  });

  it("settles model completion exactly once and releases unknown stale outcomes at zero tokens", () => {
    const userId = "88888888-8888-4888-8888-888888888888";
    const completedRequestId = "55555555-5555-4555-8555-555555555555";
    const staleRequestId = "66666666-6666-4666-8666-666666666666";
    sql(globalGoogleAuthFixtureSql(userId, "runtime-ledger-completion@example.test"));

    const reservation = JSON.parse(
      asServiceRole(`
        select public.moss_reserve_model_request(
          '${userId}',
          '${completedRequestId}',
          '/v1/responses',
          'gpt-5.5',
          500,
          '${completedRequestId}',
          'explicit',
          '${TEST_REQUEST_DIGEST}'
        );
      `),
    ) as Record<string, unknown>;
    expect(reservation.allowed).toBe(true);

    const completionSql = `
      select public.moss_complete_model_request(
        '${userId}',
        '${completedRequestId}',
        'completed',
        200,
        17,
        9,
        25,
        null
      );
    `;
    expect(JSON.parse(asServiceRole(completionSql))).toMatchObject({
      updated: true,
      already_completed: false,
    });
    expect(JSON.parse(asServiceRole(completionSql))).toMatchObject({
      updated: true,
      already_completed: true,
    });
    expect(
      JSON.parse(asServiceRole(completionSql.replace("        17,", "        18,"))),
    ).toMatchObject({ updated: false, reason: "completion_conflict" });
    expect(
      sql(`
        select input_tokens_used::text || '|' || output_tokens_used::text
        from public.account_quotas
        where user_id = '${userId}';
      `),
    ).toBe("17|9");

    expect(
      JSON.parse(
        asServiceRole(`
          select public.moss_reserve_model_request(
            '${userId}',
            '${staleRequestId}',
            '/v1/responses',
            'gpt-5.5',
            700,
            '${staleRequestId}',
            'explicit',
            '${TEST_REQUEST_DIGEST}'
          );
        `),
      ),
    ).toMatchObject({ allowed: true });
    sql(`
      update public.usage_events
      set created_at = now() - interval '16 minutes'
      where request_id = '${staleRequestId}';
    `);

    expect(
      JSON.parse(
        asServiceRole(`
          select public.moss_reserve_model_request(
            '${userId}',
            '77777777-7777-4777-8777-777777777777',
            '/v1/responses',
            'gpt-5.5',
            1,
            '77777777-7777-4777-8777-777777777777',
            'explicit',
            '${TEST_REQUEST_DIGEST}'
          );
        `),
      ),
    ).toMatchObject({ allowed: true });
    expect(
      sql(`
        select status || '|' || input_tokens::text || '|' || reserved_tokens::text || '|' || error_code
        from public.usage_events
        where request_id = '${staleRequestId}';
      `),
    ).toBe("failed|0|0|completion_outcome_unknown");
    expect(
      sql(`
        select input_tokens_used::text || '|' || output_tokens_used::text
        from public.account_quotas
        where user_id = '${userId}';
      `),
    ).toBe("17|9");
  });

  it("requires authoritative usage and rechecks both reservation and quota at completion", () => {
    const userId = "30303030-3030-4030-8030-303030303030";
    const missingUsageRequestId = "31313131-3131-4131-8131-313131313131";
    const overReservationRequestId = "32323232-3232-4232-8232-323232323232";
    const overQuotaRequestId = "34343434-3434-4434-8434-343434343434";
    const completedRequestId = "35353535-3535-4535-8535-353535353535";

    sql(`
      ${globalGoogleAuthFixtureSql(userId, "completion-cap@example.test")}
      update public.account_quotas set token_limit = 100 where user_id = '${userId}';
    `);

    const reserve = (requestId: string, tokens: number) =>
      JSON.parse(
        asServiceRole(`
          select public.moss_reserve_model_request(
            '${userId}', '${requestId}', '/v1/responses', 'gpt-5.5', ${tokens},
            '${requestId}', 'explicit', '${TEST_REQUEST_DIGEST}'
          );
        `),
      ) as Record<string, unknown>;
    const complete = (
      requestId: string,
      status: "completed" | "failed",
      inputTokens: number,
      outputTokens: number,
    ) =>
      JSON.parse(
        asServiceRole(`
          select public.moss_complete_model_request(
            '${userId}', '${requestId}', '${status}', 200,
            ${inputTokens}, ${outputTokens}, 12, null
          );
        `),
      ) as Record<string, unknown>;

    expect(reserve(missingUsageRequestId, 40)).toMatchObject({ allowed: true });
    expect(complete(missingUsageRequestId, "completed", 0, 0)).toMatchObject({
      updated: false,
      reason: "authoritative_usage_required",
    });
    expect(complete(missingUsageRequestId, "failed", 99, 99)).toMatchObject({
      updated: true,
      already_completed: false,
    });
    expect(
      sql(`
        select input_tokens::text || '|' || output_tokens::text
        from public.usage_events where request_id = '${missingUsageRequestId}';
      `),
    ).toBe("0|0");
    expect(
      sql(`
        select event_kind || '|' || (payload ->> 'state')
        from public.unified_usage_events
        where request_id = '${missingUsageRequestId}';
      `),
    ).toBe("operation.lifecycle|failed");

    expect(reserve(overReservationRequestId, 40)).toMatchObject({ allowed: true });
    expect(complete(overReservationRequestId, "completed", 21, 20)).toMatchObject({
      updated: false,
      reason: "usage_exceeds_reservation",
    });
    expect(complete(overReservationRequestId, "failed", 0, 0)).toMatchObject({ updated: true });

    expect(reserve(overQuotaRequestId, 50)).toMatchObject({ allowed: true });
    sql(`update public.account_quotas set token_limit = 40 where user_id = '${userId}';`);
    expect(complete(overQuotaRequestId, "completed", 21, 20)).toMatchObject({
      updated: false,
      reason: "token_quota_exhausted",
    });
    expect(complete(overQuotaRequestId, "failed", 0, 0)).toMatchObject({ updated: true });

    sql(`update public.account_quotas set token_limit = 100 where user_id = '${userId}';`);
    expect(reserve(completedRequestId, 50)).toMatchObject({ allowed: true });
    expect(complete(completedRequestId, "completed", 17, 9)).toMatchObject({
      updated: true,
      already_completed: false,
    });
    expect(
      sql(`
        select input_tokens_used::text || '|' || output_tokens_used::text
        from public.account_quotas where user_id = '${userId}';
      `),
    ).toBe("17|9");
    expect(
      sql(`
        select event_kind || '|' || provider_instance_id || '|' || authority
        from public.unified_usage_events
        where request_id = '${completedRequestId}';
      `),
    ).toBe("billing.settlement|codex_moss|provider-reported");
  });

  it("atomically recovers paid operations without storing request content", () => {
    const userId = "12121212-1212-4212-8212-121212121212";
    const firstRequestId = "13131313-1313-4313-8313-131313131313";
    const replayRequestId = "14141414-1414-4414-8414-141414141414";
    const operationId = "15151515-1515-4515-8515-151515151515";
    const conflictingDigest = `hmac-sha256:${"b".repeat(64)}`;
    sql(globalGoogleAuthFixtureSql(userId, "operation-recovery@example.test"));

    const reserve = (requestId: string, digest: string, mode = "explicit") =>
      JSON.parse(
        asServiceRole(`
          select public.moss_reserve_model_request(
            '${userId}',
            '${requestId}',
            '/v1/responses',
            'gpt-5.5',
            128,
            '${operationId}',
            '${mode}',
            '${digest}'
          );
        `),
      ) as Record<string, unknown>;

    expect(reserve(firstRequestId, TEST_REQUEST_DIGEST)).toMatchObject({ allowed: true });
    expect(
      JSON.parse(
        asServiceRole(`
          select public.moss_complete_model_request(
            '${userId}', '${firstRequestId}', 'completed', 200, 11, 4, 20, null
          );
        `),
      ),
    ).toMatchObject({ updated: true, already_completed: false });

    expect(reserve(replayRequestId, TEST_REQUEST_DIGEST)).toMatchObject({
      allowed: false,
      reason: "operation_replay",
      replay: {
        status: "completed",
        request_id: firstRequestId,
        identity_mode: "explicit",
        input_tokens: 11,
        output_tokens: 4,
      },
    });
    expect(reserve(replayRequestId, conflictingDigest)).toMatchObject({
      allowed: false,
      reason: "idempotency_conflict",
    });
    expect(
      sql(`
        select requests_used::text || '|' || input_tokens_used::text || '|' || output_tokens_used::text
        from public.account_quotas
        where user_id = '${userId}';
      `),
    ).toBe("1|11|4");
    expect(
      sql(`
        select string_agg(column_name, ',' order by ordinal_position)
        from information_schema.columns
        where table_schema = 'public' and table_name = 'usage_events';
      `),
    ).not.toMatch(
      /prompt|response_body|response_content|raw_response|file_path|credential|api_key/iu,
    );
    expect(
      sql(`
        select row_to_json(event)::text
        from public.usage_events as event
        where event.request_id = '${firstRequestId}';
      `),
    ).not.toMatch(/user-prompt|private-model-response/iu);

    const pendingRequestId = "20202020-2020-4020-8020-202020202020";
    const pendingRetryRequestId = "21212121-2121-4121-8121-212121212121";
    const pendingOperationId = "22222222-2222-4222-8222-222222222222";
    expect(
      JSON.parse(
        asServiceRole(`
          select public.moss_reserve_model_request(
            '${userId}', '${pendingRequestId}', '/v1/responses', 'gpt-5.5', 64,
            '${pendingOperationId}', 'explicit', '${TEST_REQUEST_DIGEST}'
          );
        `),
      ),
    ).toMatchObject({ allowed: true });
    expect(
      JSON.parse(
        asServiceRole(`
          select public.moss_enqueue_model_completion(
            '${userId}', '${pendingRequestId}', 'completed', 200, 3, 2, 15, null
          );
        `),
      ),
    ).toMatchObject({ status: "enqueued", state: "enqueued" });
    expect(
      JSON.parse(
        asServiceRole(`
          select public.moss_reserve_model_request(
            '${userId}', '${pendingRetryRequestId}', '/v1/responses', 'gpt-5.5', 64,
            '${pendingOperationId}', 'explicit', '${TEST_REQUEST_DIGEST}'
          );
        `),
      ),
    ).toMatchObject({
      allowed: false,
      reason: "operation_replay",
      replay: { status: "completed", request_id: pendingRequestId },
    });
    expect(
      sql(`
        select requests_used::text || '|' || input_tokens_used::text || '|' || output_tokens_used::text
        from public.account_quotas
        where user_id = '${userId}';
      `),
    ).toBe("2|14|6");
  });

  it("keeps fingerprint replay suppression bounded and permits a new admission after expiry", () => {
    const userId = "16161616-1616-4616-8616-161616161616";
    const operationId = "17171717-1717-4717-8717-171717171717";
    const firstRequestId = "18181818-1818-4818-8818-181818181818";
    const secondRequestId = "19191919-1919-4919-8919-191919191919";
    sql(globalGoogleAuthFixtureSql(userId, "fingerprint-recovery@example.test"));
    const reserve = (requestId: string) =>
      JSON.parse(
        asServiceRole(`
          select public.moss_reserve_model_request(
            '${userId}', '${requestId}', '/v1/responses', 'gpt-5.5', 64,
            '${operationId}', 'request_fingerprint', '${TEST_REQUEST_DIGEST}'
          );
        `),
      ) as Record<string, unknown>;

    expect(reserve(firstRequestId)).toMatchObject({ allowed: true });
    expect(reserve(secondRequestId)).toMatchObject({
      allowed: false,
      reason: "operation_replay",
      replay: { status: "in_progress", identity_mode: "request_fingerprint" },
    });
    sql(`
      update public.usage_events
      set operation_expires_at = now() - interval '1 second'
      where request_id = '${firstRequestId}';
    `);
    expect(reserve(secondRequestId)).toMatchObject({ allowed: true });
    expect(
      sql(`
        select count(*)
        from public.usage_events
        where user_id = '${userId}' and operation_id = '${operationId}';
      `),
    ).toBe("2");
  });

  it("persists a content-free completion handoff and drains it exactly once", () => {
    const userId = "99999999-9999-4999-8999-999999999999";
    const firstRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ambiguousRequestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const deferredRequestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const nextRequestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    sql(globalGoogleAuthFixtureSql(userId, "runtime-ledger-outbox@example.test"));

    const reserve = (requestId: string) =>
      JSON.parse(
        asServiceRole(`
          select public.moss_reserve_model_request(
            '${userId}',
            '${requestId}',
            '/v1/responses',
            'gpt-5.5',
            500,
            '${requestId}',
            'explicit',
            '${TEST_REQUEST_DIGEST}'
          );
        `),
      ) as Record<string, unknown>;
    const enqueue = (
      requestId: string,
      inputTokens: number,
      outputTokens: number,
      latencyMs = 25,
    ) =>
      JSON.parse(
        asServiceRole(`
          select public.moss_enqueue_model_completion(
            '${userId}',
            '${requestId}',
            'completed',
            200,
            ${inputTokens},
            ${outputTokens},
            ${latencyMs},
            null
          );
        `),
      ) as Record<string, unknown>;
    const drain = () =>
      JSON.parse(
        asServiceRole(`
          select public.moss_process_model_completion_outbox('${userId}', 10);
        `),
      ) as Record<string, unknown>;
    const quotaUsage = () =>
      sql(`
        select input_tokens_used::text || '|' || output_tokens_used::text
        from public.account_quotas
        where user_id = '${userId}';
      `);

    expect(reserve(firstRequestId)).toMatchObject({ allowed: true });
    expect(enqueue(firstRequestId, 31, 7)).toMatchObject({
      status: "enqueued",
      state: "enqueued",
    });
    expect(quotaUsage()).toBe("0|0");
    expect(enqueue(firstRequestId, 31, 7)).toMatchObject({
      status: "idempotent",
      state: "enqueued",
    });
    expect(enqueue(firstRequestId, 32, 7)).toMatchObject({
      status: "idempotency_conflict",
    });
    expect(
      JSON.parse(
        asServiceRole(`
          select public.moss_enqueue_model_completion(
            '${userId}',
            '${firstRequestId}',
            'completed',
            200,
            31,
            7,
            25,
            'private-secret-must-not-persist'
          );
        `),
      ),
    ).toMatchObject({ status: "rejected", reasonCode: "model-completion-invalid" });
    expect(
      sql(`
        select count(*)
        from public.unified_usage_settlement_outbox
        where model_completion_request_id = '${firstRequestId}';
      `),
    ).toBe("1");

    const outboxColumns = sql(`
      select string_agg(column_name, ',' order by ordinal_position)
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'unified_usage_settlement_outbox';
    `);
    expect(outboxColumns).not.toMatch(
      /prompt|response_body|response_content|raw_response|file_path|phone_number|credential|api_key|model_name/iu,
    );
    const persistedRow = sql(`
      select row_to_json(outbox)::text
      from public.unified_usage_settlement_outbox as outbox
      where outbox.model_completion_request_id = '${firstRequestId}'
      order by outbox.attempt
      limit 1;
    `);
    expect(persistedRow).not.toContain("private-model-response");
    expect(persistedRow).not.toContain("gpt-5.5");
    expect(persistedRow).not.toContain("user-prompt");

    expect(drain()).toMatchObject({ processed: 1, delivered: 1, failed: 0 });
    expect(quotaUsage()).toBe("31|7");
    expect(drain()).toMatchObject({ processed: 0, delivered: 0, failed: 0 });
    expect(quotaUsage()).toBe("31|7");
    expect(enqueue(firstRequestId, 31, 7)).toMatchObject({
      status: "idempotent",
      state: "delivered",
    });
    expect(
      sql(`
        select string_agg(state, ',' order by attempt)
        from public.unified_usage_settlement_outbox
        where model_completion_request_id = '${firstRequestId}';
      `),
    ).toBe("enqueued,delivered");

    // A direct completion may commit even when its HTTP response is lost. The
    // subsequent durable handoff consumes idempotently and cannot double bill.
    expect(reserve(ambiguousRequestId)).toMatchObject({ allowed: true });
    expect(
      JSON.parse(
        asServiceRole(`
          select public.moss_complete_model_request(
            '${userId}',
            '${ambiguousRequestId}',
            'completed',
            200,
            4,
            1,
            20,
            null
          );
        `),
      ),
    ).toMatchObject({ updated: true, already_completed: false });
    expect(quotaUsage()).toBe("35|8");
    expect(enqueue(ambiguousRequestId, 5, 1, 20)).toMatchObject({
      status: "idempotency_conflict",
    });
    expect(
      sql(`
        select count(*)
        from public.unified_usage_settlement_outbox
        where model_completion_request_id = '${ambiguousRequestId}';
      `),
    ).toBe("0");
    expect(enqueue(ambiguousRequestId, 4, 1, 20)).toMatchObject({ status: "enqueued" });
    expect(drain()).toMatchObject({ processed: 1, delivered: 1, failed: 0 });
    expect(quotaUsage()).toBe("35|8");

    expect(reserve(deferredRequestId)).toMatchObject({ allowed: true });
    expect(enqueue(deferredRequestId, 5, 2)).toMatchObject({
      status: "enqueued",
      state: "enqueued",
    });
    expect(quotaUsage()).toBe("35|8");

    // Simulate the post-enqueue consumer being unavailable. The next request's
    // admission drain must settle the durable row before reserving new quota.
    expect(reserve(nextRequestId)).toMatchObject({ allowed: true });
    expect(quotaUsage()).toBe("40|10");
    expect(
      sql(`
        select state
        from public.unified_usage_settlement_outbox
        where model_completion_request_id = '${deferredRequestId}'
        order by attempt desc
        limit 1;
      `),
    ).toBe("delivered");
    expect(drain()).toMatchObject({ processed: 0, delivered: 0, failed: 0 });
    expect(quotaUsage()).toBe("40|10");
  });

  it("lets later gateway traffic from another account drain pending completion handoffs", () => {
    const firstUserId = "66666666-6666-4666-8666-666666666666";
    const secondUserId = "77777777-7777-4777-8777-777777777777";
    const firstRequestId = "88888888-8888-4888-8888-888888888888";
    const secondRequestId = "99999999-9999-4999-8999-999999999999";

    sql(globalGoogleAuthFixtureSql(firstUserId, "global-drain-first@example.test"));
    sql(globalGoogleAuthFixtureSql(secondUserId, "global-drain-second@example.test"));

    const reserve = (userId: string, requestId: string) =>
      JSON.parse(
        asServiceRole(`
          select public.moss_reserve_model_request(
            '${userId}',
            '${requestId}',
            '/v1/responses',
            'gpt-5.5',
            32,
            '${requestId}',
            'explicit',
            '${TEST_REQUEST_DIGEST}'
          );
        `),
      ) as Record<string, unknown>;

    const enqueue = (
      userId: string,
      requestId: string,
      inputTokens: number,
      outputTokens: number,
    ) =>
      JSON.parse(
        asServiceRole(`
          select public.moss_enqueue_model_completion(
            '${userId}',
            '${requestId}',
            'completed',
            200,
            ${inputTokens},
            ${outputTokens},
            25,
            null
          );
        `),
      ) as Record<string, unknown>;

    const quotaUsage = (userId: string) =>
      sql(`
        select input_tokens_used::text || '|' || output_tokens_used::text
        from public.account_quotas
        where user_id = '${userId}';
      `);

    expect(reserve(firstUserId, firstRequestId)).toMatchObject({ allowed: true });
    expect(enqueue(firstUserId, firstRequestId, 9, 4)).toMatchObject({
      status: "enqueued",
      state: "enqueued",
    });
    expect(quotaUsage(firstUserId)).toBe("0|0");

    expect(reserve(secondUserId, secondRequestId)).toMatchObject({ allowed: true });
    expect(quotaUsage(firstUserId)).toBe("9|4");
    expect(
      sql(`
        select state
        from public.unified_usage_settlement_outbox
        where model_completion_request_id = '${firstRequestId}'
        order by attempt desc
        limit 1;
      `),
    ).toBe("delivered");
  });

  it("exposes a fail-closed worker schedule contract and installs pg_cron only when available", () => {
    expect(
      sql(`
        select worker_key || '|' || schedule_expression || '|' || max_batch::text || '|' || activation_status
        from public.moss_usage_worker_schedule_contract;
      `),
    ).toBe("model-completion-outbox-drain|*/1 * * * *|50|external_activation_required");
    const serviceRoleInstaller = psqlResult(
      "set role service_role; select public.moss_install_usage_worker_schedule();",
    );
    expect(serviceRoleInstaller.status).not.toBe(0);
    expect(serviceRoleInstaller.stderr).toMatch(/permission denied for function/u);
    expect(JSON.parse(sql("select public.moss_install_usage_worker_schedule();"))).toMatchObject({
      installed: false,
      status: "external_activation_required",
      reason: "pg_cron_unavailable",
    });
    const authenticatedInstall = psqlResult(
      "set role authenticated; select public.moss_install_usage_worker_schedule();",
    );
    expect(authenticatedInstall.status).not.toBe(0);
    expect(authenticatedInstall.stderr).toMatch(/permission denied for function/u);

    sql(`
      create schema cron;
      create table cron.job (
        jobid bigint primary key,
        schedule text not null,
        command text not null,
        nodename text,
        nodeport integer,
        database name not null,
        username name not null,
        active boolean not null,
        jobname name
      );
      create table cron.captured_schedule (
        job_name text,
        schedule text,
        command text,
        job_owner name
      );
      create function cron.schedule(p_job_name text, p_schedule text, p_command text)
      returns bigint
      language plpgsql
      as $cron$
      begin
        insert into cron.job (
          jobid, schedule, command, database, username, active, jobname
        ) values (
          42, p_schedule, p_command, current_database(), current_user, true, p_job_name
        );
        insert into cron.captured_schedule (job_name, schedule, command, job_owner)
        values (p_job_name, p_schedule, p_command, current_user);
        return 42;
      end;
      $cron$;
    `);
    expect(JSON.parse(sql("select public.moss_install_usage_worker_schedule();"))).toMatchObject({
      installed: true,
      status: "installed",
      job_id: 42,
    });
    expect(
      sql("select not pg_catalog.has_schema_privilege('service_role', 'cron', 'USAGE');"),
    ).toBe("t");
    expect(
      sql(`
        select job_name || '|' || schedule || '|' || command || '|' || job_owner
        from cron.captured_schedule;
      `),
    ).toBe(
      `model-completion-outbox-drain|*/1 * * * *|select public.moss_run_scheduled_model_completion_drain();|${sql("select current_user")}`,
    );

    sql(`
      delete from cron.job;
      update public.moss_usage_worker_schedule_contract
      set activation_status = 'external_activation_required',
          pg_cron_job_id = null,
          activated_at = null;
      insert into cron.job (
        jobid, schedule, command, database, username, active, jobname
      ) values (
        43,
        '*/1 * * * *',
        'select public.moss_run_scheduled_model_completion_drain();',
        current_database(),
        'service_role',
        true,
        'model-completion-outbox-drain'
      );
    `);
    expect(JSON.parse(sql("select public.moss_install_usage_worker_schedule();"))).toMatchObject({
      installed: false,
      status: "external_activation_required",
      reason: "schedule_job_drift",
    });
    expect(sql("select count(*) from cron.job;")).toBe("1");

    const unauthorizedCronJob = psqlResult(
      "set role authenticated; select public.moss_run_scheduled_model_completion_drain();",
    );
    expect(unauthorizedCronJob.status).not.toBe(0);
    expect(unauthorizedCronJob.stderr).toMatch(/permission denied for function/u);
    expect(
      JSON.parse(asServiceRole("select public.moss_run_scheduled_model_completion_drain();")),
    ).toMatchObject({ processed: 0, delivered: 0, failed: 0 });
  });
});
