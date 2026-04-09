/* ═══════════════════════════════════════════════════════════════════
   DATA MODEL
═══════════════════════════════════════════════════════════════════ */
const AVG = 10; // minutes per consultation

// Doctors registry
let doctors = [
  { id:'d1', name:'Dr. Ramesh',  room:'Room 1', emoji:'👨‍⚕️', specialty:'General Physician', maxCap:8,  status:'available', consulStart:null },
  { id:'d2', name:'Dr. Malathi', room:'Room 2', emoji:'👩‍⚕️', specialty:'Internal Medicine', maxCap:7,  status:'available', consulStart:null },
  { id:'d3', name:'Dr. Kumar',   room:'Room 3', emoji:'👨‍⚕️', specialty:'Cardiologist',       maxCap:6,  status:'available', consulStart:null },
  { id:'d4', name:'Dr. Priya',   room:'Room 4', emoji:'👩‍⚕️', specialty:'Pediatrician',       maxCap:10, status:'available', consulStart:null },
];

// Patients list
let pts = [];
let tok = 1;
let activeDocId = 'd1';

// Agent metrics
const PRIORITY_BOOSTS = { medium: 20, high: 45 };
const agentMetrics = { priority:0, doctor:0, predict:0 };

// Derived queue index cache for faster lookups.
let queueIndex = null;
let queueIndexDirty = true;
let lastStateValidationKey = '';

// Notification throttling to avoid toast spam from monitoring agents.
const AGENT_NOTIFY_COOLDOWN_MS = 120000;
const agentNotifyState = {};

/* ═══ EMERGENCY KEYWORD DETECTION ══════════════════════════════ */
const EMG_KEYWORDS = [
  'chest pain','chest ache','heart attack','stroke','unconscious','fainted','severe bleeding',
  'difficulty breathing','breathless','can\'t breathe','head injury','seizure','fitting',
  'poisoning','overdose','severe burn','fracture','broken bone','paralysis','loss of vision',
  'sudden blindness','allergic reaction','anaphylaxis','severe pain','high fever','fainting',
  'bp drop','blood pressure drop','vomiting blood','bp crash','cardiac','angina','palpitations'
];

function detectEmergency(text) {
  const t = text.toLowerCase();
  return EMG_KEYWORDS.some(k => t.includes(k));
}

function getWaitingMinutes(patient) {
  return patient.s === 'w' ? Math.max(0, Math.floor((Date.now() - patient.reg) / 60000)) : 0;
}

function flashAgentStatus(elementId, activeText = 'TRIGGERED', idleText = 'IDLE', delay = 3000) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = activeText;
  el.className = 'agent-card-status status-alert';
  window.clearTimeout(el._agentResetTimer);
  el._agentResetTimer = window.setTimeout(() => {
    el.textContent = idleText;
    el.className = 'agent-card-status status-idle';
  }, delay);
}

function calcScore(p) {
  const baseScore = p.emg ? 100 : p.sr ? 50 : 0;
  const waitMin = getWaitingMinutes(p);
  const priorityBoost = p.priorityBoost || 0;
  return baseScore + waitMin + priorityBoost;
}

function compareWaitingPatients(a, b) {
  const scoreDiff = calcScore(b) - calcScore(a);
  if (scoreDiff !== 0) return scoreDiff;
  const regDiff = a.reg - b.reg;
  if (regDiff !== 0) return regDiff;
  return String(a.id).localeCompare(String(b.id));
}

function markQueueIndexDirty() {
  queueIndexDirty = true;
}

function buildQueueIndex() {
  if (!queueIndexDirty && queueIndex) return queueIndex;

  const byDoctor = {};
  doctors.forEach(d => {
    byDoctor[d.id] = { waiting: [], inProgress: [], done: [], active: [] };
  });

  const waitingAll = [];
  const inProgressAll = [];
  const doneAll = [];

  pts.forEach(p => {
    if (p.s === 'w') waitingAll.push(p);
    if (p.s === 'ip') inProgressAll.push(p);
    if (p.s === 'done') doneAll.push(p);

    if (!p.docId) return;
    if (!byDoctor[p.docId]) byDoctor[p.docId] = { waiting: [], inProgress: [], done: [], active: [] };

    if (p.s === 'w') byDoctor[p.docId].waiting.push(p);
    if (p.s === 'ip') byDoctor[p.docId].inProgress.push(p);
    if (p.s === 'done') byDoctor[p.docId].done.push(p);
    if (p.s !== 'done') byDoctor[p.docId].active.push(p);
  });

  Object.values(byDoctor).forEach(group => {
    group.waiting.sort(compareWaitingPatients);
    group.active.sort((a, b) => {
      if (a.s !== b.s) return a.s === 'ip' ? -1 : 1;
      return compareWaitingPatients(a, b);
    });
  });

  waitingAll.sort(compareWaitingPatients);

  queueIndex = { byDoctor, waitingAll, inProgressAll, doneAll };
  queueIndexDirty = false;
  return queueIndex;
}

function agentPriorityBooster() {
  let boostedCount = 0;

  pts.forEach(p => {
    if (p.s !== 'w') {
      p.priorityBoost = 0;
      p.priorityBoostStage = 0;
      return;
    }

    const waitMin = getWaitingMinutes(p);
    const nextStage = waitMin >= 40 ? 2 : waitMin >= 20 ? 1 : 0;
    const nextBoost = nextStage === 2 ? PRIORITY_BOOSTS.high : nextStage === 1 ? PRIORITY_BOOSTS.medium : 0;

    if (p.priorityBoostStage !== nextStage) {
      const oldStage = p.priorityBoostStage || 0;
      p.priorityBoostStage = nextStage;
      p.priorityBoost = nextBoost;
      boostedCount++;

      if (nextStage > oldStage) {
        const label = nextStage === 2 ? 'moved near the top' : 'got a priority boost';
        toast('⚡', 'Priority Updated', `${p.nm} has been waiting ${waitMin} minutes and ${label}.`, 'warn', 'Priority Booster');
        logAgent('priority', `⚡ Priority Booster: ${p.tok} (${p.nm}) waiting ${waitMin}m -> boost ${nextBoost}`, 'info');
      }
    }
  });

  if (boostedCount > 0) {
    agentMetrics.priority += boostedCount;
    flashAgentStatus('priority-agent-status');
    updateAgentMetricUI();
    markQueueIndexDirty();
  }
}

function predictDoctorWait(docId) {
  const doc = getDoc(docId);
  if (!doc) return 0;

  const waiting = getDocWaiting(docId).length;
  const inConsult = pts.find(p => p.s === 'ip' && p.docId === docId);
  const consultPenalty = inConsult && inConsult.cal
    ? Math.max(0, AVG - Math.floor((Date.now() - inConsult.cal) / 60000))
    : 0;

  return waiting * AVG + consultPenalty;
}

