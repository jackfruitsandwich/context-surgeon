import {
  closeSync,
  constants,
  copyFileSync,
  chmodSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type LegacyProxyProbe = Readonly<{
  port: number;
  state: "live-v1" | "wedged" | "no-listener" | "not-v1";
  detail?: string;
}>;

export type LegacyCandidate = Readonly<{
  legacyFingerprint: string;
  directive: Readonly<Record<string, unknown>>;
  createdAt: number | null;
  lastMatchedAt: number | null;
  provenance: "v1-directives-json";
  state: "legacy-unbound";
  bindable: false;
  unsafeToolCall: boolean;
}>;

export type MigrationResult = Readonly<{
  migrated: boolean;
  backupPath: string | null;
  candidatesPath: string | null;
  candidates: readonly LegacyCandidate[];
}>;

export type LegacyLivenessProbe = (port: number) => Promise<LegacyProxyProbe>;

export async function probeLegacyProxy(port: number, timeoutMs = 750): Promise<LegacyProxyProbe> {
  const http = await import("node:http");
  return new Promise((resolve) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/_control/ping",
      method: "GET",
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { version?: unknown; identity?: { version?: unknown } };
          const version = typeof value.version === "string"
            ? value.version
            : typeof value.identity?.version === "string" ? value.identity.version : "";
          if (res.statusCode === 200 && version && !version.startsWith("2.")) {
            resolve({ port, state: "live-v1", detail: `version ${version}` });
          } else if (res.statusCode === 401 || version.startsWith("2.")) {
            resolve({ port, state: "not-v1", detail: `HTTP ${res.statusCode ?? 0}` });
          } else {
            resolve({ port, state: "wedged", detail: "Control listener identity/version was not provable" });
          }
        } catch {
          resolve({ port, state: "wedged", detail: "Control listener returned invalid identity JSON" });
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ port, state: "wedged", detail: "Authenticated/versioned liveness timed out" });
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      resolve(
        error.code === "ECONNREFUSED" || error.code === "ENOENT"
          ? { port, state: "no-listener" }
          : { port, state: "wedged", detail: error.message }
      );
    });
    req.end();
  });
}

function readPortNumbers(portsDirectory: string): number[] {
  try {
    return readdirSync(portsDirectory)
      .filter((file) => file.endsWith(".json"))
      .flatMap((file) => {
        try {
          const value = JSON.parse(readFileSync(join(portsDirectory, file), "utf8")) as { port?: unknown };
          return typeof value.port === "number" ? [value.port] : [];
        } catch { return []; }
      });
  } catch { return []; }
}

export async function assertNoLiveOrWedgedV1(input: {
  portsDirectory: string;
  probe: LegacyLivenessProbe;
}): Promise<readonly LegacyProxyProbe[]> {
  const probes = await Promise.all(readPortNumbers(input.portsDirectory).map(input.probe));
  const blockers = probes.filter((probe) => probe.state === "live-v1" || probe.state === "wedged");
  if (blockers.length > 0) {
    throw new Error(
      `Legacy migration blocked by v1 ownership: ${blockers.map((probe) => `port ${probe.port} ${probe.state}`).join(", ")}`
    );
  }
  return probes;
}

