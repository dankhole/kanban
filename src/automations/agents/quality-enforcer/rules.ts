/**
 * Quality Enforcer — detection rule evaluators.
 *
 * Six rules, ordered cheapest to most expensive:
 *   1. failing-tests           — test suite exits non-zero
 *   2. type-errors             — tsc --noEmit exits non-zero
 *   3. lint-errors             — biome/eslint exits non-zero
 *   4. missing-test-coverage   — source files changed without test files
 *   5. stale-review            — card in review column for >24h
 *   6. repeated-agent-failure  — task restarted 3+ times and still failing
 */
import { basename, dirname, join } from "node:path";
import type { RawFinding } from "../../automation-types";
import type { RuleEvaluator } from "../../rule-catalog";

// ---------------------------------------------------------------------------
// Helper — interpolate a template string with variables
// ---------------------------------------------------------------------------

function interpolate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

// ---------------------------------------------------------------------------
// Rule 1: failing-tests
// ---------------------------------------------------------------------------

const failingTestsEvaluator: RuleEvaluator = {
	rule: {
		id: "failing-tests",
		name: "Failing Tests",
		description: "Detects when the test suite exits with a non-zero exit code.",
		tier: "deterministic",
		category: "failing-tests",
		defaultSeverity: "error",
		fingerprintTemplate: "failing-tests:{{projectPath}}",
		taskTitleTemplate: "Fix failing tests",
		taskPromptTemplate:
			"The test suite is failing in `{{projectPath}}`.\n\n" +
			"**Failing tests:**\n```\n{{failingTests}}\n```\n\n" +
			"**Full test output:**\n```\n{{testOutput}}\n```\n\n" +
			"Please investigate and fix the failing tests.",
		autoStartEligible: true,
		minCooldownMinutes: 30,
	},
	async evaluate(ctx) {
		const exitCode = ctx.evidence.get("test-results.exitCode");
		if (!exitCode || exitCode === "0") {
			return [];
		}

		const testOutput = ctx.evidence.get("test-results.output") ?? "";
		const failingTests = ctx.evidence.get("test-results.failingTests") ?? "";

		const finding: RawFinding = {
			ruleId: "failing-tests",
			severity: "error",
			title: "Fix failing tests",
			description: `The test suite is failing with exit code ${exitCode}.\n\nFailing tests:\n${failingTests}`,
			affectedFiles: [],
			evidence: {
				exitCode,
				testOutput: testOutput.slice(0, 5_000),
				failingTests: failingTests.slice(0, 2_000),
			},
			fingerprintVars: {
				projectPath: ctx.projectPath,
			},
		};

		return [finding];
	},
};

// ---------------------------------------------------------------------------
// Rule 2: type-errors
// ---------------------------------------------------------------------------

const typeErrorsEvaluator: RuleEvaluator = {
	rule: {
		id: "type-errors",
		name: "TypeScript Type Errors",
		description: "Detects TypeScript type errors via tsc --noEmit.",
		tier: "deterministic",
		category: "type-errors",
		defaultSeverity: "error",
		fingerprintTemplate: "type-errors:{{projectPath}}",
		taskTitleTemplate: "Fix {{errorCount}} TypeScript type errors",
		taskPromptTemplate:
			"TypeScript type checking is failing in `{{projectPath}}`.\n\n" +
			"**Error count:** {{errorCount}}\n\n" +
			"**Type checker output:**\n```\n{{typecheckOutput}}\n```\n\n" +
			"Please fix all type errors.",
		autoStartEligible: true,
		minCooldownMinutes: 30,
	},
	async evaluate(ctx) {
		const exitCode = ctx.evidence.get("typecheck-output.exitCode");
		if (!exitCode || exitCode === "0") {
			return [];
		}

		const typecheckOutput = ctx.evidence.get("typecheck-output.output") ?? "";
		const errorCount = ctx.evidence.get("typecheck-output.errorCount") ?? "unknown";

		const finding: RawFinding = {
			ruleId: "type-errors",
			severity: "error",
			title: `Fix ${errorCount} TypeScript type errors`,
			description: `TypeScript type checking failed with ${errorCount} errors.`,
			affectedFiles: [],
			evidence: {
				exitCode,
				typecheckOutput: typecheckOutput.slice(0, 5_000),
				errorCount,
			},
			fingerprintVars: {
				projectPath: ctx.projectPath,
				errorCount,
			},
		};

		return [finding];
	},
};

// ---------------------------------------------------------------------------
// Rule 3: lint-errors
// ---------------------------------------------------------------------------