function getDoctorSuggestion(preferredDocId) {
  const available = doctors.filter(d => d.status !== 'offline');
  if (!available.length) return { bestDoc: null, selectedDoc: null };

  const ranked = available
    .map(doc => ({ doc, predictedWait: predictDoctorWait(doc.id), load: getDocWaiting(doc.id).length }))
    .sort((a, b) => a.predictedWait - b.predictedWait || a.load - b.load || a.doc.name.localeCompare(b.doc.name));

  const best = ranked[0];
  const selectedDoc = preferredDocId ? getDoc(preferredDocId) : null;
  const selectedWait = selectedDoc ? predictDoctorWait(selectedDoc.id) : null;

  return {
    bestDoc: best ? best.doc : null,
    bestWait: best ? best.predictedWait : null,
    selectedDoc,
    selectedWait,
  };
}

function agentAssign(patient, preferredDocId) {
  const suggestion = getDoctorSuggestion(preferredDocId);
  const available = doctors.filter(d => d.status !== 'offline');

  if (!available.length) {
    toast('⚠️', 'No Doctors Available', 'All doctors are offline. Patient queued.', 'warn', 'Doctor Suggestion Agent');
    logAgent('doctor', '⚠️ Doctor Suggestion: all doctors are offline — patient queued without assignment', 'warn');
    return null;
  }

  if (preferredDocId) {
    const prefDoc = suggestion.selectedDoc;
    if (prefDoc && prefDoc.status !== 'offline') {
      const load = getDocWaiting(prefDoc.id).length;
      const bestDoc = suggestion.bestDoc;
      const bestWait = suggestion.bestWait ?? predictDoctorWait(prefDoc.id);

      if (load >= prefDoc.maxCap || (bestDoc && bestDoc.id !== prefDoc.id && (suggestion.selectedWait ?? 0) - bestWait >= 20)) {
        toast('🩺', 'Better Doctor Suggested', `${bestDoc ? bestDoc.name : 'Another doctor'} has a shorter wait than ${prefDoc.name}.`, 'warn', 'Doctor Suggestion Agent');
        showSuggestion(`🩺 <strong>Doctor Suggestion Agent:</strong> ${bestDoc ? bestDoc.name : 'Another doctor'} currently looks better than <strong>${prefDoc.name}</strong> because the predicted wait is shorter.`);
        flashAgentStatus('doctor-agent-status');
      }

      logAgent('doctor', `🩺 Doctor Suggestion: ${patient.nm} kept with ${prefDoc.name} (predicted wait ${suggestion.selectedWait ?? 0}m)`, 'info');
      agentMetrics.doctor++;
      updateAgentMetricUI();
      return prefDoc.id;
    }
  }

  const bestDoc = suggestion.bestDoc;
  if (!bestDoc) return null;

  logAgent('doctor', `🩺 Doctor Suggestion: ${patient.nm} → ${bestDoc.name} (best predicted wait ${suggestion.bestWait ?? 0}m)`, 'info');
  agentMetrics.doctor++;
  updateAgentMetricUI();
  return bestDoc.id;
}

function agentPredictWaitTimes() {
  let highDelayCount = 0;

  doctors.forEach(doc => {
    if (doc.status === 'offline') {
      doc.predictedWait = 0;
      return;
    }

    const predictedWait = predictDoctorWait(doc.id);
    doc.predictedWait = predictedWait;

    if (predictedWait >= 60 && shouldNotify(`predict:${doc.id}`, 90000)) {
      highDelayCount++;
      toast('📈', 'Wait Time Warning', `${doc.name} is predicted to take about ${predictedWait} minutes.`, 'warn', 'Wait Time Predictor');
      logAgent('predict', `📈 Wait Time Predictor: ${doc.name} predicted wait ${predictedWait}m`, 'warn');
      flashAgentStatus('predict-agent-status');
    }
  });

  if (highDelayCount > 0) {
    agentMetrics.predict += highDelayCount;
    updateAgentMetricUI();
  }
}

function agentOptimizeQueue(docId) {
  agentPriorityBooster();
  markQueueIndexDirty();
}

/* ═══ INTERNAL: EMERGENCY DETECTOR ══════════════════════════════ */
function agentDetectEmergency(patient) {
  if (detectEmergency(patient.cc)) {
    if (!patient.emg) {
      patient.emg = true;
      patient.priorityBoostStage = 2;
      patient.priorityBoost = PRIORITY_BOOSTS.high;
      agentMetrics.priority++;
      flashAgentStatus('priority-agent-status');
      toast('🚨', 'Emergency Detected!', `"${patient.cc}" flagged as emergency. Queue position bumped.`, 'emg', 'Smart Priority Booster');
      logAgent('priority', `🚨 Priority Booster: auto-escalated ${patient.nm} — "${patient.cc}" matches emergency pattern`, 'alert');
      updateAgentMetricUI();
      return true;
    }
  }
  return false;
}

/* ═══ AGENT 4: DOCTOR REASSIGNMENT ═════════════════════════════ */
function agentReassign(offlineDocId) {
  const queue = pts.filter(p => p.s === 'w' && p.docId === offlineDocId);
  if (!queue.length) return;

  const available = doctors.filter(d => d.id !== offlineDocId && d.status !== 'offline');
  if (!available.length) {
    toast('⚠️', 'Reassignment Failed', 'No available doctors to reassign patients to.', 'warn', 'Doctor Suggestion Agent');
    return;
  }

  let count = 0;
  queue.forEach(p => {
    p.docId = null;
    p.dr = 'Unassigned';

    const reassignedDocId = agentAssign(p, null);
    const reassignedDoc = getDoc(reassignedDocId);
    if (reassignedDocId && reassignedDoc) {
      p.docId = reassignedDocId;
      p.dr = reassignedDoc.name + ' (' + reassignedDoc.room + ')';
      count++;
    }
  });
  markQueueIndexDirty();
  const offDoc = getDoc(offlineDocId);
  flashAgentStatus('doctor-agent-status');
  toast('🔄', 'Patients Reassigned', `${count} patient(s) from ${offDoc.name} redistributed to available doctors.`, 'ok', 'Doctor Suggestion Agent');
  logAgent('doctor', `🔄 Doctor Suggestion: ${count} patients from ${offDoc.name} redistributed after going offline`, 'ok');
  updateAgentMetricUI();
}

/* ═══ AGENT 5: WAIT TIME + LOAD MONITOR ════════════════════════ */
function agentUpdateWaitTimes() {
  agentPriorityBooster();
  buildQueueIndex();
  doctors.forEach(doc => {
    const q = getSortedWaiting(doc.id);
    q.forEach((p, i) => { p.ewt = i * AVG; });

    doc.predictedWait = predictDoctorWait(doc.id);

    const load = q.length;
    if (doc.status !== 'offline') {
      const inConsult = pts.find(p => p.s === 'ip' && p.docId === doc.id);
      if (load === 0 && !inConsult) doc.status = 'available';
      else if (load >= doc.maxCap) doc.status = 'overloaded';
      else doc.status = 'busy';
    }
  });

  agentPredictWaitTimes();
}

