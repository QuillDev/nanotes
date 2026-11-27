import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DESKTOP_COMMANDS } from "../shared/ipc.ts";
import { createCommands } from "../desktop/src/commands.js";

const root = resolve(import.meta.dir, "..");
const unused = () => {
  throw new Error("not used here");
};
const progress = () => undefined;
const commands = createCommands({
  configDir: () => mkdtempSync(join(tmpdir(), "nanotes-ipc-config-")),
  trash: unused,
  openExternal: unused,
  openPath: unused,
  hideWindow: unused,
  appVersion: () => "1.2.3",
  relaunch: unused,
  setHotkey: unused,
  clearHotkey: unused,
  autostartEnabled: unused,
  setAutostart: unused,
  updater: unused,
});

describe("desktop IPC", () => {
  test("the main process handles exactly the commands shared/ipc.ts defines", () => {
    expect(new Set(Object.keys(commands))).toEqual(new Set(DESKTOP_COMMANDS));
  });

  test("notes save, rename and search through the command table", async () => {
    const notesDir = mkdtempSync(join(tmpdir(), "nanotes-ipc-notes-"));
    const first = await commands.write_note({ notesDir, notePath: "", content: "# Groceries\n\neggs" }, progress);
    const renamed = await commands.write_note({ notesDir, notePath: first!.path, content: "# Errands\n\neggs" }, progress);
    expect([first, renamed]).toEqual([
      { path: "Groceries.md", title: "Groceries" },
      { path: "Errands.md", title: "Errands" },
    ]);
    expect(await commands.read_note({ notesDir, notePath: "Errands.md" }, progress)).toBe("# Errands\n\neggs");
    const found = await commands.list_notes({ notesDir, query: "eggs" }, progress);
    expect(found!.map(note => note.path)).toEqual(["Errands.md"]);
  });

  test("the window keeps the page sandboxed and only its own top frame may call commands", () => {
    const main = readFileSync(resolve(root, "desktop/src/main.js"), "utf8");
    expect(main).toContain("contextIsolation: true");
    expect(main).toContain("sandbox: true");
    expect(main).toContain("nodeIntegration: false");
    expect(main).toContain("event.senderFrame !== mainWindow.webContents.mainFrame");
  });
});
