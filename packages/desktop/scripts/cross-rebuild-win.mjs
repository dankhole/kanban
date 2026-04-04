/**
 * cross-rebuild-win.mjs — Download Windows prebuilt native modules for Electron.
 *
 * When cross-compiling the Windows build from macOS/Linux, @electron/rebuild
 * cannot compile node-pty via node-gyp (node-gyp doesn't support cross-compilation).
 *
 * Fortunately:
 *   - node-pty v1.2+ ships NAPI prebuilds for all platforms in its package
 *     (prebuilds/win32-x64/), so no rebuild is needed.
 *   - better-sqlite3 uses prebuild-install, which can download platform-specific
 *     prebuilt binaries on demand.
 *
 * This script uses prebuild-install to fetch the correct better-sqlite3 binary
 * for win32-x64 + Electron, so electron-builder can then package with
 * npmRebuild=false.
 */
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(__dirname, "..");

// Read the installed Electron version
const electronPkg = JSON.parse(
	(await import("node:fs")).readFileSync(
		join(desktopRoot, "node_modules", "electron", "package.json"),
		"utf8",
	),
);
const electronVersion = electronPkg.version;

console.log(`[cross-rebuild-win] Electron version: ${electronVersion}`);

// Download better-sqlite3 prebuilt for win32-x64 + Electron
const betterSqlite3Dir = join(desktopRoot, "node_modules", "better-sqlite3");
console.log("[cross-rebuild-win] Downloading better-sqlite3 prebuilt for win32-x64...");
execSync(
	`npx prebuild-install --platform win32 --arch x64 -r electron -t ${electronVersion}`,
	{ cwd: betterSqlite3Dir, stdio: "inherit" },
);
console.log("[cross-rebuild-win] Done — native modules ready for Windows packaging.");
