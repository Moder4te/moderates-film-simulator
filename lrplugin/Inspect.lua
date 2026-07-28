--[[
  선택한 사진의 프로파일 관련 develop 설정을 그대로 보여준다.

  ── 왜 필요한가 ──────────────────────────────────────────────────────────

  `Look` 테이블의 정확한 모양은 **Adobe가 문서화하지 않았다.** 커뮤니티에서 통용되는
  방법은 "프로파일을 손으로 한 번 적용한 뒤 `getDevelopSettings()`를 들여다보는 것"이다.

  그래서 적용이 안 먹을 때 이 창을 열어 **Lightroom이 실제로 무엇을 저장하는지** 보고,
  `Apply.lua`가 만드는 테이블과 대조할 수 있게 한다. 추측으로 고치는 것보다 빠르다.

  쓰는 법 — 프로필 찾아보기에서 FilmSim 프로파일을 손으로 하나 적용한 뒤 이 메뉴를
  연다. 나오는 값이 Apply.lua의 `look` 테이블과 다르면 그 차이가 원인이다.
]]

local LrApplication = import "LrApplication"
local LrDialogs = import "LrDialogs"
local LrTasks = import "LrTasks"

--- 테이블을 사람이 읽을 수 있게 편다. 깊이를 제한해 거대한 값에서 멈추지 않게 한다.
local function dump(value, indent, depth)
  indent = indent or ""
  depth = depth or 0
  if type(value) ~= "table" then
    if type(value) == "string" and #value > 120 then
      return string.format("%q", value:sub(1, 120) .. "… (" .. #value .. "자)")
    end
    return tostring(value)
  end
  if depth >= 3 then return "{…}" end

  local keys = {}
  for k in pairs(value) do keys[#keys + 1] = tostring(k) end
  table.sort(keys)

  local out = { "{" }
  for _, k in ipairs(keys) do
    out[#out + 1] = indent .. "  " .. k .. " = " .. dump(value[k], indent .. "  ", depth + 1) .. ","
  end
  out[#out + 1] = indent .. "}"
  return table.concat(out, "\n")
end

LrTasks.startAsyncTask(function()
  local photos = LrApplication.activeCatalog():getTargetPhotos()
  if #photos == 0 then
    LrDialogs.message("선택된 사진이 없습니다", "사진을 하나 고르고 다시 여세요.", "info")
    return
  end

  local s = photos[1]:getDevelopSettings()
  local parts = {}

  parts[#parts + 1] = "Look = " .. dump(s.Look)
  parts[#parts + 1] = ""
  parts[#parts + 1] = "CameraProfile = " .. dump(s.CameraProfile)
  parts[#parts + 1] = "ProcessVersion = " .. dump(s.ProcessVersion)

  LrDialogs.message(
    "이 사진의 프로파일 설정",
    table.concat(parts, "\n") ..
      "\n\n(Apply.lua가 만드는 Look 테이블과 대조해 보세요)",
    "info"
  )
end)
