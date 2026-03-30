/**
 * Core domain types for the Kanban Automation Agent Platform.
 *
 * All automation agents — Quality Enforcer, Dependency Updater, etc. —
 * share these types.  The schemas are used for validation, persistence,
 * and TRPC serialization.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Agent Template — the "class" definition for an agent type
// ---------------------------------------------------------------------------

/**
 * The set of actions an agent or agent instance is allowed to take on the board.
 */
export const automationActionSchema = z.enum([
	"create_backlog_task",
	"schedule_task",
	"auto_start_task",
	"link_to_existing_task",
	"add_finding_comment",
]);
export type AutomationAction = z.infer<typeof automationActionSchema>;

/**
 * Severity levels for findings, from least to most urgent.
 *
 * - info:     Observation only; no action taken unless policy is aggressive.
 * - warning:  Worth noting; may create a backlog task.
 * - error:    Concrete failure; should create a task.
 * - critical: Urgent failure; eligible for auto-start remediation.
 */
export const findingSeveritySchema = z.enum(["info", "warning", "error", "critical"]);
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;

/**
 * Default policy values embedded in an AutomationAgentTemplate.
 * Instances can override individual fields; the resolved policy merges both.
 */
export const automationAgentDefaultPolicySchema = z.object({
	/** How often the agent scans, in seconds. */
	scanIntervalSeconds: z.number().int().positive(),
	/** Maximum raw findings per scan before stopping rule evaluation. */
	maxFindingsPerScan: z.number().int().positive(),
	/** Maximum tasks the agent may create in any rolling 60-minute window. */
	maxTasksCreatedPerHour: z.number().int().positive(),
	/** Maximum tasks the agent may auto-start in any rolling 60-minute window. */
	maxAutoStartsPerHour: z.number().int().nonnegative(),
	/** Minimum minutes to wait before re-acting on the same fingerprint. */
	cooldownMinutes: z.number().int().positive(),
	/** Findings below this severity level are ignored. */
	severityThreshold: findingSeveritySchema,
});
export type AutomationAgentDefaultPolicy = z.infer<typeof automationAgentDefaultPolicySchema>;

/**
 * An AutomationAgentTemplate defines what an agent type *is*: its identity,
 * the rules it evaluates, and the action repertoire it has.  Templates are
 * registered at boot time and are immutable at runtime.  Users create
 * *instances* of templates to activate them for specific projects.
 */
export const automationAgentTemplateSchema = z.object({
	/** Unique slug identifier, e.g. "quality-enforcer", "dependency-updater". */
	id: z.string().min(1),
	/** Human-readable display name. */
	name: z.string().min(1),
	/** One-paragraph description of what this agent does. */
	description: z.string(),
	/** Semantic version of this template definition. */
	version: z.string().default("1.0.0"),
	/** IDs of the detection rules this agent evaluates.  Order matters —
	 *  rules are evaluated in sequence and the pipeline short-circuits on
	 *  budget exhaustion. */
	ruleIds: z.array(z.string()),
	/** The set of actions this template's instances are *allowed* to take.
	 *  Instance-level policy can only restrict, never expand, this set. */
	allowedActions: z.array(automationActionSchema),
	/** Default policy values.  Instances inherit these unless overridden. */
	defaultPolicy: automationAgentDefaultPolicySchema,
});
export type AutomationAgentTemplate = z.infer<typeof automationAgentTemplateSchema>;

// ---------------------------------------------------------------------------
// Agent Instance — a configured, scoped activation of a template
// ---------------------------------------------------------------------------

/**
 * Policy fields that an instance can override from the template defaults.
 * All fields are optional; only present fields override the template default.
 */
export const automationInstancePolicyOverridesSchema = z.object({
	scanIntervalSeconds: z.number().int().positive().optional(),
	maxFindingsPerScan: z.number().int().positive().optional(),
	maxTasksCreatedPerHour: z.number().int().positive().optional(),
	maxAutoStartsPerHour: z.number().int().nonnegative().optional(),
	cooldownMinutes: z.number().int().positive().optional(),
	severityThreshold: findingSeveritySchema.optional(),
	/** Actions this instance is restricted to (must be subset of template's
	 *  allowedActions).  null = use template's full set. */
	allowedActions: z.array(automationActionSchema).nullable().optional(),
});
export type AutomationInstancePolicyOverrides = z.infer<typeof automationInstancePolicyOverridesSchema>;

/**
 * An AutomationAgentInstance is a running (or paused) copy of a template,
 * scoped to one or more projects.  It stores the user's policy overrides
 * and the runtime state needed for scheduling and budgeting.
 */
