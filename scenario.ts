// The suite's seeded identities, ported from the kit's wire.ts buildScenario(): the viewer the
// token belongs to, the other generated users, and the org login. The scenario is a compile-time
// constant of the suite (one fixed seed), so the forge derives the same logins the checks use.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** xorshift64*, exactly as wire.ts's Rng (only the methods user generation uses). */
class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.nextInt(i + 1);
      const swap = copy[i] as T;
      copy[i] = copy[j] as T;
      copy[j] = swap;
    }
    return copy;
  }
}

function scenarioRng(label: string): Rng {
  return new Rng(scenarioSeedFor(label));
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];
const REPO_ADJECTIVES: readonly string[] = [
  'amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively',
  'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat',
  'vivid', 'warm', 'witty', 'young', 'zesty',
];
const REPO_NOUNS: readonly string[] = [
  'acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor',
  'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven',
  'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr',
];

export interface ScenarioUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

export const USERS: readonly ScenarioUser[] = generateUsers(scenarioRng('users'), 12);
export const VIEWER: ScenarioUser = USERS[0] as ScenarioUser;
export const TEAMMATE: ScenarioUser = USERS[1] as ScenarioUser;
export const STRANGER: ScenarioUser = USERS[2] as ScenarioUser;

const orgRng = scenarioRng('org');
export const ORG_LOGIN = `${orgRng.pick(REPO_ADJECTIVES)}-${orgRng.pick(REPO_NOUNS)}-org`;

/** Every login the scenario knows: the viewer owns everything the token creates. */
export const KNOWN_LOGINS: ReadonlySet<string> = new Set([...USERS.map((user) => user.login), ORG_LOGIN]);
