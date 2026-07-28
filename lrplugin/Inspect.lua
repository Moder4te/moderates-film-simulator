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
local LrView = import "LrView"
local LrFunctionContext = import "LrFunctionContext"

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
  local text = table.concat({
    "-- 플랫폼: " .. (WIN_ENV and "Windows" or "macOS"),
    "Look = " .. dump(s.Look),
    "",
    "CameraProfile = " .. dump(s.CameraProfile),
    "ProcessVersion = " .. dump(s.ProcessVersion),
  }, "\n")

  -- ⚠️ `LrDialogs.message`를 쓰지 않는다. **이 값은 복사해 가는 것이 목적**인데
  -- 알림창 본문은 선택이 안 되고, macOS에서는 긴 본문이 잘리기까지 한다.
  -- 스크롤되는 편집 필드에 넣어 두면 양쪽에서 다 읽고 복사할 수 있다.
  LrFunctionContext.callWithContext("filmsimInspect", function(context)
    local f = LrView.osFactory()
    LrDialogs.presentModalDialog({
      title = "이 사진의 프로파일 설정",
      contents = f:column({
        spacing = f:control_spacing(),
        f:static_text({ title = "Apply.lua가 만드는 Look 테이블과 대조해 보세요." }),
        f:edit_field({
          value = text,
          width_in_chars = 52,
          height_in_lines = 16,
          -- 잠그지 않는다. 비활성 필드에서 복사가 되는지 확실하지 않고, 여기서
          -- 고친 값은 아무 데도 쓰이지 않으니 열어 두는 쪽이 안전하다.
        }),
      }),
      actionVerb = "닫기",
      cancelVerb = "< exclude >", -- 취소 버튼을 없앤다. 닫는 길이 하나면 충분하다.
    })
  end)
end)
