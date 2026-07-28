--[[
  담아 둔 프로파일(.xmp)을 Camera Raw 설정 폴더에 복사한다.

  ── 경로를 home에서 조립하는 이유 ────────────────────────────────────────

  `LrPathUtils.getStandardFilePath("appData")`는 Windows에서 일반 Roaming 루트가
  아니라 **`...\Roaming\Adobe\Lightroom\`** 을 준다. 거기서 상대 경로로 CameraRaw를
  찾아 올라가면 Lightroom 폴더 구조가 바뀌는 날 조용히 깨진다.

  `home`은 두 플랫폼 모두에서 안정적이라, 거기서 규정된 경로를 직접 조립한다.
  그래도 못 찾으면 **사용자에게 폴더를 고르게 한다** — 설치 위치가 표준과 다른
  환경이 있고, 조용히 실패하는 것보다 물어보는 편이 낫다.
]]

local LrTasks = import "LrTasks"
local LrDialogs = import "LrDialogs"
local LrPathUtils = import "LrPathUtils"
local LrFileUtils = import "LrFileUtils"

local SETTINGS_REL = {
  win = { "AppData", "Roaming", "Adobe", "CameraRaw", "Settings" },
  mac = { "Library", "Application Support", "Adobe", "CameraRaw", "Settings" },
}

--- home에서 규정된 Camera Raw 설정 폴더 경로를 만든다. 존재 여부는 보지 않는다.
local function defaultSettingsDir()
  local p = LrPathUtils.getStandardFilePath("home")
  local parts = WIN_ENV and SETTINGS_REL.win or SETTINGS_REL.mac
  for _, seg in ipairs(parts) do
    p = LrPathUtils.child(p, seg)
  end
  return p
end

--- 설치 대상 폴더를 정한다. 표준 위치가 없으면 사용자가 고른다.
local function resolveTargetDir()
  local dir = defaultSettingsDir()
  if LrFileUtils.exists(dir) == "directory" then
    return dir
  end

  local picked = LrDialogs.runOpenPanel({
    title = "Camera Raw 설정 폴더를 고르세요",
    prompt = "선택",
    canChooseFiles = false,
    canChooseDirectories = true,
    allowsMultipleSelection = false,
  })
  return picked and picked[1] or nil
end

--- profiles/ 안의 .xmp 목록.
local function bundledProfiles()
  local dir = LrPathUtils.child(_PLUGIN.path, "profiles")
  local list = {}
  if LrFileUtils.exists(dir) ~= "directory" then
    return list, dir
  end
  for file in LrFileUtils.files(dir) do
    if file:lower():sub(-4) == ".xmp" then
      list[#list + 1] = file
    end
  end
  return list, dir
end

LrTasks.startAsyncTask(function()
  local profiles, srcDir = bundledProfiles()
  if #profiles == 0 then
    LrDialogs.message(
      "담긴 프로파일이 없습니다",
      "플러그인 안에 프로파일이 없습니다.\n\n" ..
        "저장소에서 직접 빌드했다면 `node tools/build-lrplugin.js`를 먼저 돌리세요.\n" ..
        "찾은 경로: " .. srcDir,
      "critical"
    )
    return
  end

  local target = resolveTargetDir()
  if not target then return end -- 사용자가 취소

  local copied, failed = 0, {}
  for _, src in ipairs(profiles) do
    local name = LrPathUtils.leafName(src)
    local dst = LrPathUtils.child(target, name)
    local ok, err = pcall(function()
      -- LrFileUtils.copy는 대상이 있으면 실패한다. 덮어쓰려면 먼저 지운다.
      if LrFileUtils.exists(dst) then
        LrFileUtils.delete(dst)
      end
      LrFileUtils.copy(src, dst)
    end)
    if ok then
      copied = copied + 1
    else
      -- **한 장이 실패해도 멈추지 않는다.** 하나 때문에 나머지를 잃는 편이 나쁘다.
      failed[#failed + 1] = name .. " (" .. tostring(err) .. ")"
    end
  end

  if #failed > 0 then
    LrDialogs.message(
      copied .. "개 설치, " .. #failed .. "개 실패",
      "실패한 파일:\n" .. table.concat(failed, "\n") ..
        "\n\n대상 폴더: " .. target,
      "warning"
    )
    return
  end

  -- ⚠️ 재시작 안내가 핵심이다. Lightroom은 **실행 시점에만** 프로파일을 읽어서,
  -- 이 말을 빠뜨리면 "설치했는데 안 보인다"가 그대로 문의로 돌아온다.
  LrDialogs.message(
    "프로파일 " .. copied .. "개를 설치했습니다",
    "대상 폴더: " .. target .. "\n\n" ..
      "**Lightroom을 다시 시작해야 목록에 나타납니다.** Lightroom은 실행할 때만 " ..
      "프로파일을 읽습니다.\n\n" ..
      "재시작 후 Develop 모듈의 기본 패널 > 프로필 찾아보기에서 \"FilmSim\" 그룹을 여세요.",
    "info"
  )
end)
