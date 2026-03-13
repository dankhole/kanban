export function KBD({ children }: React.PropsWithChildren) {
	return (
		<kbd
			style={{
				display: "inline-flex",
				alignItems: "center",
				justifyContent: " center",
				minWidth: " 20px",
				height: " 18px",
				padding: " 0 4px",
				fontFamily: " inherit",
				fontSize: " 9px",
				fontWeight: " 600",
				color: " var(--text-primary)",
				background: " var(--bg-raised)",
				border: " 1px solid var(--border)",
				borderRadius: " 3px",
				boxShadow: " 0 1px 0 rgba(0, 0, 0, .3)",
			}}
		>
			{children}
		</kbd>
	);
}
