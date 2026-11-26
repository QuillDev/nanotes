import { openDatabase } from "./database.ts";
import { Passkeys } from "./passkeys.ts";

const databasePath = process.env["NANOTES_DATABASE"];
const origin = process.env["NANOTES_ORIGIN"];

if (!databasePath || !origin) {
  console.error("NANOTES_DATABASE and NANOTES_ORIGIN are required");
  process.exit(1);
}

const database = openDatabase(databasePath);
try {
  const passkeys = new Passkeys(database, origin);
  const { url, expiresAt } = passkeys.createSetupLink(Date.now());
  console.log(url);
  console.error(`expires: ${new Date(expiresAt).toISOString()}`);
} finally {
  database.close();
}
