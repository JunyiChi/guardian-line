import { EventEmitter } from 'events';

/** Which side of the call an audio track / transcript line belongs to. */
export type Speaker = 'caller' | 'protected';

/** The 4 universal scam warning signals. */
export interface Signals { urgency: boolean; threat: boolean; data_request: boolean; transfer_request: boolean }

export type RiskStatus = 'safe' | 'watching' | 'scam';

/** The 6 signals Jev reports as probabilities. */
export type JevSignal = 'urgency' | 'threat' | 'asks_for_codes_or_data' | 'asks_for_money' | 'impersonating_authority' | 'asks_for_secrecy';

export type AlertChannel = 'voice' | 'sms' | 'whatsapp' | 'hangup';

/** Every event that flows between modules. Add new ones here. */
export interface BusEvents {
  /** Twilio voice webhook hit; the call is not connected yet. */
  'call:ringing': { callSid: string; from: string };
  /** Media stream started, i.e. the consent announcement has finished playing. */
  'call:started': { callSid: string; from: string };
  'call:ended': { callSid: string };
  /** Raw mu-law 8kHz audio chunk from the Twilio media stream (memory only, never stored) */
  'call:audio': { callSid: string; speaker: Speaker; payload: Buffer };
  /** Speech-to-text result; isFinal=false for interim results. language = BCP-47 code when the provider detects it. */
  'transcript-update': { callSid: string; speaker: Speaker; text: string; isFinal: boolean; language?: string };
  /**
   * After every detector check. score = the call's risk 0-100 (Jev: scam_likelihood/4*100; LLM: smoothed).
   * status is sticky: once a scam is detected it stays 'scam' for the rest of the call.
   */
  'risk-update': {
    callSid: string; score: number; rawScore: number; scamType: string; reason: string;
    signals: Signals; impersonating: string; tier: 'fast' | 'precise' | 'jev';
    detector: 'jev' | 'llm'; status: RiskStatus;
    /** Jev only: score confidence, each signal's probability, the level label, response time and cost. */
    confidence?: number; probabilities?: Partial<Record<JevSignal, number>>; level?: string; ms?: number; cost?: number;
  };
  /** The detector's warning rule fired (once per call). */
  'scam-detected': { callSid: string; score: number; scamType: string; reason: string; signals: Signals; impersonating: string; detector: 'jev' | 'llm' };
  'alert:sent': { callSid: string; channel: AlertChannel; message: string };
}

type Key = keyof BusEvents;

/** Typed wrapper around EventEmitter. All modules talk through `bus`. */
class Bus extends EventEmitter {
  emit<K extends Key>(event: K, data: BusEvents[K]): boolean {
    return super.emit(event, data);
  }
  /**
   * Listeners are isolated: a throw or rejected promise in one module (STT, LLM, SMS...) is logged
   * and never reaches the emitter, so the other modules and the call keep going.
   */
  on<K extends Key>(event: K, listener: (data: BusEvents[K]) => unknown): this {
    const safe = (data: BusEvents[K]) => {
      const fail = (err: any) => console.error(`[Wessuwan] [error] ${event} listener failed: ${err?.message ?? err}`);
      try {
        const r = listener(data);
        if (r instanceof Promise) r.catch(fail);
      } catch (err) {
        fail(err);
      }
    };
    return super.on(event, safe);
  }
}

export const bus = new Bus();
