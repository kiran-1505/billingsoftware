// modules/auth.js — two-user admin modal and tab-visibility control
import { state, $, $$, openModal, closeAnyModal, toast, switchTab } from './core.js';
import { db } from '../db.js';

function _showAdminPanel(which) {
  const panels = ['admin-login-form', 'admin-logout-form', 'admin-recovery-form', 'admin-reset-form'];
  for (const id of panels) {
    const el = $('#' + id);
    if (el) el.classList.toggle('hidden', id !== which);
  }
}

export function applyUserState() {
  const u = state.currentUser;

  $$('.tab-btn').forEach(btn => {
    const tab = btn.dataset.tab;
    const always    = ['billing', 'products', 'labels'].includes(tab);
    const anyUser   = tab === 'reports';
    const user2Only = ['inventory', 'daily', 'settings'].includes(tab);
    if (always)         btn.style.display = '';
    else if (anyUser)   btn.style.display = u ? '' : 'none';
    else if (user2Only) btn.style.display = u === 'user2' ? '' : 'none';
  });

  const label = $('#admin-btn-label');
  const btn   = $('#btn-admin-login');
  if (u) {
    const name = u === 'user1'
      ? (state.settings.user1Name || 'accounts')
      : (state.settings.user2Name || 'admin');
    if (label) label.textContent = name + ' ✓';
    if (btn) { btn.style.background = '#dcfce7'; btn.style.color = '#15803d'; }
  } else {
    if (label) label.textContent = 'Admin';
    if (btn)   { btn.style.background = ''; btn.style.color = ''; }
  }

  const scaleBtn = $('#btn-scale-down');
  if (scaleBtn) scaleBtn.classList.toggle('hidden', u !== 'user2');

  const userCredsSection = $('#user-creds-section');
  if (userCredsSection) userCredsSection.classList.toggle('hidden', u !== 'user2');

  const costCodeSection = $('#cost-code-settings-section');
  if (costCodeSection) costCodeSection.classList.toggle('hidden', u !== 'user2');

  const securitySection = $('#security-section');
  if (securitySection) securitySection.classList.toggle('hidden', u !== 'user2');

  // Notify modules that depend on user role (e.g. cart cost-code column)
  document.dispatchEvent(new CustomEvent('toolbill:user-changed'));
}

function openAdminModal() {
  const loggedIn = !!state.currentUser;
  if (loggedIn) {
    const name = state.currentUser === 'user1'
      ? (state.settings.user1Name || 'accounts')
      : (state.settings.user2Name || 'admin');
    $('#admin-logged-user').textContent = name;
    _showAdminPanel('admin-logout-form');
  } else {
    $('#admin-username').value = '';
    $('#admin-password').value = '';
    $('#admin-login-error').classList.add('hidden');
    _showAdminPanel('admin-login-form');
  }
  openModal('modal-admin');
  if (!loggedIn) setTimeout(() => $('#admin-username').focus(), 50);
}

function openRecoveryPanel() {
  $('#rec-birthplace').value = '';
  $('#rec-answer').value = '';
  $('#rec-error').classList.add('hidden');
  $('#rec-not-setup').classList.add('hidden');
  const q = (state.settings.securityQuestion || '').trim();
  const bp = (state.settings.securityBirthplace || '').trim();
  const a  = (state.settings.securityAnswer || '').trim();
  if (!q || !bp || !a) {
    // Recovery hasn't been set up
    $('#rec-not-setup').classList.remove('hidden');
    $('#rec-question-label').textContent = 'Your security question';
    $('#rec-birthplace').disabled = true;
    $('#rec-answer').disabled = true;
    $('#btn-rec-verify').disabled = true;
  } else {
    $('#rec-question-label').textContent = q;
    $('#rec-birthplace').disabled = false;
    $('#rec-answer').disabled = false;
    $('#btn-rec-verify').disabled = false;
  }
  _showAdminPanel('admin-recovery-form');
  setTimeout(() => $('#rec-birthplace').focus(), 50);
}

