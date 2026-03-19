import Prism from "prismjs";

import "prismjs/components/prism-bash";
import "prismjs/components/prism-c";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-css";
import "prismjs/components/prism-go";
import "prismjs/components/prism-java";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-json";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-kotlin";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-markup-templating";
import "prismjs/components/prism-php";
import "prismjs/components/prism-python";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-yaml";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

// ── Language mapping ───────────────────────────────────────────

const LANGUAGE_MAP: Record<string, string> = {
	ts: "typescript",
	tsx: "tsx",
	js: "javascript",
	jsx: "jsx",
	mjs: "javascript",
	cjs: "javascript",
	json: "json",
	jsonc: "json",
	md: "markdown",
	mdx: "markdown",
	css: "css",
	scss: "css",
	less: "css",
	html: "markup",
	htm: "markup",
	xml: "markup",
	svg: "markup",
	yaml: "yaml",
	yml: "yaml",
	py: "python",
	rb: "ruby",
	go: "go",
	rs: "rust",
	java: "java",
	kt: "kotlin",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
	cs: "csharp",
	swift: "swift",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	sql: "sql",
	graphql: "javascript",
	php: "php",
	toml: "yaml",
	dockerfile: "bash",
};

function getPrismLanguage(filePath: string): string {
	const name = filePath.slice(filePath.lastIndexOf("/") + 1).toLowerCase();
	if (name === "dockerfile" || name.startsWith("dockerfile.")) return "bash";
	if (name === "makefile" || name === "gnumakefile") return "bash";
	if (name.endsWith(".d.ts")) return "typescript";
	const dotIndex = name.lastIndexOf(".");
	if (dotIndex === -1) return "plaintext";
	const ext = name.slice(dotIndex + 1);
	return LANGUAGE_MAP[ext] ?? "plaintext";
}

// ── Highlight helpers ──────────────────────────────────────────

