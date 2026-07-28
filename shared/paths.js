/**
 * 경로 비교 — 호스트 API 없이 도는 순수 모듈.
 *
 * **왜 따로 있나.** 배치의 원본 보호가 이 함수 하나에 걸려 있다
 * (`apps/finish/src/batch.js`의 `isSameFile`). 그 파일은 맨 위에서 `photoshop`과
 * `uxp`를 require해 노드에서 못 부르므로, 안에 두면 **검사할 수 없다.** 여기로
 * 올려 두면 `tools/check-paths.js`가 매번 경계값을 실제로 돌려 본다.
 *
 * 저장소가 이미 겪은 것 — "통과 표시를 내면서 아무것도 검사하지 않는" 검사가
 * 두 번 있었다(`docs/RESOLVED.md`). 못 부르는 코드는 그 상태와 같다.
 */

/**
 * 두 경로가 같은 것을 가리키는가 — 문자열 수준 판정.
 *
 * 흡수하는 것:
 *   - 구분자 종류(`\` vs `/`)와 중복(`a\\b`)
 *   - 후행 구분자
 *   - Windows 대소문자 (드라이브 문자 `C:` 또는 UNC `\\server`)
 *
 * **흡수하지 못하는 것** — 심볼릭 링크, 매핑된 드라이브, 네트워크 별칭.
 * 이것들은 경로 문자열이 아예 다르다. 그래서 이 함수만으로 "같은 파일이 아니다"를
 * 보증할 수 없고, 호출자가 메타데이터 대조를 한 겹 더 얹어야 한다.
 *
 * POSIX는 대소문자를 구분하므로 소문자화하지 않는다. macOS의 기본 파일시스템은
 * 대소문자를 구분하지 않지만, 여기서 소문자화하면 대소문자를 구분하도록 포맷한
 * 볼륨에서 **서로 다른 두 파일을 같다고 판정**한다. 과잉 차단이 조용한 원본
 * 손실보다 낫다는 방침에 맞춰, 안전한 방향(같다고 볼 때만 막는다)으로 둔다.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function samePath(a, b) {
  const norm = (p) => {
    const raw = String(p);
    // 드라이브 문자 또는 UNC면 Windows 경로다. **구분자를 합치기 전에** 본다 —
    // 합친 뒤에는 UNC의 선행 `\\`가 `/` 하나가 돼 판별할 수 없다.
    const win = /^([a-z]:|[\\/]{2})/i.test(raw);
    const s = raw.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
    return win ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

module.exports = { samePath };
