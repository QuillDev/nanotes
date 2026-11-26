import { createApp } from "./app.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

const env = (name: string): string | null => process.env[name] || null;

const app = createApp({
  databasePath: required("NANOTES_DATABASE"),
  passwordHash: env("NANOTES_PASSWORD_HASH"),
  mcpToken: env("NANOTES_MCP_TOKEN"),
  secureCookies: process.env["NANOTES_SECURE_COOKIES"] !== "false",
  origin: env("NANOTES_ORIGIN"),
});

const server = Bun.serve({
  hostname: env("NANOTES_HOST") ?? "127.0.0.1",
  port: Number(env("NANOTES_PORT") ?? 8098),
  fetch: app.fetch,
});

console.log(`nanotes sync server listening on ${server.url}`);
