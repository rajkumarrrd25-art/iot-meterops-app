import { jsPDF } from 'jspdf';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

// jsPDF's own doc.save() fake-clicks a hidden <a download> link. That
// approach depends on the browser's normal download pipeline, which
// doesn't exist at all inside a Capacitor WebView (this is a packaged
// Android/iOS app, not a browser tab) — so on native builds nothing
// happens, silently, no error. It also breaks on iOS Safari (ignores
// the download attribute) and on some in-app/webview browsers where
// the link isn't attached to the DOM.
//
// This function branches by environment:
//   - Native Capacitor app (Android/iOS): write the PDF to the
//     filesystem via @capacitor/filesystem, then hand it to the native
//     Share sheet via @capacitor/share, which has a "Save to device" /
//     "Save to Files" option. This is the standard, reliable pattern
//     for file downloads in Capacitor apps.
//   - iOS Safari (regular web, not wrapped in Capacitor): open the PDF
//     in a new tab so the user can use the Share icon in Safari's
//     built-in PDF viewer.
//   - Everything else (desktop + Android Chrome web): a real,
//     DOM-attached <a download> link click, which is reliable
//     everywhere Blob URLs are supported.
// Converts the PDF's raw bytes to base64 ourselves instead of relying on
// jsPDF's own 'datauristring' output. That output's exact format (whether
// it includes a filename= segment, extra params, etc.) differs across
// jsPDF versions, and getting the split wrong produces a base64 string
// that LOOKS fine but decodes to a broken PDF — which is exactly the
// "file is corrupted" error. Building the base64 by hand from the raw
// bytes has no such ambiguity.
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // process in 32KB chunks so large PDFs don't
  let binary = '';          // blow the call stack on String.fromCharCode
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export async function downloadPdf(doc: jsPDF, filename: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const base64 = arrayBufferToBase64(doc.output('arraybuffer'));

    const result = await Filesystem.writeFile({
      path: filename,
      data: base64,
      directory: Directory.Cache,
    });

    await Share.share({
      title: filename,
      url: result.uri,
    });
    return;
  }

  const blob = doc.output('blob');
  const url = URL.createObjectURL(blob);

  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    // iPadOS 13+ reports as "Macintosh" but has touch support, unlike a real Mac
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  if (isIOS) {
    window.open(url, '_blank');
    // Give the new tab time to load the blob before revoking it.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
