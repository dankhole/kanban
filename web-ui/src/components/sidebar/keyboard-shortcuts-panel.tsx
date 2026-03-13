import { Button, Classes, Collapse, Icon } from "@blueprintjs/core";
import type { ReactNode } from "react";
import { useState } from "react";

import { KBD } from "../KBD";

interface ShortcutEntry {
	label: string;
	keys: ReactNode;
}

interface ShortcutGroup {
	title: string;
	shortcuts: ShortcutEntry[];
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
	{
		title: "Create & Edit",
		shortcuts: [
			{ label: "New task", keys: <KBD>C</KBD> },
			{
				label: "Quick task (no form)",
				keys: (
					<>
						<KBD>&#x21E7;</KBD>
						<KBD>C</KBD>
					</>
				),
			},
			{ label: "Edit selected", keys: <KBD>E</KBD> },
			{ label: "Delete", keys: <KBD>&#x232B;</KBD> },
		],
	},
	{
		title: "Navigate",
		shortcuts: [
			{
				label: "Between tasks",
				keys: (
					<>
						<KBD>&#x2191;</KBD>
						<KBD>&#x2193;</KBD>
					</>
				),
			},
			{
				label: "Between columns",
				keys: (
					<>
						<KBD>&#x2190;</KBD>
						<KBD>&#x2192;</KBD>
					</>
				),
			},
			{
				label: "Expand / collapse",
				keys: (
					<>
						<KBD>&#x21B5;</KBD>
						{" / "}
						<KBD>Esc</KBD>
					</>
				),
			},
		],
	},
	{
		title: "Agentic Actions",
		shortcuts: [
			{ label: "Start selected", keys: <KBD>S</KBD> },
			{
				label: "Start all backlog",
				keys: (
					<>
						<KBD>&#x21E7;</KBD>
						<KBD>S</KBD>
					</>
				),
			},
			{
				label: "/start command",
				keys: (
					<>
						<KBD>/</KBD>
						<KBD>s</KBD>
					</>
				),
			},
			{
				label: "Multi-select",
				keys: (
					<>
						<KBD>&#x2318;</KBD>
						<KBD>click</KBD>
					</>
				),
			},
			{
				label: "Select all in column",
				keys: (
					<>
						<KBD>&#x2318;</KBD>
						<KBD>A</KBD>
					</>
				),
			},
		],
	},
];

export function KeyboardShortcutsPanel(): React.ReactElement {
	const [isOpen, setIsOpen] = useState(false);

	return (
		<div style={{ padding: "4px 0px" }}>
			<Button
				variant="minimal"
				size="small"
				onClick={() => setIsOpen((prev) => !prev)}
				style={{ width: "100%", justifyContent: "flex-start" }}
			>
				<Icon size={14} icon={isOpen ? "chevron-down" : "chevron-right"} />
				<span className={Classes.TEXT_MUTED} style={{ fontSize: "var(--bp-typography-size-body-x-small)" }}>
					{isOpen ? "Hide shortcuts" : "All keyboard shortcuts"}
				</span>
			</Button>

			<div style={{ padding: "0 12px" }}>
				<Collapse isOpen={isOpen}>
					<div style={{ paddingTop: 4 }}>
						{SHORTCUT_GROUPS.map((group, groupIndex) => (
							<div key={group.title}>
								{groupIndex > 0 ? (
									<div
										style={{
											height: 1,
											background: "var(--bp-palette-dark-gray-5)",
											margin: "6px 0",
										}}
									/>
								) : null}
								<div
									className={Classes.TEXT_MUTED}
									style={{
										fontSize: "var(--bp-typography-size-body-x-small)",
										textTransform: "uppercase",
										letterSpacing: "0.5px",
										marginBottom: 4,
									}}
								>
									{group.title}
								</div>
								{group.shortcuts.map((shortcut) => (
									<div
										key={shortcut.label}
										style={{
											display: "flex",
											alignItems: "center",
											justifyContent: "space-between",
											padding: "3px 0",
											fontSize: "var(--bp-typography-size-body-small)",
											color: "var(--bp-palette-gray-4)",
										}}
									>
										<span>{shortcut.label}</span>
										<span style={{ display: "flex", gap: 3, flexShrink: 0 }}>{shortcut.keys}</span>
									</div>
								))}
							</div>
						))}
					</div>
				</Collapse>
			</div>
		</div>
	);
}
