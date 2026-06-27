import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

export type RuleType = 'learned' | 'custom' | 'ignored';

export interface UserRule {
  id: string;
  rule_text: string;
  rule_type: RuleType;
  created_at: string;
}

export interface UserPrefs {
  currency: 'pound' | 'GBP' | 'both';
  english: 'UK' | 'US';
  context: 'pharma' | 'general' | 'legal' | 'medical' | 'marketing';
  show_suggestions: boolean;
}

export interface UserStats {
  docs: number;
  corrections: number;
}

const DEFAULT_PREFS: UserPrefs = {
  currency: 'pound',
  english: 'UK',
  context: 'pharma',
  show_suggestions: true,
};

// Rules
export async function getRules(uid: string): Promise<UserRule[]> {
  return (await kv.get<UserRule[]>(`proof:${uid}:rules`)) ?? [];
}
export async function saveRules(uid: string, rules: UserRule[]): Promise<void> {
  await kv.set(`proof:${uid}:rules`, rules);
}
export async function addRule(uid: string, text: string, type: RuleType): Promise<UserRule[]> {
  const rules = await getRules(uid);
  const updated = [{ id: crypto.randomUUID(), rule_text: text, rule_type: type, created_at: new Date().toISOString() }, ...rules];
  await saveRules(uid, updated);
  return updated;
}
export async function deleteRule(uid: string, id: string): Promise<UserRule[]> {
  const updated = (await getRules(uid)).filter(r => r.id !== id);
  await saveRules(uid, updated);
  return updated;
}

// Prefs
export async function getPrefs(uid: string): Promise<UserPrefs> {
  return (await kv.get<UserPrefs>(`proof:${uid}:prefs`)) ?? DEFAULT_PREFS;
}
export async function savePrefs(uid: string, prefs: UserPrefs): Promise<void> {
  await kv.set(`proof:${uid}:prefs`, prefs);
}

// Stats
export async function getStats(uid: string): Promise<UserStats> {
  return (await kv.get<UserStats>(`proof:${uid}:stats`)) ?? { docs: 0, corrections: 0 };
}
export async function incrementStat(uid: string, field: keyof UserStats): Promise<void> {
  const stats = await getStats(uid);
  await kv.set(`proof:${uid}:stats`, { ...stats, [field]: stats[field] + 1 });
}