const lintErrorsEvaluator: RuleEvaluator = {
	rule: {
		id: "lint-errors",
		name: "Lint Errors",
		description: "Detects lint errors via biome check or eslint.",
		tier: "deterministic",
		category: "lint-errors",
		defaultSeverity: "warning",
		fingerprintTemplate: "lint-errors:{{projectPath}}",
		taskTitleTemplate: "Fix {{errorCount}} lint errors",
		taskPromptTemplate:
			"Lint errors detected in `{{projectPath}}`.\n\n" +
			"**Error count:** {{errorCount}}\n\n" +
			"**Lint output:**\n```\n{{lintOutput}}\n```\n\n" +
			"Please fix all lint errors.",
		autoStartEligible: false,
		minCooldownMinutes: 60,
	},
	async evaluate(ctx) {
		const exitCode = ctx.evidence.get("lint-output.exitCode");
		if (!exitCode || exitCode === "0") {
			return [];
		}

		const lintOutput = ctx.evidence.get("lint-output.output") ?? "";
		const errorCount = ctx.evidence.get("lint-output.errorCount") ?? "unknown";

		// Skip if no output (tool not found / no files).
		if (!lintOutput.trim() || lintOutput.includes("no lint command detected")) {
			return [];
		}

		const finding: RawFinding = {
			ruleId: "lint-errors",
			severity: "warning",
			title: `Fix ${errorCount} lint errors`,
			description: `Lint check failed with ${errorCount} errors.`,
			affectedFiles: [],
			evidence: {
				exitCode,
				lintOutput: lintOutput.slice(0, 5_000),
				errorCount,
			},
			fingerprintVars: {
				projectPath: ctx.projectPath,
				errorCount,
			},
		};

		return [finding];
	},
};

// ---------------------------------------------------------------------------
// Rule 4: missing-test-coverage
// ---------------------------------------------------------------------------

const missingTestCoverageEvaluator: RuleEvaluator = {
	rule: {
		id: "missing-test-coverage",
		name: "Missing Test Coverage",
		description: "Detects source files modified without corresponding test file changes.",
		tier: "deterministic",
		category: "missing-coverage",
		defaultSeverity: "warning",
		fingerprintTemplate: "missing-coverage:{{projectPath}}:{{sourceFile}}",
		taskTitleTemplate: "Add tests for {{sourceFile}}",
		taskPromptTemplate:
			"The file `{{sourceFile}}` was modified but no corresponding test file was updated.\n\n" +
			"**Changed file:** `{{sourceFile}}`\n" +
			"**Expected test file location(s):**\n{{expectedTestFiles}}\n\n" +
			"Please add or update tests for this change.",
		autoStartEligible: false,
		minCooldownMinutes: 120,
	},
	async evaluate(ctx) {
		const changedFiles = ctx.evidence.get("git-diff-stat.changedFiles") ?? "";
		if (!changedFiles.trim()) {
			return [];
		}

		const sourceFiles = changedFiles
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l && !l.includes(".test.") && !l.includes(".spec.") && /\.[jt]sx?$/.test(l));

		const testFiles = new Set(
			changedFiles
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l && (l.includes(".test.") || l.includes(".spec."))),
		);

		const findings: RawFinding[] = [];

		for (const sourceFile of sourceFiles.slice(0, 10)) {
			// Check if there's a corresponding test file change.
			const base = basename(sourceFile).replace(/\.[jt]sx?$/, "");
			const dir = dirname(sourceFile);
			const expectedTestFiles = [
				join(dir, `${base}.test.ts`),
				join(dir, `${base}.spec.ts`),
				join(dir, "__tests__", `${base}.ts`),
				join("test", sourceFile.replace(/^src\//, "").replace(/\.[jt]sx?$/, ".test.ts")),
			];

			const hasCoverage = expectedTestFiles.some((tf) => testFiles.has(tf));
			if (!hasCoverage) {
				findings.push({
					ruleId: "missing-test-coverage",
					severity: "warning",
					title: `Add tests for ${base}`,
					description: `\`${sourceFile}\` was modified but no corresponding test file was updated.`,
					affectedFiles: [sourceFile],
					evidence: {
						sourceFile,
						expectedTestFiles: expectedTestFiles.join("\n"),
					},
					fingerprintVars: {
						projectPath: ctx.projectPath,
						sourceFile,
					},
				});
			}
		}

		return findings;
	},
};

// ---------------------------------------------------------------------------
// Rule 5: stale-review
// ---------------------------------------------------------------------------

