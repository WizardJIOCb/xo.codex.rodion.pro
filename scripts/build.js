const { cpSync, mkdirSync, rmSync, copyFileSync } = require("fs");
const { join } = require("path");

const root = join(__dirname, "..");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
copyFileSync(join(root, "server.js"), join(dist, "server.js"));
copyFileSync(join(root, "package.json"), join(dist, "package.json"));
cpSync(join(root, "public"), join(dist, "public"), { recursive: true });

console.log("Built dist.");
