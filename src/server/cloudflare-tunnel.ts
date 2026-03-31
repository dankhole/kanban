// Cloudflare quick-tunnel support for Kanban remote access.
//
// startCloudflaredTunnel(port):
//   1. Detects whether cloudflared is installed.
//   2. If not, installs it automatically for the current platform.
//   3. Starts a quick (trycloudflare.com) tunnel pointing at `port`.
//   4. Resolves with the public tunnel URL string.
//   5. Throws on failure.
//
// stopCloudflaredTunnel():
//   Kills the running cloudflared process.
//
// getTunnelUrl():
//   Returns the current tunnel URL, or null if no tunnel is running.
//
// Ported from CARD's CloudflareManager, adapted for Kanban:
//   - No Electron IPC — pure Node.js.
//   - Quick tunnels only (no named tunnel support needed for the single-function API).
//   - Paths use ~/.cline/kanban/ instead of ~/.card/.
//   - Exported as plain functions, not a class, matching Kanban's module style.

import { exec, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ── Constants ──────────────────────────────────────────────────────────────

const KANBAN_DIR = join(homedir(), ".cline", "kanban");
const LOG_PATH = join(KANBAN_DIR, "cf.log");
const PID_PATH = join(KANBAN_DIR, "cf.pid");
const PS1_PATH = join(KANBAN_DIR, "launch-cf.ps1");

// Known platform-specific install locations when cloudflared is not on PATH.
const KNOWN_WIN_PATHS = [
	join("C:", "Program Files (x86)", "cloudflared", "cloudflared.exe"),
	join("C:", "Program Files", "cloudflared", "cloudflared.exe"),
	join(homedir(), "AppData", "Local", "cloudflared", "cloudflared.exe"),
	join(
		homedir(),
		"AppData",
		"Local",
		"Microsoft",
		"WinGet",
		"Packages",
		"Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe",
		"cloudflared.exe",
	),
];

const KNOWN_MAC_PATHS = [
	"/usr/local/bin/cloudflared", // Intel Homebrew / curl install
	"/opt/homebrew/bin/cloudflared", // Apple Silicon Homebrew
];

const KNOWN_LINUX_PATHS = ["/usr/local/bin/cloudflared", "/usr/bin/cloudflared", "/snap/bin/cloudflared"];

// ── Module state ───────────────────────────────────────────────────────────

let tunnelPid: number | null = null;
let tunnelUrl: string | null = null;

// ── Binary detection ───────────────────────────────────────────────────────

function findBin(): string | null {
	// 1. Try PATH first (works on all platforms when correctly installed).
	try {
		execSync("cloudflared --version", { encoding: "utf-8", timeout: 5000, stdio: "pipe" });
		return "cloudflared";
	} catch {
		// Not on PATH — fall through to known-path probing.
	}

	// 2. On Windows, also try PowerShell-resolved PATH (handles post-install PATH
	//    updates that haven't propagated to the current process environment yet).
	if (platform() === "win32") {
		try {
			const resolved = execSync(
				'powershell -NoProfile -NonInteractive -Command "(Get-Command cloudflared -ErrorAction SilentlyContinue).Source"',
				{ encoding: "utf-8", timeout: 8000, stdio: "pipe" },
			).trim();
			if (resolved && existsSync(resolved)) return resolved;
		} catch {
			// PowerShell not available or command failed.
		}
	}

	// 3. Check well-known platform-specific install locations.
	const knownPaths =
		platform() === "win32" ? KNOWN_WIN_PATHS : platform() === "darwin" ? KNOWN_MAC_PATHS : KNOWN_LINUX_PATHS;

	for (const p of knownPaths) {
		if (existsSync(p)) return p;
	}

	return null;
}

// Deep-scan the WinGet packages directory for cloudflared.exe.
// Used as a last resort after install when the binary isn't on PATH yet.
function findInWingetPackages(): string | null {
	const wingetBase = join(homedir(), "AppData", "Local", "Microsoft", "WinGet", "Packages");
	if (!existsSync(wingetBase)) return null;
	try {
		// execSync ls is fine here — it's a one-time post-install scan.
		const entries = readdirSync(wingetBase);
		for (const entry of entries) {
			if (!entry.toLowerCase().includes("cloudflare")) continue;
			const candidate = join(wingetBase, entry, "cloudflared.exe");
			if (existsSync(candidate)) return candidate;
			// Some WinGet packages nest in a version directory.
			try {
				const sub = readdirSync(join(wingetBase, entry));
				for (const s of sub) {
					const nested = join(wingetBase, entry, s, "cloudflared.exe");
					if (existsSync(nested)) return nested;
				}
			} catch {
				// Ignore unreadable subdirs.
			}
		}
	} catch {
		// WinGet packages directory not readable.
	}
	return null;
}

function isTunnelAlive(): boolean {
	if (!tunnelPid) return false;
	try {
		process.kill(tunnelPid, 0);
		return true;
	} catch {
		tunnelPid = null;
		tunnelUrl = null;
		return false;
	}
}

// ── Install ────────────────────────────────────────────────────────────────

async function install(): Promise<void> {
	const p = platform();
	if (p === "win32") {
		await installWindows();
	} else if (p === "darwin") {
		await installMac();
	} else {
		await installLinux();
	}
}

async function installWindows(): Promise<void> {
	const msiUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.msi";
	const msiPath = join(homedir(), "AppData", "Local", "Temp", "cloudflared-setup.msi");
	const psScript = [
		`[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`,
		`$ProgressPreference = 'SilentlyContinue'`,
		`Invoke-WebRequest -Uri '${msiUrl}' -OutFile '${msiPath}' -UseBasicParsing`,
		`Start-Process msiexec.exe -ArgumentList '/i','${msiPath}','/quiet','/norestart' -Wait`,
	].join("; ");

	try {
		await execAsync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${psScript}"`, {
			timeout: 180_000,
		});
		return;
	} catch {
		// MSI failed — try winget.
	}

	try {
		const { stderr } = await execAsync(
			"winget install --id Cloudflare.cloudflared --silent --accept-package-agreements --accept-source-agreements --disable-interactivity",
			{ timeout: 120_000 },
		);
		// winget exits 0 even when "already installed" — that's fine.
		// Only treat it as an error if the stderr contains a hard failure.
		if (stderr?.includes("failed") && !stderr.includes("already installed")) {
			throw new Error(stderr.trim());
		}
	} catch (err) {
		// If winget says "already installed" that's not a real error.
		const msg = err instanceof Error ? err.message : String(err);
		if (!msg.includes("already installed") && !msg.includes("No applicable upgrade")) {
			throw new Error(`cloudflared installation failed on Windows: ${msg}`);
		}
	}
}

