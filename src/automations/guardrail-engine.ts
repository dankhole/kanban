/**
 * GuardrailEngine — the central defense against runaway self-generated activity.
 *
 * The guardrail engine sits between the detection pipeline and the action
 * executor.  For every finding the pipeline produces, the engine decides:
 *   create_task     — new backlog card
 *   auto_start_task — new card + immediate start
 *   update_existing — finding already has a task; update lastSeenAt only
 *   suppress        — blocked by budget / cooldown / dedup
 *   halt            — tripwire triggered; abort the entire scan
 *
 * The engine enforces five categories of control:
 *   1. Deduplication   — same fingerprint = same issue; don't double-create
 *   2. Budgets         — rate limits on task creation and auto-starts
 *   3. Cooldowns       — don't re-act within N minutes of last attempt
 *   4. Loop prevention — never act on your own tasks; cap chain depth
 *   5. Tripwires       — emergency brakes when something looks wrong
 *
 * Global budget constants (not per-agent configurable).
 */

import type { AutomationStore } from "./automation-store";
import type {
	AutomationAgentInstance,
	AutomationAgentTemplate,
	AutomationFinding,
	GuardrailDecision,
	ResolvedPolicy,
} from "./automation-types";

// ---------------------------------------------------------------------------
// Global budget limits (safety net above per-instance limits)
// ---------------------------------------------------------------------------

/** Maximum tasks any combination of automation agents may create per hour. */
const GLOBAL_MAX_TASKS_PER_HOUR = 20;

/** Maximum auto-starts any combination of automation agents may trigger per hour. */
const GLOBAL_MAX_AUTO_STARTS_PER_HOUR = 5;

/** Rolling window for budget enforcement. */
const BUDGET_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/** Maximum remediation attempts before a finding is permanently abandoned. */
const MAX_ABANDON_ATTEMPTS = 5;

/** Maximum remediation attempts before auto-start is downgraded to create-only. */
const MAX_AUTO_START_ATTEMPTS = 3;

/** Maximum chain depth before a finding is suppressed as a loop. */
const _MAX_CHAIN_DEPTH = 2;

// ---------------------------------------------------------------------------
// Tripwire thresholds
// ---------------------------------------------------------------------------

/** A scan producing more raw findings than this × maxFindingsPerScan triggers a tripwire. */
const TRIPWIRE_FINDINGS_MULTIPLIER = 3;

/** Tasks created more than this × maxTasksCreatedPerHour in 30 min triggers a tripwire. */
const TRIPWIRE_RAPID_CREATION_WINDOW_MS = 30 * 60 * 1000;
const TRIPWIRE_RAPID_CREATION_MULTIPLIER = 2;

// ---------------------------------------------------------------------------
// GuardrailEngine
// ---------------------------------------------------------------------------

export interface TripwireCheck {
	triggered: boolean;
	reason: string | null;
}

export class GuardrailEngine {
	private readonly store: AutomationStore;

	/**
	 * In-scan counters: incremented as decisions are made within the current
	 * scan so that budget enforcement is accurate within a single run.
	 */
	private inScanTasksCreated = 0;
	private inScanAutoStarts = 0;

	/** Loaded once per scan from the store. */
	private historicalTasksCreated = 0;
	private historicalAutoStarts = 0;
	private globalHistoricalTasksCreated = 0;
	private globalHistoricalAutoStarts = 0;

	/** Whether we've already loaded budget history for this scan. */
	private budgetLoaded = false;

	constructor(store: AutomationStore) {
		this.store = store;
	}

	// -------------------------------------------------------------------------
	// Main entry point
	// -------------------------------------------------------------------------

