"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Service worker
 * @module
 */
/// <reference lib="WebWorker" />
require("regenerator-runtime");
const sw = self;
const CACHE = 'cache-d9b9f4b';
/**
 * IndexedDB singleton wrapper used to store persistent information with an predefined {@link Schema}
 */
const idb = (() => {
    let dbInstance;
    function getDB() {
        if (!dbInstance) {
            dbInstance = new Promise((resolve, reject) => {
                const openreq = indexedDB.open('nb-keyval', 1);
                openreq.onerror = () => {
                    reject(openreq.error);
                };
                openreq.onupgradeneeded = () => {
                    // first time setup
                    openreq.result.createObjectStore('meta');
                };
                openreq.onsuccess = () => {
                    resolve(openreq.result);
                };
            });
        }
        return dbInstance;
    }
    async function withStore(type, callback) {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction('meta', type);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            callback(transaction.objectStore('meta'));
        });
    }
    return {
        async get(key) {
            let request;
            await withStore('readonly', store => {
                request = store.get(key);
            });
            return request?.result;
        },
        set(data) {
            return withStore('readwrite', store => {
                store.put(data.value, data.key);
            });
        },
        delete(key) {
            return withStore('readwrite', store => {
                store.delete(key);
            });
        },
    };
})();
function handleInstall(e) {
    console.log('[install] Kicking off service worker registration');
    e.waitUntil(cache('install').then(() => sw.skipWaiting()));
}
function handleActivate(e) {
    console.log('[activate] Activating service worker');
    sw.clients
        .matchAll({
        includeUncontrolled: true,
    })
        .then(clientList => {
        const urls = clientList.map(client => client.url);
        console.log('[activate] Matching clients:', urls.join(', '));
    });
    e.waitUntil(deleteOldCache('activate')
        .then(() => {
        console.log('[activate] Claiming clients for version', CACHE);
        return sw.clients.claim();
    })
        .then(() => idb.set({ key: 'activatedAt', value: new Date().toISOString() })));
}
function handleFetch(e) {
    e.respondWith(caches.open(CACHE).then(async (cache) => {
        const ignoreCache = (await idb.get('ignoreCache')) || false;
        return cache.match(e.request).then(matching => {
            if (matching && !ignoreCache) {
                console.log('[fetch] Serving file from cache: ', e.request.url);
                return matching;
            }
            console.log('[fetch] Fetching file: ', e.request.url);
            return fetch(e.request);
        });
    }));
}
const success = (data) => ({
    success: true,
    data: data,
});
const error = (error) => ({
    success: false,
    error: new Error(error),
});
// try catch could be done on the callers side
const resolvers = {
    getMetadata: async () => {
        try {
            return success({
                activatedAt: await idb.get('activatedAt'),
                cacheDeletedAt: await idb.get('cacheDeletedAt'),
                cacheUpdatedAt: await idb.get('cacheUpdatedAt'),
                oldCacheDeletedAt: await idb.get('oldCacheDeletedAt'),
                ignoreCache: (await idb.get('ignoreCache')) || false,
                cacheExists: await caches.has(CACHE),
            });
        }
        catch (e) {
            return error(e.message);
        }
    },
    getOldCacheDeletedAt: async () => {
        try {
            return success({
                oldCacheDeletedAt: await idb.get('oldCacheDeletedAt'),
            });
        }
        catch (e) {
            return error(e.message);
        }
    },
    getCacheDeletedAt: async () => {
        try {
            return success({
                cacheDeletedAt: await idb.get('cacheDeletedAt'),
            });
        }
        catch (e) {
            return error(e.message);
        }
    },
    setIgnoreCache: async (e) => {
        try {
            await idb.set({ key: 'ignoreCache', value: e.payload.value });
            return success({
                ignoreCache: e.payload.value,
            });
        }
        catch (e) {
            return error(e.message);
        }
    },
    getIgnoreCache: async () => {
        try {
            return success({
                ignoreCache: (await idb.get('ignoreCache')) || false,
            });
        }
        catch (e) {
            return error(e.message);
        }
    },
    getActivatedAt: async () => {
        try {
            return success({
                activatedAt: await idb.get('activatedAt'),
            });
        }
        catch (e) {
            return error(e.message);
        }
    },
    deleteOldCache: async () => {
        try {
            await deleteOldCache('deleteOldCache');
            return success({
                oldCacheDeletedAt: await idb.get('oldCacheDeletedAt'),
            });
        }
        catch (e) {
            return error(e.message);
        }
    },
    deleteCache: async () => {
        try {
            if (!(await caches.delete(CACHE))) {
                throw Error('Cache does not exist.');
            }
            await setCacheDeletedAt();
            return success({
                cacheDeletedAt: await idb.get('cacheDeletedAt'),
            });
        }
        catch (e) {
            return error(e.message);
        }
    },
    updateCache: async () => {
        try {
            if (await caches.delete(CACHE)) {
                await setCacheDeletedAt();
            }
            await cache('updateCache');
            return success({
                cacheDeletedAt: await idb.get('cacheDeletedAt'),
                cacheUpdatedAt: await idb.get('cacheUpdatedAt'),
            });
        }
        catch (e) {
            return error(e.message);
        }
    },
    getCacheUpdatedAt: async () => {
        try {
            return success({
                cacheUpdatedAt: await idb.get('cacheUpdatedAt'),
            });
        }
        catch (e) {
            return error(e.message);
        }
    },
    getCacheExists: async () => {
        try {
            return success({
                cacheExists: await caches.has(CACHE),
            });
        }
        catch (e) {
            return error(e.message);
        }
    },
};
async function handleMessage(e) {
    console.log('[message router] Recieved message:', e.data.message);
    // check event.origin for added security
    if (!e.data?.message) {
        postMessage({ success: false, error: 'Message not provided.' });
        return;
    }
    if (resolvers.hasOwnProperty(e.data.message)) {
        const data = await resolvers[e.data.message](e.data);
        postMessage(data);
        return;
    }
    postMessage({ success: false, error: 'Resolver does not exist.' });
    return;
}
function postMessage(data) {
    sw.clients
        .matchAll({
        includeUncontrolled: true,
    })
        .then(clientList => {
        clientList.forEach(function (client) {
            client.postMessage(data);
        });
    });
}
async function cache(context) {
    return caches
        .open(CACHE)
        .then(cache => {
        console.log('[' + context + '] Opened cache');
        return cache.addAll(["./","./1-break.html","./1.html","./2-break.html","./2.html","./3-break.html","./3.html","./4-break.html","./4.html","./5-break.html","./5-pic-break.html","./5.html","./6-break.html","./6.html","./61-pic-break.html","./61.html","./62.html","./63.html","./64.html","./65.html","./66.html","./7-break.html","./7.html","./android-chrome-192x192.png","./android-chrome-384x384.png","./apple-touch-icon.png","./colophon.html","./favicon-16x16.png","./favicon-32x32.png","./favicon.ico","./favicon.png","./index.html","./klimavize.html","./manifest.json","./mstile-150x150.png","./safari-pinned-tab.svg","./slovnicek.html","./zdroje.html","./scripts/bundle.js","./style/style.min.css","./images/HnutiDUHA1_copy.jpg","./images/HouseOfRezac2.jpg","./images/KlimatickaKoalice2.jpg","./images/RLS2_copy.jpg","./images/VlajkaBB_copy.jpg","./images/Spiky.jpg","./images/aktivity.svg","./images/cile-mobile.svg","./images/cile.svg","./images/co-jak-kam.svg","./images/dialog2.png","./images/divka.jpg","./images/earth-in-hand.jpg","./images/enlarge.jpg","./images/greenpeace.jpg","./images/hlavy.jpg","./images/kominy.jpg","./images/ledovec.svg","./images/money.jpg","./images/oko2.jpg","./images/oko_stylizovane.jpg","./images/proces.svg","./images/repro.jpg","./images/pyramida.svg","./images/reset.svg","./images/shake.jpg","./images/sipka_1.jpg","./images/spolu.jpg","./images/strom-globe.jpg","./images/sumivka-oranz.jpg","./images/systems.svg","./images/talk.jpg","./images/vahy.jpg","./images/vhledy.svg","./images/vetrnik.jpg","./images/vize.svg","./images/vlajka.jpg","./images/zarovka.png","./images/zemekoule.jpg","./images/zemekoule_1.jpg","./images/zemekoulesdfsdfsf.jpg","./template-images/quotes-white.svg","./template-images/quotes.svg","./fonts/01_Right_Grotesk/RightGrotesk-SpatialRegular.woff2","./fonts/02_Archivo/Archivo-Bold.woff2","./fonts/02_Archivo/Archivo-BoldItalic.woff2","./fonts/02_Archivo/Archivo-Italic.woff2","./fonts/02_Archivo/Archivo-Regular.woff2","./fonts/02_Archivo/OFL.txt"]);
    })
        .then(() => idb.set({ key: 'cacheUpdatedAt', value: new Date().toISOString() }))
        .then(() => {
        console.log('[' + context + '] All required resources have been cached;');
        if (context === 'install') {
            console.log('the Service Worker was successfully installed');
        }
    });
}
async function deleteOldCache(context) {
    return caches
        .keys()
        .then(cacheNames => Promise.all(cacheNames.map(cacheName => {
        if (cacheName !== CACHE) {
            console.log('[' + context + '] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
        }
        return null;
    })))
        .then(async () => idb.set({ key: 'oldCacheDeletedAt', value: new Date().toISOString() }));
}
async function setCacheDeletedAt() {
    await idb.set({ key: 'cacheDeletedAt', value: new Date().toISOString() });
}
sw.addEventListener('install', handleInstall);
sw.addEventListener('activate', handleActivate);
sw.addEventListener('fetch', handleFetch);
sw.addEventListener('message', handleMessage);
