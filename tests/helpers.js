// Shared test helpers.
// Loads browser-oriented plain <script> files into a VM sandbox and
// returns the named top-level declarations via a synthetic export appendix.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_DIR = path.join(__dirname, "..");

function readApp(relPath) {
  return fs.readFileSync(path.join(APP_DIR, relPath), "utf8");
}

// Load one or more scripts together in a fresh sandbox and capture named globals.
// Names must be declared (const/let/var/function) at top level of any loaded file.
function loadScripts(files, names) {
  const code =
    files.map(readApp).join("\n") +
    "\nglobalThis.__exports = { " + names.join(", ") + " };";
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.__exports;
}

module.exports = { readApp, loadScripts, APP_DIR };
