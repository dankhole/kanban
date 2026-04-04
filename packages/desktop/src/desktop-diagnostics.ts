/**
 * Desktop diagnostics snapshot — collects structured, redacted
 * diagnostic information for debugging and support.
 *
 * **Redaction rules:**
 * - Auth tokens are NEVER included.
 * - URLs are reduced to origin only (no path, query, or fragment).
 * - Connection labels are included (not sensitive).
 * - PIDs, exit codes, and timestamps are included (not sensitive).
 */

import { app, safeStorage } from "electron";

import { getBootState } from "./desktop-boot-state.js";
import type { DesktopPreflightResult } from "./desktop-preflight.js";
import type { ConnectionManager } from "./connection-manager.js";
import type { ConnectionStore } from "./connection-store.js";
import type { RuntimeChildManager } from "./runtime-child.js";
import { readRuntimeDescriptor } from "kanban";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DesktopDiagnosticsSnapshot {
	collectedAt: string;

	bootPhase: string;
	lastSuccessfulPhase: string | null;
	failureCode: string | null;
	failureMessage: string | null;
	bootStartedAt: string;
	phaseHistory: Array<{ phase: string; timestamp: string }>;

	resources: {
		preloadExists: boolean;
		runtimeChildEntryExists: boolean;
		cliShimExists: boolean;
		nodePtyLoadable: boolean | null;
	} | null;

	descriptorExists: boolean;
	descriptorPidAlive: boolean | null;
	descriptorSource: string | null;
	descriptorSessionMatch: boolean | null;

	runtimeChildPid: number | null;
	runtimeChildRunning: boolean;

	connectionType: string | null;
	connectionId: string | null;
	runtimeUrl: string | null;

	appVersion: string;
	platform: string;
	arch: string;
	electronVersion: string;
	isPackaged: boolean;

	safeStorageEncryptionAvailable: boolean;
}


// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface DiagnosticsContext {
	connectionManager: ConnectionManager | null;
	connectionStore: ConnectionStore | null;
	runtimeManager: RuntimeChildManager | null;
	runtimeUrl: string | null;
	preflightResult: DesktopPreflightResult | null;
	desktopSessionId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reduce a URL to its origin only (scheme + host + port).
 * Returns `null` for falsy input. Returns the raw string if parsing fails.
 */
export function redactUrlToOrigin(
	url: string | null | undefined,
): string | null {
	if (!url) return null;
	try {
		return new URL(url).origin;
	} catch {
		return url;
	}
}

// ---------------------------------------------------------------------------
// Snapshot collection
// ---------------------------------------------------------------------------

export async function collectDiagnosticsSnapshot(
	ctx: DiagnosticsContext,
): Promise<DesktopDiagnosticsSnapshot> {
	const bootState = getBootState();

	// -- Descriptor state ---------------------------------------------------
	let descriptorExists = false;
	let descriptorPidAlive: boolean | null = null;
	let descriptorSource: string | null = null;
	let descriptorSessionMatch: boolean | null = null;

	try {
		const descriptor = await readRuntimeDescriptor();
		if (descriptor) {
			descriptorExists = true;
			descriptorSource = descriptor.source ?? null;
			descriptorSessionMatch =
				descriptor.source === "desktop" &&
				descriptor.desktopSessionId === ctx.desktopSessionId;
			try {
				process.kill(descriptor.pid, 0);
				descriptorPidAlive = true;
			} catch {
				descriptorPidAlive = false;
			}
		}
	} catch {
		// readRuntimeDescriptor failed — leave defaults.
	}

	// -- Runtime child state ------------------------------------------------
	let runtimeChildPid: number | null = null;
	let runtimeChildRunning = false;
	if (ctx.runtimeManager) {
		runtimeChildRunning = ctx.runtimeManager.running ?? false;
		runtimeChildPid = ctx.runtimeManager.pid ?? null;
	}

	// -- Connection state ---------------------------------------------------
	let connectionType: string | null = null;
	let connectionId: string | null = null;
	if (ctx.connectionStore) {
		const active = ctx.connectionStore.getActiveConnection();
		connectionId = active.id;
		if (active.id === "local") {
			connectionType = "local";
		} else if (active.id === "wsl") {
			connectionType = "wsl";
		} else {
			connectionType = "remote";
		}
	}

	// -- Preflight resources ------------------------------------------------
	const resources = ctx.preflightResult
		? { ...ctx.preflightResult.resources }
		: null;

	return {
		collectedAt: new Date().toISOString(),
		bootPhase: bootState.currentPhase,
		lastSuccessfulPhase: bootState.lastSuccessfulPhase,
		failureCode: bootState.failureCode,
		failureMessage: bootState.failureMessage,
		bootStartedAt: bootState.startedAt,
		phaseHistory: bootState.phaseHistory.map((e) => ({
			phase: e.phase,
			timestamp: e.timestamp,
		})),
		resources,
		descriptorExists,
		descriptorPidAlive,
		descriptorSource,
		descriptorSessionMatch,
		runtimeChildPid,
		runtimeChildRunning,
		connectionType,
		connectionId,
		runtimeUrl: redactUrlToOrigin(ctx.runtimeUrl),
		appVersion: app.getVersion(),
		platform: process.platform,
		arch: process.arch,
		electronVersion: process.versions.electron ?? "unknown",
		isPackaged: app.isPackaged,
		safeStorageEncryptionAvailable: safeStorage.isEncryptionAvailable(),
	};
}