/* ═══ HELPERS ═══════════════════════════════════════════════════ */
function getDoc(id) { return doctors.find(d => d.id === id); }
function getDocQueue(id) {
  const idx = buildQueueIndex();
  return idx.byDoctor[id] ? idx.byDoctor[id].active : [];
}
function getDocWaiting(id) {
  const idx = buildQueueIndex();
  return idx.byDoctor[id] ? idx.byDoctor[id].waiting : [];
}
function getSortedWaiting(id) {
  return getDocWaiting(id);
}

function validateSystemState() {
  const idx = buildQueueIndex();
  const offenders = doctors
    .map(d => ({ name: d.name, ipCount: idx.byDoctor[d.id] ? idx.byDoctor[d.id].inProgress.length : 0 }))
    .filter(x => x.ipCount > 1);

  const key = offenders.map(x => `${x.name}:${x.ipCount}`).join('|');
  if (key && key !== lastStateValidationKey) {
    logAgent('optim', `⚠️ State Validator: multiple in-progress patients detected (${key})`, 'warn');
  }
  lastStateValidationKey = key;
}

function shouldNotify(key, cooldownMs = AGENT_NOTIFY_COOLDOWN_MS) {
  const now = Date.now();
  const last = agentNotifyState[key] || 0;
  if (now - last < cooldownMs) return false;
  agentNotifyState[key] = now;
  return true;
}

function getDoctorAlerts(docId) {
  const doc = getDoc(docId);
  if (!doc) return [];

  const waiting = getSortedWaiting(docId);
  const inConsult = pts.find(p => p.s === 'ip' && p.docId === docId);
  const consultMin = inConsult && inConsult.cal ? Math.floor((Date.now() - inConsult.cal) / 60000) : 0;
  const alerts = [];

  if (doc.status === 'offline') alerts.push({ level: 'info', text: 'Doctor is offline' });
  if (waiting.length >= doc.maxCap) alerts.push({ level: 'high', text: `Queue overloaded (${waiting.length}/${doc.maxCap})` });
  else if (waiting.length >= Math.floor(doc.maxCap * 0.75)) alerts.push({ level: 'med', text: `Queue nearing capacity (${waiting.length}/${doc.maxCap})` });

  if (waiting.some(p => p.emg)) alerts.push({ level: 'high', text: 'Emergency patient waiting' });
  if (waiting.length > 0 && !inConsult && doc.status !== 'offline') alerts.push({ level: 'med', text: 'Patients waiting but consultation not started' });
  if (consultMin >= Math.max(15, AVG * 2)) alerts.push({ level: 'med', text: `Current consultation running long (${consultMin}m)` });

  return alerts;
}

function agentDoctorOpsMonitor() {
  doctors.forEach(doc => {
    if (doc.status === 'offline') return;

    const alerts = getDoctorAlerts(doc.id);
    const hasOverload = alerts.some(a => a.text.includes('overloaded'));
    const hasEmergency = alerts.some(a => a.text.includes('Emergency patient'));
    const hasIdleWait = alerts.some(a => a.text.includes('consultation not started'));
    const hasLongConsult = alerts.some(a => a.text.includes('running long'));

    if (hasOverload && shouldNotify(`overload:${doc.id}`)) {
      const load = getSortedWaiting(doc.id).length;
      toast('⚠️', 'Doctor Queue Overloaded', `${doc.name} is at ${load}/${doc.maxCap}. Consider reassignment.`, 'warn', 'Doctor Suggestion Agent');
      logAgent('doctor', `🩺 Doctor Suggestion: ${doc.name} overloaded (${load}/${doc.maxCap})`, 'warn');
    }

    if (hasEmergency && shouldNotify(`emgwait:${doc.id}`)) {
      const emgPatient = getSortedWaiting(doc.id).find(p => p.emg);
      toast('🚨', 'Emergency Waiting', `${doc.name} has emergency patient ${emgPatient ? emgPatient.tok : ''} pending.`, 'emg', 'Smart Priority Booster');
      logAgent('priority', `🚨 Priority Booster: emergency patient waiting for ${doc.name}`, 'alert');
    }

    if (hasIdleWait && shouldNotify(`idlewait:${doc.id}`)) {
      toast('ℹ️', 'Doctor Action Needed', `${doc.name} has waiting patients. Use CALL NEXT to continue flow.`, 'warn', 'Smart Priority Booster');
      logAgent('priority', `⚡ Priority Booster: waiting queue detected with no active consultation for ${doc.name}`, 'info');
    }

    if (hasLongConsult && shouldNotify(`longconsult:${doc.id}`)) {
      toast('⏱️', 'Long Consultation', `${doc.name} consultation is running longer than expected.`, 'warn', 'Wait Time Predictor');
      logAgent('predict', `⏱️ Wait Time Predictor: long consultation detected for ${doc.name}`, 'warn');
    }
  });
}

function updateAgentMetricUI() {
  const priorityValue = document.getElementById('amet-priority');
  const doctorValue = document.getElementById('amet-doctor');
  const predictValue = document.getElementById('amet-predict');
  if (priorityValue) priorityValue.textContent = agentMetrics.priority;
  if (doctorValue) doctorValue.textContent = agentMetrics.doctor;
  if (predictValue) predictValue.textContent = agentMetrics.predict;

  const apPriority = document.getElementById('ap-priority');
  const apDoctor = document.getElementById('ap-doctor');
  const apPredict = document.getElementById('ap-predict');
  if (apPriority) apPriority.textContent = agentMetrics.priority;
  if (apDoctor) apDoctor.textContent = agentMetrics.doctor;
  if (apPredict) apPredict.textContent = agentMetrics.predict;
}

/* ═══ REGISTER PATIENT ══════════════════════════════════════════ */
let currentPri = 'normal';
function setPri(p) {
  currentPri = p;
  ['normal','senior','emg'].forEach(x => {
    const el = document.getElementById('pri-'+x);
    el.className = 'pri-btn' + (x===p ? (' sel-'+x) : '');
  });
  // Auto-set senior if age >= 60
}

function onAgeChange() {
  const age = parseInt(document.getElementById('r-age').value);
  if (age >= 60 && currentPri === 'normal') setPri('senior');
}

function onDescChange() {
  const desc = document.getElementById('r-cc').value;
  if (detectEmergency(desc) && currentPri !== 'emg') {
    setPri('emg');
    showSuggestion('🚨 <strong>Smart Priority Booster:</strong> Keywords detected in description — priority automatically escalated to <strong>Emergency</strong>.');
  }
}

