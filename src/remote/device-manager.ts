import { randomUUID } from "node:crypto";

import type { ConnectedDevice, RemoteConfig } from "./types";

export interface CreateDeviceManagerDependencies {
	// Read the latest config without holding a stale reference.
	getConfig: () => RemoteConfig;
	// Persist trust/block list mutations and update the caller's config reference.
	saveConfig: (config: RemoteConfig) => Promise<void>;
}

export interface DeviceManager {
	// Registers a new device and returns the assigned ConnectedDevice.
	// Called by POST /api/remote/device/register.
	registerDevice(info: { ip: string; mac: string; os: string; hostname: string; userAgent: string }): ConnectedDevice;

	// Bumps lastSeen for the device matching sessionId.
	// Called on every authenticated request to keep the record fresh.
	touchDevice(sessionId: string): void;

	// Returns all currently active devices.
	listConnectedDevices(): ConnectedDevice[];

	// Removes a device from the active set.
	// Called on explicit termination or when a token is revoked.
	terminateDevice(sessionId: string): void;

	// Adds mac to trustedDeviceMacs and persists. No-op if already present.
	trustDevice(mac: string): Promise<void>;

	// Removes mac from trustedDeviceMacs and persists.
	untrustDevice(mac: string): Promise<void>;

	// Adds mac to blockedDeviceMacs and persists. No-op if already present.
	blockDevice(mac: string): Promise<void>;

	// Removes mac from blockedDeviceMacs and persists.
	unblockDevice(mac: string): Promise<void>;

	// Reads directly from getConfig() — always reflects current persisted state.
	isTrusted(mac: string): boolean;

	// Reads directly from getConfig() — always reflects current persisted state.
	isBlocked(mac: string): boolean;
}

export function createDeviceManager(deps: CreateDeviceManagerDependencies): DeviceManager {
	// In-memory only. Resets on server restart.
	const activeDevices = new Map<string, ConnectedDevice>();

	return {
		registerDevice(info): ConnectedDevice {
			const now = Date.now();
			const device: ConnectedDevice = {
				sessionId: randomUUID(),
				ip: info.ip,
				mac: info.mac,
				os: info.os,
				hostname: info.hostname,
				userAgent: info.userAgent,
				connectedAt: now,
				lastSeen: now,
			};
			activeDevices.set(device.sessionId, device);
			return device;
		},

		touchDevice(sessionId: string): void {
			const device = activeDevices.get(sessionId);
			if (device) {
				device.lastSeen = Date.now();
			}
		},

		listConnectedDevices(): ConnectedDevice[] {
			return Array.from(activeDevices.values());
		},

		terminateDevice(sessionId: string): void {
			activeDevices.delete(sessionId);
		},

		async trustDevice(mac: string): Promise<void> {
			const config = deps.getConfig();
			if (config.trustedDeviceMacs.includes(mac)) return;
			await deps.saveConfig({
				...config,
				trustedDeviceMacs: [...config.trustedDeviceMacs, mac],
			});
		},

		async untrustDevice(mac: string): Promise<void> {
			const config = deps.getConfig();
			await deps.saveConfig({
				...config,
				trustedDeviceMacs: config.trustedDeviceMacs.filter((m) => m !== mac),
			});
		},

		async blockDevice(mac: string): Promise<void> {
			const config = deps.getConfig();
			if (config.blockedDeviceMacs.includes(mac)) return;
			await deps.saveConfig({
				...config,
				blockedDeviceMacs: [...config.blockedDeviceMacs, mac],
			});
		},

		async unblockDevice(mac: string): Promise<void> {
			const config = deps.getConfig();
			await deps.saveConfig({
				...config,
				blockedDeviceMacs: config.blockedDeviceMacs.filter((m) => m !== mac),
			});
		},

		isTrusted(mac: string): boolean {
			return deps.getConfig().trustedDeviceMacs.includes(mac);
		},

		isBlocked(mac: string): boolean {
			return deps.getConfig().blockedDeviceMacs.includes(mac);
		},
	};
}
