// modules/auth.js — two-user admin modal and tab-visibility control
import { state, $, $$, openModal, closeAnyModal, toast, switchTab } from './core.js';

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
}

function openAdminModal() {
  const loggedIn = !!state.currentUser;
  $('#admin-login-form').classList.toggle('hidden', loggedIn);
  $('#admin-logout-form').classList.toggle('hidden', !loggedIn);
  if (loggedIn) {
    const name = state.currentUser === 'user1'
      ? (state.settings.user1Name || 'accounts')
      : (state.settings.user2Name || 'admin');
    $('#admin-logged-user').textContent = name;
  } else {
    $('#admin-username').value = '';
    $('#admin-password').value = '';
    $('#admin-login-error').classList.add('hidden');
  }
  openModal('modal-admin');
  if (!loggedIn) setTimeout(() => $('#admin-username').focus(), 50);
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
}