function onDocChange() {
  const sel = document.getElementById('r-doc').value;
  if (!sel) return;
  const doc = getDoc(sel);
  if (!doc) return;
  const load = getDocWaiting(sel).length;
  const predictedWait = predictDoctorWait(sel);
  if (doc.status === 'overloaded' || load >= doc.maxCap || predictedWait >= 60) {
    showSuggestion(`🩺 <strong>Doctor Suggestion Agent:</strong> ${doc.name} looks busy right now. Predicted wait is about <strong>${predictedWait} minutes</strong>. Auto-assign may be faster.`);
    flashAgentStatus('doctor-agent-status');
  } else if (load >= Math.floor(doc.maxCap * 0.75)) {
    showSuggestion(`⚠️ <strong>Doctor Suggestion Agent:</strong> ${doc.name} has ${load}/${doc.maxCap} patients — nearing capacity.`);
  } else {
    document.getElementById('suggBanner').classList.remove('on');
  }
}

function register() {
  const nm  = document.getElementById('r-nm').value.trim();
  const age = parseInt(document.getElementById('r-age').value);
  const cc  = document.getElementById('r-cc').value.trim();
  const docSel = document.getElementById('r-doc').value;

  if (!nm || isNaN(age) || age < 1) { toast('⚠️','Missing Info','Please enter patient name and age.','warn','System'); return; }

  const emg = currentPri === 'emg';
  const sr  = currentPri === 'senior' || (age >= 60 && !emg);

  const newPt = {
    id: Date.now(), tok: 'A-' + String(tok++).padStart(2,'0'),
    nm, age, cc: cc || 'General Checkup',
    emg, sr, s: 'w',
    reg: Date.now(), cal: null, done: null, ewt: 0,
    priorityBoost: 0,
    priorityBoostStage: 0,
    docId: null, dr: ''
  };

  // Run emergency detector
  agentDetectEmergency(newPt);

  // Run doctor suggestion agent
  const assignedDocId = agentAssign(newPt, docSel || null);
  newPt.docId = assignedDocId || null;
  const assignedDoc = getDoc(newPt.docId);
  newPt.dr = assignedDoc ? assignedDoc.name + ' (' + assignedDoc.room + ')' : 'Unassigned';

  pts.push(newPt);
  markQueueIndexDirty();

  // Run queue optimizer
  agentOptimizeQueue(newPt.docId);
  agentUpdateWaitTimes();

  // Show token popup
  const pos = getDocWaiting(newPt.docId).findIndex(p => p.id === newPt.id) + 1;
  showPopup(newPt, pos);

  // Reset form
  document.getElementById('r-nm').value = '';
  document.getElementById('r-age').value = '';
  document.getElementById('r-cc').value = '';
  document.getElementById('r-doc').value = '';
  setPri('normal');
  document.getElementById('suggBanner').classList.remove('on');

  repaint();
}

function showPopup(p, pos) {
  const assignedDoc = getDoc(p.docId);
  document.getElementById('pop-tok').textContent = p.tok;
  document.getElementById('pop-nm').textContent = p.nm;
  document.getElementById('pop-wait').textContent = p.emg ? '🔴 Emergency — being prioritized' : `Estimated wait: ~${p.ewt} minutes`;
  document.getElementById('pop-doc-short').textContent = assignedDoc ? assignedDoc.name.split(' ')[1] : '—';
  document.getElementById('pop-pos').textContent = '#' + pos;
  document.getElementById('pop-ewt').textContent = '~' + p.ewt + 'm';
  document.getElementById('pop-ai').textContent = '🤖 AI assigned based on doctor availability and your priority level.';
  document.getElementById('popup').classList.add('on');
}
function closePopup() { document.getElementById('popup').classList.remove('on'); }

/* ═══ DOCTOR ACTIONS ════════════════════════════════════════════ */
function callNext(docId) {
  const doc = getDoc(docId);
  if (doc.status === 'offline') { toast('⚠️','Doctor Offline','Set doctor online before calling next patient.','warn','System'); return; }

  const nextWaiting = getSortedWaiting(docId)[0];
  if (!nextWaiting) { toast('ℹ️','Queue Empty','No patients waiting for ' + doc.name + '.','warn','System'); return; }

  const ni = pts.findIndex(p => p.id === nextWaiting.id);
  if (ni < 0) { toast('⚠️','Queue Sync Issue','Unable to locate next patient record.','warn','System'); return; }

  // Mark prev IP as done
  pts.forEach(p => { if (p.s === 'ip' && p.docId === docId) { p.s = 'done'; p.done = Date.now(); } });
  pts[ni].s = 'ip'; pts[ni].cal = Date.now();
  markQueueIndexDirty();
  doc.consulStart = Date.now();
  doc.status = 'busy';
  agentOptimizeQueue(docId);
  agentUpdateWaitTimes();
  toast('✅', 'Patient Called', `${pts[ni].nm} (${pts[ni].tok}) called for ${doc.name}.`, 'ok', 'System');
  repaint();
}

function markDone(docId) {
  const cp = pts.find(p => p.s === 'ip' && p.docId === docId);
  if (!cp) { toast('ℹ️','No Active Patient','No patient currently in consultation for this doctor.','warn','System'); return; }
  cp.s = 'done'; cp.done = Date.now();
  markQueueIndexDirty();
  const doc = getDoc(docId);
  doc.consulStart = null;
  agentUpdateWaitTimes();
  repaint();
}

function toggleDocStatus(docId) {
  const doc = getDoc(docId);
  if (doc.status === 'offline') {
    doc.status = 'available';
    toast('✅', doc.name + ' Online', doc.name + ' is now available.', 'ok', 'System');
    logAgent('reassign', `✅ ${doc.name} came online`, 'ok');
  } else {
    doc.status = 'offline';
    toast('🔴', doc.name + ' Offline', 'Triggering Doctor Suggestion Agent...', 'emg', 'System');
    agentReassign(docId);
    logAgent('reassign', `🔴 ${doc.name} went offline — reassignment triggered`, 'alert');
  }
  agentUpdateWaitTimes();
  repaint();
}

/* ═══ NAVIGATION ════════════════════════════════════════════════ */
function go(btn, s) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.screen,.tv-screen').forEach(el => el.classList.remove('on'));
  const screen = document.getElementById('s-' + s);
  if (screen) screen.classList.add('on');
  repaint();
}

/* ═══ DOCTOR SELECTOR + DROPDOWN INIT ══════════════════════════ */
function buildDocDropdown() {
  const sel = document.getElementById('r-doc');
  sel.innerHTML = '<option value="">— Auto-assign (AI recommended) —</option>';
  doctors.forEach(d => {
    const load = getDocWaiting(d.id).length;
    const status = d.status === 'offline' ? ' [OFFLINE]' : d.status === 'overloaded' ? ' [FULL]' : ` (${load}/${d.maxCap})`;
    sel.innerHTML += `<option value="${d.id}" ${d.status==='offline'?'disabled':''}>${d.name} — ${d.room}${status}</option>`;
  });
}

