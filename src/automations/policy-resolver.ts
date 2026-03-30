/**
 * Policy resolver — merges an AutomationAgentTemplate's defaultPolicy with
 * an AutomationAgentInstance's policyOverrides to produce a ResolvedPolicy.
 *
 * The resolved policy is the single object that the guardrail engine, the
 * detection pipeline, and the action executor use at runtime.  Neither the
 * template defaults nor the instance overrides should be consulted directly
 * after this point.
 *
 * Instance overrides can only *restrict* the action set, never expand it.
 * Any actions listed in policyOverrides.allowedActions that are not in the
 * template's allowedActions are silently dropped.
 */
import type { AutomationAgentInstance, AutomationAgentTemplate, ResolvedPolicy } from "./automation-types";

/**
 * Merge the template's defaultPolicy with the instance's policyOverrides.
 *
 * @param template - The template this instance is based on.
 * @param instance - The configured instance.
 * @returns A fully resolved, ready-to-use policy object.
 */
export function resolvePolicy(template: AutomationAgentTemplate, instance: AutomationAgentInstance): ResolvedPolicy {
	const overrides = instance.policyOverrides ?? {};

	// Resolve allowedActions: instance can only restrict, never expand.
	const templateActions = new Set(template.allowedActions);
	let resolvedActions: ResolvedPolicy["allowedActions"];

	if (overrides.allowedActions == null) {
		// null or undefined → use the template's full action set.
		resolvedActions = [...template.allowedActions];
	} else {
		// Filter to only actions that the template also allows.
		resolvedActions = overrides.allowedActions.filter((a) => templateActions.has(a));
	}

	return {
		scanIntervalSeconds: overrides.scanIntervalSeconds ?? template.defaultPolicy.scanIntervalSeconds,
		maxFindingsPerScan: overrides.maxFindingsPerScan ?? template.defaultPolicy.maxFindingsPerScan,
		maxTasksCreatedPerHour: overrides.maxTasksCreatedPerHour ?? template.defaultPolicy.maxTasksCreatedPerHour,
		maxAutoStartsPerHour: overrides.maxAutoStartsPerHour ?? template.defaultPolicy.maxAutoStartsPerHour,
		cooldownMinutes: overrides.cooldownMinutes ?? template.defaultPolicy.cooldownMinutes,
		severityThreshold: overrides.severityThreshold ?? template.defaultPolicy.severityThreshold,
		allowedActions: resolvedActions,
	};
}
