/**
 * Quality Enforcer — AutomationAgentTemplate definition.
 *
 * The Quality Enforcer is the first agent built on the automation platform.
 * It periodically scans projects for code quality issues and creates Kanban
 * tasks to fix them.
 */
import type { AutomationAgentTemplate } from "../../automation-types";

export const QUALITY_ENFORCER_TEMPLATE: AutomationAgentTemplate = {
	id: "quality-enforcer",
	name: "Quality Enforcer",
	description:
		"Periodically scans projects for code quality issues — failing tests, " +
		"type errors, lint violations, missing test coverage, stale reviews, " +
		"and repeated agent failures — and creates Kanban tasks to address them.",
	version: "1.0.0",
	ruleIds: [
		"failing-tests",
		"type-errors",
		"lint-errors",
		"missing-test-coverage",
		"stale-review",
		"repeated-agent-failure",
	],
	allowedActions: [
		"create_backlog_task",
		"schedule_task",
		"auto_start_task",
		"link_to_existing_task",
		"add_finding_comment",
	],
	defaultPolicy: {
		scanIntervalSeconds: 900, // every 15 minutes
		maxFindingsPerScan: 20,
		maxTasksCreatedPerHour: 5,
		maxAutoStartsPerHour: 1,
		cooldownMinutes: 60,
		severityThreshold: "warning", // ignore "info" findings by default
	},
};
