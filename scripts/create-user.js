import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const accountsPath = join(__dirname, "..", "Accounts", "users.json");
const iterations = 210000;

const username = process.argv[2];
if (!username) {
  console.error("Usage: npm run create-user -- <username> [--write] [--generate-password]");
  process.exit(1);
}

const shouldGeneratePassword = process.argv.includes("--generate-password");
let password = "";

if (shouldGeneratePassword) {
  password = randomBytes(18).toString("base64url");
} else {
  const rl = createInterface({ input, output });
  password = await rl.question("Password: ");
  rl.close();
}

if (!password) {
  console.error("Password cannot be empty.");
  process.exit(1);
}

const salt = randomBytes(16).toString("base64");
const passwordHash = pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("base64");
const nextUser = { username, salt, passwordHash, iterations };
const shouldWrite = process.argv.includes("--write");

if (shouldGeneratePassword) {
  console.log(`Generated password for ${username}: ${password}`);
  console.log("Save this password now. It cannot be recovered from users.json.");
}

if (!shouldWrite) {
  console.log(JSON.stringify({ users: [nextUser] }, null, 2));
  console.log("\nSet this JSON as CHAT_USERS_JSON on Render, or rerun with --write to update Accounts/users.json locally.");
  process.exit(0);
}

let accounts = { users: [] };
if (existsSync(accountsPath)) {
  accounts = JSON.parse(readFileSync(accountsPath, "utf8"));
}

accounts.users = Array.isArray(accounts.users) ? accounts.users : [];
accounts.users = accounts.users.filter((user) => user.username !== username);
accounts.users.push(nextUser);

mkdirSync(dirname(accountsPath), { recursive: true });
writeFileSync(accountsPath, `${JSON.stringify(accounts, null, 2)}\n`);
console.log(`Updated ${accountsPath}`);
