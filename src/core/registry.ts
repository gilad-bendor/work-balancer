// Info-provider contracts and registry (instructions §4.1, ledger R-INFO-1).
// Each provider module augments ProviderTypeMap (declaration merging is erasable):
//   declare module '../../core/registry.ts' {
//     interface ProviderTypeMap { interactive: { minute: InteractiveMinute; range: InteractiveRange } }
//   }
import type { Clock } from './clock.ts';
import type { Logger } from './log.ts';
import type { MinuteKey } from './time.ts';
import type { Store } from '../store/store.ts';

export interface ProviderTypeMap {}

export type ProviderName = Extract<keyof ProviderTypeMap, string>;
export type MinuteOf<N extends ProviderName> = ProviderTypeMap[N] extends { minute: infer M } ? M : never;
export type RangeOf<N extends ProviderName> = ProviderTypeMap[N] extends { range: infer R } ? R : never;

export interface ProviderContext {
  clock: Clock;
  log: Logger;
  store: Store;
  repo: InfoRepository;
}

/** One record per minute. Raw providers persist theirs through the store; digests compute on demand, never persist. */
export interface PerMinuteInfoProvider<M> {
  readonly name: string;
  /** Names of providers whose minute info this one digests. */
  readonly dependsOn: readonly string[];
  start?(ctx: ProviderContext): void | Promise<void>;
  stop?(): void | Promise<void>;
  getMinuteInfo(minute: MinuteKey): M | null;
}

/** Aggregate over [start, end) (MinuteKeys); null when there is no data. */
export interface TimeRangeInfoProvider<R> {
  readonly name: string;
  getRangeInfo(start: MinuteKey, end: MinuteKey): R | null;
}

export interface ProviderEntry<N extends ProviderName> {
  perMinute: PerMinuteInfoProvider<MinuteOf<N>>;
  timeRange?: TimeRangeInfoProvider<RangeOf<N>>;
}

export interface InfoRepository {
  register<N extends ProviderName>(name: N, entry: ProviderEntry<N>): void;
  get<N extends ProviderName>(name: N): ProviderEntry<N>;
  has(name: string): boolean;
  names(): string[];
  /** Starts every provider after the providers it depends on. Throws on a missing dependency or a cycle. */
  startAll(ctx: Omit<ProviderContext, 'repo'>): Promise<void>;
  stopAll(): Promise<void>;
}

export function createInfoRepository(): InfoRepository {
  const entries = new Map<string, ProviderEntry<ProviderName>>();
  let started: string[] = [];

  const order = (): string[] => {
    const out: string[] = [];
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (name: string, from: string | null): void => {
      const e = entries.get(name);
      if (!e) throw new Error(`provider ${from ?? '?'} depends on unknown provider ${name}`);
      const s = state.get(name);
      if (s === 'done') return;
      if (s === 'visiting') throw new Error(`provider dependency cycle at ${name}`);
      state.set(name, 'visiting');
      for (const dep of e.perMinute.dependsOn) visit(dep, name);
      state.set(name, 'done');
      out.push(name);
    };
    for (const name of entries.keys()) visit(name, null);
    return out;
  };

  const repo: InfoRepository = {
    register(name, entry) {
      if (entries.has(name)) throw new Error(`provider ${name} registered twice`);
      if (entry.perMinute.name !== name) throw new Error(`provider registered as ${name} but named ${entry.perMinute.name}`);
      entries.set(name, entry as unknown as ProviderEntry<ProviderName>);
    },
    get(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`unknown provider ${name}`);
      return e as unknown as ProviderEntry<typeof name>;
    },
    has: (name) => entries.has(name),
    names: () => [...entries.keys()],
    async startAll(ctx) {
      for (const name of order()) {
        await entries.get(name)!.perMinute.start?.({ ...ctx, repo });
        started.push(name);
      }
    },
    async stopAll() {
      for (const name of started.reverse()) await entries.get(name)?.perMinute.stop?.();
      started = [];
    },
  };
  return repo;
}
