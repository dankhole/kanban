/**
 * RuleCatalog — registry of RuleEvaluator implementations.
 *
 * Detection rules are registered at Kanban boot time alongside their parent
 * template.  The detection pipeline looks up evaluators by rule ID when it
 * runs.  Rules that are referenced by a template but missing from the
 * catalog cause a runtime error at scan time (configuration mistake).
 *
 * Rule evaluators are the extension points for adding new quality checks.
 * Each evaluator receives collected evidence for one project and returns
 * zero or more RawFinding objects.
 */

import type { RuntimeBoardCard, RuntimeTaskSessionSummary } from "../core/api-contract";
import type { DetectionRule, RawFinding } from "./automation-types";

// ---------------------------------------------------------------------------
// RuleEvaluator interface
// ---------------------------------------------------------------------------

/**
 * Context passed to a rule's evaluate() function.
 */
export interface RuleEvaluationContext {
	/** Absolute path to the project being scanned. */
	projectPath: string;
	/**
	 * Evidence gathered by the evidence collectors.
	 * Key = collector ID (e.g. "test-results", "lint-output").
	 * Value = the raw string output from the collector.
	 */
	evidence: Map<string, string>;
	/**
	 * Current board state for the project's workspace.
	 * Used by board-state rules (stale-review, repeated-agent-failure).
	 */
	boardState: {
		cards: RuntimeBoardCard[];
		sessions: Record<string, RuntimeTaskSessionSummary>;
	};
}

/**
 * A RuleEvaluator pairs a DetectionRule definition (metadata + templates)
 * with a concrete evaluate() implementation.
 */
export interface RuleEvaluator {
	/** The rule definition (metadata). */
	rule: DetectionRule;
	/**
	 * Evaluate this rule against collected evidence for one project.
	 * Returns zero or more raw findings.  Must not throw — catch and return
	 * empty array on error.
	 */
	evaluate(context: RuleEvaluationContext): Promise<RawFinding[]>;
}

// ---------------------------------------------------------------------------
// RuleCatalog
// ---------------------------------------------------------------------------

export class RuleCatalog {
	private readonly evaluators = new Map<string, RuleEvaluator>();

	/**
	 * Register a rule evaluator.  Throws on duplicate rule IDs (programming error).
	 */
	registerRule(evaluator: RuleEvaluator): void {
		if (this.evaluators.has(evaluator.rule.id)) {
			throw new Error(
				`RuleCatalog: rule "${evaluator.rule.id}" is already registered. Each rule ID must be unique.`,
			);
		}
		this.evaluators.set(evaluator.rule.id, evaluator);
	}

	/**
	 * Look up an evaluator by rule ID.
	 * Returns null if the rule is not registered.
	 */
	getEvaluator(ruleId: string): RuleEvaluator | null {
		return this.evaluators.get(ruleId) ?? null;
	}

	/**
	 * List all registered evaluators, sorted by rule ID.
	 */
	listEvaluators(): RuleEvaluator[] {
		return Array.from(this.evaluators.values()).sort((a, b) => a.rule.id.localeCompare(b.rule.id));
	}

	/**
	 * Whether a rule with the given ID is registered.
	 */
	hasRule(ruleId: string): boolean {
		return this.evaluators.has(ruleId);
	}
}

/** Singleton catalog — shared across the process. */
export const ruleCatalog = new RuleCatalog();