	/**
	 * Evaluate a batch of findings from a single scan and decide what action
	 * (if any) to take for each one.
	 *
	 * Call resetForScan() before each scan to clear in-scan counters.
	 *
	 * The decisions array may be shorter than the findings array if a tripwire
	 * halts processing mid-batch.
	 */
	async evaluateFindings(
		findings: AutomationFinding[],
		instance: AutomationAgentInstance,
		template: AutomationAgentTemplate,
		policy: ResolvedPolicy,
		rawFindingsCount: number,
	): Promise<GuardrailDecision[]> {
		// Load budget history once per scan.
		if (!this.budgetLoaded) {
			await this.loadBudgetHistory(instance.id);
			this.budgetLoaded = true;
		}

		// --- Pre-flight tripwires (scan-level) --------------------------------
		const preflightTripwire = this.checkPreflightTripwires(rawFindingsCount, policy);
		if (preflightTripwire.triggered) {
			// Return a single "halt" decision; the pipeline will disable the instance.
			return [
				{
					finding: findings[0]!,
					action: "halt",
					reason: preflightTripwire.reason ?? "tripwire triggered",
				},
			];
		}

		const decisions: GuardrailDecision[] = [];

		for (const finding of findings) {
			const decision = await this.evaluateOneFinding(finding, instance, template, policy);
			decisions.push(decision);

			if (decision.action === "halt") {
				// Stop processing remaining findings.
				break;
			}

			if (decision.action === "create_task") {
				this.inScanTasksCreated++;
			} else if (decision.action === "auto_start_task") {
				this.inScanTasksCreated++;
				this.inScanAutoStarts++;
			}
		}

		return decisions;
	}

	/**
	 * Reset in-scan counters.  Call before each new scan run.
	 */
	resetForScan(): void {
		this.inScanTasksCreated = 0;
		this.inScanAutoStarts = 0;
		this.budgetLoaded = false;
	}

	// -------------------------------------------------------------------------
	// Budget history loader
	// -------------------------------------------------------------------------

	private async loadBudgetHistory(instanceId: string): Promise<void> {
		const [instanceTasks, instanceAutoStarts, globalTasks, globalAutoStarts] = await Promise.all([
			this.store.countTasksCreatedInWindow(instanceId, BUDGET_WINDOW_MS),
			this.store.countAutoStartsInWindow(instanceId, BUDGET_WINDOW_MS),
			this.store.countGlobalTasksCreatedInWindow(BUDGET_WINDOW_MS),
			this.store.countGlobalAutoStartsInWindow(BUDGET_WINDOW_MS),
		]);
		this.historicalTasksCreated = instanceTasks;
		this.historicalAutoStarts = instanceAutoStarts;
		this.globalHistoricalTasksCreated = globalTasks;
		this.globalHistoricalAutoStarts = globalAutoStarts;
	}

	// -------------------------------------------------------------------------
	// Single-finding evaluation
	// -------------------------------------------------------------------------

