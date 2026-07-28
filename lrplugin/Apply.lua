--[[
  필름·스캐너를 골라 선택한 사진에 프로파일을 적용한다.

  ── 어떻게 적용되는가 ────────────────────────────────────────────────────

  크리에이티브 프로파일은 develop 설정의 **`Look` 키**에 들어간다. 비문서화지만
  LR6부터 있는 `photo:applyDevelopSettings()`로 쓸 수 있다.

  ⚠️ **SDK는 설치된 프로파일을 이름으로 조회하지 못한다.** 그래서 무엇이 있는지는
  `Profiles.lua`(빌드가 생성)를 보고 알고, `Look`은 거기 담긴 이름·UUID로 직접
  조립한다. 프로파일이 아직 설치되지 않았거나 Lightroom을 재시작하지 않았으면
  적용해도 화면이 바뀌지 않는다 — 그래서 아래 안내를 함께 띄운다.

  ⚠️ **설정을 통째로 덮어쓰지 않는다.** 현재 설정을 읽어 `Look`만 갈아 끼운다.
  통째로 쓰면 사용자가 해둔 노출·크롭 같은 조정이 날아간다.
]]

local LrApplication = import "LrApplication"
local LrDialogs = import "LrDialogs"
local LrTasks = import "LrTasks"
local LrView = import "LrView"
local LrBinding = import "LrBinding"
local LrColor = import "LrColor"
local LrFunctionContext = import "LrFunctionContext"

-- `dofile`이 아니라 `require`다. Lightroom은 플러그인 폴더를 모듈 경로에 넣어 주지만
-- 파일시스템 함수는 샌드박스에서 막힐 수 있다.
local PROFILES = require "Profiles"

