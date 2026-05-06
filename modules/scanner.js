// modules/scanner.js — physical barcode scanner (keyboard) and camera scanner (ZXing)
import { $, toast, switchTab } from './core.js';
import { handleEnterInBillSearch } from './billing.js';

let _zxingReader    = null;
let _lastScannedCode = '';
let _lastScannedTime = 0;

export function closeCameraScanner() {
  if (_zxingReader) { _zxingReader.reset(); _zxingReader = null; }
  $('#modal-camera').classList.add('hidden');
  _lastScannedCode = '';
}

export async function openCameraScanner() {
  const modal  = $('#modal-camera');
  const status = $('#cam-status');
  modal.classList.remove('hidden');
  status.textContent    = 'Starting camera…';
  status.style.background = '';
  $('#cam-last-scan').textContent = '';

  if (!window.ZXing) {
    status.textContent = 'Scanner library not loaded — check internet connection';
    return;
  }
  try {
    _zxingReader = new ZXing.BrowserMultiFormatReader();
    await _zxingReader.decodeFromVideoDevice(null, 'camera-preview', (result) => {
      if (!result) return;
      const code = result.getText();
      const now  = Date.now();
      if (code === _lastScannedCode && now - _lastScannedTime < 2000) return;
      _lastScannedCode = code;
      _lastScannedTime = now;

      status.textContent      = '✓ ' + code;
      status.style.background = 'rgba(22,163,74,0.85)';
      setTimeout(() => {
        if (status) { status.textContent = 'Point camera at a barcode…'; status.style.background = ''; }
      }, 900);

      const normalised = code.replace(/%/g, '-');
      const searchEl   = $('#bill-search');
      searchEl.value   = normalised;
      handleEnterInBillSearch();
      searchEl.value   = '';
      $('#cam-last-scan').textContent = 'Last scanned: ' + normalised;
    });
    status.textContent = 'Point camera at a barcode…';
  } catch (err) {
    status.textContent = err.name === 'NotAllowedError'
      ? '⚠ Camera access denied — allow camera in browser settings'
      : '⚠ Could not start camera: ' + err.message;
  }
}

export function wireCameraScanner() {
  const btn = $('#btn-camera-scan');
  if (!btn) return;
  btn.addEventListener('click', openCameraScanner);
  $('#btn-camera-close').addEventListener('click', closeCameraScanner);
  // Stop camera whenever any modal closes (avoids circular import with core.js)
  document.addEventListener('toolbill:modal-closed', closeCameraScanner);
}

export function wireGlobalScanner() {
  let buffer      = '';
  let lastKeyTime = 0;
  const MAX_GAP_MS = 50;
  const MIN_LEN    = 3;

  document.addEventListener('keypress', (e) => {
    const active = document.activeElement;
    const tag    = active ? active.tagName : '';
    if ((tag === 'INPUT' || tag === 'TEXTAREA') && active.id !== 'bill-search') {
      buffer = ''; return;
    }
    const now = Date.now();
    const gap = now - lastKeyTime;
    lastKeyTime = now;

    if (gap > MAX_GAP_MS * 3 && buffer.length === 0 && e.key !== 'Enter') {
      if (active && active.id === 'bill-search') return;
    }

    if (e.key === 'Enter') {
      if (buffer.length >= MIN_LEN) {
        e.preventDefault();
        switchTab('billing');
        const searchEl   = $('#bill-search');
        searchEl.value   = buffer;
        handleEnterInBillSearch();
        searchEl.value   = '';
        buffer           = '';
      }
      return;
    }

    if (e.key.length === 1 && (gap <= MAX_GAP_MS || buffer.length > 0)) {
      buffer += e.key;
    }
  });
}
