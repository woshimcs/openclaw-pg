import fs from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import type { Pool } from "pg";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { registerInternalHook } from "../hooks/internal-hooks.js";
import { formatUnifiedDiff } from "./diff.js";
import {
  createPool,
  ensureSchemaAndTables,
  insertAuditEvents,
  insertMemoryPatch,
  newEventId,
  resolvePgSettings,
  sha256,
  type AuditEventRow,
  type PgAuditSettings,
} from "./pg.js";
import { isPlainObject } from "../utils.js";

const log = createSubsystemLogger("audit");

type MemoryFileState = { hash: string; text: string };

type AuditRuntime = {
  pool: Pool;
  settings: PgAuditSettings;
  teamId: string | null;
  instanceId: string | null;
  queue: AuditEventRow[];
  flushTimer: NodeJS.Timeout;
  flushing: boolean;
  memoryEnabled: boolean;
  memoryIncludeGlobs: string[];
  memoryIgnoreGlobs: string[];
  memoryWatchers: Map<string, chokidar.FSWatcher>;
  memoryFileState: Map<string, MemoryFileState>;
  agentEventStreams: Set<string>;
  agentEventsUnsub: (() => void) | null;
};

const _g = globalThis as typeof globalThis & {
  __openclaw_audit_runtime__?: AuditRuntime;
};

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => Boolean(v));
}

function resolveMemoryGlobs(params: { workspaceDir: string; cfg: OpenClawConfig }) {
  const include = coerceStringArray(params.cfg.audit?.memory?.includeGlobs);
  const ignore = coerceStringArray(params.cfg.audit?.memory?.ignoreGlobs);

  const defaultsInclude = [
    path.join(params.workspaceDir, "MEMORY.md"),
    path.join(params.workspaceDir, "memory.md"),
    path.join(params.workspaceDir, "memory", "**", "*.md"),
  ];
  const defaultsIgnore = [
    path.join(params.workspaceDir, "**", "node_modules", "**"),
    path.join(params.workspaceDir, "**", ".git", "**"),
  ];

  return {
    include: include.length ? include : defaultsInclude,
    ignore: ignore.length ? ignore : defaultsIgnore,
  };
}

function normalizeGlobsForWorkspace(globs: string[], workspaceDir: string): string[] {
  return globs.map((glob) => {
    if (!glob) {
      return glob;
    }
    if (path.isAbsolute(glob)) {
      return glob;
    }
    return path.join(workspaceDir, glob);
  });
}

function stringifyPayload(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) {
    return value;
  }
  return { value };
}

async function flushQueue(rt: AuditRuntime) {
  if (rt.flushing) {
    return;
  }
  rt.flushing = true;
  try {
    while (rt.queue.length > 0) {
      const batch = rt.queue.splice(0, rt.settings.maxBatchSize);
      try {
        await insertAuditEvents(rt.pool, rt.settings, batch);
      } catch (err) {
        rt.queue.unshift(...batch);
        log.warn(`pg insert failed (events): ${String(err)}`);
        return;
      }
    }
  } finally {
    rt.flushing = false;
  }
}

function enqueue(rt: AuditRuntime, row: Omit<AuditEventRow, "id">) {
  rt.queue.push({
    ...row,
    id: newEventId(),
  });
  if (rt.queue.length >= rt.settings.maxBatchSize) {
    void flushQueue(rt);
  }
}

async function handleMemoryFileChange(params: {
  rt: AuditRuntime;
  filePath: string;
  agentId: string | null;
  workspaceDir: string;
}) {
  let afterText: string;
  try {
    afterText = await fs.readFile(params.filePath, "utf8");
  } catch {
    return;
  }

  const key = `${params.agentId ?? "unknown"}:${params.filePath}`;
  const prior = params.rt.memoryFileState.get(key);
  const beforeText = prior?.text ?? "";
  const beforeHash = prior?.hash ?? sha256(beforeText);
  const afterHash = sha256(afterText);
  if (beforeHash === afterHash) {
    return;
  }

  const patch = formatUnifiedDiff({
    path: path.relative(params.workspaceDir, params.filePath) || params.filePath,
    beforeText,
    afterText,
  });

  try {
    await insertMemoryPatch(params.rt.pool, params.rt.settings, {
      ts: new Date(),
      teamId: params.rt.teamId,
      instanceId: params.rt.instanceId,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      path: path.relative(params.workspaceDir, params.filePath) || params.filePath,
      beforeHash,
      afterHash,
      patch,
    });
    params.rt.memoryFileState.set(key, { hash: afterHash, text: afterText });
  } catch (err) {
    log.warn(`pg insert failed (memory): ${String(err)}`);
  }
}

