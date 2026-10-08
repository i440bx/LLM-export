const printFrame  = document.getElementById('frame');
const printButton = document.getElementById('printBtn');
const barStatus   = document.getElementById('barStatus');

printButton.addEventListener('click', openPrintDialog);

function openPrintDialog() {
  const view = printFrame.contentWindow;
  if (!view) return;
  view.focus();
  view.print();
}

chrome.storage.local.get(['printDocument'], (result) => {
  const stored = result.printDocument;
  if (!stored || !stored.html) {
    barStatus.textContent = 'Nothing to print. Start the export from the extension again.';
    printButton.disabled  = true;
    return;
  }

  chrome.storage.local.remove('printDocument');

  printFrame.addEventListener('load', () => {
    barStatus.textContent = '';
    document.title = printFrame.contentDocument.title || 'LLM Export';
    openPrintDialog();
  }, { once: true });

  printFrame.srcdoc = stored.html;
});
