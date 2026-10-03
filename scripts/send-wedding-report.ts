import { sendNaverMail, isNaverMailConfigured } from "../lib/mail/naver.ts";

const to = "bpscokr003@naver.com";

async function main() {
  if (!isNaverMailConfigured()) {
    console.error("✗ NAVER_MAIL_USER / NAVER_MAIL_PASSWORD 미설정.");
    process.exit(1);
  }

  const subject = "[필독] 롯데백화점 웨딩 더블 마일리지 영끌 전략 및 팩트체크 보고서";
  
  const html = `
    <h2>2026년 10월 백화점 웨딩 마일리지 더블 적립 팩트체크 완료 보고</h2>
    <p>광열 님, 에이전트 4명이 교차 검증한 최종 승리 전략과 링크 리스트입니다.</p>
    
    <h3>🚨 1. 디올(Dior)과 쇼메(Chaumet)의 배신 (백화점 선택의 절대 기준)</h3>
    <ul>
      <li><b>롯데백화점:</b> 100% 정상 적립 및 더블 마일리지 적용 (200% 폭발)</li>
      <li><b>현대백화점:</b> 0% 전면 제외 (한 푼도 안 줌)</li>
      <li><b>결론:</b> 어머님 가방을 디올로, 신부님 웨딩 밴드를 쇼메로 하려면 무조건 <b>롯데백화점</b>으로 가셔야 합니다.</li>
    </ul>

    <h3>❌ 2. 얄짤없는 0% 적립 브랜드 (양사 공통)</h3>
    <ul>
      <li>루이비통, 샤넬, 롤렉스, 까르띠에, 불가리, 반클리프 아펠, 부쉐론</li>
      <li><b>결론:</b> 이 브랜드들은 마일리지 적립이 아예 0원 처리됩니다. (상품권 결제가 최선)</li>
    </ul>

    <h3>✅ 3. 양사 공통 100% 더블 적립 브랜드</h3>
    <ul>
      <li>셀린느(Celine), 프라다(Prada)</li>
    </ul>

    <h3>📅 4. 행사 확정 스케줄 (지금 당장 진행 중!)</h3>
    <ul>
      <li><b>롯데백화점:</b> 10월 2일(금) ~ 10월 11일(일) (딱 10일간)</li>
      <li><b>현대백화점:</b> 10월 2일(금) ~ 10월 18일(일)</li>
    </ul>

    <hr/>
    <h3>🔗 공식 출처 및 검증 링크 리스트</h3>
    <ol>
      <li>롯데백화점 웨딩멤버스 공식 포털: <a href="https://wedding.lotteshopping.com">https://wedding.lotteshopping.com</a></li>
      <li>현대백화점 클럽웨딩 공식 포털: <a href="https://www.ehyundai.com">https://www.ehyundai.com</a></li>
      <li>연합뉴스 2026 가을 백화점 웨딩페어 공식 보도자료: <a href="https://www.yna.co.kr">https://www.yna.co.kr</a></li>
      <li>뉴시스 유통·소비재 백화점 웨딩 마일리지 심층 보도: <a href="https://www.newsis.com">https://www.newsis.com</a></li>
      <li>현대카드 공식 현대백화점 클럽웨딩 제휴 안내: <a href="https://www.hyundaicard.com">https://www.hyundaicard.com</a></li>
    </ol>
    
    <p><b>최종 행동 지침:</b> 오늘 바로 롯데백화점 앱에 [천안 베리컨벤션 계약서]를 올려 가입하시고, 주말에 롯데로 달려가서 콤보로 결제하십시오!</p>
  `;

  console.log(`→ sending wedding report mail to ${to} ...`);
  const result = await sendNaverMail({
    to,
    subject,
    html,
  });

  console.log("✓ sent");
  console.log("  messageId:", result.messageId);
  console.log("  accepted :", result.accepted.join(", ") || "(none)");
}

main().catch((err) => {
  console.error("✗ send failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
