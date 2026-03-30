/**
 * AutomationService — the top-level orchestrator for automation agents.
 *
 * Responsibilities:
 *   - Manage the lifecycle of AutomationAgentInstances (create, enable, disable, delete).
 *   - Schedule and run scan cycles for each enabled instance.
 *   - Delegate detection to DetectionPipeline (one call per projectPath).
 *   - Run guardrail evaluation on findings.
 *   - Execute approved actions (create task, auto-start task, update finding).
 *   - Record scan runs and audit events.
 *
 * The service is started once at Kanban boot time and runs until shutdown.
 * Scan timers are per-instance and can be reconfigured at runtime.
 */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { automationStore } from "./automation-store";
import type {
	AutomationAgentInstance,
	AutomationAuditEvent,
	AutomationFinding,
	RemediationRecord,
	ScanRun,
} from "./automation-types";
import type { PipelineBoardState } from "./detection-pipeline";
import { detectionPipeline } from "./detection-pipeline";
import { GuardrailEngine } from "./guardrail-engine";
import { resolvePolicy } from "./policy-resolver";
import { templateRegistry } from "./template-registry";

// ---------------------------------------------------------------------------
// Dependencies injected from runtime-server
// ---------------------------------------------------------------------------

export interface AutomationServiceDeps {
	/**
	 * Get the current board state for a workspace identified by project path.
	 * Returns null if the project is not in any managed workspace.
	 */
	getBoardState(projectPath: string): Promise<PipelineBoardState | null>;
	/**
	 * Create a task on the board for the given workspace path.
	 */
	createTask(
		workspacePath: string,
		prompt: string,
		options?: { autoStart?: boolean; automationInstanceId?: string; findingFingerprint?: string },
	): Promise<{ taskId: string }>;
	/**
	 * Optional callback to broadcast the latest automation state to connected
	 * browser clients after a scan or instance mutation.
	 */
	broadcastUpdated?: (payload: {
		enabledInstancesCount: number;
		openFindingsCount: number;
		recentlyDisabledInstanceIds: string[];
	}) => void;
}

// ---------------------------------------------------------------------------
// AutomationService
// ---------------------------------------------------------------------------

const AUDIT_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1_000; // 24 hours
const AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000; // 30 days

export class AutomationService {
	private readonly deps: AutomationServiceDeps;
	/** Timer handles keyed by instance ID → NodeJS.Timeout */
	private readonly scanTimers = new Map<string, NodeJS.Timeout>();
	/** Guard against concurrent scans for the same instance. */
	private readonly runningScanIds = new Set<string>();
	/** Daily timer that purges stale audit events and scan runs. */
	private auditPurgeTimer: NodeJS.Timeout | null = null;

	constructor(deps: AutomationServiceDeps) {
		this.deps = deps;
	}

	// -------------------------------------------------------------------------
	// Startup / Shutdown
	// -------------------------------------------------------------------------

