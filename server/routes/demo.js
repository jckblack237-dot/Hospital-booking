/** Demo controls: the virtual clock, the day simulator, and a reseed. */
import express from 'express';
import { db } from '../db.js';
import * as clock from '../lib/clock.js';
import { asyncRoute } from '../lib/util.js';
import { mvParts, mvTime, hhmm } from '../lib/mvtime.js';
import * as simulator from '../services/simulator.js';
import { stalenessReport } from '../engine/engine.js';
import { stats as realtimeStats } from '../realtime.js';
import { strings } from '../services/i18n.js';
import { seed } from '../seed.js';

export const router = express.Router();

router.get('/state', asyncRoute((req, res) => {
  const clinic = db.prepare('SELECT * FROM clinics ORDER BY rowid LIMIT 1').get();
  res.json({
    clock: { ...clock.state(), label: hhmm(clock.now()) },
    simulating: simulator.status(),
    realtime: realtimeStats(),
    staleness: stalenessReport(),
    clinicId: clinic?.id,
    personas: db.prepare("SELECT id, name FROM patients WHERE name IN ('Aishath Shifa','Fathimath Rasheedha')").all(),
  });
}));

router.post('/clock', asyncRoute((req, res) => {
  if (req.body?.speed != null) clock.setSpeed(Number(req.body.speed));
  if (req.body?.hour != null) {
    const p = mvParts(clock.now());
    clock.setTime(mvTime(p.year, p.month, p.day, Number(req.body.hour), Number(req.body.minute ?? 0)));
  }
  if (req.body?.advanceMinutes) clock.setTime(clock.now() + Number(req.body.advanceMinutes) * 60_000);
  res.json({ ...clock.state(), label: hhmm(clock.now()) });
}));


router.post('/reseed', asyncRoute((req, res) => {
  for (const s of simulator.status()) simulator.disable(s.sessionId);
  const result = seed({ force: true });
  res.json(result);
}));

router.get('/i18n/:locale', asyncRoute((req, res) => {
  res.json(strings(req.params.locale === 'dv' ? 'dv' : 'en'));
}));
