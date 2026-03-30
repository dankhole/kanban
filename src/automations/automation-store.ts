/**
 * AutomationStore — JSON-file-backed persistence for the automation platform.
 *
 * Data is stored under ~/.kanban/automations/ with one file per collection:
 *   instances.json      — AutomationAgentInstance[]
 *   findings.json       — AutomationFinding[]
 *   remediations.json   — RemediationRecord[]
 *   scan-runs.json      — ScanRun[]
 *   audit-events.json   — AutomationAuditEvent[]
 *
 * All writes are atomic (write-to-temp + rename) and serialization-safe
 * (file locking via proper-lockfile through LockedFileSystem).
 *
 * Findings are keyed by fingerprint — upsert semantics keep them stable
 * across repeated scans of the same issue.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { lockedFileSystem } from "../fs/locked-file-system";
import type {
	AutomationAgentInstance,
	AutomationAuditEvent,
	AutomationFinding,
	RemediationRecord,
	ScanRun,
} from "./automation-types";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getAutomationsDataDir(): string {
	return join(homedir(), ".kanban", "automations");
}

function getInstancesPath(): string {
	return join(getAutomationsDataDir(), "instances.json");
}

function getFindingsPath(): string {
	return join(getAutomationsDataDir(), "findings.json");
}

function getRemediationsPath(): string {
	return join(getAutomationsDataDir(), "remediations.json");
}

function getScanRunsPath(): string {
	return join(getAutomationsDataDir(), "scan-runs.json");
}

function getAuditEventsPath(): string {
	return join(getAutomationsDataDir(), "audit-events.json");
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

async function readJsonFile<T>(path: string): Promise<T[]> {
	try {
		const content = await readFile(path, "utf8");
		const parsed = JSON.parse(content);
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed as T[];
	} catch {
		// File doesn't exist yet, or corrupt — start fresh.
		return [];
	}
}

async function writeJsonFile<T>(path: string, data: T[]): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(path, data);
}

// ---------------------------------------------------------------------------
// FindingFilters
// ---------------------------------------------------------------------------

export interface FindingFilters {
	instanceId?: string;
	projectPath?: string;
	status?: AutomationFinding["status"];
	ruleId?: string;
	category?: string;
	limit?: number;
}

export interface ScanRunFilters {
	instanceId?: string;
	limit?: number;
}

export interface AuditEventFilters {
	instanceId?: string;
	eventType?: AutomationAuditEvent["eventType"];
	since?: number;
	limit?: number;
}

// ---------------------------------------------------------------------------
// AutomationStore
// ---------------------------------------------------------------------------

/**
 * Lightweight persistence layer for automation state.
 *
 * All methods are async and safe to call concurrently.  Reads re-parse from
 * disk each call (no in-memory cache) to ensure multi-process correctness.
 * For hot read paths the caller should batch reads.
 */
export class AutomationStore {
	// -------------------------------------------------------------------------
	// Instances
	// -------------------------------------------------------------------------

	async listInstances(): Promise<AutomationAgentInstance[]> {
		return await readJsonFile<AutomationAgentInstance>(getInstancesPath());
	}

	async getInstance(id: string): Promise<AutomationAgentInstance | null> {
		const all = await this.listInstances();
		return all.find((i) => i.id === id) ?? null;
	}

	async saveInstance(instance: AutomationAgentInstance): Promise<void> {
		const all = await this.listInstances();
		const idx = all.findIndex((i) => i.id === instance.id);
		if (idx >= 0) {
			all[idx] = instance;
		} else {
			all.push(instance);
		}
		await writeJsonFile(getInstancesPath(), all);
	}

	async deleteInstance(id: string): Promise<void> {
		const all = await this.listInstances();
		const filtered = all.filter((i) => i.id !== id);
		await writeJsonFile(getInstancesPath(), filtered);
	}

	// -------------------------------------------------------------------------
	// Findings
	// -------------------------------------------------------------------------