function writeExclusive0600(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const dirFd = openSync(dirname(path), "r");
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

function legacyCandidates(value: unknown): LegacyCandidate[] {
  if (!value || typeof value !== "object") return [];
  const entries = (value as { entries?: unknown }).entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return [];
  return Object.entries(entries as Record<string, unknown>).flatMap(([fingerprint, raw]) => {
    if (!raw || typeof raw !== "object") return [];
    const entry = raw as Record<string, unknown>;
    const directive = entry.directive;
    if (!directive || typeof directive !== "object" || Array.isArray(directive)) return [];
    const rawDirective = directive as Record<string, unknown>;
    let safeDirective: Readonly<Record<string, unknown>>;
    if (rawDirective.type === "replace" && typeof rawDirective.content === "string") {
      safeDirective = Object.freeze({ type: "replace", content: rawDirective.content });
    } else if (rawDirective.type === "evict") {
      const mediaType = rawDirective.mediaType === "image" || rawDirective.mediaType === "document"
        ? rawDirective.mediaType
        : undefined;
      const occurrences = Array.isArray(rawDirective.occurrences)
        ? rawDirective.occurrences.filter((item): item is number => Number.isInteger(item) && (item as number) > 0)
        : undefined;
      safeDirective = Object.freeze({
        type: "evict",
        ...(mediaType ? { mediaType } : {}),
        ...(occurrences && occurrences.length > 0 ? { occurrences } : {}),
      });
    } else {
      return [];
    }
    const humanId = typeof entry.humanId === "string" ? entry.humanId : "";
    return [Object.freeze({
      legacyFingerprint: fingerprint,
      directive: safeDirective,
      createdAt: typeof entry.createdAt === "number" ? entry.createdAt : null,
      lastMatchedAt: typeof entry.lastMatchedAt === "number" ? entry.lastMatchedAt : null,
      provenance: "v1-directives-json" as const,
      state: "legacy-unbound" as const,
      bindable: false as const,
      unsafeToolCall: /^tool call\b/.test(humanId),
    })];
  });
}

/** Backs up but never mutates/deletes the v1 file, then imports inert evidence. */
export async function migrateLegacyDirectives(input: {
  legacyPath: string;
  portsDirectory: string;
  sessionDirectory: string;
  probe?: LegacyLivenessProbe;
  now?: Date;
}): Promise<MigrationResult> {
  await assertNoLiveOrWedgedV1({
    portsDirectory: input.portsDirectory,
    probe: input.probe ?? probeLegacyProxy,
  });
  if (!existsSync(input.legacyPath)) {
    return { migrated: false, backupPath: null, candidatesPath: null, candidates: [] };
  }
  const now = input.now ?? new Date();
  const suffix = now.toISOString().replace(/[:.]/g, "-");
  const backupPath = `${input.legacyPath}.backup.${suffix}.${randomUUID()}`;
  copyFileSync(input.legacyPath, backupPath, constants.COPYFILE_EXCL);
  chmodSync(backupPath, 0o600);
  const backupFd = openSync(backupPath, "r");
  try { fsyncSync(backupFd); } finally { closeSync(backupFd); }
  const candidates = legacyCandidates(JSON.parse(readFileSync(input.legacyPath, "utf8")));
  const candidatesPath = join(input.sessionDirectory, "legacy-unbound.json");
  writeExclusive0600(candidatesPath, {
    version: 1,
    importedAt: now.toISOString(),
    sourceBackup: basename(backupPath),
    candidates,
  });
  return Object.freeze({
    migrated: true,
    backupPath,
    candidatesPath,
    candidates: Object.freeze(candidates),
  });
}

export type DoctorFileReport = Readonly<{
  path: string;
  exists: boolean;
  mode: string | null;
  version: number | null;
  validJson: boolean | null;
}>;

export type DoctorReport = Readonly<{
  sessionId: string;
  state: DoctorFileReport;
  control: DoctorFileReport;
  quarantineFiles: readonly string[];
  legacyCandidateCount: number;
  legacyFileExists: boolean;
  ownership: "absent" | "present" | "invalid";
  ownershipLiveness?: "live" | "no-listener" | "wedged" | "wrong-identity" | "unknown";
  guaranteeInputs: Readonly<{
    controlRecordPresent: boolean;
    stateVersion4: boolean;
    restrictivePermissions: boolean;
  }>;
}>;

function inspectJson(path: string): DoctorFileReport {
  if (!existsSync(path)) return { path, exists: false, mode: null, version: null, validJson: null };
  let mode: string | null = null;
  let version: number | null = null;
  let validJson = false;
  try { mode = (statSync(path).mode & 0o777).toString(8).padStart(3, "0"); } catch {}
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    version = typeof value.version === "number" ? value.version : null;
    validJson = true;
  } catch {}
  return { path, exists: true, mode, version, validJson };
}

/** Purely read-only diagnosis: unlike store construction, this never quarantines. */
export function doctorSession(input: {
  sessionId: string;
  sessionDirectory: string;
  legacyPath: string;
}): DoctorReport {
  const state = inspectJson(join(input.sessionDirectory, "state.json"));
  const control = inspectJson(join(input.sessionDirectory, "control.json"));
  let files: string[] = [];
  try { files = readdirSync(input.sessionDirectory); } catch {}
  const quarantineFiles = files.filter((file) => file.includes(".quarantine.")).sort();
  let legacyCandidateCount = 0;
  try {
    const value = JSON.parse(readFileSync(join(input.sessionDirectory, "legacy-unbound.json"), "utf8")) as { candidates?: unknown };
    if (Array.isArray(value.candidates)) legacyCandidateCount = value.candidates.length;
  } catch {}
  let ownership: DoctorReport["ownership"] = "absent";
  const ownerPath = join(input.sessionDirectory, "owner.lock", "owner.json");
  if (existsSync(ownerPath)) {
    try {
      const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { nonce?: unknown; controlAddress?: unknown };
      ownership = typeof owner.nonce === "string" && typeof owner.controlAddress === "string" ? "present" : "invalid";
    } catch { ownership = "invalid"; }
  }
  const restrictivePermissions =
    (!state.exists || state.mode === "600") && (!control.exists || control.mode === "600");
  return Object.freeze({
    sessionId: input.sessionId,
    state,
    control,
    quarantineFiles: Object.freeze(quarantineFiles),
    legacyCandidateCount,
    legacyFileExists: existsSync(input.legacyPath),
    ownership,
    guaranteeInputs: Object.freeze({
      controlRecordPresent: control.exists && control.validJson === true,
      stateVersion4: state.version === 4 && state.validJson === true,
      restrictivePermissions,
    }),
  });
}

export async function doctorSessionWithLiveness(input: {
  sessionId: string;
  sessionDirectory: string;
  legacyPath: string;
  probeOwner: (owner: { nonce: string; controlAddress: string }) => Promise<{
    kind: "live" | "no-listener" | "timeout" | "wrong-response";
    sessionId?: string;
    nonce?: string;
  }>;
}): Promise<DoctorReport> {
  const base = doctorSession(input);
  const ownerPath = join(input.sessionDirectory, "owner.lock", "owner.json");
  if (base.ownership !== "present") {
    return Object.freeze({ ...base, ownershipLiveness: base.ownership === "absent" ? "no-listener" : "unknown" });
  }
  try {
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { nonce: string; controlAddress: string };
    const probe = await input.probeOwner(owner);
    const ownershipLiveness = probe.kind === "live"
      ? probe.sessionId === input.sessionId && probe.nonce === owner.nonce ? "live" : "wrong-identity"
      : probe.kind === "no-listener" ? "no-listener" : "wedged";
    return Object.freeze({ ...base, ownershipLiveness });
  } catch {
    return Object.freeze({ ...base, ownershipLiveness: "unknown" });
  }
}
