# test/sms-local — 맥 로컬 전용 문자 도구

> ⚠️ **여기 있는 코드는 서버(API)의 일부가 아니다.** Vercel 서버리스에서는 **원리적으로 실행 불가**하며,
> `lambda-src/handler.ts` → `api/index.js` 번들에 **들어가서도 안 된다.**

## 왜 분리했나

이 저장소는 Vercel 서버리스 백엔드다. 그런데 "0원으로 문자 보내기"를 위해 만든 경로들은
**내 맥/내 폰이라는 물리 장치에 의존**한다 — 서버에는 맞지 않는 물건이라 여기로 뺐다.

| 경로 | 서버에서 못 도는 이유 |
|---|---|
| `imessage.ts` | `osascript` 로 맥 메시지앱을 제어 — macOS 아니면 불가 |
| `imessage-verify.ts` | 맥의 `~/Library/Messages/chat.db` 를 읽음 (전체 디스크 접근 권한 필요) |
| `phone-gateway.ts` | SMS Gate 앱이 뜬 **집 LAN의 안드로이드폰**에 접속 — 외부 서버에서 도달 불가 |
| `usage.ts` | 발송량을 `.sms-usage.json` **로컬 파일**에 누적 — 서버리스 FS 는 읽기 전용 |

**서버에서 문자를 보내야 한다면** `lib/sms/` 의 Pushbullet 경로를 쓴다(HTTPS 호출뿐이라 서버에서 동작).
`POST /v2/admin/sms/send` 가 그것이다.

## 용도

명절 인사처럼 **내가 내 맥 앞에 앉아서 한 번에 돌리는** 일괄 발송 도구다.

```bash
npm run greetings                  # 미리보기 (절대 발송 안 함)
npm run greetings -- --send        # 실제 발송
npm run greetings -- --send --limit 30           # 1~30번째만
npm run greetings -- --send --skip 30 --limit 30 # 31~60번째

npm run sms:devices                # 쓸 수 있는 폰/서비스 목록
npm run sms:usage                  # 이번 달 발송량
npm run sms:verify -- --csv contacts.csv --since 2h   # 누가 실패했는지
```

- 연락처·문구는 저장소 루트의 `contacts.csv` / `greeting.txt` (개인정보라 **gitignore**됨).
  양식은 이 폴더의 `contacts.example.csv` / `greeting.example.txt` 참고.
- 경로 전환은 `.env` 의 `SMS_PROVIDER` 한 줄: `imessage` | `pushbullet` | `phone`.

## 손대는 사람이 알아야 할 것

1. **이 폴더의 코드를 `lib/` 나 `src/` 로 옮기지 말 것.** 서버 번들이 오염되고 배포가 깨진다.
2. `tsconfig.json` 의 `include` 는 `src`/`lib` 뿐이라 이 폴더는 서버 타입체크 대상이 아니다 — 의도된 것이다.
3. 스크립트들은 `node --env-file` 로 직접 실행되므로 상대 import 에 **`.ts` 확장자를 반드시 붙인다**
   (네이티브 ESM 리졸버가 확장자를 안 붙여줌). barrel(`lib/sms/index.ts`) 을 경유하지 말 것.
4. iMessage 는 **중계 중인 아이폰 본인 번호로는 배달되지 않는다** — 테스트는 다른 번호로.
