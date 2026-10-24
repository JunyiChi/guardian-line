import fs from 'fs';
import path from 'path';
import { config } from './index';

/** Intervention ladder, weakest to strongest. The family caps it with maxIntervention. */
export const ACTIONS = ['none', 'log', 'notify_child_after_call', 'notify_child_now', 'whisper_senior'] as const;
export type Action = (typeof ACTIONS)[number];
export const ACTION_RANK: Record<Action, number> = { none: 0, log: 1, notify_child_after_call: 2, notify_child_now: 3, whisper_senior: 4 };

/**
 * What the adult child tells us about the household. Sent to the detector on every check so a
 * caller's story can be checked against reality (the courier we expect, the clinic we use, the
 * grandson's real age). It adjusts plausibility; it never excuses an extraction-stage request.
 */
export interface FamilyContext {
  seniorName: string;
  /** Language for the whisper and the family summary: en, zh, es, ... */
  language: string;
  childName: string;
  childRelation: string;
  familyMembers: string[];
  bank?: string;
  clinics: string[];
  pharmacy?: string;
  property?: string;
  expectedDeliveries: string[];
  whitelistedOrgs: string[];
  /** Strongest action the family allows. */
  maxIntervention: Action;
  /** Allow removing the caller from the conference at whisper level. */
  allowKick: boolean;
}

const DEFAULTS: FamilyContext = {
  seniorName: 'Mom', language: 'en', childName: 'your child', childRelation: 'child', familyMembers: [],
  clinics: [], expectedDeliveries: [], whitelistedOrgs: [], maxIntervention: 'whisper_senior', allowKick: false,
};

let cached: FamilyContext | null = null;

/** family.json (FAMILY_FILE), merged over defaults. Missing file = defaults, logged once. */
export function getFamily(): FamilyContext {
  if (cached) return cached;
  const file = path.isAbsolute(config.familyFile) ? config.familyFile : path.join(__dirname, '..', '..', config.familyFile);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    cached = { ...DEFAULTS, ...raw };
    if (!ACTIONS.includes(cached!.maxIntervention)) cached!.maxIntervention = 'whisper_senior';
  } catch (err: any) {
    console.warn(`[Guardian] [family] ${file} not readable (${err?.message ?? err}); using defaults`);
    cached = { ...DEFAULTS };
  }
  return cached!;
}

/** Text block for the detector's user message. */
export function familyPrompt(f: FamilyContext = getFamily()): string {
  const { maxIntervention, allowKick, ...visible } = f;
  return JSON.stringify(visible, null, 1);
}

/** Caps an action at what the family allows. */
export function capAction(a: Action, f: FamilyContext = getFamily()): Action {
  return ACTION_RANK[a] > ACTION_RANK[f.maxIntervention] ? f.maxIntervention : a;
}
