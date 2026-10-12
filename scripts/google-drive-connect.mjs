// One-time Google Drive connection (session 6). Mambe has no Google
// Workspace, so the app works in matt@mambeblankets.com's My Drive by signing
// in as that account, with the "drive.file" scope only (it sees nothing but
// what it creates).
//
// What it does:
//   1. opens Google's sign-in page in your browser
//   2. creates the two top folders in My Drive: "Fundraising (staging)" and "Fundraising"
//   3. prints the four values to paste into Render (never into chat)
//
// Run it in the VS Code terminal, giving the client file you downloaded:
//   node scripts/google-drive-connect.mjs C:\Users\MRW\Downloads\google-client.json
// Add --no-folders to get a new sign-in code without creating folders again.
import { exec } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const file = process.argv[2];
const makeFolders = !process.argv.includes("--no-folders");
if (!file) {
  console.error("Give the downloaded client file, e.g.  node scripts/google-drive-connect.mjs C:\\Users\\MRW\\Downloads\\google-client.json");
  process.exit(1);
}
let client;
try {
  const json = JSON.parse(readFileSync(file, "utf8"));
  client = json.installed ?? json.web;
  if (!client?.client_id || !client?.client_secret) throw new Error("no client_id");
} catch (error) {
  console.error(`Couldn't read ${file}: ${error.message}. It should be the JSON file from Google Cloud → Clients (Desktop app).`);
  process.exit(1);
}

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("hex");

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (!url.searchParams.has("code") && !url.searchParams.has("error")) {
      res.writeHead(404).end();
      return;
    }
    const ok = url.searchParams.get("state") === state && url.searchParams.get("code");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(ok ? "<h2>Done. Go back to the VS Code terminal.</h2>" : `<h2>Sign-in didn't complete: ${url.searchParams.get("error") ?? "unexpected reply"}</h2>`);
    server.close();
    ok ? resolve(url.searchParams.get("code")) : reject(new Error(url.searchParams.get("error") ?? "bad state"));
  });
  server.listen(0, "127.0.0.1", () => {
    const redirect = `http://127.0.0.1:${server.address().port}`;
    globalThis.redirectUri = redirect;
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirect,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    }).toString();
    console.log("\nOpening Google sign-in in your browser. Sign in as matt@mambeblankets.com.");
    console.log("If nothing opens, copy this address into the browser:\n");
    console.log(auth.toString() + "\n");
    if (process.platform === "win32") exec(`start "" "${auth.toString()}"`);
    else exec(`open "${auth.toString()}"`);
  });
});

const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: client.client_id,
    client_secret: client.client_secret,
    redirect_uri: globalThis.redirectUri,
    code_verifier: verifier,
  }),
});
const tokens = await tokenRes.json();
if (!tokenRes.ok || !tokens.refresh_token) {
  console.error("Google didn't return a sign-in code:", tokens.error_description ?? tokens.error ?? tokenRes.status);
  process.exit(1);
}
const auth = { authorization: `Bearer ${tokens.access_token}` };

const about = await (await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", { headers: auth })).json();
console.log(`Signed in as: ${about.user?.emailAddress ?? "(unknown)"}`);

async function folder(name) {
  const res = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Couldn't create "${name}": ${JSON.stringify(body).slice(0, 300)}`);
  return body.id;
}

const line = "-".repeat(72);
// Name on one line, value alone on the next, so a triple-click copies just the value.
function show(name, value) {
  console.log(`
  ${name}  (${value.length} characters)`);
  console.log(value);
}
console.log(`\n${line}\nPaste these into Render → Environment. Never into chat.\n${line}`);
console.log("\nBoth services (mambe-fundraisers-staging AND mambe-fundraisers):");
show("GOOGLE_OAUTH_CLIENT_ID", client.client_id);
show("GOOGLE_OAUTH_CLIENT_SECRET", client.client_secret);
show("GOOGLE_OAUTH_REFRESH_TOKEN", tokens.refresh_token);
if (makeFolders) {
  const staging = await folder("Fundraising (staging)");
  const production = await folder("Fundraising");
  console.log("\nmambe-fundraisers-staging only:");
  show("DRIVE_ROOT_FOLDER_ID", staging);
  console.log("\nmambe-fundraisers (production) only:");
  show("DRIVE_ROOT_FOLDER_ID", production);
  console.log('\nIn My Drive you now have "Fundraising (staging)" and "Fundraising". Renaming or moving them is fine;');
  console.log("deleting them is not (the app finds them by ID).");
} else {
  console.log("\n(--no-folders: keep the DRIVE_ROOT_FOLDER_ID values you already have.)");
}
console.log(`${line}\n`);