	async start(): Promise<void> {
		await this.ensureDataDirExists();
		const instances = await automationStore.listInstances();
		for (const instance of instances) {
			if (instance.enabled) {
				this.scheduleInstance(instance);
			}
		}
		const activeCount = instances.filter((i) => i.enabled).length;
		process.stderr.write(`[automation-service] started — ${activeCount} active instance(s)\n`);

		// Schedule daily audit event purge (runs first after 1 min, then every 24h).
		const runPurge = () => {
			automationStore.purgeAuditEvents(Date.now() - AUDIT_RETENTION_MS).catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(`[automation-service] audit purge failed: ${msg}\n`);
			});
		};
		const initialDelay = setTimeout(() => {
			runPurge();
			this.auditPurgeTimer = setInterval(runPurge, AUDIT_PURGE_INTERVAL_MS);
		}, 60_000); // first run after 1 minute to let boot settle
		this.auditPurgeTimer = initialDelay;
	}

	stop(): void {
		for (const [instanceId, timer] of this.scanTimers) {
			clearInterval(timer);
			this.scanTimers.delete(instanceId);
		}
		if (this.auditPurgeTimer) {
			clearTimeout(this.auditPurgeTimer);
			clearInterval(this.auditPurgeTimer);
			this.auditPurgeTimer = null;
		}
	}

	// -------------------------------------------------------------------------
	// Instance CRUD
	// -------------------------------------------------------------------------

	async listInstances(): Promise<AutomationAgentInstance[]> {
		return automationStore.listInstances();
	}

	async getInstance(id: string): Promise<AutomationAgentInstance | null> {
		return automationStore.getInstance(id);
	}

	async createInstance(input: {
		templateId: string;
		label: string;
		projectPaths: string[];
		policyOverrides?: AutomationAgentInstance["policyOverrides"];
	}): Promise<AutomationAgentInstance> {
		const template = templateRegistry.getTemplate(input.templateId);
		if (!template) {
			throw new Error(`Template "${input.templateId}" is not registered.`);
		}

		const now = Date.now();
		const instance: AutomationAgentInstance = {
			id: randomUUID(),
			templateId: input.templateId,
			label: input.label,
			projectPaths: input.projectPaths,
			enabled: false, // start disabled; user must explicitly enable
			policyOverrides: input.policyOverrides ?? {},
			createdAt: now,
			updatedAt: now,
		};

		await automationStore.saveInstance(instance);
		await this.recordAuditEvent(instance, "instance_created", {
			label: instance.label,
			templateId: instance.templateId,
			projectPaths: instance.projectPaths.join(","),
		});

		return instance;
	}

	async updateInstance(
		id: string,
		updates: Partial<Pick<AutomationAgentInstance, "label" | "projectPaths" | "policyOverrides">>,
	): Promise<AutomationAgentInstance> {
		const instance = await this.requireInstance(id);
		const updated: AutomationAgentInstance = {
			...instance,
			...updates,
			updatedAt: Date.now(),
		};
		await automationStore.saveInstance(updated);
		// Reschedule if enabled (policy may have changed interval).
		if (updated.enabled) {
			this.scheduleInstance(updated);
		}
		return updated;
	}

	async enableInstance(id: string): Promise<AutomationAgentInstance> {
		const instance = await this.requireInstance(id);
		const updated: AutomationAgentInstance = { ...instance, enabled: true, updatedAt: Date.now() };
		await automationStore.saveInstance(updated);
		this.scheduleInstance(updated);
		await this.recordAuditEvent(updated, "instance_enabled", {});
		return updated;
	}

	async disableInstance(id: string): Promise<AutomationAgentInstance> {
		const instance = await this.requireInstance(id);
		const updated: AutomationAgentInstance = { ...instance, enabled: false, updatedAt: Date.now() };
		await automationStore.saveInstance(updated);
		this.unscheduleInstance(id);
		await this.recordAuditEvent(updated, "instance_disabled", {});
		return updated;
	}

	async deleteInstance(id: string): Promise<void> {
		const instance = await this.requireInstance(id);
		this.unscheduleInstance(id);
		await this.recordAuditEvent(instance, "instance_deleted", {});
		await automationStore.deleteInstance(id);
	}

	// -------------------------------------------------------------------------
	// Manual scan trigger
	// -------------------------------------------------------------------------

	async triggerScan(instanceId: string): Promise<void> {
		const instance = await this.requireInstance(instanceId);
		await this.recordAuditEvent(instance, "manual_scan_triggered", {});
		// Run async — don't await so the handler returns immediately.
		setImmediate(() => {
			this.runScan(instance).catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(`[automation-service] scan error for ${instanceId}: ${msg}\n`);
			});
		});
	}

	// -------------------------------------------------------------------------
	// Findings
	// -------------------------------------------------------------------------

	async listFindings(instanceId?: string): Promise<AutomationFinding[]> {
		return automationStore.listFindings(instanceId ? { instanceId } : {});
	}

	async suppressFinding(fingerprint: string): Promise<void> {
		const finding = await automationStore.getFinding(fingerprint);
		if (!finding) {
			throw new Error(`Finding "${fingerprint}" not found.`);
		}
		const updated: AutomationFinding = { ...finding, status: "suppressed" };
		await automationStore.upsertFinding(updated);
		const instance = await automationStore.getInstance(finding.instanceId);
		if (instance) {
			await this.recordAuditEvent(instance, "finding_manually_suppressed", { fingerprint });
		}
	}

	// -------------------------------------------------------------------------
	// Audit events
	// -------------------------------------------------------------------------

	async listAuditEvents(instanceId?: string): Promise<AutomationAuditEvent[]> {
		return automationStore.listAuditEvents(instanceId ? { instanceId } : {});
	}

	// -------------------------------------------------------------------------
	// Scan runs
	// -------------------------------------------------------------------------

	async listScanRuns(instanceId?: string): Promise<ScanRun[]> {
		return automationStore.listScanRuns(instanceId ? { instanceId } : {});
	}

	// -------------------------------------------------------------------------
	// Scan timer management
	// -------------------------------------------------------------------------

	private scheduleInstance(instance: AutomationAgentInstance): void {
		this.unscheduleInstance(instance.id);

		const template = templateRegistry.getTemplate(instance.templateId);
		if (!template) {
			return;
		}

		const policy = resolvePolicy(template, instance);
		const intervalMs = policy.scanIntervalSeconds * 1_000;

		const runOnce = () => {
			this.runScan(instance).catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(`[automation-service] scheduled scan error for ${instance.id}: ${msg}\n`);
			});
		};

		// Stagger initial run with up to 30s jitter to prevent thundering herd.
		const jitterMs = Math.random() * 30_000;
		const initialTimer = setTimeout(() => {
			runOnce();
			const recurringTimer = setInterval(runOnce, intervalMs);
			this.scanTimers.set(instance.id, recurringTimer);
		}, jitterMs);

		this.scanTimers.set(instance.id, initialTimer);
	}

	private unscheduleInstance(instanceId: string): void {
		const existing = this.scanTimers.get(instanceId);
		if (existing) {
			clearInterval(existing);
			clearTimeout(existing);
			this.scanTimers.delete(instanceId);
		}
	}

	// -------------------------------------------------------------------------
	// Scan execution
	// -------------------------------------------------------------------------

	private async runScan(instance: AutomationAgentInstance): Promise<void> {
		if (this.runningScanIds.has(instance.id)) {
			process.stderr.write(`[automation-service] scan already running for ${instance.id}, skipping\n`);
			return;
		}
		this.runningScanIds.add(instance.id);

		const scanRunId = randomUUID();
		const startedAt = Date.now();
		let tasksCreated = 0;
		let tasksAutoStarted = 0;
		let newFindingsCount = 0;
		let suppressedCount = 0;
		let tripwireTriggered = false;
		let tripwireReason: string | null = null;

		const template = templateRegistry.getTemplate(instance.templateId);
		if (!template) {
			process.stderr.write(`[automation-service] template "${instance.templateId}" not found, skipping scan\n`);
			this.runningScanIds.delete(instance.id);
			return;
		}

		await this.recordAuditEvent(instance, "scan_started", { runId: scanRunId });

		// Determine project paths to scan.
		const projectPaths = instance.projectPaths.length > 0 ? instance.projectPaths : [];

		const allErrors: string[] = [];
		const projectsScanned: string[] = [];

		try {
			for (const projectPath of projectPaths) {
				const boardState = await this.deps.getBoardState(projectPath);

				// Run the detection pipeline.
				const pipelineResult = await detectionPipeline.run(
					instance,
					projectPath,
					boardState,
					null, // lastScanAt — could track per-project in future
				);

				projectsScanned.push(projectPath);
				allErrors.push(...pipelineResult.errors);

				if (pipelineResult.findings.length === 0) {
					continue;
				}

				// Run guardrail evaluation.
				const guardrail = new GuardrailEngine(automationStore);
				guardrail.resetForScan();

				const decisions = await guardrail.evaluateFindings(
					pipelineResult.findings,
					instance,
					template,
					pipelineResult.policy,
					pipelineResult.rawFindingsCount,
				);

				// Process decisions.
				const abandonedFingerprints: string[] = [];

				for (const decision of decisions) {
					switch (decision.action) {
						case "halt": {
							tripwireTriggered = true;
							tripwireReason = decision.reason;
							await this.recordAuditEvent(instance, "tripwire_triggered", {
								reason: decision.reason,
								runId: scanRunId,
								projectPath,
							});
							await this.disableInstance(instance.id);
							await this.broadcastState([instance.id]);
							process.stderr.write(
								`[automation-service] HALT: instance ${instance.id} disabled — ${decision.reason}\n`,
							);
							// Bail out of the entire scan.
							return;
						}

						case "create_task":
						case "auto_start_task": {
							const autoStart = decision.action === "auto_start_task";
							try {
								const { taskId } = await this.deps.createTask(projectPath, buildTaskPrompt(decision.finding), {
									autoStart,
									automationInstanceId: instance.id,
									findingFingerprint: decision.finding.fingerprint,
								});

								await automationStore.upsertFinding({
									...decision.finding,
									status: autoStart ? "task_started" : "task_created",
									linkedTaskId: taskId,
									lastSeenAt: Date.now(),
								});

								const existingRemediation = await automationStore.getRemediation(decision.finding.fingerprint);
								const remediationRecord: RemediationRecord = {
									findingFingerprint: decision.finding.fingerprint,
									taskId,
									state: autoStart ? "active" : "pending",
									attemptCount: (existingRemediation?.attemptCount ?? 0) + 1,
									createdAt: existingRemediation?.createdAt ?? Date.now(),
									lastAttemptAt: Date.now(),
								};
								await automationStore.saveRemediation(remediationRecord);

								const eventType = autoStart ? "task_auto_started" : "task_created";
								await this.recordAuditEvent(instance, eventType, {
									taskId,
									fingerprint: decision.finding.fingerprint,
									ruleId: decision.finding.ruleId,
									projectPath,
								});

								tasksCreated++;
								newFindingsCount++;
								if (autoStart) {
									tasksAutoStarted++;
								}
							} catch (err: unknown) {
								const msg = err instanceof Error ? err.message : String(err);
								allErrors.push(`task creation failed: ${msg}`);
							}
							break;
						}

						case "update_existing": {
							await automationStore.upsertFinding(decision.finding);
							break;
						}

						case "suppress": {
							suppressedCount++;
							const remediation = await automationStore.getRemediation(decision.finding.fingerprint);
							if (remediation && decision.reason.includes("abandoned")) {
								abandonedFingerprints.push(decision.finding.fingerprint);
							}
							await automationStore.upsertFinding({
								...decision.finding,
								lastSeenAt: Date.now(),
							});
							break;
						}
					}
				}

				// Post-scan tripwire: repeated remediation failures.
				if (abandonedFingerprints.length >= 3) {
					const tripwireCheck = await guardrail.checkRepeatedRemediationFailureTripwire(abandonedFingerprints);
					if (tripwireCheck.triggered) {
						tripwireTriggered = true;
						tripwireReason = tripwireCheck.reason ?? "repeated remediation failure";
						await this.recordAuditEvent(instance, "tripwire_triggered", {
							reason: tripwireReason,
							runId: scanRunId,
						});
						await this.disableInstance(instance.id);
						process.stderr.write(
							`[automation-service] HALT: instance ${instance.id} disabled — ${tripwireReason}\n`,
						);
						return;
					}
				}
			}

			// Record scan run.
			const scanRun: ScanRun = {
				id: scanRunId,
				instanceId: instance.id,
				templateId: instance.templateId,
				startedAt,
				completedAt: Date.now(),
				projectsScanned,
				rulesEvaluated: template.ruleIds,
				rawFindingsCount: 0, // summed below
				newFindingsCount,
				suppressedCount,
				tasksCreated,
				tasksAutoStarted,
				tripwireTriggered,
				tripwireReason,
				outcome: allErrors.length > 0 ? "partial" : "success",
				errorMessage: allErrors.length > 0 ? allErrors.join("; ") : null,
			};
			await automationStore.saveScanRun(scanRun);

			await this.recordAuditEvent(instance, "scan_completed", {
				runId: scanRunId,
				projectsScanned: String(projectsScanned.length),
				tasksCreated: String(tasksCreated),
				tasksAutoStarted: String(tasksAutoStarted),
			});
			await this.broadcastState();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[automation-service] scan failed for ${instance.id}: ${msg}\n`);

			const scanRun: ScanRun = {
				id: scanRunId,
				instanceId: instance.id,
				templateId: instance.templateId,
				startedAt,
				completedAt: Date.now(),
				projectsScanned,
				rulesEvaluated: template.ruleIds,
				rawFindingsCount: 0,
				newFindingsCount,
				suppressedCount,
				tasksCreated,
				tasksAutoStarted,
				tripwireTriggered: false,
				tripwireReason: null,
				outcome: "error",
				errorMessage: msg,
			};
			await automationStore.saveScanRun(scanRun);
		} finally {
			this.runningScanIds.delete(instance.id);
		}
	}

	// -------------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------------

	private async requireInstance(id: string): Promise<AutomationAgentInstance> {
		const instance = await automationStore.getInstance(id);
		if (!instance) {
			throw new Error(`Automation instance "${id}" not found.`);
		}
		return instance;
	}

	private async recordAuditEvent(
		instance: AutomationAgentInstance,
		eventType: AutomationAuditEvent["eventType"],
		details: Record<string, unknown>,
	): Promise<void> {
		const event: AutomationAuditEvent = {
			id: randomUUID(),
			instanceId: instance.id,
			templateId: instance.templateId,
			eventType,
			timestamp: Date.now(),
			details,
		};
		await automationStore.saveAuditEvent(event);
	}

	private async ensureDataDirExists(): Promise<void> {
		const dir = join(homedir(), ".kanban", "automations");
		await mkdir(dir, { recursive: true });
	}

	/** Build and emit the automation_updated broadcast to all connected UI clients. */
	async broadcastState(recentlyDisabledInstanceIds: string[] = []): Promise<void> {
		if (!this.deps.broadcastUpdated) {
			return;
		}
		const instances = await automationStore.listInstances();
		const findings = await automationStore.listFindings({ status: "open" });
		this.deps.broadcastUpdated({
			enabledInstancesCount: instances.filter((i) => i.enabled).length,
			openFindingsCount: findings.length,
			recentlyDisabledInstanceIds,
		});
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTaskPrompt(finding: AutomationFinding): string {
	const lines = [
		`**Automated finding from Quality Enforcer**`,
		``,
		`**Rule:** ${finding.ruleId}`,
		`**Severity:** ${finding.severity}`,
		`**Project:** ${finding.projectPath}`,
		``,
		finding.description,
	];

	if (finding.affectedFiles.length > 0) {
		lines.push(``, `**Affected files:**`);
		for (const f of finding.affectedFiles.slice(0, 10)) {
			lines.push(`- ${f}`);
		}
	}

	if (Object.keys(finding.evidence).length > 0) {
		const firstEvidence = Object.entries(finding.evidence)[0];
		if (firstEvidence) {
			const [key, value] = firstEvidence;
			lines.push(``, `**Evidence (${key}):**`, "```", value.slice(0, 2000), "```");
		}
	}

	lines.push(``, `*Finding fingerprint: ${finding.fingerprint}*`);

	return lines.join("\n");
}