	async listFindings(filters: FindingFilters = {}): Promise<AutomationFinding[]> {
		let all = await readJsonFile<AutomationFinding>(getFindingsPath());

		if (filters.instanceId !== undefined) {
			all = all.filter((f) => f.instanceId === filters.instanceId);
		}
		if (filters.projectPath !== undefined) {
			all = all.filter((f) => f.projectPath === filters.projectPath);
		}
		if (filters.status !== undefined) {
			all = all.filter((f) => f.status === filters.status);
		}
		if (filters.ruleId !== undefined) {
			all = all.filter((f) => f.ruleId === filters.ruleId);
		}
		if (filters.category !== undefined) {
			all = all.filter((f) => f.category === filters.category);
		}

		// Sort by most-recently-seen first.
		all.sort((a, b) => b.lastSeenAt - a.lastSeenAt);

		if (filters.limit !== undefined && filters.limit > 0) {
			all = all.slice(0, filters.limit);
		}

		return all;
	}

	async getFinding(fingerprint: string): Promise<AutomationFinding | null> {
		const all = await readJsonFile<AutomationFinding>(getFindingsPath());
		return all.find((f) => f.fingerprint === fingerprint) ?? null;
	}

	/**
	 * Upsert a finding by fingerprint.
	 *
	 * If a finding with the same fingerprint already exists, it is updated
	 * (lastSeenAt, status, evidence, linkedTaskId).  Otherwise the finding
	 * is inserted.
	 *
	 * This is the persistence-level half of deduplication.
	 */
	async upsertFinding(finding: AutomationFinding): Promise<void> {
		const all = await readJsonFile<AutomationFinding>(getFindingsPath());
		const idx = all.findIndex((f) => f.fingerprint === finding.fingerprint);
		if (idx >= 0) {
			all[idx] = finding;
		} else {
			all.push(finding);
		}
		await writeJsonFile(getFindingsPath(), all);
	}

	// -------------------------------------------------------------------------
	// Remediation Records
	// -------------------------------------------------------------------------

	async getRemediation(fingerprint: string): Promise<RemediationRecord | null> {
		const all = await readJsonFile<RemediationRecord>(getRemediationsPath());
		return all.find((r) => r.findingFingerprint === fingerprint) ?? null;
	}

	async listRemediations(): Promise<RemediationRecord[]> {
		return await readJsonFile<RemediationRecord>(getRemediationsPath());
	}

	async saveRemediation(record: RemediationRecord): Promise<void> {
		const all = await readJsonFile<RemediationRecord>(getRemediationsPath());
		const idx = all.findIndex((r) => r.findingFingerprint === record.findingFingerprint);
		if (idx >= 0) {
			all[idx] = record;
		} else {
			all.push(record);
		}
		await writeJsonFile(getRemediationsPath(), all);
	}

	// -------------------------------------------------------------------------
	// Scan Runs
	// -------------------------------------------------------------------------

	async listScanRuns(filters: ScanRunFilters = {}): Promise<ScanRun[]> {
		let all = await readJsonFile<ScanRun>(getScanRunsPath());

		if (filters.instanceId !== undefined) {
			all = all.filter((r) => r.instanceId === filters.instanceId);
		}

		// Sort by most-recent first.
		all.sort((a, b) => b.startedAt - a.startedAt);

		if (filters.limit !== undefined && filters.limit > 0) {
			all = all.slice(0, filters.limit);
		}

		return all;
	}

	async saveScanRun(run: ScanRun): Promise<void> {
		const all = await readJsonFile<ScanRun>(getScanRunsPath());
		const idx = all.findIndex((r) => r.id === run.id);
		if (idx >= 0) {
			all[idx] = run;
		} else {
			all.push(run);
		}
		await writeJsonFile(getScanRunsPath(), all);
	}

