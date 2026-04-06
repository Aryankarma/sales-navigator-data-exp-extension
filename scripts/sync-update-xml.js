/**
 * Writes leadextractor-host/public/update.xml from chrome_extension/manifest.json version.
 * Edit UPDATE_CODEBASE below if your production URL changes.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const MANIFEST = path.join(ROOT, "chrome_extension", "manifest.json");
/** Full URL to extension.crx (no trailing slash on path) */
const UPDATE_CODEBASE =
  "https://leadextractor-host-production.up.railway.app/extension.crx";

const hostPublic = path.join(ROOT, "..", "leadextractor-host", "public", "update.xml");

function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const version = String(manifest.version || "0.0.1").trim();
  // Chrome extension id generation from a base64-encoded public key:
  // SHA256(derBytes) -> first 16 bytes -> 32 hex chars -> map each hex digit 0-15 to 'a'+value.
  const appid = (() => {
    const crypto = require("crypto");
    const der = Buffer.from(manifest.key, "base64");
    const sha = crypto.createHash("sha256").update(der).digest();
    const first16 = sha.subarray(0, 16).toString("hex"); // 32 hex chars
    let id = "";
    for (const ch of first16) {
      const v = parseInt(ch, 16);
      id += String.fromCharCode("a".charCodeAt(0) + v);
    }
    return id;
  })();

  const xml = `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${appid}'>
    <updatecheck 
      codebase='${UPDATE_CODEBASE}' 
      version='${version}' />
  </app>
</gupdate>
`;
  fs.mkdirSync(path.dirname(hostPublic), { recursive: true });
  fs.writeFileSync(hostPublic, xml.replace(/\n/g, "\r\n"), "utf8");
  console.log("Wrote", hostPublic, "version", version, "appid", appid);
}

main();
