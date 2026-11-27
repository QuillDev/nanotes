import { readdirSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";

/**
 * The engines every server suite runs on. Postgres comes from NANOTES_TEST_POSTGRES_URL when set;
 * otherwise a throwaway server is started from the machine's Postgres install (GitHub's Ubuntu
 * runners ship one). CI must run both, so a missing Postgres only skips it locally.
 */
export type Engine = "sqlite" | "postgres";

const configuredUrl = process.env["NANOTES_TEST_POSTGRES_URL"] || null;

function postgresBinDir(): string | null {
  const onPath = Bun.which("initdb");
  if (onPath) return join(onPath, "..");
  const root = "/usr/lib/postgresql";
  try {
    const newest = Math.max(...readdirSync(root).map(Number).filter(Number.isFinite));
    return Number.isFinite(newest) ? join(root, String(newest), "bin") : null;
  } catch {
    return null;
  }
}

const binDir = configuredUrl ? null : postgresBinDir();

export function engines(): Engine[] {
  if (configuredUrl || binDir) return ["sqlite", "postgres"];
  if (process.env["CI"]) throw new Error("CI needs Postgres: set NANOTES_TEST_POSTGRES_URL or install PostgreSQL");
  console.warn("Postgres not found: running the server suites on SQLite only");
  return ["sqlite"];
}

interface Cluster {
  readonly adminUrl: string;
  stop(): void;
}

function waitUntilReady(bin: string, socketDir: string): void {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (Bun.spawnSync([join(bin, "pg_isready"), "-q", "-h", socketDir]).exitCode === 0) return;
    Bun.sleepSync(100);
  }
  throw new Error("Postgres did not start");
}

/** Starts a private Postgres listening only on a socket in a temp dir. */
async function startCluster(bin: string): Promise<Cluster> {
  const dir = await mkdtemp(join(tmpdir(), "nanotes-pg-"));
  const data = join(dir, "data");
  const init = Bun.spawnSync([join(bin, "initdb"), "-D", data, "-U", "postgres", "--auth=trust", "--no-sync"], { stderr: "pipe" });
  if (init.exitCode !== 0) throw new Error(`initdb failed: ${init.stderr.toString()}`);
  const server = Bun.spawn(
    [join(bin, "postgres"), "-D", data, "-k", dir, "-c", "listen_addresses=", "-c", "fsync=off", "-c", "full_page_writes=off"],
    { stdout: "ignore", stderr: "ignore" },
  );
  const adminUrl = `postgresql://postgres@localhost/postgres?host=${encodeURIComponent(dir)}`;
  const stop = () => {
    server.kill("SIGQUIT");
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    waitUntilReady(bin, dir);
  } catch (cause) {
    stop();
    throw cause;
  }
  return { adminUrl, stop };
}

let cluster: Promise<Cluster> | null = null;

function serverUrl(): Promise<string> {
  if (configuredUrl) return Promise.resolve(configuredUrl);
  if (!binDir) throw new Error("Postgres is not available");
  cluster ??= startCluster(binDir);
  return cluster.then((started) => started.adminUrl);
}

const created: string[] = [];

/** A database path or URL for `createApp`: a fresh in-memory SQLite or a fresh, empty Postgres database. */
export async function testDatabase(engine: Engine): Promise<string> {
  if (engine === "sqlite") return ":memory:";
  const admin = await serverUrl();
  const name = `nanotes_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const client = new Client(admin);
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
  created.push(name);
  const url = new URL(admin);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Drops the databases this file created and stops the private server; call from `afterAll`. */
export async function releaseTestDatabases(): Promise<void> {
  const drops = created.splice(0);
  if (configuredUrl && drops.length > 0) {
    const client = new Client(configuredUrl);
    await client.connect();
    try {
      await Promise.all(drops.map((name) => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)));
    } finally {
      await client.end();
    }
  }
  if (cluster) {
    const started = cluster;
    cluster = null;
    (await started).stop();
  }
}
