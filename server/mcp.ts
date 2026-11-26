import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { NotesStore } from "./notes.ts";
import type { Passkeys } from "./passkeys.ts";

function json(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function buildServer(notes: NotesStore, passkeys: Passkeys | null, clock: () => number): McpServer {
  const server = new McpServer(
    { name: "nanotes", version: "0.1.0" },
    {
      instructions:
        "nanotes is the user's synced Markdown scratchpad. Every edit, create, pin, or delete syncs automatically to all connected nanotes desktop apps. " +
        "The first line of a note is its title and determines its filename.",
    },
  );

  server.registerTool(
    "list_notes",
    {
      description: "List synced notes (pinned first, then most recently updated), with id, path, title, pinned state, revision, updatedAt (ms), and byte size.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    ({ limit }) => json({ rev: notes.currentRev(), notes: notes.list(undefined, limit ?? 200) }),
  );

  server.registerTool(
    "search_notes",
    {
      description: "Search synced notes by case-insensitive substring across title, filename, and Markdown body.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    ({ query, limit }) => json({ notes: notes.list(query, limit ?? 50) }),
  );

  server.registerTool(
    "read_note",
    {
      description: "Read a synced note's full Markdown content and metadata by its id or filename path (e.g. 'Shopping list.md').",
      inputSchema: {
        idOrPath: z.string().min(1),
      },
    },
    ({ idOrPath }) => {
      const note = notes.get(idOrPath);
      return json(note ?? { error: "note not found" });
    },
  );

  server.registerTool(
    "create_note",
    {
      description: "Create a new synced Markdown note. The first line becomes its title and filename (e.g. '# Meeting notes\\n\\n...').",
      inputSchema: {
        content: z.string(),
        path: z.string().optional(),
        pinned: z.boolean().optional(),
      },
    },
    (args) => json(notes.create(args, clock())),
  );

  server.registerTool(
    "update_note",
    {
      description: "Replace a note's Markdown content, rename its filename, or pin/unpin it. Look up by id or current filename path.",
      inputSchema: {
        idOrPath: z.string().min(1),
        content: z.string().optional(),
        path: z.string().optional(),
        pinned: z.boolean().optional(),
      },
    },
    ({ idOrPath, ...changes }) => json(notes.update(idOrPath, changes, clock()) ?? { error: "note not found" }),
  );

  server.registerTool(
    "append_note",
    {
      description: "Append Markdown text to the end of an existing synced note without overwriting existing content.",
      inputSchema: {
        idOrPath: z.string().min(1),
        text: z.string().min(1),
      },
    },
    ({ idOrPath, text }) => json(notes.append(idOrPath, text, clock()) ?? { error: "note not found" }),
  );

  server.registerTool(
    "delete_note",
    {
      description: "Delete a synced note by id or filename path. Synced desktop clients will move their local copy to trash.",
      inputSchema: {
        idOrPath: z.string().min(1),
      },
    },
    ({ idOrPath }) => {
      const deleted = notes.remove(idOrPath, clock());
      return json(deleted ? { deleted: true, id: deleted.id, path: deleted.path, rev: deleted.rev } : { error: "note not found" });
    },
  );

  if (passkeys !== null) {
    server.registerTool(
      "passkey_setup_link",
      {
        description:
          "Mint a one-time link (valid 24 hours) that lets the user register a passkey for signing in to the nanotes sync server. Share only with the owner.",
      },
      () => {
        const { url, expiresAt } = passkeys.createSetupLink(clock());
        return json({ url, expiresAt });
      },
    );
  }

  return server;
}

/** Stateless Streamable HTTP MCP handler: one server and transport per request. */
export async function handleMcp(
  req: Request,
  notes: NotesStore,
  passkeys: Passkeys | null,
  clock: () => number,
): Promise<Response> {
  const server = buildServer(notes, passkeys, clock);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void server.close();
  }
}
