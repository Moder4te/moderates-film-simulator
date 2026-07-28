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
  if #photos == 0 then return 0, 0 end

  local look = {
    Name = profile.name,
    Amount = amount,
    UUID = profile.uuid,
  }

  local ok, failed = 0, 0
  catalog:withWriteAccessDo("FilmSim 프로파일 적용", function()
    for _, photo in ipairs(photos) do
      local applied = pcall(function()
        -- 현재 설정을 읽어 Look만 갈아 끼운다(통째로 덮어쓰면 다른 조정이 날아간다).
        local s = photo:getDevelopSettings()
        s.Look = look
        photo:applyDevelopSettings(s, "FilmSim: " .. profile.name)
      end)
      if applied then ok = ok + 1 else failed = failed + 1 end
    end
  end)
  return ok, failed
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

    local ok, failed = applyToSelection(profile, props.amount)
    if failed > 0 then
      LrDialogs.message(ok .. "장 적용, " .. failed .. "장 실패", profile.name, "warning")
    else
      LrDialogs.showBezel(profile.name .. " — " .. ok .. "장 적용")
    end
  end)
end)
