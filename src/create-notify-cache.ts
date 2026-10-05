/**
 * @system notify-cache
 * @status handwritten
 * @edit factory entry point — auto-registers in the central registry and
 *   best-effort attaches LISTEN subscribers when a NotifyAdapter is wired.
 */

import { getLoadContext, getNotifyAdapter } from "./configure.ts";
import { NotifyCache } from "./notify-cache.ts";
import { notifyCacheRegistry } from "./registry.ts";
import type { NotifyAdapter, NotifyCacheOptions } from "./types.ts";

export function createNotifyCache<T>(
	options: NotifyCacheOptions<T> & {
		notifyAdapter?: NotifyAdapter | null;
		loadContext?: unknown;
	},
): NotifyCache<T> {
	const cache = new NotifyCache<T>({
		...options,
		notifyAdapter: options.notifyAdapter ?? getNotifyAdapter(),
		loadContext: options.loadContext ?? getLoadContext(),
	});
	notifyCacheRegistry.register(cache);
	// Best-effort attach — the cache works interval-driven without it; errors
	// surface via emit().
	void cache.attach().catch(() => {});
	return cache;
}
