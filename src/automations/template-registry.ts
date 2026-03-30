/**
 * TemplateRegistry — in-memory registry of AutomationAgentTemplate definitions.
 *
 * Templates are registered at Kanban boot time (before any TRPC handlers are
 * invoked) and are immutable for the lifetime of the process.  Agent instances
 * reference templates by ID; if a template ID is missing from the registry
 * the instance cannot be activated.
 *
 * Usage:
 *   templateRegistry.registerTemplate(QUALITY_ENFORCER_TEMPLATE);
 *   const tmpl = templateRegistry.getTemplate("quality-enforcer");
 */
import type { AutomationAgentTemplate } from "./automation-types";

// ---------------------------------------------------------------------------
// TemplateRegistry
// ---------------------------------------------------------------------------

export class TemplateRegistry {
	private readonly templates = new Map<string, AutomationAgentTemplate>();

	/**
	 * Register a template.  Throws if a template with the same ID is already
	 * registered (boot-time misconfiguration is a programming error).
	 */
	registerTemplate(template: AutomationAgentTemplate): void {
		if (this.templates.has(template.id)) {
			throw new Error(
				`TemplateRegistry: template "${template.id}" is already registered. Each template ID must be unique.`,
			);
		}
		this.templates.set(template.id, template);
	}

	/**
	 * Look up a registered template by ID.
	 * Returns null if no template with that ID has been registered.
	 */
	getTemplate(id: string): AutomationAgentTemplate | null {
		return this.templates.get(id) ?? null;
	}

	/**
	 * List all registered templates, sorted alphabetically by ID.
	 */
	listTemplates(): AutomationAgentTemplate[] {
		return Array.from(this.templates.values()).sort((a, b) => a.id.localeCompare(b.id));
	}

	/**
	 * Whether a template with the given ID is registered.
	 */
	hasTemplate(id: string): boolean {
		return this.templates.has(id);
	}
}

/** Singleton registry — shared across the process. */
export const templateRegistry = new TemplateRegistry();
