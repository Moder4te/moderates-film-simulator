/**
 * 서비스 워커 — 설치형(PWA)으로 쓸 때 오프라인에서도 열리게 한다.
 *
 * 앱이 파일 하나(index.html)라 캐시할 것도 그것뿐이다. **네트워크 먼저**, 안 되면
 * 캐시 — 새로 배포하면 다음에 열 때 바로 새 판이 뜬다. 캐시 먼저로 두면 옛 판에
 * 갇혀 "고쳤는데 안 바뀐다"가 된다.
 *
 * 사진은 여기를 지나가지 않는다. 파일은 페이지가 직접 읽고 어디로도 보내지 않는다.
 */
const CACHE = "filmsim-studio-__VERSION__";
const SHELL = ["./", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("./")))
  );
});
