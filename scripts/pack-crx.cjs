/**
 * Pack chrome_extension/ as CRX3 using chrome_extension.pem (keeps extension id stable).
 */
const fs = require("fs");
const path = require("path");
const writeCRX3File = require("crx3");
const createConfiguration = require("crx3/lib/configuration");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "chrome_extension");
const PEM = path.join(ROOT, "chrome_extension.pem");
const OUT_HOST = path.join(ROOT, "..", "leadextractor-host", "public", "extension.crx");
const OUT_LOCAL = path.join(ROOT, "chrome_extension.crx");

if (!fs.existsSync(SRC)) {
  console.error("Missing:", SRC);
  process.exit(1);
}
if (!fs.existsSync(PEM)) {
  console.error("Missing private key:", PEM);
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT_HOST), { recursive: true });

const cfg = createConfiguration({
  srcPaths: [SRC],
  crxPath: OUT_HOST,
  keyPath: PEM,
});

writeCRX3File([SRC], cfg)
  .then(() => {
    fs.copyFileSync(OUT_HOST, OUT_LOCAL);
    console.log("CRX3 OK:");
    console.log(" ", OUT_HOST);
    console.log(" ", OUT_LOCAL);
    console.log('Run: npm run sync:update-xml  (or npm run release)');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