function verifyRecoveryAnswers() {
  const bpAnswer = $('#rec-birthplace').value.trim().toLowerCase();
  const qAnswer  = $('#rec-answer').value.trim().toLowerCase();
  const expectedBp = (state.settings.securityBirthplace || '').trim().toLowerCase();
  const expectedA  = (state.settings.securityAnswer || '').trim().toLowerCase();
  if (!expectedBp || !expectedA) {
    $('#rec-not-setup').classList.remove('hidden');
    return;
  }
  if (bpAnswer === expectedBp && qAnswer === expectedA) {
    // Show reset panel
    $('#reset-newpass').value = '';
    $('#reset-error').classList.add('hidden');
    $('#reset-account').value = 'user2';
    _showAdminPanel('admin-reset-form');
    setTimeout(() => $('#reset-newpass').focus(), 50);
  } else {
    $('#rec-error').classList.remove('hidden');
  }
}

async function submitNewPassword() {
  const which = $('#reset-account').value;
  const newPass = $('#reset-newpass').value;
  if (!newPass) {
    $('#reset-error').classList.remove('hidden');
    return;
  }
  if (which === 'user2') {
    state.settings.user2Pass = newPass;
    await db.setSetting('user2Pass', newPass);
  } else {
    state.settings.user1Pass = newPass;
    await db.setSetting('user1Pass', newPass);
  }
  toast('Password updated — log in with the new password', 'success');
  // Back to login form, pre-fill username
  const username = which === 'user2'
    ? (state.settings.user2Name || 'admin')
    : (state.settings.user1Name || 'accounts');
  $('#admin-username').value = username;
  $('#admin-password').value = '';
  $('#admin-login-error').classList.add('hidden');
  _showAdminPanel('admin-login-form');
  setTimeout(() => $('#admin-password').focus(), 50);
}

function attemptAdminLogin() {
  const user = $('#admin-username').value.trim().toLowerCase();
  const pass = $('#admin-password').value;
  const u1   = (state.settings.user1Name || 'accounts').toLowerCase();
  const u1p  = state.settings.user1Pass  || '1234';
  const u2   = (state.settings.user2Name || 'admin').toLowerCase();
  const u2p  = state.settings.user2Pass  || 'admin123';

  if (user === u1 && pass === u1p) {
    state.currentUser = 'user1';
  } else if (user === u2 && pass === u2p) {
    state.currentUser = 'user2';
  } else {
    $('#admin-login-error').classList.remove('hidden');
    $('#admin-password').value = '';
    $('#admin-password').focus();
    return;
  }
  applyUserState();
  closeAnyModal();
  if (state.currentUser === 'user1') switchTab('reports');
  toast('Welcome', 'success');
}

export function wireAdmin() {
  $('#btn-admin-login').addEventListener('click', openAdminModal);
  $('#btn-admin-submit').addEventListener('click', attemptAdminLogin);
  $('#admin-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attemptAdminLogin();
  });
  $('#btn-admin-logout').addEventListener('click', () => {
    state.currentUser = null;
    applyUserState();
    const active = document.querySelector('.tab-btn[data-active="true"]');
    if (active && !['billing', 'products', 'labels'].includes(active.dataset.tab)) {
      switchTab('billing');
    }
    closeAnyModal();
    toast('Logged out', '');
  });
  // Forgot password flow
  $('#btn-forgot-pass')?.addEventListener('click', openRecoveryPanel);
  $('#btn-rec-back')?.addEventListener('click', () => _showAdminPanel('admin-login-form'));
  $('#btn-rec-verify')?.addEventListener('click', verifyRecoveryAnswers);
  $('#rec-answer')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') verifyRecoveryAnswers();
  });
  $('#btn-reset-submit')?.addEventListener('click', submitNewPassword);
  $('#reset-newpass')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitNewPassword();
  });
}
