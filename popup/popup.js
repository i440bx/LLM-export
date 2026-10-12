const exportButton    = document.getElementById('convertBtn');
const robustButton    = document.getElementById('robustBtn');
const formatSelect    = document.getElementById('formatSelect');
const themeSelect     = document.getElementById('themeSelect');
const includeImages   = document.getElementById('includeImages');
const latexSupport    = document.getElementById('latexSupport');
const askTitle        = document.getElementById('askTitle');
const main            = document.getElementById('main');
const notOnChatgpt    = document.getElementById('notOnChatgpt');
const themeToggle     = document.getElementById('themeToggle');
const domNotice       = document.getElementById('domNotice');
const domNoticeOk     = document.getElementById('domNoticeOk');
const domNoticeCancel = document.getElementById('domNoticeCancel');
const formatLockNotice   = document.getElementById('formatLockNotice');
const formatLockNoticeOk = document.getElementById('formatLockNoticeOk');

let lastFormat     = formatSelect.value;
let markdownLocked = false;

chrome.storage.sync.get(['exportFormat', 'exportTheme', 'includeImages', 'latexSupport', 'askTitle', 'darkMode'], (result) => {
  if (result.exportFormat)  formatSelect.value    = result.exportFormat;
  if (result.exportTheme)   themeSelect.value     = result.exportTheme;
  if (result.includeImages) includeImages.checked  = result.includeImages;
  if (result.latexSupport)  latexSupport.checked   = result.latexSupport;
  if (result.askTitle)      askTitle.checked       = result.askTitle;

  if (result.darkMode === true)  applyDarkMode(true);
  else if (result.darkMode === false) applyDarkMode(false);

  lastFormat = formatSelect.value;
  updateOptionAvailability();
});

function applyDarkMode(dark) {
  document.body.classList.toggle('dark', dark);
  document.body.classList.toggle('light', !dark);
  themeToggle.classList.toggle('on', dark);
}

themeToggle.addEventListener('click', () => {
  const goingDark = !document.body.classList.contains('dark');
  applyDarkMode(goingDark);
  chrome.storage.sync.set({ darkMode: goingDark });
});

function updateOptionAvailability() {
  const isMarkdown = formatSelect.value === 'markdown';
  const isPdf      = formatSelect.value === 'pdf';
  includeImages.disabled = isMarkdown;
  includeImages.closest('.field')?.classList.toggle('disabled', isMarkdown);
  latexSupport.disabled  = isPdf;
  latexSupport.closest('.field')?.classList.toggle('disabled', isPdf);
}

formatSelect.addEventListener('change', () => {
  if (markdownLocked && formatSelect.value === 'markdown') {
    formatSelect.value = lastFormat;
    formatLockNotice.style.display = 'flex';
    return;
  }
  lastFormat = formatSelect.value;
  chrome.storage.sync.set({ exportFormat: formatSelect.value });
  updateOptionAvailability();
});

updateOptionAvailability();

themeSelect.addEventListener('change', () => {
  chrome.storage.sync.set({ exportTheme: themeSelect.value });
});

includeImages.addEventListener('change', () => {
  chrome.storage.sync.set({ includeImages: includeImages.checked });
});

latexSupport.addEventListener('change', () => {
  chrome.storage.sync.set({ latexSupport: latexSupport.checked });
});

askTitle.addEventListener('change', () => {
  chrome.storage.sync.set({ askTitle: askTitle.checked });
});

function ensureContentScript(tab, cb) {
  chrome.tabs.sendMessage(tab.id, { action: 'ping' }, (response) => {
    if (chrome.runtime.lastError) {
      chrome.tabs.executeScript(tab.id, { file: 'content/content.js' }, cb);
    } else {
      cb();
    }
  });
}

let preLockFormat = null;

function setFormatLocked(locked) {
  markdownLocked = locked;
  robustButton.disabled = locked;
  robustButton.title = locked
    ? 'Robust export requires a signed-in ChatGPT session'
    : 'Paged backend export for very long conversations';
  if (locked) {
    if (formatSelect.value === 'markdown') {
      preLockFormat = 'markdown';
      formatSelect.value = 'html';
    }
  } else if (preLockFormat) {
    formatSelect.value = preLockFormat;
    preLockFormat = null;
  }
  lastFormat = formatSelect.value;
  updateOptionAvailability();
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  const url = new URL(tab.url);
  if (url.hostname !== 'chatgpt.com') {
    main.style.display = 'none';
    notOnChatgpt.style.display = 'block';
    return;
  }

  main.style.display = 'block';

  ensureContentScript(tab, () => {
    chrome.tabs.sendMessage(tab.id, { action: 'check_dom_fallback' }, (resp) => {
      const usesDom = !chrome.runtime.lastError && resp && resp.usesDom;
      setFormatLocked(usesDom);
    });
  });
});

formatLockNoticeOk.addEventListener('click', () => {
  formatLockNotice.style.display = 'none';
});

let pendingStart = null;

exportButton.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];

    const startExport = () => {
      const msg = {
        action: 'convert_to_html',
        format: formatSelect.value,
        theme: themeSelect.value,
        includeImages: includeImages.checked,
        latexSupport: latexSupport.checked,
        askTitle: askTitle.checked
      };
      exportButton.classList.add('loading');
      chrome.tabs.sendMessage(tab.id, msg, (response) => {
        exportButton.classList.remove('loading');
        if (response && response.status === 'print')  chrome.tabs.create({ url: chrome.runtime.getURL('print/print.html') });
      });
    };

    const afterInjected = () => {
      if (formatSelect.value === 'markdown') { startExport(); return; }

      chrome.tabs.sendMessage(tab.id, { action: 'check_dom_fallback' }, (resp) => {
        const usesDom = !chrome.runtime.lastError && resp && resp.usesDom;
        if (!usesDom) { startExport(); return; }

        chrome.storage.sync.get(['domNoticeAcknowledged'], (result) => {
          if (result.domNoticeAcknowledged) {
            startExport();
          } else {
            pendingStart = startExport;
            domNotice.style.display = 'flex';
          }
        });
      });
    };

    ensureContentScript(tab, afterInjected);
  });
});

robustButton.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    const msg = {
      action: 'convert_to_html_robust',
      format: formatSelect.value,
      theme: themeSelect.value,
      includeImages: includeImages.checked,
      latexSupport: latexSupport.checked,
      askTitle: askTitle.checked
    };

    robustButton.classList.add('loading');
    chrome.tabs.sendMessage(tab.id, msg, (response) => {
      robustButton.classList.remove('loading');

      if (chrome.runtime.lastError) {
        alert(`Robust export failed: ${chrome.runtime.lastError.message}`);
        return;
      }
      if (response?.status === 'error') {
        alert(`Robust export failed: ${response.error || 'Unknown error'}`);
        return;
      }
      if (response?.status === 'print') {
        chrome.tabs.create({ url: chrome.runtime.getURL('print/print.html') });
      }
    });
  });
});

domNoticeOk.addEventListener('click', () => {
  domNotice.style.display = 'none';
  chrome.storage.sync.set({ domNoticeAcknowledged: true });
  if (pendingStart) { pendingStart(); pendingStart = null; }
});

domNoticeCancel.addEventListener('click', () => {
  domNotice.style.display = 'none';
  pendingStart = null;
});
