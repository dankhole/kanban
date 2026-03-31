import { ArrowLeft, ChevronRight, Folder, FolderOpen, Home } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

interface FolderEntry {
	name: string;
	path: string;
}

interface FolderPickerDialogProps {
	open: boolean;
	currentProjectId: string | null;
	onSelect: (path: string) => void;
	onCancel: () => void;
}

export function FolderPickerDialog({
	open,
	currentProjectId,
	onSelect,
	onCancel,
}: FolderPickerDialogProps): React.ReactElement {
	const [currentPath, setCurrentPath] = useState<string>("");
	const [entries, setEntries] = useState<FolderEntry[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [history, setHistory] = useState<string[]>([]);

	const navigate = useCallback(
		async (path: string, addToHistory = true) => {
			setIsLoading(true);
			setError(null);
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const result = await trpcClient.projects.listDirectory.query({ path });
				if (result.error) {
					setError(result.error);
				} else {
					if (addToHistory && currentPath) {
						setHistory((h) => [...h, currentPath]);
					}
					setCurrentPath(result.path);
					setEntries(result.entries);
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setIsLoading(false);
			}
		},
		[currentProjectId, currentPath],
	);

	// Load home directory when dialog opens
	useEffect(() => {
		if (open) {
			setHistory([]);
			void navigate("~", false);
		}
		// navigate is intentionally excluded to avoid re-running on every render
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const handleBack = useCallback(() => {
		const prev = history[history.length - 1];
		if (!prev) return;
		setHistory((h) => h.slice(0, -1));
		void navigate(prev, false);
	}, [history, navigate]);

	// Build breadcrumb segments
	const segments = currentPath ? currentPath.replace(/\\/g, "/").split("/").filter(Boolean) : [];

	return (
		<Dialog
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen) onCancel();
			}}
			contentClassName="max-w-xl"
			contentAriaDescribedBy="folder-picker-desc"
		>
			<DialogHeader title="Select Project Folder" />

			<DialogBody>
				<div id="folder-picker-desc" className="flex flex-col gap-3">
					{/* Breadcrumb */}
					<div className="flex min-h-6 flex-wrap items-center gap-1 text-xs text-text-secondary">
						<button
							type="button"
							className="flex items-center gap-1 transition-colors hover:text-text-primary"
							onClick={() => {
								setHistory((h) => (currentPath ? [...h, currentPath] : h));
								void navigate("~", false);
							}}
						>
							<Home size={12} />
						</button>
						{segments.map((seg, i) => {
							const segPath = currentPath.includes("/")
								? `/${segments.slice(0, i + 1).join("/")}`
								: segments.slice(0, i + 1).join("\\");
							return (
								<span key={segPath} className="flex items-center gap-1">
									<ChevronRight size={12} className="shrink-0 text-text-tertiary" />
									<button
										type="button"
										className={cn(
											"max-w-[120px] truncate transition-colors hover:text-text-primary",
											i === segments.length - 1 && "font-medium text-text-primary",
										)}
										onClick={() => {
											setHistory((h) => (currentPath ? [...h, currentPath] : h));
											void navigate(segPath, false);
										}}
									>
										{seg}
									</button>
								</span>
							);
						})}
					</div>

					{/* Folder list */}
					<div className="flex flex-col overflow-hidden rounded-md border border-border bg-surface-2">
						{history.length > 0 ? (
							<button
								type="button"
								className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-3"
								onClick={handleBack}
							>
								<ArrowLeft size={14} className="shrink-0" />
								<span>Back</span>
							</button>
						) : null}

						{isLoading ? (
							<div className="flex items-center justify-center py-10">
								<Spinner size={20} />
							</div>
						) : error ? (
							<div className="px-4 py-6 text-center text-sm text-status-red">{error}</div>
						) : entries.length === 0 ? (
							<div className="px-4 py-6 text-center text-sm text-text-tertiary">No subfolders found.</div>
						) : (
							<div className="max-h-64 overflow-y-auto">
								{entries.map((entry) => (
									<button
										key={entry.path}
										type="button"
										className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-sm text-text-primary transition-colors last:border-b-0 hover:bg-surface-3"
										onClick={() => void navigate(entry.path)}
									>
										<Folder size={14} className="shrink-0 text-status-gold" />
										<span className="truncate text-left">{entry.name}</span>
										<ChevronRight size={12} className="ml-auto shrink-0 text-text-tertiary" />
									</button>
								))}
							</div>
						)}
					</div>

					{/* Current selection */}
					{currentPath ? (
						<div className="flex items-center gap-2 rounded-md border border-border bg-surface-0 px-3 py-2">
							<FolderOpen size={14} className="shrink-0 text-status-gold" />
							<span className="truncate font-mono text-xs text-text-secondary">{currentPath}</span>
						</div>
					) : null}
				</div>
			</DialogBody>

			<DialogFooter>
				<Button variant="default" onClick={onCancel}>
					Cancel
				</Button>
				<Button
					variant="primary"
					disabled={!currentPath || isLoading}
					onClick={() => {
						if (currentPath) onSelect(currentPath);
					}}
				>
					Select Folder
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