	/**
	 * Delete scan run records older than the given age.
	 * Returns the count of records deleted.
	 */
	async purgeScanRuns(olderThanMs: number): Promise<number> {
		const all = await readJsonFile<ScanRun>(getScanRunsPath());
		const cutoff = Date.now() - olderThanMs;
		const kept = all.filter((r) => r.startedAt > cutoff);
		await writeJsonFile(getScanRunsPath(), kept);
		return all.length - kept.length;
	}

	// -------------------------------------------------------------------------
	// Audit Events
	// -------------------------------------------------------------------------

	async listAuditEvents(filters: AuditEventFilters = {}): Promise<AutomationAuditEvent[]> {
		let all = await readJsonFile<AutomationAuditEvent>(getAuditEventsPath());

		if (filters.instanceId !== undefined) {
			all = all.filter((e) => e.instanceId === filters.instanceId);
		}
		if (filters.eventType !== undefined) {
			all = all.filter((e) => e.eventType === filters.eventType);
		}
		if (filters.since !== undefined) {
			all = all.filter((e) => e.timestamp >= (filters.since ?? 0));
		}

		// Sort by most-recent first.
		all.sort((a, b) => b.timestamp - a.timestamp);

		if (filters.limit !== undefined && filters.limit > 0) {
			all = all.slice(0, filters.limit);
		}

		return all;
	}

	async saveAuditEvent(event: AutomationAuditEvent): Promise<void> {
		const all = await readJsonFile<AutomationAuditEvent>(getAuditEventsPath());
		all.push(event);
		await writeJsonFile(getAuditEventsPath(), all);
	}

	/**
	 * Delete audit events older than the given age.
	 * Returns the count of records deleted.
	 */
	async purgeAuditEvents(olderThanMs: number): Promise<number> {
		const all = await readJsonFile<AutomationAuditEvent>(getAuditEventsPath());
		const cutoff = Date.now() - olderThanMs;
		const kept = all.filter((e) => e.timestamp > cutoff);
		await writeJsonFile(getAuditEventsPath(), kept);
		return all.length - kept.length;
	}

	// -------------------------------------------------------------------------
	// Budget helpers — used by the guardrail engine to compute rolling windows
	// -------------------------------------------------------------------------

	/**
	 * Count tasks created by a given instance in the last windowMs milliseconds.
	 */
	async countTasksCreatedInWindow(instanceId: string, windowMs: number): Promise<number> {
		const runs = await this.listScanRuns({ instanceId });
		const cutoff = Date.now() - windowMs;
		return runs.filter((r) => r.startedAt > cutoff).reduce((sum, r) => sum + r.tasksCreated, 0);
	}

	/**
	 * Count auto-started tasks by a given instance in the last windowMs milliseconds.
	 */
	async countAutoStartsInWindow(instanceId: string, windowMs: number): Promise<number> {
		const runs = await this.listScanRuns({ instanceId });
		const cutoff = Date.now() - windowMs;
		return runs.filter((r) => r.startedAt > cutoff).reduce((sum, r) => sum + r.tasksAutoStarted, 0);
	}

	/**
	 * Count tasks created by ALL instances in the last windowMs milliseconds.
	 * Used for global budget enforcement.
	 */
	async countGlobalTasksCreatedInWindow(windowMs: number): Promise<number> {
		const runs = await this.listScanRuns();
		const cutoff = Date.now() - windowMs;
		return runs.filter((r) => r.startedAt > cutoff).reduce((sum, r) => sum + r.tasksCreated, 0);
	}

	/**
	 * Count auto-starts across ALL instances in the last windowMs milliseconds.
	 */
	async countGlobalAutoStartsInWindow(windowMs: number): Promise<number> {
		const runs = await this.listScanRuns();
		const cutoff = Date.now() - windowMs;
		return runs.filter((r) => r.startedAt > cutoff).reduce((sum, r) => sum + r.tasksAutoStarted, 0);
	}
}

/** Singleton store instance — shared across the process. */
export const automationStore = new AutomationStore();
