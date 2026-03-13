import { Button, Classes, Icon, type IconName, KeyComboTag } from "@blueprintjs/core";
import type { ReactNode } from "react";
import { useTaskActions } from "@/hooks/task-actions-context";
import { KBD } from "../KBD";

interface QuickAction {
	id: string;
	icon: IconName;
	label: string;
	combo: ReactNode;
	intent?: "primary";
	onClick: () => void;
}

function QuickActionRow({ action }: { action: QuickAction }): React.ReactElement {
	const color = action.intent === "primary" ? "var(--bp-intent-primary-rest)" : undefined;
	return (
		<Button variant="minimal" onClick={action.onClick} textClassName="w-full">
			<span
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					width: "100%",
					color,
					padding: "6px 8px",
				}}
			>
				<span
					style={{
						display: "flex",
						alignItems: "center",
						gap: 8,
					}}
				>
					<Icon icon={action.icon} color={color} size={14} />
					<span>{action.label}</span>
				</span>
				<span style={{ display: "flex", gap: 3, flexShrink: 0, alignItems: "center" }}>{action.combo}</span>
			</span>
		</Button>
	);
}

export function QuickActionsPanel(): React.ReactElement {
	const { createTask, startAllBacklogTasks, openClearTrash } = useTaskActions();

	const actions: QuickAction[] = [
		{
			id: "new-task",
			icon: "plus",
			label: "New task",
			combo: <KBD>C</KBD>,
			intent: "primary",
			onClick: createTask,
		},
		{
			id: "start-all",
			icon: "play",
			label: "/start all backlog",
			combo: (
				<>
					<KBD>&#x21E7;</KBD>
					<KBD>S</KBD>
				</>
			),
			intent: "primary",
			onClick: startAllBacklogTasks,
		},
		{
			id: "empty-trash",
			icon: "trash",
			label: "Empty trash",
			combo: (
				<>
					<KBD>&#x2318;</KBD>
					<KBD>&#x21E7;</KBD>
					<KBD>&#x232B;</KBD>
				</>
			),
			onClick: openClearTrash,
		},
	];

	return (
		<div style={{ padding: "8px 12px" }}>
			<div
				className={Classes.TEXT_MUTED}
				style={{
					fontSize: "var(--bp-typography-size-body-x-small)",
					fontWeight: 600,
					textTransform: "uppercase",
					letterSpacing: "0.8px",
					marginBottom: 4,
				}}
			>
				Quick Actions
			</div>
			<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
				{actions.map((action) => (
					<QuickActionRow key={action.id} action={action} />
				))}
			</div>
		</div>
	);
}
