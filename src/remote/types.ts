// Persisted configuration for the remote access module.
// Stored at ~/.cline/kanban/remote-config.json via config-store.ts.
export interface RemoteConfig {
	// Password-based auth fallback. Empty string = disabled.
	password: string;
	// WorkOS user IDs allowed to connect. Empty array = any authenticated WorkOS user is allowed.
	workosAllowedUserIds: string[];
	// MAC addresses that bypass the password check (still require a valid token).
	trustedDeviceMacs: string[];
	// MAC addresses that are always rejected, even with a valid token.
	blockedDeviceMacs: string[];
	// Absolute path to the VAPID keys JSON file.
	vapidKeysPath: string;
	// Cloudflare tunnel configuration.
	cloudflare: RemoteCloudflareConfig;
}

export interface RemoteCloudflareConfig {
	enabled: boolean;
	mode: "quick" | "named";
	tunnelName: string;
}

// Represents a device that has registered and received a session ID.
// Held in memory by DeviceManager — not persisted to disk.
export interface ConnectedDevice {
	// Assigned at POST /api/remote/device/register via crypto.randomUUID().
	sessionId: string;
	ip: string;
	mac: string;
	os: string;
	hostname: string;
	userAgent: string;
	// Unix ms timestamp set at registration.
	connectedAt: number;
	// Unix ms timestamp updated on each authenticated request.
	lastSeen: number;
}

// The decoded identity carried by a valid session token.
// Stored in AuthManager's in-memory token map.
export interface RemoteSession {
	token: string;
	deviceMac: string;
	// Set when the token was issued via WorkOS auth; null for password auth.
	workosUserId: string | null;
	// True when the token was issued via the password fallback flow.
	isPasswordAuth: boolean;
	// Unix ms timestamp.
	issuedAt: number;
}

// Returned by POST /api/remote/auth on success.
export interface RemoteAuthResult {
	token: string;
	// True if the device MAC is in RemoteConfig.trustedDeviceMacs.
	trusted: boolean;
}

// The SSE event envelope sent to remote clients over GET /api/remote/events.
// All variants share this discriminated-union shape.
//
// Payload fields typed as `unknown` here are narrowed in sse-hub.ts using
// the concrete types from src/core/api-contract.ts. Keeping them unknown
// here avoids importing Kanban internals into the base types layer.
export type RemoteSseEvent =
	| { type: "connected"; sessionId: string }
	| { type: "board:updated"; workspaceId: string; board: unknown }
	| { type: "task:updated"; workspaceId: string; summaries: unknown[] }
	| { type: "task:readyForReview"; workspaceId: string; taskId: string; triggeredAt: number }
	| { type: "agent:message"; workspaceId: string; taskId: string; message: unknown }
	| { type: "agent:cleared"; workspaceId: string; taskId: string }
	| { type: "projects:updated"; currentProjectId: string | null; projects: unknown[] }
	| { type: "heartbeat" };
