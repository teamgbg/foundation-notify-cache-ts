/**
 * @system notify-cache
 * @status handwritten
 * @edit bootloader injection per `configured-primitives` — consumers call
 *   configure() at startup to supply the NotifyAdapter (their LISTEN client)
 *   and the load context. Until then, tests can pass both via
 *   createNotifyCache options directly.
 */

import type { NotifyAdapter } from "./types.ts";

interface NotifyCacheConfig {
	notifyAdapter: NotifyAdapter | null;
	loadContext: unknown;
}

let _config: NotifyCacheConfig = {
	notifyAdapter: null,
	loadContext: null,
};

export function configure(config: Partial<NotifyCacheConfig>): void {
	_config = { ..._config, ...config };
}

export function getNotifyAdapter(): NotifyAdapter | null {
	return _config.notifyAdapter;
}

export function getLoadContext(): unknown {
	return _config.loadContext;
}
