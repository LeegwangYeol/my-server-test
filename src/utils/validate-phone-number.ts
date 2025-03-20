// 전화번호 유효성 검사 함수
export const validatePhoneNumber = (phoneNumber: string): boolean =>
  phoneNumber.split("+").length > 2 ? false : true;
