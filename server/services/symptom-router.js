/**
 * Symptom -> specialty router.
 *
 * Three hard behaviours, and they are not negotiable:
 *  1. Red-flag interception. Emergency guidance is surfaced ABOVE any booking
 *     option and cannot be dismissed away from the first screen.
 *  2. It never names a condition. Output is always "doctors who treat this",
 *     never "you may have X". That is a regulatory and safety line.
 *  3. It fails to breadth, not to confidence. Unrecognised input returns
 *     general practice and a search box, never a guess.
 *
 * This is a curated, clinically-reviewable mapping — deliberately not a
 * generative model.
 */

export const EMERGENCY_NUMBER = '102';

const RED_FLAGS = [
  { match: ['chest pain', 'chest tightness', 'crushing chest', 'pain in chest'], why: 'Chest pain can be a heart emergency.' },
  { match: ['difficulty breathing', 'cannot breathe', "can't breathe", 'shortness of breath', 'gasping'], why: 'Breathing difficulty needs urgent assessment.' },
  { match: ['severe bleeding', 'heavy bleeding', 'bleeding a lot', 'blood loss'], why: 'Heavy bleeding needs emergency care.' },
  { match: ['unconscious', 'unresponsive', 'not waking', 'fainted and not waking'], why: 'An unresponsive person needs emergency care now.' },
  { match: ['face drooping', 'slurred speech', 'weakness one side', 'stroke'], why: 'These can be signs of a stroke. Time matters.' },
  { match: ['seizure', 'fitting', 'convulsion'], why: 'An ongoing seizure needs emergency care.' },
  { match: ['baby not breathing', 'child not breathing', 'blue lips'], why: 'This is an emergency.' },
  { match: ['suicide', 'kill myself', 'end my life'], why: 'Please talk to someone now. You are not alone.' },
];

const MAP = [
  { specialty: 'paediatrics', terms: ['child', 'baby', 'kid', 'infant', 'toddler', 'kujjaa', 'fever in child', 'vaccination', 'wheeze', 'newborn'] },
  { specialty: 'cardiology', terms: ['heart', 'palpitation', 'blood pressure', 'bp high', 'cholesterol', 'ecg'] },
  { specialty: 'dermatology', terms: ['skin', 'rash', 'acne', 'itch', 'eczema', 'hair loss', 'fungal'] },
  { specialty: 'ent', terms: ['ear', 'nose', 'throat', 'sinus', 'tonsil', 'hearing', 'sore throat', 'blocked nose'] },
  { specialty: 'obgyn', terms: ['pregnan', 'period', 'menstrual', 'gynae', 'antenatal', 'womb', 'fertility'] },
  { specialty: 'ophthalmology', terms: ['eye', 'vision', 'blurred', 'spectacle', 'glasses', 'red eye'] },
  { specialty: 'orthopaedics', terms: ['bone', 'fracture', 'knee', 'back pain', 'joint', 'shoulder', 'sprain'] },
  { specialty: 'internal_medicine', terms: ['diabetes', 'sugar', 'thyroid', 'stomach', 'liver', 'kidney', 'fatigue', 'weight loss'] },
  { specialty: 'psychiatry', terms: ['anxiety', 'depress', 'sleep', 'stress', 'panic', 'mental'] },
  { specialty: 'dental', terms: ['tooth', 'teeth', 'gum', 'dental', 'cavity'] },
  { specialty: 'general_practice', terms: ['fever', 'cough', 'cold', 'flu', 'headache', 'checkup', 'certificate', 'general', 'hun'] },
];

export function route(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return { emergency: null, specialties: ['general_practice'], matched: false };

  for (const flag of RED_FLAGS) {
    if (flag.match.some((m) => q.includes(m))) {
      return {
        emergency: {
          why: flag.why,
          number: EMERGENCY_NUMBER,
          action: 'Call emergency services or go to the nearest emergency department now.',
        },
        specialties: ['general_practice'],
        matched: true,
      };
    }
  }

  const hits = [];
  for (const entry of MAP) {
    const score = entry.terms.reduce((s, t) => s + (q.includes(t) ? t.length : 0), 0);
    if (score) hits.push({ specialty: entry.specialty, score });
  }
  hits.sort((a, b) => b.score - a.score);

  if (!hits.length) {
    // Fail to breadth. Never guess.
    return { emergency: null, specialties: ['general_practice'], matched: false };
  }
  return { emergency: null, specialties: hits.slice(0, 3).map((h) => h.specialty), matched: true };
}

export const SPECIALTY_LABELS = {
  general_practice: 'General practice', internal_medicine: 'Internal medicine',
  paediatrics: 'Paediatrics', obgyn: 'Obstetrics & gynaecology', cardiology: 'Cardiology',
  dermatology: 'Dermatology', ent: 'ENT', ophthalmology: 'Ophthalmology',
  orthopaedics: 'Orthopaedics', dental: 'Dental', psychiatry: 'Psychiatry', physiotherapy: 'Physiotherapy',
};

export const LANGUAGE_LABELS = { dv: 'Dhivehi', en: 'English', hi: 'Hindi/Urdu', ur: 'Hindi/Urdu', bn: 'Bengali', si: 'Sinhala', tl: 'Tagalog' };