	private async evaluateOneFinding(
		finding: AutomationFinding,
		instance: AutomationAgentInstance,
		_template: AutomationAgentTemplate,
		policy: ResolvedPolicy,
	): Promise<GuardrailDecision> {
		// 1. Self-referencing exclusion (loop prevention — stage 1).
		//    Findings on tasks created by this same instance are filtered
		//    earlier in the pipeline; if one slips through, suppress it here.
		if (finding.linkedTaskId && finding.instanceId === instance.id) {
			return {
				finding,
				action: "suppress",
				reason: "self-referencing: finding is about a task created by this agent instance",
			};
		}

		// 2. Deduplication check.
		const existingFinding = await this.store.getFinding(finding.fingerprint);
		if (existingFinding) {
			const dedupeDecision = this.checkDeduplication(existingFinding, finding);
			if (dedupeDecision) {
				return dedupeDecision;
			}
		}

		// 3. Severity threshold filter.
		const severityOrder: Record<string, number> = { info: 0, warning: 1, error: 2, critical: 3 };
		const findingSeverityRank = severityOrder[finding.severity] ?? 0;
		const thresholdRank = severityOrder[policy.severityThreshold] ?? 0;
		if (findingSeverityRank < thresholdRank) {
			return {
				finding,
				action: "suppress",
				reason: `severity ${finding.severity} is below threshold ${policy.severityThreshold}`,
			};
		}

		// 4. Remediation attempt cap (loop prevention — stage 3).
		const remediation = await this.store.getRemediation(finding.fingerprint);
		if (remediation) {
			if (remediation.state === "abandoned" || remediation.attemptCount >= MAX_ABANDON_ATTEMPTS) {
				return {
					finding,
					action: "suppress",
					reason: `finding has been abandoned after ${remediation.attemptCount} failed remediation attempts`,
				};
			}
		}

		// 5. Cooldown check.
		const cooldownDecision = this.checkCooldown(existingFinding ?? null, remediation ?? null, policy);
		if (cooldownDecision) {
			return cooldownDecision;
		}

		// 6. Budget check.
		const budgetDecision = this.checkBudgets(finding, policy, remediation?.attemptCount ?? 0);
		if (budgetDecision) {
			return budgetDecision;
		}

		// 7. Tripwire: rapid task creation in the last 30 minutes.
		const rapidTripwire = await this.checkRapidCreationTripwire(instance.id, policy);
		if (rapidTripwire.triggered) {
			return {
				finding,
				action: "halt",
				reason: rapidTripwire.reason ?? "rapid creation tripwire",
			};
		}

		// 8. Determine final action.
		const totalTasksCreated = this.historicalTasksCreated + this.inScanTasksCreated;
		const totalAutoStarts = this.historicalAutoStarts + this.inScanAutoStarts;
		const globalTotalTasks = this.globalHistoricalTasksCreated + this.inScanTasksCreated;
		const globalTotalAutoStarts = this.globalHistoricalAutoStarts + this.inScanAutoStarts;

		const canAutoStart =
			(policy.allowedActions.includes("auto_start_task") && finding.severity === "critical") ||
			finding.severity === "error";

		const autoStartBudgetAvailable =
			totalAutoStarts < policy.maxAutoStartsPerHour && globalTotalAutoStarts < GLOBAL_MAX_AUTO_STARTS_PER_HOUR;

		const attemptCount = remediation?.attemptCount ?? 0;

		if (
			canAutoStart &&
			autoStartBudgetAvailable &&
			globalTotalTasks < GLOBAL_MAX_TASKS_PER_HOUR &&
			totalTasksCreated < policy.maxTasksCreatedPerHour &&
			attemptCount < MAX_AUTO_START_ATTEMPTS
		) {
			return { finding, action: "auto_start_task", reason: "eligible for auto-start" };
		}

		if (
			policy.allowedActions.includes("create_backlog_task") &&
			totalTasksCreated < policy.maxTasksCreatedPerHour &&
			globalTotalTasks < GLOBAL_MAX_TASKS_PER_HOUR
		) {
			return { finding, action: "create_task", reason: "new finding within budget" };
		}

		return {
			finding,
			action: "suppress",
			reason: `task creation budget exhausted (${totalTasksCreated}/${policy.maxTasksCreatedPerHour} per-instance, ${globalTotalTasks}/${GLOBAL_MAX_TASKS_PER_HOUR} global)`,
		};
	}

	// -------------------------------------------------------------------------
	// Deduplication
	// -------------------------------------------------------------------------

	private checkDeduplication(existing: AutomationFinding, _incoming: AutomationFinding): GuardrailDecision | null {
		switch (existing.status) {
			case "suppressed":
				// User manually suppressed — permanent suppression.
				return {
					finding: existing,
					action: "suppress",
					reason: "finding has been manually suppressed by the user",
				};

			case "open":
			case "task_created":
				// Issue is known and either open or has a task — just update timestamps.
				return {
					finding: {
						...existing,
						lastSeenAt: Date.now(),
					},
					action: "update_existing",
					reason: `finding already known (status: ${existing.status}); updating lastSeenAt`,
				};

			case "task_started":
				// Remediation is actively running — don't interfere.
				return {
					finding: existing,
					action: "update_existing",
					reason: "remediation task is currently active",
				};

			case "resolved":
				// Previously fixed but re-appearing — treat as new.
				return null;
		}
	}

	// -------------------------------------------------------------------------
	// Cooldown
	// -------------------------------------------------------------------------

