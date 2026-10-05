/**
 * @system notify-cache
 * @status handwritten
 * @edit NotifyCache<T> — hot in-memory snapshot invalidated by Postgres
 *   LISTEN/NOTIFY. States: uninitialized → loading → ready ⇄ rehydrating, with
 *   failed → loading on a first-load throw. get() WAITS for a refresh when the
 *   held value was invalidated (invalidate-on-write — see
 *   `reference/notify-cache.md`), shares one in-flight load/refresh across
 *   concurrent callers, and serves a fresh value in sub-µs.
 */

import type {
	NotifyAdapter,
	NotifyCacheEvent,
	NotifyCacheOptions,
	NotifyCacheStats,
} from "./types.ts";

export class NotifyCache<T> {
	readonly name: string;
	private readonly load: (ctx: unknown) => Promise<T>;
	private readonly invalidateOn: string[];
	private readonly staleAfterMs: number;
	private readonly emit: (event: NotifyCacheEvent) => void;
	private readonly notifyAdapter: NotifyAdapter | null;
	private readonly loadContext: unknown;

	private value: T | undefined;
	private state: NotifyCacheStats["state"] = "uninitialized";
	private loadingPromise: Promise<T> | null = null;
	/**
	 * In-flight refresh after an invalidation. `get()` awaits this while the held
	 * value is stale so it receives the FRESH value, never the pre-write one.
	 */
	private freshPromise: Promise<T> | null = null;
	/**
	 * True once a NOTIFY or a passed staleAfterMs ceiling has invalidated the held
	 * value and the refresh has not yet settled with no further invalidation.
	 * Drives the refresh loop's no-lost-wakeup check.
	 */
	private stale = false;
	/** Most recent invalidation reason, surfaced in the load-failed event. */
	private lastRefreshReason: "notify" | "stale-timeout" | "get" = "get";
	private lastLoadAt: number | null = null;
	private lastLoadDurationMs: number | null = null;
	private hits = 0;
	private misses = 0;
	private invalidations = 0;
	private failedLoads = 0;
	private enabled: boolean;
	private unsubscribers: Array<() => Promise<void>> = [];
	private staleTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		options: NotifyCacheOptions<T> & {
			notifyAdapter?: NotifyAdapter | null;
			loadContext?: unknown;
		},
	) {
		this.name = options.name;
		this.load = options.load;
		this.invalidateOn = options.invalidateOn;
		this.staleAfterMs = options.staleAfterMs ?? 0;
		this.emit = options.emit ?? (() => {});
		this.notifyAdapter = options.notifyAdapter ?? null;
		this.loadContext = options.loadContext ?? null;
		this.enabled = options.enabled ?? true;
	}

	/**
	 * Hot path. Loads on first call; returns the cached value when fresh; and when
	 * the held value has been invalidated, WAITS for a fresh load rather than
	 * returning the stale one.
	 */
	async get(): Promise<T> {
		// Bypass: always-load mode (operator-disabled for troubleshooting).
		if (!this.enabled) {
			this.misses++;
			return this.load(this.loadContext);
		}

		// Missed-NOTIFY ceiling: a dropped LISTEN connection means no NOTIFY
		// arrives, so staleAfterMs is the safety net. NOTIFY is the mechanism.
		if (
			this.state === "ready" &&
			this.staleAfterMs > 0 &&
			this.lastLoadAt !== null &&
			Date.now() - this.lastLoadAt > this.staleAfterMs
		) {
			this.markStaleAndRefresh("stale-timeout");
		}

		// Fast path: a fresh, held value that is not mid-refresh.
		if (this.state === "ready") {
			this.hits++;
			return this.value as T;
		}

		this.misses++;
		// NEVER serve a value older than the last invalidating write.
		if (this.freshPromise) return this.freshPromise;
		// First load, recovery from a failed first load, or a load in flight.
		return this.ensureLoaded();
	}

	private async ensureLoaded(): Promise<T> {
		if (this.loadingPromise) return this.loadingPromise;
		this.state = "loading";
		const start = Date.now();
		this.loadingPromise = (async () => {
			try {
				const value = await this.load(this.loadContext);
				this.value = value;
				this.stale = false;
				this.lastLoadAt = Date.now();
				this.lastLoadDurationMs = this.lastLoadAt - start;
				this.state = "ready";
				this.emit({
					cache: this.name,
					kind: "loaded",
					durationMs: this.lastLoadDurationMs,
				});
				return value;
			} catch (err) {
				this.failedLoads++;
				this.state = "failed";
				const message = err instanceof Error ? err.message : String(err);
				this.emit({
					cache: this.name,
					kind: "load-failed",
					error: message,
				});
				throw err;
			} finally {
				this.loadingPromise = null;
			}
		})();
		return this.loadingPromise;
	}

	/**
	 * Mark the held value stale and start a refresh if one is not already in
	 * flight. Idempotent: a second call leaves `stale` true so the running
	 * refresh performs one more reload (no lost wakeup).
	 */
	private markStaleAndRefresh(reason: "notify" | "stale-timeout" | "get"): void {
		this.stale = true;
		this.lastRefreshReason = reason;
		if (this.freshPromise) return; // a refresh is already running; stale stays true → it loops
		this.freshPromise = this.runRefreshLoop();
	}

	/**
	 * Reload until a load completes with no invalidation during it, then publish.
	 * This is the construction fix for the silent stale-read class — see
	 * `reference/notify-cache.md`.
	 */
	private async runRefreshLoop(): Promise<T> {
		// Let an in-flight initial load populate value/state first, so a
		// first-load-during-write race does not double-load concurrently.
		if (this.loadingPromise) {
			try {
				await this.loadingPromise;
			} catch {
				/* initial load failed — fall through; the loop will retry */
			}
		}
		while (true) {
			// A NOTIFY landing during the await below re-sets stale, keeping the
			// loop going for one more reload so that write is captured.
			this.stale = false;
			this.state = "rehydrating";
			const start = Date.now();
			try {
				const value = await this.load(this.loadContext);
				this.value = value;
				this.lastLoadAt = Date.now();
				this.lastLoadDurationMs = this.lastLoadAt - start;
				if (!this.stale) {
					// No invalidation arrived during the load → value is fresh.
					this.state = "ready";
					this.freshPromise = null;
					this.emit({
						cache: this.name,
						kind: "rehydrated",
						durationMs: this.lastLoadDurationMs,
					});
					return value;
				}
				// A NOTIFY arrived during the load — reload to capture it.
				continue;
			} catch (err) {
				// Rehydrate failure leaves the prior value in place — no poisoning.
				// stale resets so a failing upstream cannot block every get(); the
				// next NOTIFY or staleAfterMs retries.
				this.failedLoads++;
				this.state = "ready"; // previous value remains usable
				this.stale = false;
				this.freshPromise = null;
				const message = err instanceof Error ? err.message : String(err);
				this.emit({
					cache: this.name,
					kind: "load-failed",
					error: `rehydrate(${this.lastRefreshReason}) failed: ${message}`,
				});
				return this.value as T;
			}
		}
	}

	/**
	 * Bind the cache to its NOTIFY channels. Adapter is injected via constructor
	 * options; absence makes the cache purely interval-driven (or load-once when
	 * staleAfterMs is 0).
	 */
	async attach(): Promise<void> {
		if (!this.notifyAdapter) return;
		for (const channel of this.invalidateOn) {
			const unsubscribe = await this.notifyAdapter.listen(channel, () => {
				this.invalidations++;
				// Invalidate-on-write: the held value is now older than this write.
				this.markStaleAndRefresh("notify");
				this.emit({
					cache: this.name,
					kind: "invalidated",
					channel,
				});
			});
			this.unsubscribers.push(unsubscribe);
		}
	}

	async detach(): Promise<void> {
		for (const unsub of this.unsubscribers) {
			try {
				await unsub();
			} catch {}
		}
		this.unsubscribers = [];
		if (this.staleTimer) {
			clearTimeout(this.staleTimer);
			this.staleTimer = null;
		}
	}

	disable(): void {
		if (!this.enabled) return;
		this.enabled = false;
		this.emit({ cache: this.name, kind: "disabled" });
	}

	enable(): void {
		if (this.enabled) return;
		this.enabled = true;
		this.emit({ cache: this.name, kind: "enabled" });
	}

	stats(): NotifyCacheStats {
		return {
			name: this.name,
			state: this.state,
			stale: this.stale,
			lastLoadAt: this.lastLoadAt,
			lastLoadDurationMs: this.lastLoadDurationMs,
			hits: this.hits,
			misses: this.misses,
			invalidations: this.invalidations,
			failedLoads: this.failedLoads,
			enabled: this.enabled,
		};
	}
}