--- 목록에서 중복 없이 순서를 지켜 뽑는다.
local function distinct(key)
  local seen, out = {}, {}
  for _, p in ipairs(PROFILES) do
    if not seen[p[key]] then
      seen[p[key]] = true
      out[#out + 1] = p[key]
    end
  end
  return out
end

local function popupItems(values)
  local items = {}
  for _, v in ipairs(values) do
    items[#items + 1] = { title = v, value = v }
  end
  return items
end

local function findProfile(film, scannerName)
  for _, p in ipairs(PROFILES) do
    if p.film == film and p.scanner == scannerName then return p end
  end
  return nil
end

--- 선택한 사진들에 Look을 적용한다. 실패해도 멈추지 않고 건수를 돌려준다.
local function applyToSelection(profile, amount)
  local catalog = LrApplication.activeCatalog()
  local photos = catalog:getTargetPhotos()
  if #photos == 0 then return 0, 0, {}, nil end

  local label = "FilmSim: " .. profile.name

  -- Name·Amount·UUID 세 개만 넣었을 때 **이름과 강도 슬라이더는 제대로 떴는데 색이
  -- 걸리지 않았다.** 이름이 떴다는 건 Lightroom이 UUID로 프로파일을 찾았다는 뜻이라,
  -- 부족한 건 참조가 아니라 그 참조를 렌더링에 물리는 쪽이다.
  --
  -- 그래서 프로파일 파일(`crs:` 속성)이 실제로 선언하는 값을 그대로 채운다. 지어내지
  -- 않고 생성물에서 가져온 값이다 — `tools/build-lrplugin.js`가 굽는 XMP 헤더 참조.
  local look = {
    Name = profile.name,
    Amount = amount,
    UUID = profile.uuid,
    Cluster = "",
    SupportsAmount = true,
    SupportsMonochrome = true,
    SupportsOutputReferred = true,
  }

  -- ── 길은 하나만 쓴다 ─────────────────────────────────────────────────
  --
  -- 한때 `addDevelopPresetForPlugin` + `applyDevelopPreset`를 대안으로 뒀는데,
  -- **실기에서 사진을 망가뜨렸다.** `{ Look = ... }`만 담은 프리셋을 적용하면
  -- Look은 그대로인 채 다른 설정만 헤집어 놓는다(강한 그린 캐스트로 나타났다).
  -- 되지도 않으면서 원본 편집을 망치는 경로라 뺐다 — 안 되는 기능이 낫다.
  --
  -- 남은 `applyDevelopSettings`는 비문서화다. 실패하면 이유를 그대로 보여준다.
  --
  -- ⚠️ **`pcall`이 아니라 `LrTasks.pcall`이다.** Lua 5.1은 C 함수 경계를 넘어
  -- yield하지 못하는데 `pcall`이 바로 그 C 함수다. SDK의 비동기 호출을 평범한
  -- pcall로 감싸면 호출 자체가
  --   "Yielding is not allowed within a C or metamethod call"
  -- 로 죽는다 — 오류를 잡으려고 넣은 것이 오류를 만든다. `LrTasks.pcall`은
  -- 이 경우를 위해 있는 yield 안전 버전이다.
  local ok, failed, firstError = 0, 0, nil

  catalog:withWriteAccessDo("FilmSim 프로파일 적용", function()
    for _, photo in ipairs(photos) do
      local good, err = LrTasks.pcall(function()
        -- 현재 설정을 읽어 Look만 갈아 끼운다(통째로 덮어쓰면 다른 조정이 날아간다).
        local s = photo:getDevelopSettings()
        s.Look = look
        photo:applyDevelopSettings(s, label)
      end)
      if good then
        ok = ok + 1
      else
        failed = failed + 1
        firstError = firstError or tostring(err)
      end
    end
  end)

  return ok, failed, firstError
end

LrTasks.startAsyncTask(function()
  if #PROFILES == 0 then
    LrDialogs.message("담긴 프로파일이 없습니다",
      "`node tools/build-lrplugin.js`로 다시 빌드하세요.", "critical")
    return
  end

  local photos = LrApplication.activeCatalog():getTargetPhotos()
  if #photos == 0 then
    LrDialogs.message("선택된 사진이 없습니다",
      "적용할 사진을 먼저 고르세요.", "info")
    return
  end

  LrFunctionContext.callWithContext("filmsimApply", function(context)
    local f = LrView.osFactory()
    local props = LrBinding.makePropertyTable(context)
    local filmList = distinct("film")
    local scannerList = distinct("scanner")
    props.film = filmList[1]
    props.scanner = scannerList[1]
    props.amount = 1.0

    local contents = f:column({
      bind_to_object = props,
      spacing = f:control_spacing(),

      f:static_text({ title = "선택한 사진 " .. #photos .. "장에 적용합니다." }),

      -- ⚠️ 폭을 픽셀로 박지 않는다. macOS는 기본 폰트가 Windows보다 넓어서 딱 맞춘
      -- 픽셀 값이 거기서 잘린다. `LrView.share`는 가장 넓은 라벨에 맞춰 레이아웃
      -- 시점에 정해지고, `width_in_chars`는 글자 수로 잡는다 — 둘 다 폰트를 따라간다.
      -- 팝업은 폭을 주지 않으면 가장 긴 항목에 맞춰 스스로 늘어난다.
      f:row({
        f:static_text({ title = "필름", alignment = "right", width = LrView.share("label") }),
        f:popup_menu({ value = LrView.bind("film"), items = popupItems(filmList) }),
      }),
      f:row({
        f:static_text({ title = "스캐너", alignment = "right", width = LrView.share("label") }),
        f:popup_menu({ value = LrView.bind("scanner"), items = popupItems(scannerList) }),
      }),
      f:row({
        f:static_text({ title = "강도", alignment = "right", width = LrView.share("label") }),
        f:slider({ value = LrView.bind("amount"), min = 0, max = 1, fill_horizontal = 1 }),
        -- 슬라이더 값을 그대로 붙이면 0.7300000000001처럼 나온다. 백분율로 다듬는다.
        f:static_text({
          width_in_chars = 4,
          title = LrView.bind({
            key = "amount",
            transform = function(v) return math.floor((v or 0) * 100 + 0.5) .. "%" end,
          }),
        }),
      }),

      -- 폭·높이를 글자 기준으로 잡아 줄바꿈 위치를 못 박는다. 안 그러면 이 한 줄이
      -- 대화상자 폭을 결정해 버리고, 그 폭이 플랫폼마다 달라진다.
      f:static_text({
        title = "프로파일이 아직 설치·재시작되지 않았다면 화면이 바뀌지 않습니다.",
        width_in_chars = 34,
        height_in_lines = 2,
        text_color = LrColor(0.5, 0.5, 0.5),
      }),
    })

    local result = LrDialogs.presentModalDialog({
      title = "FilmSim 프로파일 적용",
      contents = contents,
      actionVerb = "적용",
    })
    if result ~= "ok" then return end

    local profile = findProfile(props.film, props.scanner)
    if not profile then
      LrDialogs.message("그 조합의 프로파일이 없습니다",
        props.film .. " · " .. props.scanner, "warning")
      return
    end

    local ok, failed, err = applyToSelection(profile, props.amount)

    if failed > 0 then
      LrDialogs.message(
        ok .. "장 적용, " .. failed .. "장 실패",
        profile.name .. "\n\n오류: " .. (err or "(이유 없음)"),
        "warning"
      )
      return
    end

    -- 호출이 성공했다고 값이 남았다는 뜻은 아니다. 되읽어서 확인한다 — 이게 없으면
    -- "적용했다는데 사진이 그대로"인 상황에서 어디가 문제인지 구분할 수 없다.
    local after = photos[1]:getDevelopSettings().Look
    if type(after) == "table" and after.UUID == profile.uuid then
      LrDialogs.showBezel(profile.name .. " — " .. ok .. "장 적용")
      return
    end

    LrDialogs.message(
      "설정은 넘겼는데 값이 남지 않았습니다",
      ok .. "장 처리했지만 되읽으니 Look이 바뀌지 않았습니다.\n\n" ..
        "보낸 UUID: " .. profile.uuid .. "\n" ..
        "남은 Look: " .. (type(after) == "table" and tostring(after.UUID) or type(after)) .. "\n\n" ..
        "프로파일이 설치·재시작되지 않았거나, Look 테이블 모양이 맞지 않습니다.\n" ..
        "프로필 찾아보기에서 이 프로파일을 손으로 한 번 적용한 뒤 " ..
        "\"이 사진의 프로파일 설정 보기\"를 열어 실제 값을 확인하세요.",
      "warning"
    )
  end)
end)
