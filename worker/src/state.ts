import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { config } from './config';
import { errMsg, log } from './log';

export type ReplyClass = 'safe' | 'cant_move' | 'needs_medical' | 'unclear';

/** A reply we have already classified. `key` identifies (check-in, text) so the same reply is never re-asked. */
export interface ReplyRecord {
  key: string;
  category: ReplyClass;
  /** set_reply_class accepted, or permanently not applicable (unclear / reply no longer pending). */
  done: boolean;
}
/** The last note the worker sent for a building: the facts it was written from, and which world (scenario) they describe. */
export interface ExplanationRecord {
  hash: string;
  text: string;
  /** Hash of the scenario-stable facts (construction, fixes, residents). A different basis = a note about another world. */
  basis?: string;
}

interface Persisted {
  replies: Record<string, ReplyRecord>;
  explanations: Record<string, ExplanationRecord>;
  /** facts hash → note, across buildings and scenarios, so revisiting a scenario costs no model calls. */
  notes: Record<string, string>;
}

const MAX_NOTES = 300;

/** Small JSON file next to the token, so a restart never re-classifies a reply or re-pays for a note. */
export class WorkerState {
  private data: Persisted = { replies: {}, explanations: {}, notes: {} };
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly file = config.stateFile) {
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Persisted>;
      this.data = { replies: parsed.replies ?? {}, explanations: parsed.explanations ?? {}, notes: parsed.notes ?? {} };
      for (const r of Object.values(this.data.explanations)) this.data.notes[r.hash] ??= r.text; // older state files
      log.info('loaded worker state', {
        replies: Object.keys(this.data.replies).length,
        explanations: Object.keys(this.data.explanations).length,
        notes: Object.keys(this.data.notes).length,
      });
    } catch (e) {
      log.warn('could not read worker state, starting fresh', { file, error: errMsg(e) });
    }
  }

  reply(personId: number): ReplyRecord | undefined {
    return this.data.replies[personId];
  }
  setReply(personId: number, r: ReplyRecord) {
    this.data.replies[personId] = r;
    this.save();
  }
  forgetReply(personId: number) {
    if (!(personId in this.data.replies)) return;
    delete this.data.replies[personId];
    this.save();
  }

  explanation(buildingId: number): ExplanationRecord | undefined {
    return this.data.explanations[buildingId];
  }
  setExplanation(buildingId: number, r: ExplanationRecord) {
    this.data.explanations[buildingId] = r;
    this.save();
  }

  /** A note already written from exactly these facts (any building, any scenario). */
  note(hash: string): string | undefined {
    return this.data.notes[hash];
  }
  setNote(hash: string, text: string) {
    delete this.data.notes[hash]; // re-insert as newest
    this.data.notes[hash] = text;
    const keys = Object.keys(this.data.notes);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_NOTES))) delete this.data.notes[k];
    this.save();
  }

  /** Debounced atomic write. */
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }
  flush() {
    clearTimeout(this.timer);
    try {
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.data, null, 1));
      renameSync(tmp, this.file);
    } catch (e) {
      log.warn('could not save worker state', { error: errMsg(e) });
    }
  }
}
