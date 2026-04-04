import { RefreshCw, WifiOff, X } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";

/** Number of failed reconnect attempts before showing the "Connection failed" state with a manual retry button. */
const MAX_AUTO_RETRY_ATTEMPTS = 5;

export type ReconnectionBannerStatus = "reconnecting" | "failed" | "reconnected";

interface ReconnectionBannerProps {
	status: ReconnectionBannerStatus;
	attemptCount: number;
	onRetry: () => void;
	onDismiss: () => void;
}

export function ReconnectionBanner({
	status,
	attemptCount,
	onRetry,
	onDismiss,
}: ReconnectionBannerProps): ReactElement {
	const effectiveStatus = status === "reconnecting" && attemptCount >= MAX_AUTO_RETRY_ATTEMPTS ? "failed" : status;

	return (
		<div
			className={cn(
				"kb-reconnection-banner",
				"fixed top-0 left-0 right-0 z-[9999] flex items-center justify-center gap-2 px-4 py-2 text-[13px] font-medium shadow-md",
				effectiveStatus === "reconnecting" &&
					"bg-status-yellow/15 text-status-yellow border-b border-status-yellow/30",
				effectiveStatus === "failed" && "bg-status-red/15 text-status-red border-b border-status-red/30",
				effectiveStatus === "reconnected" && "bg-status-green/15 text-status-green border-b border-status-green/30",
			)}
			role="status"
			aria-live="polite"
		>
			{effectiveStatus === "reconnecting" ? (
				<>
					<Spinner size={14} className="text-status-yellow" />
					<span>Connection lost. Reconnecting…</span>
				</>
			) : effectiveStatus === "failed" ? (
				<>
					<WifiOff size={14} />
					<span>Connection failed.</span>
					<Button
						variant="ghost"
						size="sm"
						onClick={onRetry}
						className="ml-1 h-6 px-2 text-xs text-status-red hover:text-status-red"
					>
						<RefreshCw size={12} />
						Retry
					</Button>
				</>
			) : (
				<>
					<span>Reconnected</span>
					<button
						type="button"
						onClick={onDismiss}
						className="ml-1 inline-flex items-center justify-center rounded p-0.5 text-status-green/70 hover:text-status-green cursor-pointer"
						aria-label="Dismiss"
					>
						<X size={14} />
					</button>
				</>
			)}
		</div>
	);
}