function openAddDoctor() {
  const name = prompt('Doctor name (e.g. Dr. Sharma):');
  if (!name) return;
  const room = prompt('Room (e.g. Room 5):') || 'Room ' + (doctors.length + 1);
  const capStr = prompt('Max capacity (patients in queue):', '8');
  const cap = parseInt(capStr) || 8;
  const id = 'd' + (Date.now());
  doctors.push({ id, name, room, emoji: '👨‍⚕️', specialty: 'General', maxCap: cap, status: 'available', consulStart: null });
  toast('✅', 'Doctor Added', `${name} (${room}) added to system.`, 'ok', 'System');
  repaint();
}

/* ═══ AGENT DRAWER ══════════════════════════════════════════════ */
function openAgentDrawer() { document.getElementById('agentDrawer').classList.add('open'); }
function closeAgentDrawer() { document.getElementById('agentDrawer').classList.remove('open'); }
function switchAgentTab(btn, panel) {
  document.querySelectorAll('.agent-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.agent-log-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('agent' + panel.charAt(0).toUpperCase() + panel.slice(1)).classList.add('active');
}

const tagMap = { priority:'tag-optim', doctor:'tag-assign', predict:'tag-predict', assign:'tag-assign', balance:'tag-balance', optim:'tag-optim', detect:'tag-detect', reassign:'tag-reassign' };
const tagLabel = { priority:'PRIORITY', doctor:'DOCTOR', predict:'PREDICT', assign:'ASSIGN', balance:'LOAD-BALANCER', optim:'OPTIMIZER', detect:'EMG-DETECT', reassign:'REASSIGN' };
let logCount = 0;
function logAgent(type, msg, level='info') {
  const container = document.getElementById('agentLogs');
  if (container.children.length === 1 && container.children[0].style) container.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'log-entry ' + level;
  div.innerHTML = `<div><span class="log-agent-tag ${tagMap[type]}">${tagLabel[type]}</span></div><div class="log-msg">${msg}</div><div class="log-time">${new Date().toLocaleTimeString('en-IN')}</div>`;
  container.insertBefore(div, container.firstChild);
  if (container.children.length > 60) container.removeChild(container.lastChild);
  logCount++;
}

/* ═══ TOAST SYSTEM ══════════════════════════════════════════════ */
function toast(icon, title, msg, type='info', agent='') {
  const stack = document.getElementById('toastStack');
  const div = document.createElement('div');
  div.className = 'toast type-' + type;
  div.innerHTML = `<div class="toast-icon">${icon}</div><div class="toast-body"><div class="toast-title">${title}</div><div class="toast-msg">${msg}</div>${agent?`<div class="toast-agent">${agent.toUpperCase()}</div>`:''}</div>`;
  stack.appendChild(div);
  setTimeout(() => { div.classList.add('fadeout'); setTimeout(() => div.remove(), 350); }, 4000);
}

function showSuggestion(html) {
  document.getElementById('suggText').innerHTML = html;
  document.getElementById('suggBanner').classList.add('on');
}

/* ═══ REPAINT ALL ════════════════════════════════════════════════ */
function repaint() {
  validateSystemState();
  agentUpdateWaitTimes();
  agentDoctorOpsMonitor();
  buildDocDropdown();

  const activeTab = document.querySelector('.tab.active')?.getAttribute('data-s') || 'rec';
  if (activeTab === 'rec') paintRec();
  if (activeTab === 'doc') paintDocScreen();
  if (activeTab === 'admin') paintAdmin();
  if (activeTab === 'tv') paintTV();

  updateAgentMetricUI();
}

/* ═══ PAINT: RECEPTION ══════════════════════════════════════════ */
function paintRec() {
  const wq = pts.filter(p => p.s === 'w');
  document.getElementById('r-cnt').textContent = wq.length;
  paintEmergencyAlerts();
  const tb = document.getElementById('r-tbody');
  const vis = pts.filter(p => p.s !== 'done');
  if (!vis.length) { tb.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--app-muted);padding:32px;font-size:13px">No patients yet.</td></tr>'; return; }
  tb.innerHTML = vis.map(p => {
    let sp = '';
    if (p.s === 'w') sp = `<span class="pill pill-wait">● Waiting</span>`;
    if (p.s === 'ip') sp = `<span class="pill pill-room">⏳ In Room</span>`;
    const fl = p.emg ? `<span class="tag-emg">EMG</span>` : p.sr ? `<span class="tag-sr">SR</span>` : '';
    const score = calcScore(p);
    return `<tr>
      <td><span class="q-tok">${p.tok}</span></td>
      <td><div style="font-weight:500">${p.nm}</div><div style="font-size:11px;color:var(--app-muted)">${p.age} yrs</div></td>
      <td style="color:var(--app-muted);font-size:12px">${p.cc}</td>
      <td style="font-size:12px">${p.dr.split('(')[0].trim()}</td>
      <td><span class="ai-score">${score}</span></td>
      <td style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--app-muted)">${p.s==='w'?'~'+p.ewt+'m':'—'}</td>
      <td style="display:flex;gap:5px;align-items:center;padding-top:14px">${sp} ${fl}</td>
    </tr>`;
  }).join('');
}

function paintEmergencyAlerts() {
  const waitingEmg = pts
    .filter(p => p.s === 'w' && p.emg)
    .sort((a, b) => calcScore(b) - calcScore(a));

  const countEl = document.getElementById('emg-live-count');
  const criticalEl = document.getElementById('emg-live-critical');
  const longEl = document.getElementById('emg-live-long');
  const listEl = document.getElementById('emg-live-list');
  if (!countEl || !criticalEl || !longEl || !listEl) return;

  const criticalCount = waitingEmg.filter(p => getWaitingMinutes(p) >= 40).length;
  const longWaitCount = waitingEmg.filter(p => getWaitingMinutes(p) >= 20).length;

  countEl.textContent = `${waitingEmg.length} waiting`;
  criticalEl.textContent = `Critical now: ${criticalCount}`;
  longEl.textContent = `Over 20m wait: ${longWaitCount}`;

  if (!waitingEmg.length) {
    listEl.innerHTML = '<div class="emg-empty">No emergency patients waiting.</div>';
    return;
  }

  listEl.innerHTML = waitingEmg.slice(0, 4).map(p => {
    const waitMin = getWaitingMinutes(p);
    const docName = p.dr ? p.dr.split('(')[0].trim() : 'Unassigned';
    return `<div class="emg-item">
      <div class="emg-token">${p.tok}</div>
      <div>
        <div class="emg-name">${p.nm}</div>
        <div class="emg-sub">${p.cc} · ${docName}</div>
      </div>
      <div class="emg-wait">${waitMin}m</div>
    </div>`;
  }).join('');
}

/* ═══ PAINT: DOCTOR SCREEN ══════════════════════════════════════ */
function paintDocScreen() {
  paintDocOverview();
  paintDocDetail(activeDocId);
}

function paintDocOverview() {
  const wrap = document.getElementById('docOverview');
  wrap.innerHTML = doctors.map(d => {
    const waiting = getDocWaiting(d.id).length;
    const predictedWait = predictDoctorWait(d.id);
    const cap = d.maxCap;
    const pct = Math.min(Math.round(waiting / cap * 100), 100);
    const isOver = d.status === 'overloaded';
    const isOff = d.status === 'offline';
    const dotCls = isOff ? 'ds-off' : isOver ? 'ds-over' : waiting > 0 ? 'ds-busy' : 'ds-avail';
    const statusTxt = isOff ? 'OFFLINE' : isOver ? 'OVERLOADED' : waiting > 0 ? 'BUSY' : 'AVAILABLE';
    const badgeCls = isOff ? 'dsb-off' : isOver ? 'dsb-over' : waiting > 0 ? 'dsb-busy' : 'dsb-avail';
    const fillCls = pct >= 100 ? 'over' : pct >= 75 ? 'warn' : '';
    return `<div class="doc-ov-card ${d.id === activeDocId ? 'selected' : ''} ${isOver ? 'overloaded' : ''}" onclick="selectDoc('${d.id}')">
      <div class="doc-ov-top">
        <div class="doc-avatar">${d.emoji}</div>
        <div style="flex:1">
          <div class="doc-ov-name">${d.name}</div>
          <div class="doc-ov-room">${d.specialty} · ${d.room}</div>
        </div>
        <span class="doc-status-badge ${badgeCls}">
          <span class="doc-status-dot ${dotCls}" style="width:6px;height:6px;border-radius:50%;display:inline-block"></span>
          ${statusTxt}
        </span>
      </div>
      <div class="doc-ov-queue">
        <div>
          <div class="doc-ov-q-num">${waiting}</div>
          <div class="doc-ov-q-lab">Waiting</div>
        </div>
        <div class="doc-ov-ml">
          <div style="font-size:22px;font-weight:700;color:var(--app-text)">${cap}</div>
          <div class="doc-ov-q-lab">Capacity</div>
        </div>
      </div>
      <div class="capacity-bar" style="margin-top:10px">
        <div class="capacity-fill ${fillCls}" style="width:${pct}%"></div>
      </div>
      <div style="margin-top:8px;font-size:11px;color:var(--app-muted);display:flex;justify-content:space-between;gap:8px">
        <span>Predicted wait</span>
        <span style="font-family:'IBM Plex Mono',monospace;color:var(--app-text)">~${predictedWait}m</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:8px">
        <span style="font-size:10px;color:var(--app-muted)">${pct}% full</span>
        <button onclick="event.stopPropagation();toggleDocStatus('${d.id}')" style="font-size:10px;padding:2px 8px;border-radius:5px;border:1px solid var(--app-border);background:white;cursor:pointer;color:${isOff?'var(--green)':'var(--red)'};font-weight:600;font-family:Barlow,sans-serif">
          ${isOff ? 'Set Online' : 'Set Offline'}
        </button>
      </div>
    </div>`;
  }).join('');
}

function selectDoc(id) {
  activeDocId = id;
  paintDocScreen();
}

function paintDocDetail(docId) {
  const doc = getDoc(docId);
  if (!doc) return;
  const wrap = document.getElementById('docDetail');
  const cp = pts.find(p => p.s === 'ip' && p.docId === docId);
  const waiting = getSortedWaiting(docId);
  const done = pts.filter(p => p.s === 'done' && p.docId === docId);
  const emgs = pts.filter(p => p.emg && p.docId === docId).length;
  const docAlerts = getDoctorAlerts(docId);
  const nextPriority = waiting[0] || null;
  const overflowCount = Math.max(waiting.length - 8, 0);
  const predictedWait = predictDoctorWait(docId);

  const cpHTML = cp ? `
    <div class="cp-tok">${cp.tok}</div>
    <div class="cp-nm">${cp.nm}</div>
    <div class="cp-cc">${cp.cc}</div>
    <div class="cp-meta-row">
      <div class="cp-m"><div class="cp-m-lab">Age</div><div class="cp-m-val">${cp.age} yrs</div></div>
      <div class="cp-m"><div class="cp-m-lab">Priority</div><div class="cp-m-val">${cp.emg?'🔴 EMG':cp.sr?'🟡 Senior':'Normal'}</div></div>
      <div class="cp-m"><div class="cp-m-lab">Called At</div><div class="cp-m-val">${cp.cal?new Date(cp.cal).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}):'—'}</div></div>
      <div class="cp-m"><div class="cp-m-lab">Doctor</div><div class="cp-m-val">${doc.name}</div></div>
    </div>` : `
    <div class="cp-tok" style="font-size:50px;opacity:0.3">—</div>
    <div class="cp-nm">No patient in consultation</div>
    <div class="cp-cc">Click CALL NEXT to begin</div>`;

  const wlHTML = waiting.length ? waiting.slice(0, 8).map((p, i) => `
    <div class="wl-row">
      <div class="wl-pos">#${i + 1}</div>
      <div style="flex:1"><div class="wl-nm">${p.nm} ${p.emg?'🔴':p.sr?'🟡':''}</div><div class="wl-cc">${p.cc}</div></div>
      <span class="ai-score" style="font-size:9px;margin-right:8px">${calcScore(p)}</span>
      <div class="wl-wt">~${p.ewt}m</div>
    </div>`).join('') : '<div style="text-align:center;color:var(--app-muted);font-size:13px;padding:20px">Queue is empty.</div>';

  wrap.innerHTML = `
    <div>
      <div class="cp-card">
        <div class="cp-eye">Currently Consulting — ${doc.name}</div>
        ${cpHTML}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px">
        <button class="btn-next-big" onclick="callNext('${docId}')">
          <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
          CALL NEXT
        </button>
        <button class="btn-mark-done" onclick="markDone('${docId}')">✓ Mark Done</button>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-hd">
          <div class="card-title"><div class="cdot c-blue"></div> Waiting for ${doc.name}</div>
          <span class="count-badge" style="font-size:16px">${waiting.length}</span>
        </div>
        <div style="margin-bottom:10px;padding:10px 12px;border-radius:8px;background:var(--app-surface)">
          <div style="font-size:10px;letter-spacing:0.6px;color:var(--app-muted);text-transform:uppercase;font-weight:700;margin-bottom:6px">Operational Alerts</div>
          ${docAlerts.length ? docAlerts.map(a => `<div style="font-size:11px;margin-top:4px;color:${a.level==='high'?'var(--red)':a.level==='med'?'#8a6000':'var(--app-muted)'}">• ${a.text}</div>`).join('') : '<div style="font-size:11px;color:var(--green)">• No active operational alerts</div>'}
        </div>
        <div style="font-size:11px;color:var(--app-muted);margin-bottom:10px;display:flex;justify-content:space-between;gap:8px">
          <span>${nextPriority ? `Next priority: ${nextPriority.tok} · ${nextPriority.nm}` : 'No next patient'}</span>
          <span>${nextPriority ? `Score ${calcScore(nextPriority)}` : ''}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:7px">${wlHTML}</div>
        ${overflowCount ? `<div style="margin-top:10px;font-size:11px;color:var(--app-muted)">+ ${overflowCount} more waiting patient(s) not shown in top 8.</div>` : ''}
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:16px">
      <div class="card">
        <div class="card-hd"><div class="card-title"><div class="cdot c-cyan"></div> Today's Stats</div></div>
        <div class="d-stat-grid">
          <div class="d-stat"><div class="d-stat-v" style="color:var(--cyan2)">${done.length}</div><div class="d-stat-l">Done</div></div>
          <div class="d-stat"><div class="d-stat-v" style="color:var(--amber)">${waiting.length}</div><div class="d-stat-l">Waiting</div></div>
          <div class="d-stat"><div class="d-stat-v" style="color:var(--blue)">~${predictedWait}m</div><div class="d-stat-l">Predicted Wait</div></div>
          <div class="d-stat"><div class="d-stat-v" style="color:var(--red)">${emgs}</div><div class="d-stat-l">Emergency</div></div>
        </div>
      </div>
      <div class="card">
        <div class="card-hd" style="margin-bottom:10px"><div class="card-title"><div class="cdot c-amber"></div> Doctor Info</div></div>
        <div style="display:flex;align-items:center;gap:14px;padding:4px 0">
          <div class="doc-avatar">${doc.emoji}</div>
          <div>
            <div style="font-size:15px;font-weight:600">${doc.name}</div>
            <div style="font-size:12px;color:var(--app-muted)">${doc.specialty} · ${doc.room}</div>
          </div>
        </div>
        <div style="margin-top:14px;padding:12px;background:var(--app-surface);border-radius:9px">
          <div style="display:flex;justify-content:space-between;margin-bottom:5px">
            <span style="font-size:11px;color:var(--app-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Queue Capacity</span>
            <span style="font-size:13px;font-weight:700">${waiting.length}/${doc.maxCap}</span>
          </div>
          <div class="capacity-bar">
            <div class="capacity-fill ${waiting.length>=doc.maxCap?'over':waiting.length>=doc.maxCap*0.75?'warn':''}" style="width:${Math.min(waiting.length/doc.maxCap*100,100)}%"></div>
          </div>
        </div>
        <button onclick="toggleDocStatus('${docId}')" style="margin-top:12px;width:100%;padding:9px;border-radius:8px;border:1.5px solid var(--app-border);background:white;cursor:pointer;font-weight:600;font-family:Barlow,sans-serif;font-size:13px;color:${doc.status==='offline'?'var(--green)':'var(--red)'};transition:all 0.15s">
          ${doc.status === 'offline' ? '✅ Set Doctor Online' : '🔴 Set Doctor Offline'}
        </button>
      </div>
    </div>`;
}

/* ═══ PAINT: ADMIN ══════════════════════════════════════════════ */
function paintAdmin() {
  const idx = buildQueueIndex();
  const tot  = pts.length;
  const done = idx.doneAll.length;
  const wt   = idx.waitingAll.length;
  const emg  = pts.filter(p => p.emg).length;
  document.getElementById('a-tot').textContent = tot;
  document.getElementById('a-dn').textContent  = done;
  document.getElementById('a-wt').textContent  = wt;
  document.getElementById('a-emg').textContent = emg;

  const tb = document.getElementById('a-tbody');
  if (!pts.length) {
    tb.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--app-muted);padding:28px">No records.</td></tr>';
  } else {
    tb.innerHTML = pts.map(p => {
      const sc = p.s==='done'?'pill-done':p.s==='ip'?'pill-room':'pill-wait';
      const sl = p.s==='done'?'Done':p.s==='ip'?'In Room':'Waiting';
      const fl = p.emg?'<span class="tag-emg">EMG</span>':p.sr?'<span class="tag-sr">SR</span>':'—';
      return `<tr class="${p.emg?'emg-row':''}">
        <td><strong style="font-family:'Barlow Condensed',sans-serif;font-size:16px">${p.tok}</strong></td>
        <td>${p.nm}</td><td>${p.age}</td>
        <td style="color:var(--app-muted);font-size:11px">${p.cc}</td>
        <td style="font-size:11px">${p.dr.split('(')[0].trim()}</td>
        <td><span class="ai-score">${calcScore(p)}</span></td>
        <td>${fl}</td>
        <td><span class="pill ${sc}">${sl}</span></td>
        <td style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--app-muted)">${new Date(p.reg).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}</td>
      </tr>`;
    }).join('');
  }

  // Hourly bars
  const hrs = Array.from({length:9},(_,i)=>i+9);
  const hc  = hrs.map(h=>pts.filter(p=>new Date(p.reg).getHours()===h).length);
  const mx  = Math.max(...hc,1);
  document.getElementById('a-bars').innerHTML = hrs.map((h,i)=>{
    const pct=Math.round(hc[i]/mx*100);
    const lbl=h>12?(h-12)+'pm':h+'am';
    return `<div class="bar-w"><div class="bar-b" style="height:${Math.max(pct,3)}%" title="${hc[i]} patients"></div><div class="bar-l">${lbl}</div></div>`;
  }).join('');

  // Peak prediction band (simple heuristic based on historical pattern)
  const peakPattern = [0,1,2,3,3,2,1,2,1]; // 9am–5pm predicted load level 0-3
  const peakBand = document.getElementById('peak-band');
  const peakLabels = document.getElementById('peak-labels');
  if (peakBand) {
    peakBand.innerHTML = hrs.map((h,i)=>{
      const level = peakPattern[i] || 0;
      const cls = level===3?'high':level===2?'med':'';
      return `<div class="peak-hr ${cls}" title="${h>12?h-12+'pm':h+'am'}: ${['Low','Moderate','High','Peak'][level]} load"></div>`;
    }).join('');
    peakLabels.innerHTML = hrs.map(h=>`<div style="flex:1;font-size:8px;color:var(--app-muted);text-align:center">${h>12?h-12+'p':h+'a'}</div>`).join('');
  }

  paintWorkloadHeatmap();
}