export const automationAgentInstanceSchema = z.object({
	/** Unique instance ID (UUID). */
	id: z.string().uuid(),
	/** The template this instance was created from. */
	templateId: z.string().min(1),
	/** Human-readable label, e.g. "Quality Enforcer — kanban". */
	label: z.string().min(1),
	/** Project paths this instance is scoped to.  Empty = all indexed projects. */
	projectPaths: z.array(z.string()),
	/** Whether this instance is actively scanning. */
	enabled: z.boolean(),
	/** Policy overrides.  Merged with the template's defaultPolicy at runtime.
	 *  Only the keys present here override the template defaults. */
	policyOverrides: automationInstancePolicyOverridesSchema.optional(),
	/** When this instance was created.  Unix ms. */
	createdAt: z.number(),
	/** When this instance was last modified.  Unix ms. */
	updatedAt: z.number(),
});
export type AutomationAgentInstance = z.infer<typeof automationAgentInstanceSchema>;

// ---------------------------------------------------------------------------
// Resolved Policy — template defaults merged with instance overrides
// ---------------------------------------------------------------------------

/**
 * The fully resolved policy for an agent instance.  Produced by the
 * policy resolver by merging the template's defaultPolicy with the
 * instance's policyOverrides.  This is the object the guardrail engine
 * and pipeline use at runtime.
 */
export const resolvedPolicySchema = z.object({
	scanIntervalSeconds: z.number().int().positive(),
	maxFindingsPerScan: z.number().int().positive(),
	maxTasksCreatedPerHour: z.number().int().positive(),
	maxAutoStartsPerHour: z.number().int().nonnegative(),
	cooldownMinutes: z.number().int().positive(),
	severityThreshold: findingSeveritySchema,
	allowedActions: z.array(automationActionSchema),
});
export type ResolvedPolicy = z.infer<typeof resolvedPolicySchema>;

// ---------------------------------------------------------------------------
// Finding — a detected issue from a scan
// ---------------------------------------------------------------------------

/**
 * A Finding is a normalized quality/issue report produced by a detection
 * rule during a scan.  Findings carry a stable fingerprint so the guardrail
 * system can deduplicate and apply cooldowns across scans.
 *
 * Findings are the bridge between detection and action.  The pipeline
 * creates findings; the guardrail system decides what to do with them.
 */
export const automationFindingSchema = z.object({
	/** Unique ID for this specific finding occurrence (UUID). */
	id: z.string().uuid(),
	/** Stable content-based fingerprint for deduplication.
	 *  Same root cause → same fingerprint across scans.
	 *  Built from: ruleId + projectPath + normalized evidence key. */
	fingerprint: z.string().min(1),
	/** The detection rule that produced this finding. */
	ruleId: z.string().min(1),
	/** Which agent instance produced this finding. */
	instanceId: z.string().uuid(),
	/** The template the instance belongs to. */
	templateId: z.string().min(1),
	/** Project path where the finding was detected. */
	projectPath: z.string(),
	/** Severity as assessed by the detection rule. */
	severity: findingSeveritySchema,
	/** Short human-readable title, suitable for a Kanban card title.
	 *  e.g. "Failing tests in src/server/job-queue-service.ts" */
	title: z.string().min(1),
	/** Longer description with evidence details. */
	description: z.string(),
	/** Category tag for grouping, e.g. "failing-tests", "missing-coverage",
	 *  "lint-errors", "type-errors", "stale-review". */
	category: z.string().min(1),
	/** Affected file paths, if applicable. */
	affectedFiles: z.array(z.string()),
	/** Raw evidence: command output, diff excerpts, etc.
	 *  Stored as a key-value map so different rule types can attach
	 *  different evidence without a rigid schema. */
	evidence: z.record(z.string(), z.string()),
	/** When this finding was first detected.  Unix ms. */
	firstSeenAt: z.number(),
	/** When this finding was most recently detected.  Unix ms. */
	lastSeenAt: z.number(),
	/** Lifecycle status of the finding. */
	status: z.enum(["open", "task_created", "task_started", "resolved", "suppressed"]),
	/** If a task was created for this finding, the Kanban task ID. */
	linkedTaskId: z.string().nullable(),
});
export type AutomationFinding = z.infer<typeof automationFindingSchema>;

// ---------------------------------------------------------------------------
// Remediation Record — tracks what happened after a finding
// ---------------------------------------------------------------------------

/**
 * A RemediationRecord tracks the lifecycle of a finding-to-task action.
 * It answers: "we found issue X, we created task Y — did it work?"
 */
