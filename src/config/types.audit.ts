export type AuditPgConfig = {
  connectionString?: string;
  schema?: string;
  eventsTable?: string;
  memoryTable?: string;
  maxBatchSize?: number;
  flushIntervalMs?: number;
};

export type AuditMemoryConfig = {
  enabled?: boolean;
  includeGlobs?: string[];
  ignoreGlobs?: string[];
};

export type AuditAgentEventsConfig = {
  enabled?: boolean;
  streams?: string[];
};

export type AuditConfig = {
  enabled?: boolean;
  teamId?: string;
  instanceId?: string;
  pg?: AuditPgConfig;
  agentEvents?: AuditAgentEventsConfig;
  memory?: AuditMemoryConfig;
};