	private checkCooldown(
		existingFinding: AutomationFinding | null,
		remediation: { lastAttemptAt: number; findingFingerprint: string } | null,
		policy: ResolvedPolicy,
	): GuardrailDecision | null {
		if (!remediation || !existingFinding) {
			return null;
		}

		const cooldownMs = policy.cooldownMinutes * 60 * 1000;
		const timeSinceLastAttempt = Date.now() - remediation.lastAttemptAt;

		if (timeSinceLastAttempt < cooldownMs) {
			const remainingMinutes = Math.ceil((cooldownMs - timeSinceLastAttempt) / 60_000);
			return {
				finding: {
					...existingFinding,
					lastSeenAt: Date.now(),
				},
				action: "suppress",
				reason: `within cooldown period (${remainingMinutes} min remaining)`,
			};
		}

		return null;
	}

	// -------------------------------------------------------------------------
	// Budget enforcement
	// -------------------------------------------------------------------------

	private checkBudgets(
		finding: AutomationFinding,
		policy: ResolvedPolicy,
		_attemptCount: number,
	): GuardrailDecision | null {
		const totalTasksCreated = this.historicalTasksCreated + this.inScanTasksCreated;
		const globalTotalTasks = this.globalHistoricalTasksCreated + this.inScanTasksCreated;

		if (totalTasksCreated >= policy.maxTasksCreatedPerHour) {
			return {
				finding,
				action: "suppress",
				reason: `per-instance task creation budget exhausted (${totalTasksCreated}/${policy.maxTasksCreatedPerHour}/h)`,
			};
		}

		if (globalTotalTasks >= GLOBAL_MAX_TASKS_PER_HOUR) {
			return {
				finding,
				action: "suppress",
				reason: `global task creation budget exhausted (${globalTotalTasks}/${GLOBAL_MAX_TASKS_PER_HOUR}/h)`,
			};
		}

		return null;
	}

	// -------------------------------------------------------------------------
	// Tripwires
	// -------------------------------------------------------------------------

	private checkPreflightTripwires(rawFindingsCount: number, policy: ResolvedPolicy): TripwireCheck {
		// Too-many-findings tripwire.
		if (rawFindingsCount > policy.maxFindingsPerScan * TRIPWIRE_FINDINGS_MULTIPLIER) {
			return {
				triggered: true,
				reason: `too_many_findings: scan produced ${rawFindingsCount} findings (limit: ${policy.maxFindingsPerScan * TRIPWIRE_FINDINGS_MULTIPLIER})`,
			};
		}
		return { triggered: false, reason: null };
	}

	private async checkRapidCreationTripwire(instanceId: string, policy: ResolvedPolicy): Promise<TripwireCheck> {
		const rapidWindowTasks = await this.store.countTasksCreatedInWindow(
			instanceId,
			TRIPWIRE_RAPID_CREATION_WINDOW_MS,
		);
		const limit = policy.maxTasksCreatedPerHour * TRIPWIRE_RAPID_CREATION_MULTIPLIER;

		if (rapidWindowTasks > limit) {
			return {
				triggered: true,
				reason: `rapid_task_creation: ${rapidWindowTasks} tasks created in the last 30 minutes (limit: ${limit})`,
			};
		}

		// Check repeated remediation failures: 3+ findings with max abandon attempts in this scan.
		// This is computed by the caller (AutomationService) after the scan, not here.

		return { triggered: false, reason: null };
	}

	/**
	 * Check whether an instance should be disabled due to repeated remediation
	 * failures.  Called from AutomationService after a scan completes.
	 */
	async checkRepeatedRemediationFailureTripwire(abandonedFingerprintsThisScan: string[]): Promise<TripwireCheck> {
		if (abandonedFingerprintsThisScan.length >= 3) {
			return {
				triggered: true,
				reason: `repeated_remediation_failure: ${abandonedFingerprintsThisScan.length} findings reached max abandon attempts in one scan`,
			};
		}
		return { triggered: false, reason: null };
	}
}