function paintWorkloadHeatmap() {
  const wrap = document.getElementById('a-heatmap');
  if (!wrap) return;

  if (!doctors.length) {
    wrap.innerHTML = '<div class="heatmap-empty">No doctor data.</div>';
    return;
  }

  wrap.innerHTML = doctors.map(doc => {
    const waiting = getDocWaiting(doc.id).length;
    const predicted = predictDoctorWait(doc.id);
    const capacityPct = Math.min(100, Math.round((waiting / Math.max(doc.maxCap, 1)) * 100));
    const heatClass = capacityPct >= 90 || predicted >= 60 ? 'heat-high' : capacityPct >= 60 || predicted >= 35 ? 'heat-med' : 'heat-low';

    return `<div class="heatmap-row">
      <div>
        <div class="heatmap-doc">${doc.name}</div>
        <div class="heatmap-sub">${waiting}/${doc.maxCap} waiting · ~${predicted}m predicted</div>
      </div>
      <div class="heatmap-chip ${heatClass}">${capacityPct}%</div>
    </div>`;
  }).join('');
}

/* ═══ PAINT: TV ═════════════════════════════════════════════════ */
function paintTV() {
  const idx = buildQueueIndex();
  // Use first in-progress patient globally for TV "now serving"
  const cp = idx.inProgressAll[0];
  const wq = idx.waitingAll;
  const done = idx.doneAll;

  document.getElementById('tv-tok').textContent   = cp ? cp.tok : '—';
  document.getElementById('tv-pname').textContent = cp ? cp.nm : 'Waiting for next patient';
  document.getElementById('tv-pdoc').textContent  = cp ? cp.dr + ' · Now' : '—';
  document.getElementById('tv-qcnt').textContent  = wq.length + ' patient' + (wq.length!==1?'s':'') + ' waiting';
  document.getElementById('tv-st1').textContent = pts.length;
  document.getElementById('tv-st2').textContent = wq.length;
  document.getElementById('tv-st3').textContent = done.length;
  document.getElementById('tv-st4').textContent = wq.length ? '~' + AVG + ' min' : '—';

  const qr = document.getElementById('tv-qrows');
  if (!wq.length) { qr.innerHTML='<div style="color:var(--t3);font-size:14px;text-align:center;padding:28px">Queue is clear 🎉</div>'; return; }
  qr.innerHTML = wq.slice(0, 7).map((p, i) => {
    const isE = p.emg, isN = i === 0;
    const rc = isE?'is-emg':isN?'is-next':'';
    const tc = isE?'ce':isN?'cn':'';
    const badge = isE ? '<span class="tvq-badge emg">URGENT</span>'
                : isN ? '<span class="tvq-badge next">NEXT</span>'
                :       `<span class="tvq-badge num">~${p.ewt}m</span>`;
    return `<div class="tv-qrow ${rc}" style="animation-delay:${i*0.07}s">
      <div class="tvq-token ${tc}">${p.tok}</div>
      <div><div class="tvq-name">${p.nm}${p.sr?' (Sr.)':''}</div><div class="tvq-sub">${p.cc} · ${p.dr.split('(')[0].trim()}</div></div>
      <div class="tvq-age">${p.age}y</div>
      ${badge}
    </div>`;
  }).join('');
}

