/**
 * 마감 파라미터 스키마는 `shared/params/finish.js`에 있다 — 독립 실행형
 * (apps/studio)이 같은 프리셋 JSON을 읽어야 해서 앱 밖으로 뺐다.
 * 여기는 기존 `require("./params")`를 깨지 않기 위한 재수출이다.
 */
module.exports = require("../lib/shared/params/finish");
