// * 해당 요청이 들어와도 발송지가 카카오채널의 IP 주소여야만 허용합니다.
// * @see https://devtalk.kakao.com/t/if-callback-request-is-failed-firewall-setting-required/83372
// * @see https://cs.kakao.com/helps_html/1073203399?locale=ko
export const KAKAO_ALLOWED_IPS = [
  // 첫 번째 IP 대역
  "211.249.203.104",
  "211.249.203.105",
  "211.249.203.106",
  "211.249.203.107",
  "211.249.203.108",
  "211.249.203.109",
  "211.249.203.169",
  "211.249.203.170",
  "211.249.203.171",
  "211.249.203.172",

  // 두 번째 IP 대역
  "220.64.110.190",
  "220.64.110.222",
  "220.64.111.158",
  "220.64.111.188",
  "220.64.111.219",
  "220.64.111.244",
  "220.64.111.245",
  "220.64.111.246",
  "220.64.109.84",
  "220.64.109.85",

  // 세 번째 IP 대역
  "203.217.230.3",
  "203.217.230.4",
  "203.217.230.5",
  "203.217.230.6",
  "203.217.230.7",
  "203.217.230.29",
  "203.217.230.35",
  "203.217.230.36",
  "203.217.230.37",
  "203.217.230.38",

  //추가
  "219.249.231.40",
  "219.249.231.41",
  "219.249.231.42",
] as const;

// IP 검증을 위한 유틸리티 함수
export const isKakaoIP = (ip: string | null): boolean => {
  console.log(ip);
  console.log(
    KAKAO_ALLOWED_IPS.includes(ip as (typeof KAKAO_ALLOWED_IPS)[number]),
  );
  if (!ip) return false;
  return KAKAO_ALLOWED_IPS.includes(ip as (typeof KAKAO_ALLOWED_IPS)[number]);
};