/* ═══ CLOCK ════════════════════════════════════════════════════ */
let consulStartTimes = {};
function tickClock() {
  const now = new Date();
  const hms = now.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  const dstr = now.toLocaleDateString('en-IN',{weekday:'long',day:'2-digit',month:'long',year:'numeric'});
  document.getElementById('tv-hms').textContent = hms;
  document.getElementById('tv-dstr').textContent = dstr;

  // Consultation timer — find any IP patient
  const cp = pts.find(p => p.s === 'ip');
  if (cp && cp.cal) {
    const sec = Math.floor((Date.now() - cp.cal) / 1000);
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    document.getElementById('tv-dur').textContent = m + ':' + s;
  } else {
    document.getElementById('tv-dur').textContent = '00:00';
  }
}
setInterval(tickClock, 1000);
tickClock();

// Re-optimize queues periodically
setInterval(() => {
  doctors.forEach(d => agentOptimizeQueue(d.id));
  agentUpdateWaitTimes();
  repaint();
}, 30000);

setInterval(() => {
  agentDoctorOpsMonitor();
}, 12000);

/* ═══ HELPERS ══════════════════════════════════════════════════ */
function clearDone() { pts = pts.filter(p => p.s !== 'done'); markQueueIndexDirty(); repaint(); }
function nuke() { if(confirm('Clear ALL data? Cannot be undone.')) { pts=[]; tok=1; markQueueIndexDirty(); repaint(); toast('🗑','Reset','All data cleared.','warn','System'); } }
function expCSV() {
  if (!pts.length) { alert('No data.'); return; }
  const h = ['Token','Name','Age','Description','Doctor','AI Score','Emergency','Senior','Status','Registered'];
  const r = pts.map(p => [p.tok,p.nm,p.age,p.cc,p.dr,calcScore(p),p.emg?'Yes':'No',p.sr?'Yes':'No',p.s,new Date(p.reg).toLocaleString()]);
  const csv = [h,...r].map(row=>row.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download = 'queueflow_' + new Date().toISOString().slice(0,10) + '.csv';
  a.click();
}

/* ═══ DEMO SEED ════════════════════════════════════════════════ */
(function seed() {
  const now = Date.now();
  const demo = [
    {nm:'Priya Venkataraman', age:34, cc:'Fever & Cold',         docId:'d1', emg:false, sr:false, s:'ip'},
    {nm:'Arjun Krishnan',     age:28, cc:'Chest pain, dizzy',    docId:'d1', emg:true,  sr:false, s:'w'},
    {nm:'Suresh Kumar',       age:67, cc:'BP Check',             docId:'d1', emg:false, sr:true,  s:'w'},
    {nm:'Meena Devi',         age:45, cc:'Back Pain',            docId:'d2', emg:false, sr:false, s:'w'},
    {nm:'Lakshmi Narayanan',  age:72, cc:'Diabetes Review',      docId:'d2', emg:false, sr:true,  s:'w'},
    {nm:'Ravi Chandran',      age:38, cc:'Stomach Ache',         docId:'d1', emg:false, sr:false, s:'done'},
    {nm:'Kavitha Murthy',     age:52, cc:'Migraine',             docId:'d3', emg:false, sr:false, s:'w'},
    {nm:'Dinesh Balaji',      age:41, cc:'Eye Irritation',       docId:'d3', emg:false, sr:false, s:'w'},
    {nm:'Rekha Sundaram',     age:8,  cc:'Ear pain, child',      docId:'d4', emg:false, sr:false, s:'w'},
    {nm:'Mohan Pillai',       age:60, cc:'Knee pain',            docId:'d4', emg:false, sr:true,  s:'done'},
  ];
  demo.forEach((d, i) => {
    const doc = getDoc(d.docId);
    pts.push({...d, id: Date.now()+i, tok: 'A-'+String(tok++).padStart(2,'0'),
      reg: now - (55 - i*6)*60000,
      cal: ['ip','done'].includes(d.s) ? now - (45 - i*6)*60000 : null,
      done: d.s==='done' ? now - (30 - i*6)*60000 : null,
      ewt: 0,
      dr: doc ? doc.name + ' (' + doc.room + ')' : 'Unassigned'
    });
  });
  markQueueIndexDirty();

  // Run agents on seed data
  doctors.forEach(d => agentOptimizeQueue(d.id));
  agentUpdateWaitTimes();

  logAgent('priority', '⚡ Smart Priority Booster initialized — waiting patients will be promoted automatically', 'ok');
  logAgent('doctor', '🩺 Doctor Suggestion Agent active — monitoring doctor load and routing choices', 'info');
  logAgent('predict', '📈 Wait Time Predictor active — forecasting delays across doctors', 'info');

  repaint();
})();
