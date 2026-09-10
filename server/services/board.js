/**
 * Read models for the clinic dashboard.
 *
 * One shape for a token and one for a session, whether it arrives in
 * GET /board, in an action response, or in a `token.changed` socket message.
 * The board is what a receptionist believes; every path that describes a
 * token has to describe it the same way, or the UI special-cases each one and
 * they drift.
 */
import { db } from '../db.js';
import { parse } from '../lib/util.js';
import { readProjection } from '../engine/engine.js';
import * as billing from './billing.js';
import * as simulator from './simulator.js';

const qToken = db.prepare(`SELECT t.*, p.name AS patient_name, p.phone, p.language, p.payer_type,
    p.insurer, p.travel_island, p.travel_atoll, p.dob
    FROM tokens t JOIN patients p ON p.id = t.patient_id WHERE t.id = ?`);
const qTokens = db.prepare(`SELECT t.*, p.name AS patient_name, p.phone, p.language, p.payer_type,
    p.insurer, p.travel_island, p.travel_atoll, p.dob
    FROM tokens t JOIN patients p ON p.id = t.patient_id WHERE t.session_id = ? ORDER BY t.seq, t.rowid`);
const qSession = db.prepare(`SELECT s.*, d.name AS doctor_name, d.specialty, d.fee_minor, d.languages
    FROM sessions s JOIN doctors d ON d.id = s.doctor_id WHERE s.id = ?`);
const qBlackouts = db.prepare('SELECT * FROM blackouts WHERE session_id = ? ORDER BY starts_at');

function enrich(row, projection) {
  const eligibility = billing.latestEligibility(row.patient_id);
  return {
    ...row,
    flags: parse(row.flags, []) || [],
    projection: projection?.entries?.find((e) => e.tokenId === row.id) ?? null,
    eligibility: eligibility ? { result: eligibility.result, detail: eligibility.detail } : null,
    invoice: billing.invoiceForTokenIfAny(row.id),
  };
}

/** One token as the board shows it. `projection` may be passed to save a read. */
export function tokenView(tokenId, projection) {
  const row = qToken.get(tokenId);
  if (!row) return null;
  return enrich(row, projection === undefined ? readProjection(row.session_id) : projection);
}

/** Every token of a session, in queue order, all states mixed. */
export function tokensView(sessionId, projection) {
  const p = projection === undefined ? readProjection(sessionId) : projection;
  return qTokens.all(sessionId).map((row) => enrich(row, p));
}

/** The session row as the board and `session.changed` carry it. */
export function sessionView(sessionId) {
  const row = qSession.get(sessionId);
  if (!row) return null;
  return {
    ...row,
    languages: parse(row.languages, []) || [],
    blackouts: qBlackouts.all(sessionId),
    simulating: simulator.status().some((x) => x.sessionId === sessionId),
  };
}
