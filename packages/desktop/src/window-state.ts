/**
 * Window state persistence for the Electron main process.
 *
 * Stores and retrieves the BrowserWindow position, size, and maximized state
 * to/from userData/window-state.json so the window reopens in the same
 * position across app restarts.
 *
 * This module is intentionally free of Electron imports so the pure functions
 * can be tested without an Electron runtime.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WindowState {
	x: number | undefined;
	y: number | undefined;
	width: number;
	height: number;
	isMaximized: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WINDOW_STATE_FILE = "window-state.json";

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/** Resolve the full path to the window state file in userData. */
export function resolveWindowStatePath(userDataPath: string): string {
	return path.join(userDataPath, WINDOW_STATE_FILE);
}

/**
 * Load persisted window state from disk.
 * Returns undefined if the file doesn't exist or is corrupt.
 */
export function loadWindowState(userDataPath: string): WindowState | undefined {
	try {
		const filePath = resolveWindowStatePath(userDataPath);
		if (!existsSync(filePath)) return undefined;
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;

		// Validate the shape
		if (
			typeof parsed.width !== "number" ||
			typeof parsed.height !== "number" ||
			typeof parsed.isMaximized !== "boolean"
		) {
			return undefined;
		}

		return {
			x: typeof parsed.x === "number" ? parsed.x : undefined,
			y: typeof parsed.y === "number" ? parsed.y : undefined,
			width: parsed.width,
			height: parsed.height,
			isMaximized: parsed.isMaximized,
		};
	} catch {
		return undefined;
	}
}

/**
 * Save window state to disk. Writes synchronously to ensure the data
 * is flushed before the process exits.
 */
export function saveWindowState(
	userDataPath: string,
	state: WindowState,
): void {
	try {
		const filePath = resolveWindowStatePath(userDataPath);
		writeFileSync(filePath, JSON.stringify(state, null, "\t"), "utf-8");
	} catch {
		// Best-effort — don't crash if userData is read-only.
	}
}
