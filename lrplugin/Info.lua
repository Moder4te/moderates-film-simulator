--[[
  FilmSim 프로파일 — Lightroom Classic 플러그인 매니페스트.

  이 플러그인은 **색을 계산하지 않는다.** 엔진(Photoshop UXP)이 구운 프로파일(.xmp)을
  담아 두고, Camera Raw 설정 폴더에 복사해 주는 일만 한다.

  왜 계산을 넣지 않았나 — LrC SDK로는 그럴 이유가 없다.
    · SDK는 **픽셀에 접근할 수 없다.** Develop 렌더링에 끼어들 방법이 아예 없어,
      필름 룩을 넣는 길은 프로파일뿐이다.
    · 프로파일은 **Lightroom 실행 시점에만 읽힌다.** 안에서 생성해 봐야 바꿀 때마다
      재시작해야 하므로, 색 엔진(3342줄)을 Lua로 옮겨도 얻는 것이 없다.
    · 그리고 구현이 둘이 되면 반드시 갈라진다 — 이 프로젝트에서 가장 자주 난 결함이다.

  프로파일 파일은 `tools/build-lrplugin.js`가 생성해 `profiles/`에 넣는다.
]]

return {
  LrSdkVersion = 10.0,
  LrSdkMinimumVersion = 6.0,

  LrToolkitIdentifier = "com.filmsim.profiles",
  LrPluginName = "FilmSim 프로파일",

  -- 라이브러리 > 플러그인 추가 기능. 적용을 먼저 두는 이유는 설치가 한 번뿐이기 때문이다.
  LrLibraryMenuItems = {
    { title = "필름 룩 적용…", file = "Apply.lua" },
    { title = "필름 프로파일 설치…", file = "Install.lua" },
    { title = "이 사진의 프로파일 설정 보기", file = "Inspect.lua" },
  },
  -- ⚠️ 파일 메뉴에도 **같은 항목을 전부** 둔다. 라이브러리 메뉴는 라이브러리 모듈에
  -- 있을 때만 나오는데, 프로파일을 손으로 고르는 일은 현상 모듈에서 한다 —
  -- 진단 항목을 라이브러리에만 뒀더니 정작 필요한 자리에서 보이지 않았다.
  LrExportMenuItems = {
    { title = "필름 룩 적용…", file = "Apply.lua" },
    { title = "필름 프로파일 설치…", file = "Install.lua" },
    { title = "이 사진의 프로파일 설정 보기", file = "Inspect.lua" },
  },

  LrPluginInfoUrl = "https://github.com/Moder4te/moderates-film-simulator",

  VERSION = { major = 2, minor = 2, revision = 0, build = 0 },
}
