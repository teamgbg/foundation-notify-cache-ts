/**
 * @system notify-cache
 * @status handwritten
 * @edit the type contracts for @teamscala/notify-cache — the hot snapshot
 *   primitive whose invalidation is driven by Postgres LISTEN/NOTIFY.
 */

export interface NotifyCacheStats {
	name: string;
	state: "uninitialized" | "loading" | "ready" | "rehydrating" | "failed";
	/** True while the held value has been invalidated (a NOTIFY / passed ceiling) and a refresh has not yet settled it fresh. */
	stale: boolean;
	lastLoadAt: number | null;
	lastLoadDurationMs: number | null;
	hits: number;
	misses: number;
	invalidations: number;
	failedLoads: number;
	enabled: boolean;
}

export type NotifyCacheEventKind =
	| "loaded"
	| "invalidated"
	| "rehydrated"
	| "load-failed"
	| "disabled"
	| "enabled";

export interface NotifyCacheEvent {
	cache: string;
	kind: NotifyCacheEventKind;
	durationMs?: number;
	error?: string;
	channel?: string;
}

/**
 * Minimal contract for the LISTEN connection. Consumers inject an adapter
 * wrapping their own Postgres client so notify-cache stays driver-agnostic.
 */
export interface NotifyAdapter {
	/**
	 * Subscribe to a Postgres NOTIFY channel. Returns an unsubscribe function.
	 */
	listen(
		channel: string,
		handler: (payload: string) => void,
	): Promise<() => Promise<void>>;
}

export interface NotifyCacheOptions<T> {
	/** Unique name in the process. `<package>:<purpose>` convention. */
	name: string;
	/** Loader called to populate the cache. Receives the opaque context the
	 *  bootloader injects via configure(). */
	load: (ctx: unknown) => Promise<T>;
	/** Postgres NOTIFY channels that should trigger a rehydrate. */
	invalidateOn: string[];
	/**
	 * Ceiling on staleness when no NOTIFY fires (a dropped LISTEN connection).
	 * Default 0 — invalidation is purely event-driven.
	 */
	staleAfterMs?: number;
	/** Optional event sink for observability. */
	emit?: (event: NotifyCacheEvent) => void;
	/** `false` makes `get()` always load fresh. Default: true. */
	enabled?: boolean;
}