export const remediationRecordSchema = z.object({
	/** Finding fingerprint this remediation addresses. */
	findingFingerprint: z.string().min(1),
	/** The Kanban task ID created for remediation. */
	taskId: z.string(),
	/** When the remediation task was created.  Unix ms. */
	createdAt: z.number(),
	/** When the last attempt was made (task started or restarted).  Unix ms. */
	lastAttemptAt: z.number(),
	/** How many times a remediation task has been started for this finding. */
	attemptCount: z.number().int().nonnegative(),
	/** Current state of remediation. */
	state: z.enum(["pending", "active", "resolved", "abandoned"]),
});
export type RemediationRecord = z.infer<typeof remediationRecordSchema>;

// ---------------------------------------------------------------------------
// Detection Rule — defines how to detect a specific kind of issue
// ---------------------------------------------------------------------------

/**
 * A DetectionRule defines one specific check that can be evaluated during
 * a scan.  Rules are registered in the rule catalog and referenced by
 * agent templates via ruleIds.
 *
 * Rules are split into two tiers:
 * - deterministic: runs a shell command and inspects the exit code / output.
 * - heuristic: invokes an LLM or agent for deeper analysis (more expensive,
 *   subject to stricter budget controls).
 */
export const detectionRuleSchema = z.object({
	/** Unique rule identifier, e.g. "failing-tests", "missing-test-coverage". */
	id: z.string().min(1),
	/** Human-readable name. */
	name: z.string().min(1),
	/** Description of what this rule detects. */
	description: z.string(),
	/** Whether this rule is deterministic (cheap shell command) or heuristic
	 *  (requires LLM invocation). */
	tier: z.enum(["deterministic", "heuristic"]),
	/** The category tag to assign to findings from this rule. */
	category: z.string().min(1),
	/** Default severity for findings from this rule.
	 *  Can be overridden by the rule's evaluate function based on evidence. */
	defaultSeverity: findingSeveritySchema,
	/** How to build the finding fingerprint from evidence.
	 *  A template string with {{placeholders}} that are filled from evidence keys.
	 *  e.g. "failing-tests:{{projectPath}}:{{testSuite}}" */
	fingerprintTemplate: z.string().min(1),
	/** Template for the Kanban task title when a finding triggers task creation. */
	taskTitleTemplate: z.string().min(1),
	/** Template for the Kanban task prompt/description. */
	taskPromptTemplate: z.string().min(1),
	/** Whether findings from this rule are eligible for auto-start remediation. */
	autoStartEligible: z.boolean(),
	/** Minimum cooldown override for this rule, in minutes.
	 *  If set, overrides the instance-level cooldown for findings from this rule. */
	minCooldownMinutes: z.number().int().positive().nullable(),
});
export type DetectionRule = z.infer<typeof detectionRuleSchema>;

// ---------------------------------------------------------------------------
// Scan Run — a record of one automation scan execution
// ---------------------------------------------------------------------------

/**
 * A ScanRun records what happened during one invocation of an agent's
 * detection pipeline.  It's the primary unit of the audit trail.
 */
export const scanRunSchema = z.object({
	/** Unique run ID (UUID). */
	id: z.string().uuid(),
	/** The agent instance that ran this scan. */
	instanceId: z.string().uuid(),
	/** Template used. */
	templateId: z.string(),
	/** When the scan started.  Unix ms. */
	startedAt: z.number(),
	/** When the scan completed.  Unix ms.  null if still running. */
	completedAt: z.number().nullable(),
	/** Projects scanned in this run. */
	projectsScanned: z.array(z.string()),
	/** Rules evaluated. */
	rulesEvaluated: z.array(z.string()),
	/** Total findings produced (before dedup/budget filtering). */
	rawFindingsCount: z.number().int().nonnegative(),
	/** Findings after dedup/budget filtering. */
	newFindingsCount: z.number().int().nonnegative(),
	/** Findings suppressed by dedup/cooldown/budget. */
	suppressedCount: z.number().int().nonnegative(),
	/** Tasks created in response to findings. */
	tasksCreated: z.number().int().nonnegative(),
	/** Tasks auto-started. */
	tasksAutoStarted: z.number().int().nonnegative(),
	/** Whether a tripwire was triggered during this scan. */
	tripwireTriggered: z.boolean(),
	/** If tripwire triggered, which one. */
	tripwireReason: z.string().nullable(),
	/** Run outcome. */
	outcome: z.enum(["success", "partial", "tripwire_halt", "error"]),
	/** Error message if outcome is "error". */
	errorMessage: z.string().nullable(),
});
export type ScanRun = z.infer<typeof scanRunSchema>;

// ---------------------------------------------------------------------------
// Audit Event — a record of one significant automation action
// ---------------------------------------------------------------------------

