// ───────────────────────────────────────────────────────────────────────
// win-sign.cjs — electron-builder custom sign hook for Windows
//
// Signing modes (selected automatically by environment variables):
//   1. Azure Trusted Signing (EV): AZURE_SIGN_ENDPOINT, etc.
//   2. Standard PFX / OV certificate: WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD
//   3. No-op (local dev builds): no signing env vars set
//
// Timestamp server: http://timestamp.acs.microsoft.com (RFC 3161)
// ───────────────────────────────────────────────────────────────────────
// @ts-check
"use strict";

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

/** @type {string} */
const TIMESTAMP_SERVER = "http://timestamp.acs.microsoft.com";

const AZURE_REQUIRED_ENV_VARS = /** @type {const} */ ([
	"AZURE_SIGN_ENDPOINT",
	"AZURE_SIGN_CERT_PROFILE",
	"AZURE_SIGN_CODE_SIGNING_ACCOUNT",
]);

const PFX_REQUIRED_ENV_VARS = /** @type {const} */ ([
	"WIN_CSC_LINK",
	"WIN_CSC_KEY_PASSWORD",
]);

/**
 * Check whether all listed env vars are present and non-empty.
 * @param {readonly string[]} keys
 * @param {Record<string, string | undefined>} env
 * @returns {{ ok: true } | { ok: false; missing: string[] }}
 */
function checkEnvVars(keys, env) {
	const missing = keys.filter((key) => !env[key]);
	return missing.length > 0 ? { ok: false, missing } : { ok: true };
}

/**
 * Determine which signing mode to use based on available env vars.
 * @param {Record<string, string | undefined>} env
 * @returns {{ mode: "azure" } | { mode: "pfx" } | { mode: "none"; reason: string }}
 */
function detectSigningMode(env) {
	if (checkEnvVars(AZURE_REQUIRED_ENV_VARS, env).ok) return { mode: "azure" };
	if (checkEnvVars(PFX_REQUIRED_ENV_VARS, env).ok) return { mode: "pfx" };
	return {
		mode: "none",
		reason:
			"No Windows signing env vars detected. " +
			`Azure needs: ${AZURE_REQUIRED_ENV_VARS.join(", ")}. ` +
			`PFX needs: ${PFX_REQUIRED_ENV_VARS.join(", ")}.`,
	};
}

/**
 * Decode a base64-encoded PFX certificate to a temporary file.
 * @param {string} base64Content
 * @returns {string} — path to the temporary .pfx file
 */
function decodePfxToTempFile(base64Content) {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-sign-"));
	const pfxPath = path.join(tmpDir, "cert.pfx");
	fs.writeFileSync(pfxPath, Buffer.from(base64Content, "base64"));
	return pfxPath;
}

/**
 * Sign a file using Azure Trusted Signing (AzureSignTool).
 * @param {string} filePath
 * @param {Record<string, string | undefined>} env
 */
function signWithAzure(filePath, env) {
	const args = [
		"sign",
		"--azure-key-vault-managed-identity", "true",
		"--azure-key-vault-url", /** @type {string} */ (env.AZURE_SIGN_ENDPOINT),
		"--azure-key-vault-certificate", /** @type {string} */ (env.AZURE_SIGN_CERT_PROFILE),
		"--azure-key-vault-account-name", /** @type {string} */ (env.AZURE_SIGN_CODE_SIGNING_ACCOUNT),
		"--timestamp-rfc3161", TIMESTAMP_SERVER,
		"--timestamp-digest", "sha256",
		"--file-digest", "sha256",
		"--verbose",
		`"${filePath}"`,
	];
	execSync(`AzureSignTool ${args.join(" ")}`, { stdio: "inherit" });
}

/**
 * Sign a file using signtool.exe with a PFX certificate.
 * @param {string} filePath
 * @param {string} pfxPath
 * @param {string} password
 */
function signWithSigntool(filePath, pfxPath, password) {
	const args = [
		"sign", "/f", `"${pfxPath}"`, "/p", `"${password}"`,
		"/fd", "sha256", "/tr", TIMESTAMP_SERVER, "/td", "sha256",
		"/v", `"${filePath}"`,
	];
	execSync(`signtool ${args.join(" ")}`, { stdio: "inherit" });
}

/**
 * electron-builder custom sign hook. Called once per file.
 * @param {object} configuration
 * @param {string} configuration.path — absolute path to the file to sign
 */
async function sign(configuration) {
	const filePath = configuration.path;
	const mode = detectSigningMode(process.env);

	if (mode.mode === "none") {
		console.log(`[win-sign] Skipping: ${mode.reason}`);
		return;
	}

	console.log(`[win-sign] Signing (${mode.mode}): ${filePath}`);

	if (mode.mode === "azure") {
		signWithAzure(filePath, process.env);
		return;
	}

	// PFX mode
	const cscLink = /** @type {string} */ (process.env.WIN_CSC_LINK);
	const password = /** @type {string} */ (process.env.WIN_CSC_KEY_PASSWORD);

	const pfxPath = fs.existsSync(cscLink)
		? cscLink
		: decodePfxToTempFile(cscLink);

	try {
		signWithSigntool(filePath, pfxPath, password);
	} finally {
		// Clean up temp PFX (only if we created it)
		if (pfxPath !== cscLink) {
			try {
				fs.unlinkSync(pfxPath);
				fs.rmdirSync(path.dirname(pfxPath));
			} catch { /* best-effort */ }
		}
	}
}

// Export for electron-builder (default export)
module.exports = sign;

// Export helpers for testing
module.exports.checkEnvVars = checkEnvVars;
module.exports.detectSigningMode = detectSigningMode;
module.exports.decodePfxToTempFile = decodePfxToTempFile;
module.exports.AZURE_REQUIRED_ENV_VARS = AZURE_REQUIRED_ENV_VARS;
module.exports.PFX_REQUIRED_ENV_VARS = PFX_REQUIRED_ENV_VARS;
module.exports.TIMESTAMP_SERVER = TIMESTAMP_SERVER;