function highlightCode(code: string, lang: string): string {
	const grammar = Prism.languages[lang];
	if (!grammar) return escapeHtml(code);
	return Prism.highlight(code, grammar, lang);
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Types ──────────────────────────────────────────────────────

export interface EditorSettings {
	fontSize: number;
	wordWrap: boolean;
	minimap: boolean;
	lineNumbers: boolean;
}

interface FileContent {
	path: string;
	content: string | null;
	size: number;
	isBinary: boolean;
	error?: string;
}

// ── Component ──────────────────────────────────────────────────

export function CodeViewer({
	workspaceId,
	filePath,
	onDirtyChange,
	editorSettings,
}: {
	workspaceId: string | null;
	filePath: string | null;
	onDirtyChange?: (path: string, isDirty: boolean) => void;
	editorSettings?: EditorSettings;
}): React.ReactElement {
	const [fileContent, setFileContent] = useState<FileContent | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [editValue, setEditValue] = useState("");
	const loadingPathRef = useRef<string | null>(null);
	const originalContentRef = useRef<string>("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const preRef = useRef<HTMLPreElement>(null);
	const gutterRef = useRef<HTMLDivElement>(null);
	const scrollContainerRef = useRef<HTMLDivElement>(null);

	const fontSize = editorSettings?.fontSize ?? 10;
	const wordWrap = editorSettings?.wordWrap ?? false;
	const showLineNumbers = editorSettings?.lineNumbers ?? true;
	const lineHeight = Math.round(fontSize * 1.6);

	// ── File loading ───────────────────────────────────────────
	const loadFile = useCallback(
		async (path: string) => {
			if (!workspaceId) return;
			loadingPathRef.current = path;
			setIsLoading(true);
			try {
				const client = getRuntimeTrpcClient(workspaceId);
				const result = await client.workspace.readFile.query({ path });
				if (loadingPathRef.current !== path) return;
				const fc = result as FileContent;
				setFileContent(fc);
				const content = fc.content ?? "";
				originalContentRef.current = content;
				setEditValue(content);
			} catch (err) {
				if (loadingPathRef.current !== path) return;
				setFileContent({
					path,
					content: null,
					size: 0,
					isBinary: false,
					error: err instanceof Error ? err.message : String(err),
				});
			} finally {
				if (loadingPathRef.current === path) setIsLoading(false);
			}
		},
		[workspaceId],
	);

	useEffect(() => {
		if (!filePath) {
			setFileContent(null);
			loadingPathRef.current = null;
			return;
		}
		void loadFile(filePath);
	}, [filePath, loadFile]);

	// ── File saving ────────────────────────────────────────────
	const saveFile = useCallback(async () => {
		if (!workspaceId || !filePath || isSaving) return;
		setIsSaving(true);
		try {
			const client = getRuntimeTrpcClient(workspaceId);
			const result = await client.workspace.writeFile.mutate({
				path: filePath,
				content: editValue,
			});
			if (result.ok) {
				originalContentRef.current = editValue;
				onDirtyChange?.(filePath, false);
			}
		} finally {
			setIsSaving(false);
		}
	}, [workspaceId, filePath, isSaving, editValue, onDirtyChange]);

	// ── Keyboard shortcuts ─────────────────────────────────────
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			// Cmd+S / Ctrl+S → save
			if ((e.metaKey || e.ctrlKey) && e.key === "s") {
				e.preventDefault();
				void saveFile();
				return;
			}

			// Tab → insert tab character
			if (e.key === "Tab") {
				e.preventDefault();
				const ta = e.currentTarget;
				const start = ta.selectionStart;
				const end = ta.selectionEnd;
				const newValue = `${editValue.slice(0, start)}\t${editValue.slice(end)}`;
				setEditValue(newValue);
				// Restore cursor position after React re-render
				requestAnimationFrame(() => {
					ta.selectionStart = start + 1;
					ta.selectionEnd = start + 1;
				});
			}
		},
		[editValue, saveFile],
	);

	// ── Change handler ─────────────────────────────────────────
	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const newValue = e.target.value;
			setEditValue(newValue);
			if (filePath) {
				onDirtyChange?.(filePath, newValue !== originalContentRef.current);
			}
		},
		[filePath, onDirtyChange],
	);

	// ── Sync scroll between textarea and highlighted pre ───────
	const handleScroll = useCallback(() => {
		const container = scrollContainerRef.current;
		const ta = textareaRef.current;
		const pre = preRef.current;
		const gutter = gutterRef.current;
		if (!container || !ta || !pre) return;

		// Sync horizontal scroll from textarea to pre
		pre.scrollLeft = ta.scrollLeft;

		// Sync vertical scroll from container to textarea/pre
		if (gutter) {
			gutter.style.transform = `translateY(${-container.scrollTop}px)`;
		}
	}, []);

	// ── Highlighting ───────────────────────────────────────────
	const lang = useMemo(
		() => (fileContent ? getPrismLanguage(fileContent.path) : "plaintext"),
		[fileContent],
	);

	const highlightedHtml = useMemo(() => highlightCode(editValue, lang), [editValue, lang]);

	const lineCount = useMemo(() => {
		const count = editValue.split("\n").length;
		return count;
	}, [editValue]);

	const gutterWidth = useMemo(
		() => (showLineNumbers ? Math.max(String(lineCount).length * (fontSize * 0.6) + 20, 40) : 0),
		[showLineNumbers, lineCount, fontSize],
	);

	// ── Render states ──────────────────────────────────────────
	if (!filePath) {
		return (
			<div className="flex flex-1 items-center justify-center min-h-0 text-text-tertiary text-sm">
				Select a file to view its contents
			</div>
		);
	}
	if (isLoading) {
		return (
			<div className="flex flex-1 items-center justify-center min-h-0">
				<Spinner size={24} />
			</div>
		);
	}
	if (!fileContent) return <div />;
	if (fileContent.error) {
		return (
			<div className="flex flex-1 items-center justify-center min-h-0 text-text-tertiary text-sm">
				Cannot read file: {fileContent.error}
			</div>
		);
	}
	if (fileContent.isBinary) {
		return (
			<div className="flex flex-1 items-center justify-center min-h-0 text-text-tertiary text-sm">
				Binary file: {fileContent.path}
			</div>
		);
	}

	return (
		<div className="flex flex-col flex-1 min-h-0 min-w-0 relative bg-surface-1">
			{isSaving && (
				<div className="absolute top-1 right-3 z-10 text-[11px] text-text-tertiary">
					Saving…
				</div>
			)}
			<div
				ref={scrollContainerRef}
				className="flex flex-1 min-h-0 min-w-0 overflow-auto"
				onScroll={handleScroll}
			>
				{/* Line number gutter */}
				{showLineNumbers && (
					<div
						ref={gutterRef}
						className="sticky left-0 z-[2] shrink-0 select-none bg-surface-1 border-r border-border"
						style={{ width: gutterWidth, minWidth: gutterWidth }}
					>
						<div style={{ paddingTop: 8 }}>
							{Array.from({ length: lineCount }, (_, i) => (
								<div
									key={i}
									className="text-right text-text-tertiary pr-2 pl-1"
									style={{
										fontSize,
										lineHeight: `${lineHeight}px`,
										height: lineHeight,
										fontFamily:
											"ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
									}}
								>
									{i + 1}
								</div>
							))}
						</div>
					</div>
				)}

				{/* Editor area: highlighted pre underneath, transparent textarea on top */}
				<div className="relative flex-1 min-w-0">
					{/* Syntax-highlighted layer (visual only) */}
					<pre
						ref={preRef}
						className="absolute inset-0 m-0 pointer-events-none kb-diff-text"
						aria-hidden="true"
						style={{
							fontSize,
							lineHeight: `${lineHeight}px`,
							fontFamily:
								"ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
							padding: "8px 12px",
							whiteSpace: wordWrap ? "pre-wrap" : "pre",
							wordBreak: wordWrap ? "break-all" : "normal",
							color: "var(--color-text-primary)",
							overflow: "hidden",
							tabSize: 2,
						}}
						// biome-ignore lint/security/noDangerouslySetInnerHtml: prism highlighted code
						dangerouslySetInnerHTML={{
							__html: `${highlightedHtml}\n`,
						}}
					/>

					{/* Editable textarea (transparent text, captures input) */}
					<textarea
						ref={textareaRef}
						className="relative z-[1] block w-full h-full resize-none border-0 outline-none bg-transparent"
						value={editValue}
						onChange={handleChange}
						onKeyDown={handleKeyDown}
						onScroll={handleScroll}
						spellCheck={false}
						autoCapitalize="off"
						autoCorrect="off"
						autoComplete="off"
						style={{
							fontSize,
							lineHeight: `${lineHeight}px`,
							fontFamily:
								"ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
							padding: "8px 12px",
							whiteSpace: wordWrap ? "pre-wrap" : "pre",
							wordBreak: wordWrap ? "break-all" : "normal",
							color: "transparent",
							caretColor: "var(--color-text-primary)",
							overflow: wordWrap ? "hidden" : "auto",
							tabSize: 2,
							minHeight: lineCount * lineHeight + 16,
						}}
					/>
				</div>
			</div>
		</div>
	);
}