/**
 * An AutomationAuditEvent is emitted for every significant action the
 * automation platform takes.  Events are append-only and surfaced in the
 * audit timeline UI.
 */
export const automationAuditEventSchema = z.object({
	/** Unique event ID (UUID). */
	id: z.string().uuid(),
	/** When this event occurred.  Unix ms. */
	timestamp: z.number(),
	/** The agent instance that produced this event. */
	instanceId: z.string().uuid(),
	/** The template the instance belongs to. */
	templateId: z.string(),
	/** Type of event. */
	eventType: z.enum([
		"scan_started",
		"scan_completed",
		"finding_detected",
		"finding_suppressed_dedup",
		"finding_suppressed_cooldown",
		"finding_suppressed_budget",
		"task_created",
		"task_auto_started",
		"remediation_attempted",
		"remediation_resolved",
		"remediation_abandoned",
		"tripwire_triggered",
		"instance_enabled",
		"instance_disabled",
		"instance_deleted",
		"manual_scan_triggered",
		"finding_manually_suppressed",
		"finding_manually_unsuppressed",
	]),
	/** Structured context for this event. */
	details: z.record(z.string(), z.unknown()),
});
export type AutomationAuditEvent = z.infer<typeof automationAuditEventSchema>;

// ---------------------------------------------------------------------------
// Guardrail Decision — the output of the guardrail engine for one finding
// ---------------------------------------------------------------------------

/**
 * The action the guardrail engine decided to take for a given finding.
 *
 * - create_task:     Create a new backlog card for this finding.
 * - auto_start_task: Create and immediately start a task.
 * - update_existing: Finding already has a task; only update lastSeenAt.
 * - suppress:        Finding blocked by budget / cooldown / dedup.
 * - halt:            Tripwire triggered; stop the entire scan immediately.
 */
export type GuardrailDecisionAction = "create_task" | "auto_start_task" | "update_existing" | "suppress" | "halt";

export interface GuardrailDecision {
	finding: AutomationFinding;
	action: GuardrailDecisionAction;
	/** Human-readable reason — recorded in the audit trail. */
	reason: string;
}

// ---------------------------------------------------------------------------
// Raw Finding — pre-normalization output from a rule evaluator
// ---------------------------------------------------------------------------

/**
 * Output from a rule's evaluate() call.  The pipeline normalizes this into
 * a full AutomationFinding with fingerprint, id, and timestamps.
 */
export interface RawFinding {
	/** ID of the rule that produced this finding. */
	ruleId: string;
	/** Severity of this occurrence. */
	severity: FindingSeverity;
	/** Short title suitable for a Kanban card title. */
	title: string;
	/** Longer description with evidence details. */
	description: string;
	/** Files implicated by this finding. */
	affectedFiles: string[];
	/** Key→value evidence map (command output excerpts, counts, etc.). */
	evidence: Record<string, string>;
	/**
	 * Values used to fill the fingerprint template placeholders.
	 * e.g. { testFile: "src/foo.test.ts", projectPath: "/Users/..." }
	 */
	fingerprintVars: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Scan Context — the execution context for a single scan pass
// ---------------------------------------------------------------------------

/**
 * Passed through all pipeline stages.  Contains the resolved configuration,
 * collected evidence, and intermediate results.
 */
export interface ScanContext {
	/** Unique run ID — set at stage 1, recorded in the ScanRun. */
	runId: string;
	/** The agent instance driving this scan. */
	instance: AutomationAgentInstance;
	/** The template the instance was created from. */
	template: AutomationAgentTemplate;
	/** Fully resolved policy (template defaults + instance overrides). */
	policy: ResolvedPolicy;
	/** Unix ms when the scan started. */
	startedAt: number;
	/** Projects and their scope data, populated by Stage 1. */
	projectScopes: ProjectScope[];
	/** Evidence gathered by Stage 2.  Keyed by projectPath → evidenceId → value. */
	evidence: Map<string, Map<string, string>>;
	/** Raw findings from Stage 3 (before normalization). */
	rawFindings: RawFinding[];
	/** Normalized findings from Stage 4. */
	normalizedFindings: AutomationFinding[];
	/** Guardrail decisions from Stage 5. */
	guardrailDecisions: GuardrailDecision[];
	/** Actions executed in Stage 6. */
	executedActions: Array<{ finding: AutomationFinding; taskId: string; action: string }>;
}

/**
 * Scope information for one project within a scan.
 */
export interface ProjectScope {
	/** Absolute path to the project repository. */
	projectPath: string;
	/** Unix ms of the last scan for this project, or null if never scanned. */
	lastScanAt: number | null;
	/** Approximate count of files changed since last scan.  null if unknown. */
	changedFileCount: number | null;
}