function ensureMemoryWatcher(params: { rt: AuditRuntime; workspaceDir: string; agentId: string | null }) {
  const key = `${params.agentId ?? "unknown"}:${params.workspaceDir}`;
  if (params.rt.memoryWatchers.has(key)) {
    return;
  }

  const include = normalizeGlobsForWorkspace(
    params.rt.memoryIncludeGlobs.length
      ? params.rt.memoryIncludeGlobs
      : [
          path.join(params.workspaceDir, "MEMORY.md"),
          path.join(params.workspaceDir, "memory.md"),
          path.join(params.workspaceDir, "memory", "**", "*.md"),
        ],
    params.workspaceDir,
  );
  const ignore = normalizeGlobsForWorkspace(
    params.rt.memoryIgnoreGlobs.length
      ? params.rt.memoryIgnoreGlobs
      : [
          path.join(params.workspaceDir, "**", "node_modules", "**"),
          path.join(params.workspaceDir, "**", ".git", "**"),
        ],
    params.workspaceDir,
  );

  const watcher = chokidar.watch(include, {
    ignoreInitial: false,
    ignored: ignore,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
  });
  const onChange = (filePath: string) =>
    void handleMemoryFileChange({
      rt: params.rt,
      filePath,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
    });
  watcher.on("add", onChange);
  watcher.on("change", onChange);
  watcher.on("error", (err) => log.warn(`memory watcher error: ${String(err)}`));

  params.rt.memoryWatchers.set(key, watcher);
}

function registerHookIngest(rt: AuditRuntime) {
  const keys = ["message", "command", "agent", "gateway", "session"];
  for (const key of keys) {
    registerInternalHook(key, (event) => {
      enqueue(rt, {
        ts: event.timestamp,
        teamId: rt.teamId,
        instanceId: rt.instanceId,
        sessionKey: event.sessionKey,
        kind: `hook:${event.type}`,
        action: event.action,
        payload: {
          sessionKey: event.sessionKey,
          type: event.type,
          action: event.action,
          context: stringifyPayload(event.context),
        },
      });

      if (rt.memoryEnabled && event.type === "agent" && event.action === "bootstrap") {
        const ctx = event.context;
        const workspaceDir = typeof ctx.workspaceDir === "string" ? ctx.workspaceDir : "";
        const agentId = typeof ctx.agentId === "string" ? ctx.agentId : null;
        if (workspaceDir) {
          ensureMemoryWatcher({ rt, workspaceDir, agentId });
        }
      }
    });
  }
}

function registerAgentEventIngest(rt: AuditRuntime) {
  if (rt.agentEventsUnsub) {
    return;
  }
  rt.agentEventsUnsub = onAgentEvent((evt) => {
    if (!rt.agentEventStreams.has(evt.stream)) {
      return;
    }
    enqueue(rt, {
      ts: new Date(evt.ts),
      teamId: rt.teamId,
      instanceId: rt.instanceId,
      sessionKey: evt.sessionKey ?? "",
      kind: "agent_event",
      action: evt.stream,
      payload: {
        runId: evt.runId,
        seq: evt.seq,
        stream: evt.stream,
        ts: evt.ts,
        sessionKey: evt.sessionKey,
        data: stringifyPayload(evt.data),
      },
    });
  });
}

export async function startAuditRuntime(params: {
  cfg: OpenClawConfig;
  defaultWorkspaceDir: string;
}): Promise<void> {
  if (_g.__openclaw_audit_runtime__) {
    return;
  }
  if (!params.cfg.audit?.enabled) {
    return;
  }

  const settings = resolvePgSettings(params.cfg.audit.pg);
  if (!settings) {
    log.warn("audit enabled but pg.connectionString missing");
    return;
  }

  const pool = createPool(settings);
  await ensureSchemaAndTables(pool, settings);

  const streams = new Set(
    coerceStringArray(params.cfg.audit.agentEvents?.streams).length
      ? coerceStringArray(params.cfg.audit.agentEvents?.streams)
      : ["tool", "assistant"],
  );

  const memoryEnabled = params.cfg.audit.memory?.enabled ?? false;
  const globs = resolveMemoryGlobs({ workspaceDir: params.defaultWorkspaceDir, cfg: params.cfg });
  const includeGlobs = coerceStringArray(params.cfg.audit.memory?.includeGlobs);
  const ignoreGlobs = coerceStringArray(params.cfg.audit.memory?.ignoreGlobs);

  const rt: AuditRuntime = {
    pool,
    settings,
    teamId: params.cfg.audit.teamId?.trim() || null,
    instanceId: params.cfg.audit.instanceId?.trim() || null,
    queue: [],
    flushing: false,
    flushTimer: setInterval(() => void flushQueue(rt), settings.flushIntervalMs),
    memoryEnabled,
    memoryIncludeGlobs: includeGlobs.length ? includeGlobs : globs.include,
    memoryIgnoreGlobs: ignoreGlobs.length ? ignoreGlobs : globs.ignore,
    memoryWatchers: new Map(),
    memoryFileState: new Map(),
    agentEventStreams: streams,
    agentEventsUnsub: null,
  };
  rt.flushTimer.unref?.();
  _g.__openclaw_audit_runtime__ = rt;

  registerHookIngest(rt);
  if (params.cfg.audit.agentEvents?.enabled ?? true) {
    registerAgentEventIngest(rt);
  }
  if (memoryEnabled) {
    ensureMemoryWatcher({ rt, workspaceDir: params.defaultWorkspaceDir, agentId: null });
  }

  log.info(
    `audit runtime started: pg schema=${settings.schema} eventsTable=${settings.eventsTable} memoryTable=${settings.memoryTable}`,
  );
}