async function installMac(): Promise<void> {
	try {
		await execAsync("brew install cloudflared", { timeout: 120_000 });
		return;
	} catch {
		// Homebrew failed — try direct binary download.
	}

	try {
		await execAsync(
			"curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared",
			{ timeout: 120_000 },
		);
	} catch (err) {
		throw new Error(`cloudflared installation failed on macOS: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function installLinux(): Promise<void> {
	// Detect architecture.
	let arch = "amd64";
	try {
		const raw = execSync("uname -m", { encoding: "utf-8" }).trim();
		if (raw === "aarch64" || raw === "arm64") arch = "arm64";
		else if (raw.startsWith("arm")) arch = "arm";
	} catch {
		// Default to amd64.
	}

	try {
		await execAsync(
			`curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch} -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared`,
			{ timeout: 120_000 },
		);
	} catch (err) {
		throw new Error(`cloudflared installation failed on Linux: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// ── Process spawning ───────────────────────────────────────────────────────

function spawnTunnelProcess(bin: string, args: string[]): void {
	ensureKanbanDir();
	// Clear PID file before launch.
	try {
		writeFileSync(PID_PATH, "", "utf-8");
	} catch {
		// Ignore.
	}

	if (platform() === "win32") {
		spawnWindows(bin, args);
	} else {
		spawnUnix(bin, args);
	}
}

function spawnUnix(bin: string, args: string[]): void {
	const proc = spawn(bin, args, { stdio: "ignore", detached: true, shell: false });
	proc.unref();
	tunnelPid = proc.pid ?? null;
}

function spawnWindows(bin: string, args: string[]): void {
	// Use PowerShell Start-Process so cloudflared runs hidden with no console window.
	const pidPathEsc = PID_PATH.replace(/\\/g, "\\\\");
	const binEsc = bin.replace(/'/g, "''");
	const psArgList = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(",");
	const ps1 = `$p = Start-Process -FilePath '${binEsc}' -ArgumentList ${psArgList} -WindowStyle Hidden -PassThru; if ($p) { $p.Id | Out-File '${pidPathEsc}' -Encoding ASCII }`;
	writeFileSync(PS1_PATH, ps1, "utf-8");

	const ps = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", PS1_PATH], {
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
		shell: false,
	});

	ps.on("close", (code) => {
		if (code !== 0) return;
		try {
			if (existsSync(PID_PATH)) {
				const pid = parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
				if (!Number.isNaN(pid) && pid > 0) tunnelPid = pid;
			}
		} catch {
			// Ignore PID read errors.
		}
	});
}

// ── Stop ───────────────────────────────────────────────────────────────────

export async function stopCloudflaredTunnel(): Promise<void> {
	if (tunnelPid) {
		try {
			if (platform() === "win32") {
				execSync(`taskkill /PID ${tunnelPid} /F /T`, { stdio: "pipe" });
			} else {
				process.kill(tunnelPid, "SIGTERM");
			}
		} catch {
			// Already gone.
		}
		tunnelPid = null;
		tunnelUrl = null;
	}
	// Safety net: kill any cloudflared processes by name.
	if (platform() === "win32") {
		try {
			execSync("taskkill /IM cloudflared.exe /F", { stdio: "pipe" });
		} catch {
			// None running.
		}
	}
}

// ── State ──────────────────────────────────────────────────────────────────

export function getTunnelUrl(): string | null {
	return isTunnelAlive() ? tunnelUrl : null;
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Start a Cloudflare quick tunnel pointing at `port`.
 *
 * If cloudflared is not installed, installs it automatically.
 * Retries up to 3 times on transient failures.
 *
 * @returns The public tunnel URL (e.g. https://xxxx.trycloudflare.com)
 * @throws  If installation or tunnel start fails after all retries.
 */
export async function startCloudflaredTunnel(port: number): Promise<string> {
	// Stop any existing tunnel first.
	await stopCloudflaredTunnel();

	// Find or install cloudflared.
	let bin = findBin();
	if (!bin) {
		await install();
		// After install, rescan — MSI/winget may have put the binary in a known location
		// that is not yet on the current process PATH (requires new shell session on Windows).
		bin = findBin();
		if (!bin) {
			// Last resort on Windows: scan WinGet packages directory for cloudflared.exe.
			if (platform() === "win32") {
				bin = findInWingetPackages();
			}
			if (!bin) {
				throw new Error(
					"cloudflared was installed but the binary could not be located. " +
						"If you are on Windows, try opening a new terminal and running 'cloudflared --version'. " +
						"On Linux/macOS, ensure /usr/local/bin is on your PATH.",
				);
			}
		}
	}

	// Attempt quick tunnel with up to 3 retries.
	const MAX_RETRIES = 3;
	let lastError = "Unknown error";

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const url = await tryQuickTunnel(bin, port);
			tunnelUrl = url;
			return url;
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
			// Do not retry on rate-limit errors.
			if (lastError.includes("429") || lastError.includes("rate limit") || lastError.includes("Too Many Requests")) {
				break;
			}
			if (attempt < MAX_RETRIES) {
				await new Promise((r) => setTimeout(r, 3000));
			}
		}
	}

	throw new Error(`Failed to start Cloudflare tunnel after ${MAX_RETRIES} attempts: ${lastError}`);
}

// ── Quick tunnel implementation ────────────────────────────────────────────

function ensureKanbanDir(): void {
	if (!existsSync(KANBAN_DIR)) mkdirSync(KANBAN_DIR, { recursive: true });
}

function readLogTail(chars: number): string {
	try {
		return readFileSync(LOG_PATH, "utf-8").slice(-chars);
	} catch {
		return "";
	}
}

function tryQuickTunnel(bin: string, port: number): Promise<string> {
	ensureKanbanDir();

	// Clear log file before each attempt.
	try {
		writeFileSync(LOG_PATH, "", "utf-8");
	} catch {
		// Ignore.
	}

	const args = [
		"tunnel",
		"--protocol",
		"http2",
		"--no-autoupdate",
		"--logfile",
		LOG_PATH,
		"--url",
		`http://localhost:${port}`,
	];

	spawnTunnelProcess(bin, args);

	return new Promise<string>((resolve, reject) => {
		let bytesRead = 0;
		let settled = false;

		const TIMEOUT_MS = 30_000;

		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			unwatchFile(LOG_PATH);
			reject(new Error(`Timeout waiting for tunnel URL.\n${readLogTail(300)}`));
		}, TIMEOUT_MS);

		watchFile(LOG_PATH, { interval: 250 }, () => {
			if (settled) return;
			try {
				const content = readFileSync(LOG_PATH, "utf-8");
				const chunk = content.slice(bytesRead);
				if (!chunk) return;
				bytesRead = content.length;

				// Success: found a trycloudflare.com URL in the log.
				const urlMatch = chunk.match(/https?:\/\/[^\s|"\\]+\.trycloudflare\.com/);
				if (urlMatch) {
					settled = true;
					clearTimeout(timeout);
					unwatchFile(LOG_PATH);
					resolve(urlMatch[0].trim());
					return;
				}

				// Rate limited.
				if (chunk.includes("429") || chunk.includes("Too Many Requests") || chunk.includes("1015")) {
					settled = true;
					clearTimeout(timeout);
					unwatchFile(LOG_PATH);
					reject(new Error("Rate limited by Cloudflare Quick Tunnel API."));
					return;
				}

				// Fatal error in log.
				if (chunk.includes('"level":"fatal"')) {
					settled = true;
					clearTimeout(timeout);
					unwatchFile(LOG_PATH);
					reject(new Error(`cloudflared fatal error: ${chunk.slice(-300)}`));
				}
			} catch {
				// Log not readable yet — wait for next tick.
			}
		});
	});
}
