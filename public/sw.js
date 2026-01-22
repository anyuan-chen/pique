// Service Worker for Cooking Shorts PWA

const CACHE_NAME = 'shorts-v1';

// Install event
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Activate event
self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// Handle share target POST requests
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Handle Web Share Target
  if (url.pathname === '/shorts.html' && event.request.method === 'POST') {
    event.respondWith(handleShareTarget(event.request));
    return;
  }
});

async function handleShareTarget(request) {
  const formData = await request.formData();
  const videoFile = formData.get('video');

  // Store the shared file in IndexedDB for the page to pick up
  if (videoFile && videoFile.size > 0) {
    const db = await openDB();
    await storeFile(db, videoFile);
  }

  // Redirect to the app
  return Response.redirect('/shorts.html?shared=1', 303);
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('shorts-share', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('shared-files')) {
        db.createObjectStore('shared-files', { keyPath: 'id' });
      }
    };
  });
}

function storeFile(db, file) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('shared-files', 'readwrite');
    const store = tx.objectStore('shared-files');
    store.put({ id: 'pending', file, timestamp: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
