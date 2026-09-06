/**
 * The bridge between the engine and everything downstream.
 *
 * engine.recompute() -> materiality decision -> (a) realtime fanout to the
 * clinic board and patient app, (b) a message down the channel cascade,
 * (c) partner webhooks. Nothing else is allowed to send a patient a message,
 * so the debounce and rate caps cannot be bypassed by accident.
 */
import { db } from '../db.js';
import { now } from '../lib/clock.js';
import { parse } from '../lib/util.js';
import { hhmm, rfc3339 } from '../lib/mvtime.js';
import { onProjection } from '../engine/engine.js';
import { publish } from '../realtime.js';
import * as messaging from './messaging.js';
import * as webhooks from './webhooks.js';

const RULE_TO_TEMPLATE = {
  position: 'position',
  leave_now: 'leave_now',
  next: 'next',
  called: 'called',
  eta_changed: 'eta_changed',
  improved: 'improved',
  paused: 'paused',
  penalised: 'penalised',
  at_risk: 'at_risk',
};

const RULE_TO_WEBHOOK = {
  position: 'queue.token.eta_changed',
  leave_now: 'queue.token.leave_now',
  next: 'queue.token.next',
  called: 'queue.token.called',
  eta_changed: 'queue.token.eta_changed',
  improved: 'queue.token.eta_changed',
  penalised: 'queue.token.penalised',
  at_risk: 'queue.token.at_risk',
  paused: 'queue.session.paused',
};

function patientFor(id) {
  return db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
}

function varsFor(entry, decision, session) {
  const doctor = db.prepare(`SELECT d.name FROM doctors d JOIN sessions s ON s.doctor_id = d.id WHERE s.id = ?`).get(session.id);
  const win = messaging.windowText(entry);
  return {
    token: entry.display,
    ahead: entry.tokensAhead,
    window: win,
    doctor: doctor?.name ?? 'Your doctor',
    deltaMinutes: Math.abs(decision.data.deltaMinutes ?? entry.deltaMinutes ?? 0),
    reasonText: messaging.REASON_TEXT[entry.reason] ?? 'the queue changed',
    kind: session.state === 'paused' ? 'break' : 'break',
    resume: hhmm(entry.predictedStart.window.from),
    positions: 2,
    calledAt: hhmm(now()),
    when: hhmm(session.scheduled_start),
  };
}

export function start() {
  onProjection(({ projection, notifications, session }) => {
    // (a) realtime — the board and every patient tracking a token in it
    publish(`session:${projection.sessionId}`, { type: 'projection', ...projection });
    publish(`clinic:${session.clinic_id}`, { type: 'projection', ...projection });
    for (const entry of projection.entries) {
      publish(`patient:${entry.patientId}`, { type: 'token_update', sessionId: projection.sessionId, entry, version: projection.version });
    }

    if (projection.nowServing) {
      webhooks.emit({
        type: 'queue.token.now_serving', clinicId: session.clinic_id, sessionId: session.id,
        sequence: projection.version,
        data: { token_display: projection.nowServing.display, started_at: rfc3339(projection.nowServing.startedAt) },
      });
    }

    for (const decision of notifications) {
      const { entry, rule } = decision;
      const token = db.prepare('SELECT * FROM tokens WHERE id = ?').get(entry.tokenId);
      if (!token) continue;
      const patient = patientFor(entry.patientId);
      if (!patient) continue;

      // (b) message — suppressed when the partner has taken responsibility for
      // relaying, so the patient does not get two sets of notifications.
      const template = RULE_TO_TEMPLATE[rule];
      if (template && !token.notify_via_partner_only) {
        const sent = messaging.send({
          patient, clinicId: session.clinic_id, tokenId: entry.tokenId,
          template, vars: varsFor(entry, decision, session), urgent: decision.urgent,
        });
        if (sent) publish(`patient:${patient.id}`, { type: 'message', message: sent });
        if (sent) publish(`clinic:${session.clinic_id}`, { type: 'message_sent', message: { ...sent, patient_name: patient.name } });
      }

      // (c) partner webhook
      const wh = RULE_TO_WEBHOOK[rule];
      if (wh) {
        webhooks.emit({
          type: wh, clinicId: session.clinic_id, sessionId: session.id, sequence: projection.version,
          data: {
            booking_id: token.id, token_display: entry.display, tokens_ahead: entry.tokensAhead,
            predicted_start: {
              p50: rfc3339(entry.predictedStart.p50),
              p80_window: { from: rfc3339(entry.predictedStart.window.from), to: rfc3339(entry.predictedStart.window.to) },
              confidence: entry.predictedStart.confidence,
            },
            delta_minutes: entry.deltaMinutes ?? 0,
            reason: entry.reason ?? null,
            token_id: token.id,
          },
        });
      }
    }
  });
}

/** Session-level partner events, emitted by the outbox relay. */
const OUTBOX_TO_WEBHOOK = {
  'session.started': 'queue.session.started',
  'session.delayed': 'queue.session.delayed',
  'session.paused': 'queue.session.paused',
  'session.resumed': 'queue.session.resumed',
  'session.cancelled': 'queue.session.cancelled',
  'token.created': 'booking.confirmed',
  'token.cancelled': 'booking.cancelled',
  'token.no_show': 'queue.token.no_show',
  'consultation.ended': 'queue.token.completed',
};

/**
 * Outbox relay. The queue mutation and its event committed together; this
 * drains them to the partner bus. Losing one silently corrupts every
 * downstream ETA, which is why it is a relay over a durable table rather than
 * a fire-and-forget call at the mutation site.
 */
export function relayOutbox(limit = 100) {
  const rows = db.prepare(`SELECT e.* FROM outbox o JOIN events e ON e.seq = o.event_seq
                           WHERE o.processed = 0 ORDER BY e.seq LIMIT ?`).all(limit);
  const mark = db.prepare('UPDATE outbox SET processed = 1 WHERE event_seq = ?');
  for (const e of rows) {
    const type = OUTBOX_TO_WEBHOOK[e.type];
    if (type) {
      const payload = parse(e.payload, {}) || {};
      webhooks.emit({
        type, clinicId: e.clinic_id, sessionId: e.session_id, sequence: e.seq,
        data: e.token_id ? { booking_id: e.token_id, token_id: e.token_id, ...payload } : payload,
      });
    }
    mark.run(e.seq);
  }
  return rows.length;
}
