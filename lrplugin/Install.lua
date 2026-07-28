--[[
  담아 둔 프로파일(.xmp)을 Camera Raw 설정 폴더에 복사한다.

  ── 경로를 home에서 조립하는 이유 ────────────────────────────────────────

  `LrPathUtils.getStandardFilePath("appData")`는 Windows에서 일반 Roaming 루트가
  아니라 **`...\Roaming\Adobe\Lightroom\`** 을 준다. 거기서 상대 경로로 CameraRaw를
  찾아 올라가면 Lightroom 폴더 구조가 바뀌는 날 조용히 깨진다.

  `home`은 두 플랫폼 모두에서 안정적이라, 거기서 규정된 경로를 직접 조립한다.

  ── 없으면 고르게 하지 않고 만든다 ──────────────────────────────────────

  Camera Raw는 이 폴더를 **처음 필요할 때 만든다.** 갓 설치한 환경에는 없을 수 있다.

  이때 "폴더를 고르세요"로 넘기는 건 **macOS에서 막다른 길**이다. `~/Library`는
  Finder에서 숨김이라 열기 패널에 아예 뜨지 않는다. 그래서 규정된 경로면 직접
  만들고, 폴더 선택은 **만들기까지 실패했을 때만** 쓴다.
]]

local LrTasks = import "LrTasks"
local LrDialogs = import "LrDialogs"
local LrPathUtils = import "LrPathUtils"
local LrFileUtils = import "LrFileUtils"
local LrShell = import "LrShell"

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

--- 사람에게 보여줄 짧은 표기. 전체 경로는 홈 아래라 길고 읽기 나쁘다.
local function shortForm()
  return WIN_ENV
    and "%APPDATA%\\Adobe\\CameraRaw\\Settings"
    or "~/Library/Application Support/Adobe/CameraRaw/Settings"
end

--- 설치 대상 폴더를 정한다. 없으면 만들고, 만들기도 실패하면 사용자가 고른다.
local function resolveTargetDir()
  local dir = defaultSettingsDir()
  if LrFileUtils.exists(dir) == "directory" then
    return dir
  end

  pcall(function() LrFileUtils.createAllDirectories(dir) end)
  if LrFileUtils.exists(dir) == "directory" then
    return dir
  end

  -- 여기까지 왔으면 표준 경로가 아닌 환경이다. macOS라면 숨김 폴더를 열기 패널에서
  -- 찾아야 하므로 가는 법을 함께 알려준다(Finder: Cmd+Shift+G).
  local hint = WIN_ENV
    and "탐색기 주소창에 이 경로를 붙여 넣으면 바로 갑니다:\n" .. shortForm()
    or "Finder에서 Cmd+Shift+G 를 누르고 이 경로를 붙여 넣으세요:\n" .. shortForm()

  LrDialogs.message(
    "Camera Raw 설정 폴더를 찾지 못했습니다",
    "표준 위치에 없고 만들지도 못했습니다.\n\n" .. hint,
    "warning"
  )

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
  --
  -- "폴더 열기"를 붙인 이유는 macOS다. 대상이 숨김 폴더(`~/Library`) 안이라 경로를
  -- 알려줘도 Finder로 직접 가기 번거롭다. revealInShell은 양쪽에서 다 된다.
  local answer = LrDialogs.confirm(
    "프로파일 " .. copied .. "개를 설치했습니다",
    "대상 폴더: " .. shortForm() .. "\n\n" ..
      "Lightroom을 다시 시작해야 목록에 나타납니다. Lightroom은 실행할 때만 " ..
      "프로파일을 읽습니다.\n\n" ..
      "재시작 후 현상 모듈의 기본 패널 > 프로필 찾아보기에서 \"FilmSim\" 그룹을 여세요.",
    "확인",
    "폴더 열기"
  )
  -- 두 번째 버튼이 "폴더 열기"라 반환값은 `cancel`이다. 이름과 뜻이 어긋나 보이지만,
  -- 세 번째 버튼을 쓰면 지울 수 없는 "취소"가 하나 더 붙는다 — 설치가 이미 끝난
  -- 창에 취소 버튼이 있는 편이 더 헷갈린다.
  if answer == "cancel" then
    LrShell.revealInShell(target)
  end
end)