const staleReviewEvaluator: RuleEvaluator = {
	rule: {
		id: "stale-review",
		name: "Stale Review Task",
		description: "Detects tasks that have been in the review column for more than 24 hours.",
		tier: "deterministic",
		category: "stale-review",
		defaultSeverity: "info",
		fingerprintTemplate: "stale-review:{{projectPath}}:{{taskId}}",
		taskTitleTemplate: "Review stale task: {{taskTitle}}",
		taskPromptTemplate:
			"Task `{{taskId}}` has been awaiting review for {{hoursStale}} hours.\n\n" +
			"**Task:** {{taskTitle}}\n\n" +
			"Please review and either approve, request changes, or move it back to in-progress.",
		autoStartEligible: false,
		minCooldownMinutes: 360, // 6 hours
	},
	async evaluate(ctx) {
		const reviewCardsJson = ctx.evidence.get("board-state.reviewCards") ?? "[]";
		let reviewCards: Array<{ id: string; prompt: string; updatedAt: number }> = [];

		try {
			reviewCards = JSON.parse(reviewCardsJson) as typeof reviewCards;
		} catch {
			return [];
		}

		const staleThresholdMs = 24 * 60 * 60 * 1000;
		const findings: RawFinding[] = [];

		for (const card of reviewCards) {
			const staleMs = Date.now() - card.updatedAt;
			if (staleMs > staleThresholdMs) {
				const hoursStale = Math.floor(staleMs / (60 * 60 * 1000));
				const taskTitle = card.prompt.slice(0, 80).replace(/\n/g, " ");

				findings.push({
					ruleId: "stale-review",
					severity: "info",
					title: `Review stale task: ${taskTitle}`,
					description: `Task has been awaiting review for ${hoursStale} hours.`,
					affectedFiles: [],
					evidence: {
						taskId: card.id,
						taskTitle,
						hoursStale: String(hoursStale),
					},
					fingerprintVars: {
						projectPath: ctx.projectPath,
						taskId: card.id,
					},
				});
			}
		}

		return findings;
	},
};

// ---------------------------------------------------------------------------
// Rule 6: repeated-agent-failure
// ---------------------------------------------------------------------------

const repeatedAgentFailureEvaluator: RuleEvaluator = {
	rule: {
		id: "repeated-agent-failure",
		name: "Repeated Agent Failure",
		description: "Detects tasks that have been restarted multiple times and keep failing.",
		tier: "deterministic",
		category: "repeated-failure",
		defaultSeverity: "warning",
		fingerprintTemplate: "repeated-failure:{{projectPath}}:{{taskId}}",
		taskTitleTemplate: "Investigate repeated failures on: {{taskTitle}}",
		taskPromptTemplate:
			"Task `{{taskId}}` has failed or been interrupted repeatedly.\n\n" +
			"**Task:** {{taskTitle}}\n" +
			"**Failure state:** {{sessionState}}\n\n" +
			"Please investigate why this task keeps failing and determine if the prompt needs to be clarified.",
		autoStartEligible: false,
		minCooldownMinutes: 240, // 4 hours
	},
	async evaluate(ctx) {
		const inProgressCardsJson = ctx.evidence.get("board-state.inProgressCards") ?? "[]";
		const sessionsJson = ctx.evidence.get("board-state.sessionsJson") ?? "{}";

		let inProgressCards: Array<{
			id: string;
			prompt: string;
			sessionState?: string;
			startedAt?: number;
		}> = [];

		try {
			inProgressCards = JSON.parse(inProgressCardsJson) as typeof inProgressCards;
		} catch {
			return [];
		}

		let sessions: Record<string, { state?: string; startedAt?: number }> = {};
		try {
			sessions = JSON.parse(sessionsJson) as typeof sessions;
		} catch {
			// Use what we have from inProgressCards.
		}

		const findings: RawFinding[] = [];

		for (const card of inProgressCards) {
			const session = sessions[card.id] ?? { state: card.sessionState };
			const state = session.state ?? card.sessionState ?? "unknown";

			if (state === "failed" || state === "interrupted") {
				const taskTitle = card.prompt.slice(0, 80).replace(/\n/g, " ");

				findings.push({
					ruleId: "repeated-agent-failure",
					severity: "warning",
					title: `Investigate repeated failures on: ${taskTitle}`,
					description: `Task has failed or been interrupted (state: ${state}).`,
					affectedFiles: [],
					evidence: {
						taskId: card.id,
						taskTitle,
						sessionState: state,
					},
					fingerprintVars: {
						projectPath: ctx.projectPath,
						taskId: card.id,
					},
				});
			}
		}

		return findings;
	},
};

// ---------------------------------------------------------------------------
// Export all evaluators
// ---------------------------------------------------------------------------

export const qualityEnforcerRules: RuleEvaluator[] = [
	failingTestsEvaluator,
	typeErrorsEvaluator,
	lintErrorsEvaluator,
	missingTestCoverageEvaluator,
	staleReviewEvaluator,
	repeatedAgentFailureEvaluator,
];

// Re-export the interpolate helper for use in the pipeline.
export { interpolate };
