import { randomUUID, timingSafeEqual } from "node:crypto";

import type { RemoteAuthResult, RemoteConfig, RemoteSession } from "./types";

const DEFAULT_CLINE_API_BASE_URL = "https://api.cline.bot";
const WORKOS_TOKEN_PREFIX = "workos:";

export interface CreateAuthManagerDependencies {
	// Indirection so the manager always reads the latest config without holding a stale reference.
	getConfig: () => RemoteConfig;
}

export interface AuthManager {
	// Verifies a WorkOS access token against api.cline.bot.
	// Checks the resolved user ID against RemoteConfig.workosAllowedUserIds.
	// Returns null on invalid token, network error, or disallowed user.
	authenticateWorkos(workosAccessToken: string, deviceMac: string): Promise<RemoteAuthResult | null>;

	// Verifies a password. Devices in trustedDeviceMacs bypass the password check entirely.
	// Returns null if the password is wrong and the device is not trusted.
	authenticatePassword(password: string, deviceMac: string): RemoteAuthResult | null;

	// Validates a Bearer token from an incoming request.
	// Returns the associated RemoteSession, or null if invalid.
	validateToken(token: string): RemoteSession | null;

	// Returns true if the MAC address is in RemoteConfig.blockedDeviceMacs.
	isBlocked(mac: string): boolean;

	// Removes a token from the in-memory store (called on logout / device termination).
	revokeToken(token: string): void;
}

export function createAuthManager(deps: CreateAuthManagerDependencies): AuthManager {
	// In-memory token store. Tokens do not expire — revoked explicitly via revokeToken().
	const sessions = new Map<string, RemoteSession>();

	function issueToken(deviceMac: string, workosUserId: string | null, isPasswordAuth: boolean): string {
		const token = randomUUID();
		const session: RemoteSession = {
			token,
			deviceMac,
			workosUserId,
			isPasswordAuth,
			issuedAt: Date.now(),
		};
		sessions.set(token, session);
		return token;
	}

	// Ensures the token has the workos: prefix before sending to api.cline.bot,
	// matching how cline-provider-service.ts handles this.
	function ensureWorkosPrefix(accessToken: string): string {
		const normalized = accessToken.trim();
		if (!normalized) return normalized;
		if (normalized.toLowerCase().startsWith(WORKOS_TOKEN_PREFIX)) return normalized;
		return `${WORKOS_TOKEN_PREFIX}${normalized}`;
	}

	// Constant-time comparison to prevent timing attacks on password checks.
	function passwordMatches(input: string, stored: string): boolean {
		if (!stored) return false; // empty stored password = password auth disabled
		const inputBuf = Buffer.from(input);
		const storedBuf = Buffer.from(stored);
		if (inputBuf.length !== storedBuf.length) return false;
		return timingSafeEqual(inputBuf, storedBuf);
	}

	return {
		async authenticateWorkos(workosAccessToken: string, deviceMac: string): Promise<RemoteAuthResult | null> {
			const config = deps.getConfig();

			if (isBlocked(config, deviceMac)) return null;

			try {
				const prefixed = ensureWorkosPrefix(workosAccessToken);
				const response = await fetch(`${DEFAULT_CLINE_API_BASE_URL}/v1/users/me`, {
					headers: { Authorization: `Bearer ${prefixed}` },
				});

				if (!response.ok) return null;

				const body = (await response.json()) as { id?: string; sub?: string };
				const userId = (body.id ?? body.sub ?? "").trim();
				if (!userId) return null;

				// If allowlist is non-empty, the user must be in it.
				if (config.workosAllowedUserIds.length > 0 && !config.workosAllowedUserIds.includes(userId)) {
					return null;
				}

				const token = issueToken(deviceMac, userId, false);
				return { token, trusted: config.trustedDeviceMacs.includes(deviceMac) };
			} catch {
				// Network errors, JSON parse failures, etc. — treat as auth failure.
				return null;
			}
		},

		authenticatePassword(password: string, deviceMac: string): RemoteAuthResult | null {
			const config = deps.getConfig();

			if (isBlocked(config, deviceMac)) return null;

			const trusted = config.trustedDeviceMacs.includes(deviceMac);

			// Trusted devices bypass the password check.
			if (!trusted && !passwordMatches(password, config.password)) {
				return null;
			}

			const token = issueToken(deviceMac, null, true);
			return { token, trusted };
		},

		validateToken(token: string): RemoteSession | null {
			return sessions.get(token) ?? null;
		},

		isBlocked(mac: string): boolean {
			return isBlocked(deps.getConfig(), mac);
		},

		revokeToken(token: string): void {
			sessions.delete(token);
		},
	};
}

// Module-level helper so it can be called from both the returned object
// and the internal issueToken path without `this` binding issues.
function isBlocked(config: RemoteConfig, mac: string): boolean {
	return config.blockedDeviceMacs.includes(mac);
}
